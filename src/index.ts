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
import { RuntimeConfig, setRuntimeConfigSingleton } from './core/runtime-config.js';
import { settingQueries } from './data/db.js';
import { AlchemyService } from './services/alchemy.js';

async function main() {
  // Initialise RuntimeConfig — overlays env defaults with any saved DB settings
  const runtimeConfig = new RuntimeConfig(config as any, settingQueries);

  // Wire singleton so logger reads LOG_LEVEL dynamically on each call
  setRuntimeConfigSingleton(runtimeConfig);

  // Conditionally instantiate AlchemyService if API key is available
  const alchemyService = config.ALCHEMY_API_KEY
    ? new AlchemyService(config.ALCHEMY_API_KEY)
    : undefined;

  // Restore persisted active network (survives restarts)
  const savedNetwork = settingQueries.getSetting.get('ACTIVE_NETWORK')?.value;
  if (savedNetwork && availableNetworks.includes(savedNetwork)) {
    botState.setNetwork(savedNetwork);
  }

  logger.info('Starting coinbase trade bot');
  logger.info(`Strategy: ${runtimeConfig.get('STRATEGY')} | Dry run: ${runtimeConfig.get('DRY_RUN')}`);
  logger.info(`Networks: ${availableNetworks.join(', ')} (active: ${botState.activeNetwork})`);

  let pausedByMcp = false;
  const mcp = new MCPClient(config.MCP_SERVER_URL, () => botState.activeNetwork, (healthy) => {
    botState.setMcpHealthy(healthy);
    if (!healthy) {
      pausedByMcp = botState.status !== 'paused'; // only flag if not already manually paused
      botState.setStatus('paused');
      botState.emitAlert('⚠️ MCP server unreachable — bot paused. Will resume automatically on recovery.');
    } else {
      if (pausedByMcp) {
        botState.setStatus('running');
        botState.emitAlert('✅ MCP server recovered — bot resumed.');
      } else {
        botState.emitAlert('✅ MCP server recovered.');
      }
      pausedByMcp = false;
    }
  });
  await mcp.connect();

  const tools = new CoinbaseTools(mcp);
  const pollNow = await startPortfolioTracker(tools, runtimeConfig, alchemyService);

  botState.onNetworkChange(network => {
    logger.info(`Network switched to ${network} — re-polling portfolio`);
    settingQueries.upsertSetting.run('ACTIVE_NETWORK', network);
    pollNow();
  });

  const executor = new TradeExecutor(tools, runtimeConfig);
  const engine = new TradingEngine(executor, runtimeConfig);

  engine.start();
  startTelegramBot(engine);
  startWebServer(tools, runtimeConfig, executor, engine);

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
