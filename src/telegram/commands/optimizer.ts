import type { Telegraf } from 'telegraf';
import { botState } from '../../core/state.js';
import { queries, rotationQueries, dailyPnlQueries } from '../../data/db.js';
import type { TradingEngine } from '../../trading/engine.js';
import type { PortfolioOptimizer } from '../../trading/optimizer.js';
import type { WatchlistManager } from '../../portfolio/watchlist.js';
import type { RuntimeConfig } from '../../core/runtime-config.js';

export interface OptimizerCommandCtx {
  engine: TradingEngine;
  optimizer?: PortfolioOptimizer;
  watchlistManager?: WatchlistManager;
  runtimeConfig?: RuntimeConfig;
}

export function registerOptimizerCommands(bot: Telegraf, ctx: OptimizerCommandCtx): void {
  const { engine, optimizer, watchlistManager, runtimeConfig } = ctx;

  bot.command('scores', tgCtx => {
    const scores = optimizer?.getLatestScores() ?? [];
    if (scores.length === 0) return tgCtx.reply('No scores available yet.');
    const lines = scores
      .sort((a, b) => b.score - a.score)
      .map(s => {
        const dir15 = s.signals.candle15m.signal;
        const dir1h = s.signals.candle1h.signal;
        const dir24h = s.signals.candle24h.signal;
        const sign = s.score >= 0 ? '+' : '';
        return `${s.symbol}: ${sign}${s.score.toFixed(0)} (15m:${dir15} 1h:${dir1h} 24h:${dir24h})`;
      });
    tgCtx.reply(`📊 Opportunity Scores\n${lines.join('\n')}`);
  });

  bot.command('rotations', tgCtx => {
    const rows = rotationQueries.getRecentRotations.all(botState.activeNetwork, 5) as any[];
    if (rows.length === 0) return tgCtx.reply('No rotations yet.');
    const lines = rows.map(r => {
      const gain = r.actual_gain_pct != null
        ? `${r.actual_gain_pct.toFixed(1)}%`
        : `~${r.estimated_gain_pct.toFixed(1)}%`;
      return `${r.sell_symbol} → ${r.buy_symbol}: ${gain} (${r.status}, ${r.timestamp.slice(11, 16)})`;
    });
    tgCtx.reply(`🔄 Recent Rotations\n${lines.join('\n')}`);
  });

  bot.command('watchlist', tgCtx => {
    const items = watchlistManager?.getAll(botState.activeNetwork) ?? [];
    if (items.length === 0) return tgCtx.reply('Watchlist is empty.');
    const lines = items.map(i => `${i.symbol}${i.address ? '' : ' (no address)'} — ${i.source}`);
    tgCtx.reply(`👁 Watchlist\n${lines.join('\n')}`);
  });

  bot.command('watch', tgCtx => {
    const parts = tgCtx.message.text.split(/\s+/).slice(1);
    const symbol = parts[0]?.toUpperCase();
    const address = parts[1];
    if (!symbol) return tgCtx.reply('Usage: /watch SYMBOL [address]');
    watchlistManager?.add(symbol, botState.activeNetwork, address);
    tgCtx.reply(`Added ${symbol} to watchlist.`);
  });

  bot.command('unwatch', tgCtx => {
    const symbol = tgCtx.message.text.split(/\s+/)[1]?.toUpperCase();
    if (!symbol) return tgCtx.reply('Usage: /unwatch SYMBOL');
    watchlistManager?.remove(symbol, botState.activeNetwork);
    tgCtx.reply(`Removed ${symbol} from watchlist.`);
  });

  bot.command('risk', tgCtx => {
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

    tgCtx.reply(`🛡️ Risk Status
Daily P&L: ${lossPct > 0 ? '-' : '+'}${Math.abs(lossPct).toFixed(1)}% (limit: -${maxLoss}%)
Rotations: ${rotCount}/${maxRot}
Portfolio: $${pnl?.current_usd?.toFixed(2) ?? '?'} (floor: $${floor})
Optimizer: ${engine.optimizerEnabled ? 'active' : 'disabled'} (${mode})`);
  });

  bot.command('killswitch', tgCtx => {
    botState.setStatus('paused');
    engine.disableOptimizer();
    botState.emitAlert('KILL SWITCH activated via Telegram');
    queries.insertEvent.run('killswitch', `Activated by ${tgCtx.from?.username ?? tgCtx.from?.id}`);
    tgCtx.reply('🚨 All trading halted. Optimizer disabled. Use /resume to restart.');
  });

  bot.command('optimizer', tgCtx => {
    const arg = tgCtx.message.text.split(/\s+/)[1]?.toLowerCase();
    if (arg === 'on') {
      engine.enableOptimizer();
      tgCtx.reply('✅ Optimizer enabled.');
    } else if (arg === 'off') {
      engine.disableOptimizer();
      tgCtx.reply('⏸ Optimizer disabled.');
    } else {
      tgCtx.reply(`Optimizer is ${engine.optimizerEnabled ? 'enabled' : 'disabled'}. Use /optimizer on or /optimizer off`);
    }
  });
}
