import { Router } from 'express';
import { botState } from '../../core/state.js';
import { queries, dailyPnlQueries, rotationQueries, portfolioSnapshotQueries } from '../../data/db.js';
import type { RouteContext } from '../route-context.js';

export function registerPerformanceRoutes(router: Router, _ctx: RouteContext): void {
  router.get('/api/prices', (req, res) => {
    const limit  = parseInt((req.query.limit as string) ?? '288', 10);
    const symbol = (req.query.asset as string | undefined)?.toUpperCase();
    if (symbol) {
      res.json(queries.recentAssetSnapshots.all(symbol, limit));
      return;
    }
    res.json(queries.recentSnapshots.all(limit));
  });

  router.get('/api/portfolio', (req, res) => {
    const limit = parseInt((req.query.limit as string) ?? '288', 10);
    res.json(queries.recentPortfolioSnapshots.all(limit));
  });

  router.get('/api/trades', (req, res) => {
    const limit = parseInt((req.query.limit as string) ?? '20', 10);
    res.json(queries.recentTrades.all(limit));
  });

  router.get('/api/performance', (req, res) => {
    const network = botState.activeNetwork;
    const days = parseInt(String(req.query.days ?? '30'));

    // Portfolio value history (for chart)
    const snapshots = portfolioSnapshotQueries.getRecentSnapshots.all(days * 24 * 60); // ~1 per minute
    // Thin to ~1 per hour for response size
    const thinned: Array<{ timestamp: string; portfolio_usd: number }> = [];
    let lastHour = '';
    for (const s of snapshots.reverse()) {
      const hour = s.timestamp.slice(0, 13);
      if (hour !== lastHour) {
        thinned.push({ timestamp: s.timestamp, portfolio_usd: s.portfolio_usd });
        lastHour = hour;
      }
    }

    // Daily P&L history
    const dailyPnl = dailyPnlQueries.getRecentDailyPnl.all(network, days) as Array<{
      date: string; high_water: number; current_usd: number; rotations: number; realized_pnl: number;
    }>;

    // Compute aggregated metrics
    const todayPnl = dailyPnlQueries.getTodayPnl.get(network) as any;
    const currentUsd = todayPnl?.current_usd ?? 0;
    const todayHighWater = todayPnl?.high_water ?? currentUsd;
    const todayChange = todayHighWater > 0 ? currentUsd - todayHighWater : 0;
    const todayChangePct = todayHighWater > 0 ? (todayChange / todayHighWater) * 100 : 0;

    // 7-day and 30-day P&L from daily snapshots
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);

    const oldest7d = dailyPnl.filter(d => d.date >= sevenDaysAgo);
    const oldest30d = dailyPnl.filter(d => d.date >= thirtyDaysAgo);

    const startValue7d = oldest7d.length > 0 ? oldest7d[oldest7d.length - 1].current_usd : currentUsd;
    const startValue30d = oldest30d.length > 0 ? oldest30d[oldest30d.length - 1].current_usd : currentUsd;

    const change7d = currentUsd - startValue7d;
    const change30d = currentUsd - startValue30d;
    const change7dPct = startValue7d > 0 ? (change7d / startValue7d) * 100 : 0;
    const change30dPct = startValue30d > 0 ? (change30d / startValue30d) * 100 : 0;

    // Total P&L since first snapshot
    const firstSnapshot = thinned.length > 0 ? thinned[0] : null;
    const totalChange = firstSnapshot ? currentUsd - firstSnapshot.portfolio_usd : 0;
    const totalChangePct = firstSnapshot && firstSnapshot.portfolio_usd > 0
      ? (totalChange / firstSnapshot.portfolio_usd) * 100 : 0;

    // Rotation stats
    const totalRotations = dailyPnl.reduce((sum, d) => sum + d.rotations, 0);
    const recentRotations = rotationQueries.getRecentRotations.all(network, 20) as any[];
    const profitableRotations = recentRotations.filter(r => r.status === 'executed' && (r.actual_gain_pct ?? r.estimated_gain_pct) > 0).length;

    res.json({
      current_usd: currentUsd,
      today: { change: todayChange, change_pct: todayChangePct, rotations: todayPnl?.rotations ?? 0 },
      week: { change: change7d, change_pct: change7dPct },
      month: { change: change30d, change_pct: change30dPct },
      total: { change: totalChange, change_pct: totalChangePct, since: firstSnapshot?.timestamp ?? null },
      rotations: { total: totalRotations, recent_profitable: profitableRotations, recent_total: recentRotations.length },
      portfolio_history: thinned,
      daily_pnl: dailyPnl.reverse(),
    });
  });
}
