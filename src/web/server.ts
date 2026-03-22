import express, { Router } from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { settingQueries, passkeyQueries } from '../data/db.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { createAuthMiddleware, createSessionMiddleware, isIpAllowed, requireAuth, registerAuthRoutes } from './auth.js';
import type { CoinbaseTools } from '../mcp/tools.js';
import type { RuntimeConfig } from '../core/runtime-config.js';
import type { TradeExecutor } from '../trading/executor.js';
import type { TradingEngine } from '../trading/engine.js';
import type { PortfolioOptimizer } from '../trading/optimizer.js';
import type { WatchlistManager } from '../portfolio/watchlist.js';
import type { RouteContext } from './route-context.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTradingRoutes } from './routes/trading.js';
import { registerAssetsRoutes } from './routes/assets.js';
import { registerCandlesRoutes } from './routes/candles.js';
import { registerRotationsRoutes } from './routes/rotations.js';
import { registerRiskRoutes } from './routes/risk.js';
import { registerWatchlistRoutes } from './routes/watchlist.js';
import { registerPerformanceRoutes } from './routes/performance.js';
import { registerOptimizerRoutes } from './routes/optimizer.js';
import { registerWalletRoutes } from './routes/wallet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startWebServer(
  tools: CoinbaseTools,
  runtimeConfig: RuntimeConfig,
  executor: TradeExecutor,
  engine: TradingEngine,
  optimizer?: PortfolioOptimizer,
  watchlistManager?: WatchlistManager,
): void {
  const app = express();
  let sessionSecret = config.SESSION_SECRET;
  if (!sessionSecret) {
    // Derive a stable secret from DATA_DIR so TOTP encryption survives restarts
    sessionSecret = crypto.createHash('sha256').update(`totp-key:${config.DATA_DIR}`).digest('hex');
    logger.warn('SESSION_SECRET not set — deriving from DATA_DIR. Set SESSION_SECRET env var for production.');
  }
  app.set('trust proxy', true); // for correct req.ip behind reverse proxy

  // 1. JSON body parsing
  app.use(express.json());

  // 2. Session middleware
  app.use(createSessionMiddleware(sessionSecret));

  // 3. IP allowlist
  const allowedIps = config.ALLOWED_IPS || '';
  if (allowedIps) {
    app.use((req, res, next) => {
      if (!isIpAllowed(req.ip || '', allowedIps)) {
        res.status(403).send('Forbidden');
        return;
      }
      next();
    });
  }

  // 4. TOTP route protection (session-based auth for browser access)
  const getTotpSecret = () => settingQueries.getSetting.get('TOTP_SECRET')?.value || undefined;
  app.use(requireAuth(getTotpSecret));

  // 5. Auth routes (login, setup, logout, passkeys)
  registerAuthRoutes(app, settingQueries, sessionSecret, passkeyQueries, {
    rpId: config.WEBAUTHN_RP_ID,
    rpName: config.WEBAUTHN_RP_NAME,
    origin: config.WEBAUTHN_ORIGIN,
  });

  // 6. Static files
  app.use(express.static(path.join(__dirname, 'public')));

  // 7. Bearer token auth for mutating API endpoints (CLI/Telegram)
  app.use(createAuthMiddleware(() => config.DASHBOARD_SECRET || undefined));

  // Mount all API routes
  const router = Router();
  const ctx: RouteContext = { tools, runtimeConfig, executor, engine, optimizer, watchlistManager };
  registerStatusRoutes(router, ctx);
  registerSettingsRoutes(router, ctx);
  registerTradingRoutes(router, ctx);
  registerAssetsRoutes(router, ctx);
  registerCandlesRoutes(router, ctx);
  registerRotationsRoutes(router, ctx);
  registerRiskRoutes(router, ctx);
  registerWatchlistRoutes(router, ctx);
  registerPerformanceRoutes(router, ctx);
  registerOptimizerRoutes(router, ctx);
  registerWalletRoutes(router, ctx);
  app.use(router);

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(config.WEB_PORT, '0.0.0.0', () => {
    logger.info(`Web dashboard: http://0.0.0.0:${config.WEB_PORT}`);
  });
}
