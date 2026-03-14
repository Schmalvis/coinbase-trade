import { Telegraf } from 'telegraf';
import { botState } from '../core/state.js';
import { queries, settingQueries } from '../data/db.js';
import { logger } from '../core/logger.js';
import { config } from '../config.js';
import type { TradingEngine } from '../trading/engine.js';

export function startTelegramBot(engine: TradingEngine): void {
  if (!config.TELEGRAM_BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram bot disabled');
    return;
  }

  const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
  const allowed = config.TELEGRAM_ALLOWED_CHAT_IDS ?? [];

  const guard = (ctx: any, next: () => Promise<void>) => {
    if (allowed.length > 0 && !allowed.includes(ctx.chat?.id)) {
      logger.warn(`Blocked unauthorised Telegram chat: ${ctx.chat?.id}`);
      return;
    }
    return next();
  };

  bot.use(guard);

  bot.command('status', ctx => {
    const price = botState.lastPrice ?? 0;
    const ethBalance = botState.lastBalance ?? 0;
    const usdcBalance = botState.lastUsdcBalance ?? 0;
    const portfolioUsd = (price * ethBalance + usdcBalance).toFixed(2);
    const walletDisplay = botState.walletAddress
      ? `\nWallet: \`${botState.walletAddress.slice(0, 10)}...${botState.walletAddress.slice(-4)}\``
      : '';

    ctx.reply(
      `*Bot Status*\n` +
      `Status: ${botState.status}\n` +
      `Network: ${botState.activeNetwork}${walletDisplay}\n` +
      `ETH price: $${price.toFixed(2)}\n` +
      `ETH balance: ${ethBalance.toFixed(6)}\n` +
      `USDC balance: ${usdcBalance.toFixed(2)}\n` +
      `Portfolio: $${portfolioUsd}\n` +
      `Dry run: ${config.DRY_RUN ? 'yes' : 'no'}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('pause', ctx => {
    botState.setStatus('paused');
    queries.insertEvent.run('pause', `Paused by Telegram user ${ctx.from?.username}`);
    ctx.reply('Bot paused. No trades will execute until resumed.');
  });

  bot.command('resume', ctx => {
    botState.setStatus('running');
    queries.insertEvent.run('resume', `Resumed by Telegram user ${ctx.from?.username}`);
    ctx.reply('Bot resumed. Autonomous trading active.');
  });

  bot.command('trades', ctx => {
    const trades = queries.recentTrades.all(5) as any[];
    if (trades.length === 0) return ctx.reply('No trades yet.');

    const lines = trades.map(t =>
      `${t.timestamp} ${t.action.toUpperCase()} ${t.amount_eth} ETH @ $${t.price_usd}${t.dry_run ? ' [DRY]' : ''}`
    );
    ctx.reply('*Recent trades:*\n' + lines.join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command('buy', async ctx => {
    ctx.reply('Executing manual BUY...');
    await engine.manualTrade('buy');
  });

  bot.command('sell', async ctx => {
    ctx.reply('Executing manual SELL...');
    await engine.manualTrade('sell');
  });

  bot.command('network', ctx => {
    const arg = ctx.message?.text?.split(' ')[1]?.trim();
    if (!arg) {
      ctx.reply(
        `*Network*\nActive: \`${botState.activeNetwork}\`\nAvailable: ${botState.availableNetworks.map(n => `\`${n}\``).join(', ')}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    try {
      botState.setNetwork(arg);
      queries.insertEvent.run('network_switch', `Switched to ${arg} by Telegram user ${ctx.from?.username}`);
      ctx.reply(`Switched to \`${arg}\` — re-polling balances...`, { parse_mode: 'Markdown' });
    } catch (err: unknown) {
      ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command('resetwallet', ctx => {
    settingQueries.upsertSetting.run('EXPECTED_WALLET_ADDRESS', '');
    botState.setWalletAddress(null);
    queries.insertEvent.run('wallet_reset', `Expected wallet address cleared by Telegram user ${ctx.from?.username}`);
    ctx.reply('Expected wallet address cleared. Bot will re-establish on next poll.');
  });

  bot.command('help', ctx => {
    ctx.reply(
      '/status — portfolio + bot status\n' +
      '/network — show active network\n' +
      '/network <name> — switch network (e.g. /network base-mainnet)\n' +
      '/pause — pause autonomous trading\n' +
      '/resume — resume autonomous trading\n' +
      '/trades — last 5 trades\n' +
      '/buy — manual buy\n' +
      '/sell — manual sell\n' +
      '/resetwallet — clear expected wallet (use after deliberate wallet change)'
    );
  });

  // Push alert notifications
  botState.onAlert(async message => {
    for (const chatId of allowed) {
      await bot.telegram.sendMessage(
        chatId,
        `🚨 *ALERT*\n${message}`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // Push trade notifications
  botState.onTrade(async notification => {
    for (const chatId of allowed) {
      const emoji = notification.action === 'buy' ? '🟢' : '🔴';
      const dryTag = notification.dryRun ? ' [DRY RUN]' : '';
      await bot.telegram.sendMessage(
        chatId,
        `${emoji} *${notification.action.toUpperCase()}${dryTag}*\n` +
        `Amount: ${notification.amountEth.toFixed(6)} ETH\n` +
        `Price: $${notification.priceUsd.toFixed(2)}\n` +
        `Reason: ${notification.reason}` +
        (notification.txHash ? `\nTx: \`${notification.txHash}\`` : ''),
        { parse_mode: 'Markdown' }
      );
    }
  });

  bot.launch();
  logger.info('Telegram bot started');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
