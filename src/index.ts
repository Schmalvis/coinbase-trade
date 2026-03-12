import { MCPClient } from './mcp/client.js';
import { CoinbaseTools } from './mcp/tools.js';
import { startPortfolioTracker } from './portfolio/tracker.js';
import { TradeExecutor } from './trading/executor.js';
import { TradingEngine } from './trading/engine.js';
import { startTelegramBot } from './telegram/bot.js';
import { startWebServer } from './web/server.js';
import { botState } from './core/state.js';
import { logger } from './core/logger.js';
import { config } from './config.js';

async function main() {
  logger.info('Starting coinbase trade bot (base-sepolia testnet)');
  logger.info(`Strategy: ${config.STRATEGY} | Dry run: ${config.DRY_RUN}`);

  const mcp = new MCPClient(config.MCP_SERVER_URL, config.NETWORK_ID);
  await mcp.connect();

  const tools = new CoinbaseTools(mcp);
  const executor = new TradeExecutor(tools);
  const engine = new TradingEngine(executor);

  await startPortfolioTracker(tools);

  engine.start();
  startTelegramBot(engine);
  startWebServer();

  botState.setStatus('running');
  logger.info('Bot running. Dashboard: http://localhost:' + config.WEB_PORT);

  const shutdown = async () => {
    logger.info('Shutting down...');
    botState.setStatus('stopped');
    await mcp.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
