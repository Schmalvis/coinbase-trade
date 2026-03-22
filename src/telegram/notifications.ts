import type { Telegraf } from 'telegraf';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import { rotationQueries, dailyPnlQueries } from '../data/db.js';
import type { RuntimeConfig } from '../core/runtime-config.js';

export type TelegramMode = 'all' | 'important_only' | 'digest' | 'off';

/** Check if current UTC time is within the quiet window */
export function isQuietHours(rc: RuntimeConfig | undefined): boolean {
  if (!rc) return false;
  const start = rc.get('TELEGRAM_QUIET_START') as string;
  const end = rc.get('TELEGRAM_QUIET_END') as string;
  if (!start || !end) return false;

  const now = new Date();
  const hhmm = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;

  // Handle overnight windows (e.g. 22:00 → 07:00)
  if (startMin <= endMin) {
    return hhmm >= startMin && hhmm < endMin;
  }
  return hhmm >= startMin || hhmm < endMin;
}

/** Whether a message should be sent immediately based on mode + importance */
export function shouldSendNow(
  rc: RuntimeConfig | undefined,
  isCritical: boolean,
): boolean {
  if (!rc) return true;
  const mode = (rc.get('TELEGRAM_MODE') as TelegramMode) ?? 'all';

  if (mode === 'off') return false;
  if (mode === 'all') {
    // In quiet hours, only critical alerts break through
    if (isQuietHours(rc)) return isCritical;
    return true;
  }
  if (mode === 'important_only') return isCritical;
  if (mode === 'digest') return isCritical; // non-critical queued for digest
  return true;
}

// ── Digest queue ─────────────────────────────────────────────────────────────

const digestQueue: string[] = [];

export function queueForDigest(message: string): void {
  digestQueue.push(message);
  // Cap at 100 to prevent unbounded growth
  if (digestQueue.length > 100) digestQueue.shift();
}

export function flushDigest(): string | null {
  if (digestQueue.length === 0) return null;
  const eventCount = digestQueue.length;
  digestQueue.length = 0;

  // Build natural language summary from DB data
  const network = botState.activeNetwork;
  const now = new Date();
  const todayPnl = dailyPnlQueries.getTodayPnl.get(network);
  const recentRotations = rotationQueries.getRecentRotations.all(network, 50) as Array<{
    sell_symbol: string; buy_symbol: string; status: string;
    actual_gain_pct: number | null; timestamp: string;
  }>;

  // Filter to today's rotations
  const todayStr = now.toISOString().slice(0, 10);
  const todayRotations = recentRotations.filter(r => r.timestamp?.startsWith(todayStr));
  const executed = todayRotations.filter(r => r.status === 'executed');
  const failed = todayRotations.filter(r => r.status === 'failed' || r.status === 'vetoed');

  // Summarise buys and sells
  const bought = new Map<string, number>();
  const sold = new Map<string, number>();
  for (const r of executed) {
    sold.set(r.sell_symbol, (sold.get(r.sell_symbol) ?? 0) + 1);
    bought.set(r.buy_symbol, (bought.get(r.buy_symbol) ?? 0) + 1);
  }
  const boughtStr = [...bought.entries()].map(([s, n]) => `${n}x ${s}`).join(', ') || 'none';
  const soldStr = [...sold.entries()].map(([s, n]) => `${n}x ${s}`).join(', ') || 'none';

  // Portfolio value and P&L
  const portfolioUsd = (todayPnl as any)?.current_usd ?? (botState.lastBalance ?? 0) * (botState.lastPrice ?? 0);
  const highWater = (todayPnl as any)?.high_water ?? portfolioUsd;
  const dayChange = portfolioUsd - highWater;
  const dayChangePct = highWater > 0 ? (dayChange / highWater) * 100 : 0;
  const realizedPnl = (todayPnl as any)?.realized_pnl ?? 0;

  const timeStr = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;

  const lines: string[] = [];
  lines.push(`📋 *Trading Summary*`);
  lines.push('');

  if (executed.length === 0 && failed.length === 0) {
    lines.push(`No trades were executed since the last digest.`);
  } else {
    const tradeWord = executed.length === 1 ? 'trade was' : 'trades were';
    lines.push(`${executed.length} ${tradeWord} executed today, purchasing ${boughtStr} and selling ${soldStr}.`);
    if (failed.length > 0) {
      lines.push(`${failed.length} rotation${failed.length > 1 ? 's were' : ' was'} vetoed or failed.`);
    }
  }

  lines.push('');
  const arrow = dayChange >= 0 ? '📈' : '📉';
  const sign = dayChange >= 0 ? '+' : '';
  lines.push(`${arrow} Portfolio is at *$${portfolioUsd.toFixed(2)}* as of ${timeStr}.`);
  lines.push(`Today's P\\&L: *${sign}$${dayChange.toFixed(2)}* (${sign}${dayChangePct.toFixed(1)}%)`);
  if (realizedPnl !== 0) {
    const rSign = realizedPnl >= 0 ? '+' : '';
    lines.push(`Realized from trades: *${rSign}$${realizedPnl.toFixed(2)}*`);
  }

  lines.push('');
  lines.push(`_${eventCount} event${eventCount > 1 ? 's' : ''} since last digest_`);

  return lines.join('\n');
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createNotificationSystem(
  bot: Telegraf,
  allowed: number[],
  runtimeConfig: RuntimeConfig | undefined,
) {
  async function sendFiltered(
    message: string,
    isCritical: boolean,
    parseMode: 'Markdown' | undefined = 'Markdown',
  ): Promise<void> {
    if (shouldSendNow(runtimeConfig, isCritical)) {
      for (const chatId of allowed) {
        await bot.telegram
          .sendMessage(chatId, message, parseMode ? { parse_mode: parseMode } : {})
          .catch(err => logger.warn(`Telegram send error: ${err}`));
      }
    } else {
      const mode = (runtimeConfig?.get('TELEGRAM_MODE') as TelegramMode) ?? 'all';
      if (mode === 'digest' || mode === 'important_only') {
        queueForDigest(message.replace(/[*_`]/g, '')); // strip markdown for digest
      }
    }
  }

  function startDigestScheduler(): void {
    setInterval(() => {
      const mode = (runtimeConfig?.get('TELEGRAM_MODE') as TelegramMode) ?? 'all';
      if (mode !== 'digest') return;

      const digestTimes = (runtimeConfig?.get('TELEGRAM_DIGEST_TIMES') as string) ?? '08:00,20:00';
      const now = new Date();
      const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

      // Check if current minute matches any digest time
      if (digestTimes.split(',').includes(hhmm)) {
        const summary = flushDigest();
        if (summary) {
          for (const chatId of allowed) {
            bot.telegram
              .sendMessage(chatId, summary, { parse_mode: 'Markdown' })
              .catch(err => logger.warn(`Digest send error: ${err}`));
          }
        }
      }
    }, 60_000); // check every minute
  }

  return { sendFiltered, startDigestScheduler };
}
