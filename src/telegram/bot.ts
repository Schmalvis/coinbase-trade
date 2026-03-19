import { Telegraf } from 'telegraf';
import { botState } from '../core/state.js';
import { queries, settingQueries, rotationQueries, dailyPnlQueries, portfolioSnapshotQueries } from '../data/db.js';
import { logger } from '../core/logger.js';
import { config } from '../config.js';
import type { TradingEngine } from '../trading/engine.js';
import type { PortfolioOptimizer } from '../trading/optimizer.js';
import type { WatchlistManager } from '../portfolio/watchlist.js';
import type { RuntimeConfig } from '../core/runtime-config.js';

// ── Notification filtering helpers ──────────────────────────────────────────

type TelegramMode = 'all' | 'important_only' | 'digest' | 'off';

/** Check if current UTC time is within the quiet window */
function isQuietHours(rc: RuntimeConfig | undefined): boolean {
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
function shouldSendNow(
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

// ── Digest queue ────────────────────────────────────────────────────────────

const digestQueue: string[] = [];

function queueForDigest(message: string): void {
  digestQueue.push(message);
  // Cap at 100 to prevent unbounded growth
  if (digestQueue.length > 100) digestQueue.shift();
}

function flushDigest(): string | null {
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
  const portfolioUsd = todayPnl?.current_usd ?? (botState.lastBalance ?? 0) * (botState.lastPrice ?? 0);
  const highWater = todayPnl?.high_water ?? portfolioUsd;
  const dayChange = portfolioUsd - highWater;
  const dayChangePct = highWater > 0 ? (dayChange / highWater) * 100 : 0;
  const realizedPnl = todayPnl?.realized_pnl ?? 0;

  const timeStr = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;

  let lines: string[] = [];
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

  const guard = (ctx: any, next: () => Promise<void>) => {
    if (allowed.length > 0 && !allowed.includes(ctx.chat?.id)) {
      logger.warn(`Blocked unauthorised Telegram chat: ${ctx.chat?.id}`);
      return;
    }
    return next();
  };

  bot.use(guard);

  // ── Helper to send with mode filtering ──────────────────────────────────

  async function sendFiltered(message: string, isCritical: boolean, parseMode: 'Markdown' | undefined = 'Markdown'): Promise<void> {
    if (shouldSendNow(runtimeConfig, isCritical)) {
      for (const chatId of allowed) {
        await bot.telegram.sendMessage(chatId, message, parseMode ? { parse_mode: parseMode } : {}).catch(err =>
          logger.warn(`Telegram send error: ${err}`),
        );
      }
    } else {
      const mode = (runtimeConfig?.get('TELEGRAM_MODE') as TelegramMode) ?? 'all';
      if (mode === 'digest' || mode === 'important_only') {
        queueForDigest(message.replace(/[*_`]/g, '')); // strip markdown for digest
      }
    }
  }

  // ── Digest scheduler ────────────────────────────────────────────────────

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
          bot.telegram.sendMessage(chatId, summary, { parse_mode: 'Markdown' }).catch(err =>
            logger.warn(`Digest send error: ${err}`),
          );
        }
      }
    }
  }, 60_000); // check every minute

  // ── Commands ────────────────────────────────────────────────────────────

  bot.command('status', ctx => {
    const price = botState.lastPrice ?? 0;
    const ethBalance = botState.lastBalance ?? 0;
    const usdcBalance = botState.lastUsdcBalance ?? 0;
    const portfolioUsd = (price * ethBalance + usdcBalance).toFixed(2);
    const walletDisplay = botState.walletAddress
      ? ` | Wallet: \`${botState.walletAddress.slice(0, 10)}...${botState.walletAddress.slice(-4)}\``
      : '';
    const tgMode = (runtimeConfig?.get('TELEGRAM_MODE') as string) ?? 'all';

    ctx.reply(
      `*Bot Status*\n` +
      `Status: ${botState.status}\n` +
      `Network: ${botState.activeNetwork}${walletDisplay}\n` +
      `ETH price: $${price.toFixed(2)}\n` +
      `ETH balance: ${ethBalance.toFixed(6)}\n` +
      `USDC balance: ${usdcBalance.toFixed(2)}\n` +
      `Portfolio: $${portfolioUsd}\n` +
      `Dry run: ${runtimeConfig?.get('DRY_RUN') ? 'yes' : 'no'}\n` +
      `Notifications: ${tgMode}`,
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

  bot.command('scores', ctx => {
    const scores = optimizer?.getLatestScores() ?? [];
    if (scores.length === 0) return ctx.reply('No scores available yet.');
    const lines = scores
      .sort((a, b) => b.score - a.score)
      .map(s => {
        const dir15 = s.signals.candle15m.signal;
        const dir1h = s.signals.candle1h.signal;
        const dir24h = s.signals.candle24h.signal;
        const sign = s.score >= 0 ? '+' : '';
        return `${s.symbol}: ${sign}${s.score.toFixed(0)} (15m:${dir15} 1h:${dir1h} 24h:${dir24h})`;
      });
    ctx.reply(`📊 Opportunity Scores\n${lines.join('\n')}`);
  });

  bot.command('rotations', ctx => {
    const rows = rotationQueries.getRecentRotations.all(botState.activeNetwork, 5) as any[];
    if (rows.length === 0) return ctx.reply('No rotations yet.');
    const lines = rows.map(r => {
      const gain = r.actual_gain_pct != null ? `${r.actual_gain_pct.toFixed(1)}%` : `~${r.estimated_gain_pct.toFixed(1)}%`;
      return `${r.sell_symbol} → ${r.buy_symbol}: ${gain} (${r.status}, ${r.timestamp.slice(11, 16)})`;
    });
    ctx.reply(`🔄 Recent Rotations\n${lines.join('\n')}`);
  });

  bot.command('watchlist', ctx => {
    const items = watchlistManager?.getAll(botState.activeNetwork) ?? [];
    if (items.length === 0) return ctx.reply('Watchlist is empty.');
    const lines = items.map(i => `${i.symbol}${i.address ? '' : ' (no address)'} — ${i.source}`);
    ctx.reply(`👁 Watchlist\n${lines.join('\n')}`);
  });

  bot.command('watch', ctx => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const symbol = parts[0]?.toUpperCase();
    const address = parts[1];
    if (!symbol) return ctx.reply('Usage: /watch SYMBOL [address]');
    watchlistManager?.add(symbol, botState.activeNetwork, address);
    ctx.reply(`Added ${symbol} to watchlist.`);
  });

  bot.command('unwatch', ctx => {
    const symbol = ctx.message.text.split(/\s+/)[1]?.toUpperCase();
    if (!symbol) return ctx.reply('Usage: /unwatch SYMBOL');
    watchlistManager?.remove(symbol, botState.activeNetwork);
    ctx.reply(`Removed ${symbol} from watchlist.`);
  });

  bot.command('risk', ctx => {
    const network = botState.activeNetwork;
    const pnl = dailyPnlQueries.getTodayPnl.get(network) as any;
    const rotCount = (rotationQueries.getTodayRotationCount.get(network) as any)?.cnt ?? 0;
    const maxRot = runtimeConfig?.get('MAX_DAILY_ROTATIONS') ?? '?';
    const maxLoss = runtimeConfig?.get('MAX_DAILY_LOSS_PCT') ?? '?';
    const floor = runtimeConfig?.get('PORTFOLIO_FLOOR_USD') ?? '?';
    const mode = optimizer?.isRiskOff ? 'risk-off' : 'normal';

    let lossPct = 0;
    if (pnl?.high_water && pnl.current_usd) {
      lossPct = ((pnl.high_water - pnl.current_usd) / pnl.high_water) * 100;
    }

    ctx.reply(`🛡️ Risk Status
Daily P&L: ${lossPct > 0 ? '-' : '+'}${Math.abs(lossPct).toFixed(1)}% (limit: -${maxLoss}%)
Rotations: ${rotCount}/${maxRot}
Portfolio: $${pnl?.current_usd?.toFixed(2) ?? '?'} (floor: $${floor})
Optimizer: ${engine.optimizerEnabled ? 'active' : 'disabled'} (${mode})`);
  });

  // ── /pnl — Performance summary ──────────────────────────────────────────

  bot.command('pnl', ctx => {
    const network = botState.activeNetwork;
    const todayPnl = dailyPnlQueries.getTodayPnl.get(network) as any;
    const currentUsd = todayPnl?.current_usd ?? 0;
    const todayHighWater = todayPnl?.high_water ?? currentUsd;
    const todayChange = todayHighWater > 0 ? currentUsd - todayHighWater : 0;
    const todayChangePct = todayHighWater > 0 ? (todayChange / todayHighWater) * 100 : 0;

    // 7-day and 30-day
    const dailyRows = dailyPnlQueries.getRecentDailyPnl.all(network, 30) as any[];
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const rows7d = dailyRows.filter((d: any) => d.date >= sevenDaysAgo);
    const startValue7d = rows7d.length > 0 ? rows7d[rows7d.length - 1].current_usd : currentUsd;
    const change7d = currentUsd - startValue7d;
    const change7dPct = startValue7d > 0 ? (change7d / startValue7d) * 100 : 0;

    const startValue30d = dailyRows.length > 0 ? dailyRows[dailyRows.length - 1].current_usd : currentUsd;
    const change30d = currentUsd - startValue30d;
    const change30dPct = startValue30d > 0 ? (change30d / startValue30d) * 100 : 0;

    // Total since first portfolio snapshot
    const snapshots = portfolioSnapshotQueries.getRecentSnapshots.all(999999) as any[];
    const firstSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
    const totalChange = firstSnapshot ? currentUsd - firstSnapshot.portfolio_usd : 0;
    const totalChangePct = firstSnapshot && firstSnapshot.portfolio_usd > 0
      ? (totalChange / firstSnapshot.portfolio_usd) * 100 : 0;
    const sinceDate = firstSnapshot?.timestamp?.slice(0, 10) ?? 'N/A';

    // Today's rotation stats
    const rotCount = (rotationQueries.getTodayRotationCount.get(network) as any)?.cnt ?? 0;
    const recentRotations = rotationQueries.getRecentRotations.all(network, 10) as any[];
    const profitable = recentRotations.filter((r: any) => r.status === 'executed' && (r.actual_gain_pct ?? r.estimated_gain_pct) > 0).length;

    ctx.reply(
      `📊 *Performance*\n` +
      `Today: ${todayChange >= 0 ? '+' : ''}$${Math.abs(todayChange).toFixed(2)} (${todayChangePct >= 0 ? '+' : ''}${todayChangePct.toFixed(1)}%)\n` +
      `7-day: ${change7d >= 0 ? '+' : ''}$${Math.abs(change7d).toFixed(2)} (${change7dPct >= 0 ? '+' : ''}${change7dPct.toFixed(1)}%)\n` +
      `30-day: ${change30d >= 0 ? '+' : ''}$${Math.abs(change30d).toFixed(2)} (${change30dPct >= 0 ? '+' : ''}${change30dPct.toFixed(1)}%)\n` +
      `Total: ${totalChange >= 0 ? '+' : ''}$${Math.abs(totalChange).toFixed(2)} (${totalChangePct >= 0 ? '+' : ''}${totalChangePct.toFixed(1)}%) since ${sinceDate}\n` +
      `Rotations today: ${rotCount} (${profitable} profitable of last 10)`,
      { parse_mode: 'Markdown' },
    );
  });

  // ── /notify — Change notification mode ──────────────────────────────────

  bot.command('notify', ctx => {
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    const validModes = ['all', 'important_only', 'digest', 'off'];

    if (!arg || !validModes.includes(arg)) {
      const current = (runtimeConfig?.get('TELEGRAM_MODE') as string) ?? 'all';
      ctx.reply(
        `*Notification mode:* ${current}\n` +
        `Usage: /notify <mode>\n` +
        `Modes: all | important\\_only | digest | off`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    runtimeConfig?.set('TELEGRAM_MODE', arg);
    ctx.reply(`Notification mode set to: ${arg}`);
  });

  bot.command('killswitch', ctx => {
    botState.setStatus('paused');
    engine.disableOptimizer();
    botState.emitAlert('KILL SWITCH activated via Telegram');
    queries.insertEvent.run('killswitch', `Activated by ${ctx.from?.username ?? ctx.from?.id}`);
    ctx.reply('🚨 All trading halted. Optimizer disabled. Use /resume to restart.');
  });

  bot.command('optimizer', ctx => {
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    if (arg === 'on') {
      engine.enableOptimizer();
      ctx.reply('✅ Optimizer enabled.');
    } else if (arg === 'off') {
      engine.disableOptimizer();
      ctx.reply('⏸ Optimizer disabled.');
    } else {
      ctx.reply(`Optimizer is ${engine.optimizerEnabled ? 'enabled' : 'disabled'}. Use /optimizer on or /optimizer off`);
    }
  });

  bot.command('help', ctx => {
    ctx.reply(
      '/status — portfolio + bot status\n' +
      '/pnl — performance summary (today/7d/30d/total)\n' +
      '/network — show active network\n' +
      '/network <name> — switch network\n' +
      '/pause — pause autonomous trading\n' +
      '/resume — resume autonomous trading\n' +
      '/trades — last 5 trades\n' +
      '/buy — manual buy\n' +
      '/sell — manual sell\n' +
      '/scores — show opportunity scores\n' +
      '/rotations — last 5 rotations\n' +
      '/watchlist — show watchlist\n' +
      '/watch <symbol> [address] — add to watchlist\n' +
      '/unwatch <symbol> — remove from watchlist\n' +
      '/risk — show risk status\n' +
      '/optimizer on|off — toggle optimizer\n' +
      '/notify <mode> — set notification mode (all/important_only/digest/off)\n' +
      '/killswitch — emergency halt all trading\n' +
      '/resetwallet — clear expected wallet'
    );
  });

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
    const message = `${emoji} *${notification.action.toUpperCase()}${dryTag}*\n` +
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
