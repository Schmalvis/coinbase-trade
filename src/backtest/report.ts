import type { BacktestResult } from './types.js';

export function printReport(result: BacktestResult): void {
  const { config, rotations } = result;
  const sign = (n: number) => n >= 0 ? '+' : '';
  const fmt = (n: number, d = 2) => n.toFixed(d);
  const fmtUsd = (n: number) => `$${Math.abs(n).toFixed(2)}`;
  const fmtPnl = (n: number) => `${sign(n)}$${Math.abs(n).toFixed(2)}`;
  const fmtPct = (n: number) => `${sign(n)}${n.toFixed(2)}%`;

  const days = Math.round(
    (new Date(result.lastTick).getTime() - new Date(result.firstTick).getTime()) / 86400_000,
  );

  console.log('');
  console.log(`Backtest: ${config.fromDate} → ${config.toDate} (${days} days) | ${config.network}`);
  console.log(`Ticks: ${result.ticks} × 15m | Symbols: ${config.symbols.join(', ')}`);
  console.log(`Params: sell<${config.sellThreshold} buy>${config.buyThreshold} delta>${config.minScoreDelta} size=${config.rotationSizePct * 100}% fee=${config.feePct * 100}%`);
  console.log('');

  const SEP = '─'.repeat(68);
  // HODL-Portfolio is the primary benchmark: "what if I held my exact starting composition?"
  // HODL-ETH is a secondary reference shown as a header note, not a table column.
  const row = (label: string, bot: string, hodlPort: string, hodlUsdc: string) =>
    ` ${label.padEnd(24)}${bot.padStart(11)}  ${hodlPort.padStart(14)}  ${hodlUsdc.padStart(11)}`;

  const hodlPnl = result.hodlPortfolioUsd - result.startPortfolioUsd;
  const hodlPct = result.startPortfolioUsd > 0 ? (hodlPnl / result.startPortfolioUsd) * 100 : 0;
  const ethPnl = result.hodlEthUsd - result.startPortfolioUsd;
  const ethPct = result.startPortfolioUsd > 0 ? (ethPnl / result.startPortfolioUsd) * 100 : 0;

  console.log(SEP);
  console.log(row('Metric', 'Bot', 'HODL-Portfolio', 'HODL-USDC'));
  console.log(SEP);

  console.log(row('Starting portfolio', fmtUsd(result.startPortfolioUsd), fmtUsd(result.startPortfolioUsd), fmtUsd(result.startPortfolioUsd)));
  console.log(row('Ending portfolio', fmtUsd(result.endPortfolioUsd), fmtUsd(result.hodlPortfolioUsd), fmtUsd(result.hodlUsdcUsd)));
  console.log(row('P&L ($)', fmtPnl(result.pnlUsd), fmtPnl(hodlPnl), '$0.00'));
  console.log(row('P&L (%)', fmtPct(result.pnlPct), fmtPct(hodlPct), '0.00%'));
  console.log(row('Rotations', String(rotations.length), '—', '—'));
  console.log(row('Vetoed', String(result.vetoed), '—', '—'));
  console.log(row('Avg fee', fmtPct(result.avgFeePct), '—', '—'));
  console.log(` HODL-ETH reference: ${fmtUsd(result.hodlEthUsd)} (${fmtPct(ethPct)}) — all starting USD converted to ETH`);
  console.log(SEP);
  console.log('');

  if (rotations.length > 0) {
    console.log('Rotation log:');
    for (const r of rotations) {
      const ts = r.tick.slice(0, 16).replace('T', ' ');
      const ok = r.portfolioUsdAfter >= r.portfolioUsdBefore ? '✓' : '✗';
      console.log(
        `  ${ok} ${ts}  ` +
        `${r.sellSymbol.padEnd(6)}→${r.buySymbol.padEnd(6)}  ` +
        `Δ=${fmt(r.scoreDelta, 1).padStart(6)}  ` +
        `sell=${fmt(r.sellScore, 1).padStart(7)}  ` +
        `buy=${fmt(r.buyScore, 1).padStart(7)}  ` +
        `size=${fmtUsd(r.sellAmountUsd)}  fee=${fmtUsd(r.feePaidUsd)}`,
      );
    }
    console.log('');
  }
}
