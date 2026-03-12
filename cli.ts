#!/usr/bin/env tsx
import { Command } from 'commander';

const BASE_URL = process.env.BOT_URL ?? 'http://localhost:8080';

async function api(path: string, method = 'GET') {
  const res = await fetch(BASE_URL + path, { method });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const program = new Command()
  .name('trade-cli')
  .description('Coinbase trade bot CLI')
  .version('0.1.0');

program.command('status')
  .description('Show bot status')
  .action(async () => {
    const s = await api('/api/status');
    console.log(`Status:    ${s.status}${s.dryRun ? ' [DRY RUN]' : ''}`);
    console.log(`Strategy:  ${s.strategy}`);
    console.log(`ETH price: $${s.lastPrice?.toFixed(2) ?? 'unknown'}`);
    console.log(`Balance:   ${s.lastBalance?.toFixed(6) ?? 'unknown'} ETH`);
    console.log(`Portfolio: $${s.portfolioUsd?.toFixed(2) ?? 'unknown'}`);
    console.log(`Last trade: ${s.lastTradeAt ?? 'none'}`);
  });

program.command('pause')
  .description('Pause autonomous trading')
  .action(async () => {
    await api('/api/control/pause', 'POST');
    console.log('Bot paused.');
  });

program.command('resume')
  .description('Resume autonomous trading')
  .action(async () => {
    await api('/api/control/resume', 'POST');
    console.log('Bot resumed.');
  });

program.command('trades')
  .description('Show recent trades')
  .option('-n, --limit <n>', 'Number of trades', '10')
  .action(async opts => {
    const trades = await api(`/api/trades?limit=${opts.limit}`);
    if (trades.length === 0) return console.log('No trades yet.');
    for (const t of trades) {
      const dry = t.dry_run ? ' [DRY]' : '';
      console.log(`${t.timestamp}  ${t.action.toUpperCase()}${dry}  ${parseFloat(t.amount_eth).toFixed(6)} ETH @ $${parseFloat(t.price_usd).toFixed(2)}  ${t.reason ?? ''}`);
    }
  });

program.parseAsync();
