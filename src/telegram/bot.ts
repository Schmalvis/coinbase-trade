import { Telegraf } from 'telegraf';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import { config } from '../config.js';
import type { TradingEngine } from '../trading/engine.js';
import type { PortfolioOptimizer } from '../trading/optimizer.js';
import type { WatchlistManager } from '../portfolio/watchlist.js';
import type { RuntimeConfig } from '../core/runtime-config.js';
import { createNotificationSystem } from './notifications.js';
import { registerTradingCommands } from './commands/trading.js';
import { registerOptimizerCommands } from './commands/optimizer.js';
import { registerAccountCommands } from './commands/account.js';

export function startTelegramBot(
  engine: TradingEngine,
  optimizer?: PortfolioOptimizer,
  watchlistManager?: WatchlistManager,
  runtimeConfig?: RuntimeConfig,
): void {
  if (!config.TELEGRAM_BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram bot disabled');
    return;
  }

  const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
  const allowed = config.TELEGRAM_ALLOWED_CHAT_IDS ?? [];

  // ── Authorisation middleware ─────────────────────────────────────────────
  bot.use((ctx, next) => {
    if (allowed.length > 0 && !allowed.includes(ctx.chat?.id as number)) {
      logger.warn(`Blocked unauthorised Telegram chat: ${ctx.chat?.id}`);
      return;
    }
    return next();
  });

  // ── Notification system ──────────────────────────────────────────────────
  const { sendFiltered, startDigestScheduler } = createNotificationSystem(bot, allowed, runtimeConfig);
  startDigestScheduler();

  // ── Command groups ───────────────────────────────────────────────────────
  registerTradingCommands(bot, { engine, runtimeConfig });
  registerOptimizerCommands(bot, { engine, optimizer, watchlistManager, runtimeConfig });
  registerAccountCommands(bot, { runtimeConfig });

  // ── Push alert notifications (filtered) ─────────────────────────────────
  botState.onAlert(async message => {
    // Alerts containing these keywords are always critical (break through quiet/digest)
    const isCritical = /FLOOR|KILL|WALLET.*CHANGED|HALT|loss limit/i.test(message);
    await sendFiltered(`🚨 *ALERT*\n${message}`, isCritical);
  });

  // ── Push trade notifications (filtered) ─────────────────────────────────
  botState.onTrade(async notification => {
    const emoji = notification.action === 'buy' ? '🟢' : '🔴';
    const dryTag = notification.dryRun ? ' [DRY RUN]' : '';
    const message =
      `${emoji} *${notification.action.toUpperCase()}${dryTag}*\n` +
      `Amount: ${notification.amountEth.toFixed(6)} ETH\n` +
      `Price: $${notification.priceUsd.toFixed(2)}\n` +
      `Reason: ${notification.reason}` +
      (notification.txHash ? `\nTx: \`${notification.txHash}\`` : '');

    // Trade notifications are never critical — they respect mode fully
    await sendFiltered(message, false);
  });

  bot.launch();
  logger.info('Telegram bot started');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
