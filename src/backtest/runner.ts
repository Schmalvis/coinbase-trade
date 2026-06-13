import BetterSqlite3 from 'better-sqlite3';
import { scoreAssets } from './score.js';
import { VirtualPortfolio } from './portfolio-sim.js';
import type { BacktestConfig, BacktestResult } from './types.js';
import type { Candle } from '../services/candles.js';

// symbol → interval → candles in ASC order (oldest first)
type CandleStore = Map<string, Map<string, Candle[]>>;

function loadCandles(db: BetterSqlite3.Database, config: BacktestConfig): CandleStore {
  const rows = db.prepare(`
    SELECT symbol, network, interval, open_time AS openTime, open, high, low, close, volume, source
    FROM candles
    WHERE network = ? AND open_time >= ? AND open_time <= ?
    ORDER BY open_time ASC
  `).all(
    config.network,
    config.fromDate,
    config.toDate + 'T23:59:59Z',
  ) as Candle[];

  const store: CandleStore = new Map();
  for (const row of rows) {
    if (!config.symbols.includes(row.symbol)) continue;
    if (!store.has(row.symbol)) store.set(row.symbol, new Map());
    const byInterval = store.get(row.symbol)!;
    if (!byInterval.has(row.interval)) byInterval.set(row.interval, []);
    byInterval.get(row.interval)!.push(row);
  }
  return store;
}

function loadInitialPortfolio(
  db: BetterSqlite3.Database,
  config: BacktestConfig,
): { balances: Map<string, number>; prices: Map<string, number> } {
  // Latest snapshot per symbol before fromDate.
  // Uses MAX(id) subquery — GROUP BY...HAVING MAX(col) returns the max value but
  // non-aggregated columns (price_usd, balance) come from an arbitrary row in SQLite.
  const rows = db.prepare(`
    SELECT s.symbol, s.price_usd, s.balance
    FROM asset_snapshots s
    JOIN (
      SELECT symbol, MAX(id) AS mid
      FROM asset_snapshots
      WHERE timestamp < ?
      GROUP BY symbol
    ) m ON s.id = m.mid
  `).all(config.fromDate) as { symbol: string; price_usd: number; balance: number }[];

  const balances = new Map<string, number>();
  const prices = new Map<string, number>();

  for (const row of rows) {
    if (!config.symbols.includes(row.symbol)) continue;
    balances.set(row.symbol, row.balance);
    prices.set(row.symbol, row.price_usd);
  }

  // Default: 200 USDC when no snapshot data exists
  if (balances.size === 0) {
    balances.set('USDC', 200);
    prices.set('USDC', 1);
  }

  // Fill gaps with zero for symbols not in snapshot
  for (const sym of config.symbols) {
    if (!balances.has(sym)) balances.set(sym, 0);
    if (!prices.has(sym)) prices.set(sym, 0);
  }

  return { balances, prices };
}

/**
 * Slice candles up to `atTime` (inclusive) from the ASC store,
 * return the last `limit` in DESC order (newest first) — matching
 * the ordering of candleQueries.getCandles which the CandleStrategy
 * was calibrated against.
 */
function getSlice(
  store: CandleStore,
  symbol: string,
  interval: '15m' | '1h' | '24h',
  atTime: string,
  limit = 50,
): Candle[] {
  const candlesAsc = store.get(symbol)?.get(interval) ?? [];
  let end = candlesAsc.length;
  // Find the insertion point for atTime (linear scan — fast enough for typical sizes)
  while (end > 0 && candlesAsc[end - 1].openTime > atTime) end--;
  // Take last `limit` of filtered slice, reverse to DESC
  return candlesAsc.slice(Math.max(0, end - limit), end).reverse();
}

