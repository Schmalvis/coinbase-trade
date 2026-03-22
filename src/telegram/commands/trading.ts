import type { Telegraf } from 'telegraf';
import { botState } from '../../core/state.js';
import { queries } from '../../data/db.js';
import type { TradingEngine } from '../../trading/engine.js';
import type { RuntimeConfig } from '../../core/runtime-config.js';

export interface TradingCommandCtx {
  engine: TradingEngine;
  runtimeConfig?: RuntimeConfig;
}

export function registerTradingCommands(bot: Telegraf, ctx: TradingCommandCtx): void {
  const { engine, runtimeConfig } = ctx;

  bot.command('status', tgCtx => {
    const price = botState.lastPrice ?? 0;
    const ethBalance = botState.lastBalance ?? 0;
    const usdcBalance = botState.lastUsdcBalance ?? 0;
    const portfolioUsd = (price * ethBalance + usdcBalance).toFixed(2);
    const walletDisplay = botState.walletAddress
      ? ` | Wallet: \`${botState.walletAddress.slice(0, 10)}...${botState.walletAddress.slice(-4)}\``
      : '';
    const tgMode = (runtimeConfig?.get('TELEGRAM_MODE') as string) ?? 'all';

    tgCtx.reply(
      `*Bot Status*\n` +
      `Status: ${botState.status}\n` +
      `Network: ${botState.activeNetwork}${walletDisplay}\n` +
      `ETH price: $${price.toFixed(2)}\n` +
      `ETH balance: ${ethBalance.toFixed(6)}\n` +
      `USDC balance: ${usdcBalance.toFixed(2)}\n` +
      `Portfolio: $${portfolioUsd}\n` +
      `Dry run: ${runtimeConfig?.get('DRY_RUN') ? 'yes' : 'no'}\n` +
      `Notifications: ${tgMode}`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('pause', tgCtx => {
    botState.setStatus('paused');
    queries.insertEvent.run('pause', `Paused by Telegram user ${tgCtx.from?.username}`);
    tgCtx.reply('Bot paused. No trades will execute until resumed.');
  });

  bot.command('resume', tgCtx => {
    botState.setStatus('running');
    queries.insertEvent.run('resume', `Resumed by Telegram user ${tgCtx.from?.username}`);
    tgCtx.reply('Bot resumed. Autonomous trading active.');
  });

  bot.command('trades', tgCtx => {
    const trades = queries.recentTrades.all(5) as any[];
    if (trades.length === 0) return tgCtx.reply('No trades yet.');

    const lines = trades.map(t =>
      `${t.timestamp} ${t.action.toUpperCase()} ${t.amount_eth} ETH @ $${t.price_usd}${t.dry_run ? ' [DRY]' : ''}`,
    );
    tgCtx.reply('*Recent trades:*\n' + lines.join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command('buy', async tgCtx => {
    tgCtx.reply('Executing manual BUY...');
    await engine.manualTrade('buy');
  });

  bot.command('sell', async tgCtx => {
    tgCtx.reply('Executing manual SELL...');
    await engine.manualTrade('sell');
  });

  bot.command('network', tgCtx => {
    const arg = tgCtx.message?.text?.split(' ')[1]?.trim();
    if (!arg) {
      tgCtx.reply(
        `*Network*\nActive: \`${botState.activeNetwork}\`\nAvailable: ${botState.availableNetworks.map(n => `\`${n}\``).join(', ')}`,
        { parse_mode: 'Markdown' },
      );
      return;
    }
    try {
      botState.setNetwork(arg);
      queries.insertEvent.run('network_switch', `Switched to ${arg} by Telegram user ${tgCtx.from?.username}`);
      tgCtx.reply(`Switched to \`${arg}\` — re-polling balances...`, { parse_mode: 'Markdown' });
    } catch (err: unknown) {
      tgCtx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
