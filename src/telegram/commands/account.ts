import type { Telegraf } from 'telegraf';
import { botState } from '../../core/state.js';
import { queries, settingQueries, rotationQueries, dailyPnlQueries, portfolioSnapshotQueries } from '../../data/db.js';
import type { RuntimeConfig } from '../../core/runtime-config.js';

export interface AccountCommandCtx {
  runtimeConfig?: RuntimeConfig;
}

export function registerAccountCommands(bot: Telegraf, ctx: AccountCommandCtx): void {
  const { runtimeConfig } = ctx;

  bot.command('resetwallet', tgCtx => {
    settingQueries.upsertSetting.run('EXPECTED_WALLET_ADDRESS', '');
    botState.setWalletAddress(null);
    queries.insertEvent.run('wallet_reset', `Expected wallet address cleared by Telegram user ${tgCtx.from?.username}`);
    tgCtx.reply('Expected wallet address cleared. Bot will re-establish on next poll.');
  });

  bot.command('pnl', tgCtx => {
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
    const profitable = recentRotations.filter(
      (r: any) => r.status === 'executed' && (r.actual_gain_pct ?? r.estimated_gain_pct) > 0,
    ).length;

    tgCtx.reply(
      `📊 *Performance*\n` +
      `Today: ${todayChange >= 0 ? '+' : ''}$${Math.abs(todayChange).toFixed(2)} (${todayChangePct >= 0 ? '+' : ''}${todayChangePct.toFixed(1)}%)\n` +
      `7-day: ${change7d >= 0 ? '+' : ''}$${Math.abs(change7d).toFixed(2)} (${change7dPct >= 0 ? '+' : ''}${change7dPct.toFixed(1)}%)\n` +
      `30-day: ${change30d >= 0 ? '+' : ''}$${Math.abs(change30d).toFixed(2)} (${change30dPct >= 0 ? '+' : ''}${change30dPct.toFixed(1)}%)\n` +
      `Total: ${totalChange >= 0 ? '+' : ''}$${Math.abs(totalChange).toFixed(2)} (${totalChangePct >= 0 ? '+' : ''}${totalChangePct.toFixed(1)}%) since ${sinceDate}\n` +
      `Rotations today: ${rotCount} (${profitable} profitable of last 10)`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('notify', tgCtx => {
    const arg = tgCtx.message.text.split(/\s+/)[1]?.toLowerCase();
    const validModes = ['all', 'important_only', 'digest', 'off'];

    if (!arg || !validModes.includes(arg)) {
      const current = (runtimeConfig?.get('TELEGRAM_MODE') as string) ?? 'all';
      tgCtx.reply(
        `*Notification mode:* ${current}\n` +
        `Usage: /notify <mode>\n` +
        `Modes: all | important\\_only | digest | off`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    runtimeConfig?.set('TELEGRAM_MODE', arg);
    tgCtx.reply(`Notification mode set to: ${arg}`);
  });

  bot.command('help', tgCtx => {
    tgCtx.reply(
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
      '/resetwallet — clear expected wallet',
    );
  });
}