const USDC_SCORE = { symbol: 'USDC', score: 0, confidence: 1.0, isHeld: false, currentWeight: 0 };

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const db = new BetterSqlite3(config.dbPath, { readonly: true });

  const store = loadCandles(db, config);
  const { balances, prices } = loadInitialPortfolio(db, config);
  db.close();

  const fullConfig: BacktestConfig = { ...config, initialBalances: balances, initialPrices: prices };
  const portfolio = new VirtualPortfolio(fullConfig);

  // Build 15m tick timeline from candle openTimes across all symbols
  const allTicks = new Set<string>();
  for (const sym of config.symbols) {
    for (const c of store.get(sym)?.get('15m') ?? []) allTicks.add(c.openTime);
  }
  const ticks = [...allTicks].sort();

  if (ticks.length === 0) {
    throw new Error(
      `No 15m candle data found for [${config.symbols.join(', ')}] on ${config.network} ` +
      `between ${config.fromDate} and ${config.toDate}. ` +
      `Check your --db path and --network flag.`
    );
  }

  const scoredSymbols = config.symbols.filter(s => s !== 'USDC');

  for (const tick of ticks) {
    // Update prices from the close of the latest 15m candle per symbol
    const currentPrices = new Map<string, number>();
    for (const sym of config.symbols) {
      const slice = getSlice(store, sym, '15m', tick, 1);
      if (slice.length > 0) currentPrices.set(sym, slice[0].close); // [0] = most recent
    }
    portfolio.updatePrices(currentPrices);

    const scores = scoreAssets(
      scoredSymbols,
      (sym, interval) => getSlice(store, sym, interval, tick),
      portfolio.balances,
      portfolio.prices,
    );

    // USDC is always a buy candidate at score=0
    const usdcEntry = {
      ...USDC_SCORE,
      isHeld: (portfolio.balances.get('USDC') ?? 0) >= 2,
    };
    const allScores = [...scores, usdcEntry];

    // Find best sell: held, score < sellThreshold, not USDC
    const sellCandidates = allScores
      .filter(s => s.isHeld && s.score < config.sellThreshold && s.symbol !== 'USDC')
      .sort((a, b) => a.score - b.score);

    if (sellCandidates.length === 0) continue;

    // Find best buy: score > buyThreshold, different from sell
    const bestSell = sellCandidates[0];
    const bestBuy = allScores
      .filter(b => b.score > config.buyThreshold && b.symbol !== bestSell.symbol)
      .sort((a, b) => b.score - a.score)[0];

    if (!bestBuy) continue;

    const scoreDelta = bestBuy.score - bestSell.score;
    if (scoreDelta < config.minScoreDelta) continue;

    const canCheck = portfolio.canRotate(bestSell.symbol, bestBuy.symbol, tick);
    if (!canCheck.ok) {
      portfolio.vetoed.push({
        tick,
        sellSymbol: bestSell.symbol,
        buySymbol: bestBuy.symbol,
        scoreDelta,
        reason: canCheck.reason!,
      });
      continue;
    }

    portfolio.executeRotation(
      bestSell.symbol,
      bestBuy.symbol,
      scoreDelta,
      bestSell.score,
      bestBuy.score,
      tick,
    );
  }

  const endPortfolioUsd = portfolio.getPortfolioUsd();
  const pnlUsd = endPortfolioUsd - portfolio.startPortfolioUsd;
  const { rotations } = portfolio;

  // NOTE: per-rotation win rate omitted — portfolioUsdAfter is always portfolioUsdBefore - fee
  // at the instant of execution (same-tick prices), so it would always be ~0%. Meaningful
  // win-rate requires forward-looking position marking which is not implemented.
  const avgFeePct = rotations.length > 0
    ? rotations.reduce((s, r) => s + (r.feePaidUsd / r.sellAmountUsd), 0) / rotations.length * 100
    : fullConfig.feePct * 100;

  return {
    config: fullConfig,
    ticks: ticks.length,
    firstTick: ticks[0],
    lastTick: ticks[ticks.length - 1],
    startPortfolioUsd: portfolio.startPortfolioUsd,
    endPortfolioUsd,
    pnlUsd,
    pnlPct: portfolio.startPortfolioUsd > 0 ? (pnlUsd / portfolio.startPortfolioUsd) * 100 : 0,
    hodlPortfolioUsd: portfolio.getHodlPortfolioUsd(),
    hodlEthUsd: portfolio.getHodlEthUsd(),
    hodlUsdcUsd: portfolio.getHodlUsdcUsd(),
    rotations,
    vetoed: portfolio.vetoed.length,
    avgFeePct,
  };
}
