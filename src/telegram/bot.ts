import { Telegraf } from 'telegraf';
import { botState } from '../core/state.js';
import { queries, settingQueries, rotationQueries, dailyPnlQueries } from '../data/db.js';
import { logger } from '../core/logger.js';
import { config } from '../config.js';
import type { TradingEngine } from '../trading/engine.js';
import type { PortfolioOptimizer } from '../trading/optimizer.js';
import type { WatchlistManager } from '../portfolio/watchlist.js';
import type { RuntimeConfig } from '../core/runtime-config.js';

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

  bot.command('status', ctx => {
    const price = botState.lastPrice ?? 0;
    const ethBalance = botState.lastBalance ?? 0;
    const usdcBalance = botState.lastUsdcBalance ?? 0;
    const portfolioUsd = (price * ethBalance + usdcBalance).toFixed(2);
    const walletDisplay = botState.walletAddress
      ? ` | Wallet: \`${botState.walletAddress.slice(0, 10)}...${botState.walletAddress.slice(-4)}\``
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
      '/network — show active network\n' +
      '/network <name> — switch network (e.g. /network base-mainnet)\n' +
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
      '/killswitch — emergency halt all trading\n' +
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
