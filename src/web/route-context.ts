import type { CoinbaseTools } from '../wallet/tools.js';
import type { RuntimeConfig } from '../core/runtime-config.js';
import type { TradeExecutor } from '../trading/executor.js';
import type { TradingEngine } from '../trading/engine.js';
import type { PortfolioOptimizer } from '../trading/optimizer.js';
import type { WatchlistManager } from '../portfolio/watchlist.js';

export interface RouteContext {
  tools: CoinbaseTools;
  runtimeConfig: RuntimeConfig;
  executor: TradeExecutor;
  engine: TradingEngine;
  optimizer?: PortfolioOptimizer;
  watchlistManager?: WatchlistManager;
}
