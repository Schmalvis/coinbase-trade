import { MCPClient } from './mcp/client.js';
import { CoinbaseTools } from './mcp/tools.js';
import { startPortfolioTracker } from './portfolio/tracker.js';
import { TradeExecutor } from './trading/executor.js';
import { TradingEngine } from './trading/engine.js';
import { startTelegramBot } from './telegram/bot.js';
import { startWebServer } from './web/server.js';
import { botState } from './core/state.js';
import { logger } from './core/logger.js';
import { config, availableNetworks } from './config.js';

async function main() {
  logger.info('Starting coinbase trade bot');
  logger.info(`Strategy: ${config.STRATEGY} | Dry run: ${config.DRY_RUN}`);
  logger.info(`Networks: ${availableNetworks.join(', ')} (active: ${botState.activeNetwork})`);

  const mcp = new MCPClient(config.MCP_SERVER_URL, () => botState.activeNetwork);
  await mcp.connect();

  const tools = new CoinbaseTools(mcp);
  const pollNow = await startPortfolioTracker(tools);

  // On network switch: immediately re-poll so UI reflects new balances
  botState.onNetworkChange(network => {
    logger.info(`Network switched to ${network} — re-polling portfolio`);
    pollNow();
  });

  const executor = new TradeExecutor(tools);
  const engine = new TradingEngine(executor);

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
