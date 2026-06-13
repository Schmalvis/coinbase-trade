import { program } from 'commander';
import { resolve, join } from 'path';
import { runBacktest } from './runner.js';
import { printReport } from './report.js';

// Default DB path mirrors the DATA_DIR convention used in the bot
const defaultDb = join(
  process.env.DATA_DIR ?? `${process.env.HOME}/.local/share/coinbase-trade/base-mainnet`,
  'trades.db',
);

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

program
  .name('backtest')
  .description('Replay CandleStrategy scoring against historical SQLite candle data')
  .option('--from <date>',          'Start date YYYY-MM-DD', daysAgo(30))
  .option('--to <date>',            'End date YYYY-MM-DD (inclusive)', daysAgo(0))
  .option('--network <name>',       'Network ID', 'base-mainnet')
  .option('--db <path>',            'Path to trades.db', defaultDb)
  .option('--symbols <list>',       'Comma-separated symbols', 'ETH,CBBTC,CBETH,USDC')
  .option('--fee <pct>',            'Fee as decimal (0.01 = 1%)', '0.01')
  .option('--rotation-size <pct>',  'Fraction of held asset to sell (0.25 = 25%)', '0.25')
  .option('--sell-threshold <n>',   'Score below which held asset is sell candidate', '-20')
  .option('--buy-threshold <n>',    'Score above which asset is buy candidate', '30')
  .option('--delta <n>',            'Min score delta to trigger rotation', '40')
  .option('--max-rotations <n>',    'Max rotations per day', '10')
  .option('--json',                 'Emit JSON result to stdout (no formatted table)')
  .action(async (opts) => {
    const config = {
      network: opts.network as string,
      fromDate: opts.from as string,
      toDate: opts.to as string,
      dbPath: resolve(opts.db as string),
      symbols: (opts.symbols as string).split(',').map(s => s.trim()),
      feePct: parseFloat(opts.fee),
      rotationSizePct: parseFloat(opts.rotationSize),
      sellThreshold: parseInt(opts.sellThreshold),
      buyThreshold: parseInt(opts.buyThreshold),
      minScoreDelta: parseInt(opts.delta),
      maxDailyRotations: parseInt(opts.maxRotations),
      pairCooldownMs: 4 * 60 * 60 * 1000,
      initialBalances: new Map<string, number>(),
      initialPrices: new Map<string, number>(),
    };

    try {
      const result = await runBacktest(config);

      if (opts.json) {
        console.log(JSON.stringify({
          ...result,
          config: {
            ...result.config,
            initialBalances: Object.fromEntries(result.config.initialBalances),
            initialPrices: Object.fromEntries(result.config.initialPrices),
          },
        }, null, 2));
      } else {
        printReport(result);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
