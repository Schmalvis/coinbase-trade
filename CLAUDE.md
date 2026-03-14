# coinbase-trade

Autonomous trading bot for Base network (sepolia testnet / mainnet) using Coinbase AgentKit via MCP.

---

## Project Status

**Phase 1 complete** — portfolio tracking, strategy engine, web dashboard, Telegram bot, CLI all wired up and tested.
Bot tracks ETH + USDC balances, executes ETH↔USDC swaps via the Coinbase AgentKit MCP server.
Docker support added — image published to `ghcr.io/schmalvis/coinbase-trade:latest`.

**Phase 2 (multi-asset) complete** — asset registry implemented for ETH, USDC, CBBTC, CBETH with per-asset balance tracking. Dashboard updated with asset selector for price chart, Holdings section showing all tracked assets, and dynamic trade pair buttons. LOG_LEVEL hot-reload fixed — Settings modal LOG_LEVEL changes now take effect immediately without restart.

**Phase 3 (ERC20 discovery) complete** — AlchemyService scans the wallet for any ERC20 tokens and persists them as `discovered_assets` in SQLite. Discovered tokens appear in a dynamic asset table on the dashboard with ENABLE/DISMISS actions. Enabled tokens get their own independent strategy loop in TradingEngine. Asset Management modal allows per-asset strategy configuration. Set `ALCHEMY_API_KEY` to activate discovery.

**Phase 3.5 (reliability) complete** — Per-asset strategy parameter injection wired (ThresholdStrategy/SMAStrategy accept explicit `dropPct`/`risePct`/`smaShort`/`smaLong` overrides). MCP circuit breaker with auto-pause/resume on server failures. Wallet address monitoring (detects MCP server wallet changes, pauses + alerts). Telegram alert bus for critical events.

**Phase 4 (portfolio optimizer) complete** — Cross-asset opportunity rotation system. OHLCV candle data from Coinbase Advanced Trade API (15m/1h/24h) + synthetic candles from spot prices. CandleStrategy (RSI, MACD, volume, candle patterns) scores assets across timeframes. PortfolioOptimizer ranks assets, detects rotation opportunities, checks RiskGuard (position limits, daily loss limit, portfolio floor kill switch), and executes two-leg rotations (sell weak → buy strong). Watchlist for tracking assets not yet held. Full dashboard redesign with dark/light themes, candlestick charts, opportunity scores, rotation log, risk monitor. New Telegram commands (/scores, /rotations, /watchlist, /risk, /killswitch, /optimizer).

**Next steps:**
- Deploy and verify optimizer in DRY_RUN mode — watch scores and rotation decisions in logs/dashboard before enabling real trades
- Tune optimizer thresholds via dashboard Settings (ROTATION_SELL_THRESHOLD, ROTATION_BUY_THRESHOLD, MIN_ROTATION_SCORE_DELTA)
- Add assets to watchlist via Telegram (/watch SYMBOL ADDRESS) or dashboard

---

## Key Facts

- **Testnet wallet:** `0x9123528571C6aD8fe80eb0cC82f6a388311A3104` (base-sepolia)
- **Mainnet wallet:** `0x7dD5Acd498BCF96832f82684584734cF48c7318D` (base-mainnet)
- **MCP server:** `http://YOUR_MCP_SERVER_IP:3002/mcp` (see [Schmalvis/coinbase-mcp-server](https://github.com/Schmalvis/coinbase-mcp-server))
- **Network:** controlled by `NETWORK_ID` env var — injected into every MCP tool call by `mcp/client.ts`
- **Data dir:** must be on a POSIX filesystem (not SMB/CIFS) — SQLite WAL mode requires proper file locking
- **Web dashboard:** `http://YOUR_MCP_SERVER_IP:3003`
- **Telegram:** configured, chat ID `8423651207`

---

## Running the Bot

```bash
cd /home/pi/share/coinbase-trade

# Dev (live reload)
npm run dev

# Production
npm run build && npm start

# Container
docker compose up -d

# CLI (bot must be running)
npx tsx cli.ts status
npx tsx cli.ts pause
npx tsx cli.ts resume
npx tsx cli.ts trades
```

**Note:** tsx/esm cold-start takes ~15 seconds on the Pi — this is normal, not a hang.

---

## Architecture

```
src/
  config.ts          # Zod-validated settings from .env
  index.ts           # Entry point — wires all components
  core/
    logger.ts        # appendFileSync logger (sync writes survive SIGTERM)
    state.ts         # Shared bot state (price, balances, pause/resume, trade events)
  mcp/
    client.ts        # MCPClient — injects network into every tool call
    tools.ts         # Typed wrappers for Coinbase AgentKit tools
  assets/
    registry.ts      # Static asset registry (ETH, USDC, CBBTC, CBETH)
  data/
    db.ts            # SQLite via better-sqlite3 (WAL mode)
  portfolio/
    tracker.ts       # Polls balances/prices; runs Alchemy ERC20 discovery if key set
  services/
    alchemy.ts       # AlchemyService: ERC20 token discovery via Alchemy JSON-RPC
    candles.ts       # CandleService: OHLCV from Coinbase API + synthetic candle aggregation
  strategy/
    base.ts          # Strategy interface
    threshold.ts     # Buy on price drop %, sell on price rise %
    sma.ts           # SMA crossover (short/long window)
    candle.ts        # CandleStrategy: RSI, MACD, volume, candle pattern indicators
  trading/
    executor.ts      # Risk checks + trade execution + two-leg rotation (respects DRY_RUN)
    engine.ts        # Runs strategy on interval; per-asset loops; optimizer loop
    optimizer.ts     # PortfolioOptimizer: scoring, rotation detection, risk-off mode
    risk-guard.ts    # RiskGuard: pure veto gate (position limits, loss limits, rotation caps)
  portfolio/
    tracker.ts       # Polls balances/prices; runs Alchemy ERC20 discovery if key set
    watchlist.ts     # WatchlistManager: external asset tracking
  telegram/
    bot.ts           # Telegraf bot: /status /pause /resume /trades /buy /sell /scores /rotations /watchlist /risk /killswitch /optimizer
  web/
    server.ts        # Express API + static dashboard
    public/index.html # Dashboard with dark/light themes, candlestick charts, optimizer panels
cli.ts               # CLI (talks to running bot via HTTP)
Dockerfile           # Multi-stage build (arm64)
docker-compose.yml   # Portainer-compatible stack
stack.env            # Environment variable template for Portainer deployment
docs/
  real-account-options.md     # Options and steps for connecting real funds
  real-account-integration.md # Integration research notes
```

---

## Known Issues / Notes

- **MCP tool responses:** wallet details and ERC20 balances return as plain text (parsed with regex in `mcp/tools.ts`); prices may be double-JSON-encoded (handled in `mcp/client.ts`). This is AgentKit behaviour — not a bug.
- **Network injection:** `MCPClient` automatically appends `network: NETWORK_ID` to every tool call. Never pass `network` manually in `tools.ts`.
- **Wallet is deterministic:** the MCP server derives wallet addresses from `CDP_WALLET_SECRET`. Same secret = same address on every boot.
- **Faucet:** call `CdpApiActionProvider_request_faucet_funds` via MCP to top up testnet ETH.
- **Strategy signals require history:** threshold needs 2+ snapshots, SMA needs `SMA_LONG_WINDOW` (default 20) snapshots before it fires.
- **Per-asset strategy params:** discovered-asset loops now use per-asset `drop_pct`/`rise_pct`/`sma_short`/`sma_long` from the `discovered_assets` DB table, falling back to global config if not set.
- **Candle data warmup:** CandleStrategy needs 26+ candles per timeframe before producing signals. After fresh deploy, allow ~6.5 hours for 15m candles to accumulate (or the optimizer falls back to hold signals).
- **Optimizer config is DB-persisted:** All optimizer settings (thresholds, limits, intervals) are stored in the `settings` table and survive restarts/repulls. Env vars only set initial defaults.

---

## .env Keys

| Key | Default | Notes |
|-----|---------|-------|
| `MCP_SERVER_URL` | `http://YOUR_MCP_SERVER_IP:3002/mcp` | |
| `NETWORK_ID` | `base-sepolia` | Change to `base-mainnet` for real trading |
| `TELEGRAM_BOT_TOKEN` | set | |
| `TELEGRAM_ALLOWED_CHAT_IDS` | `8423651207` | |
| `STRATEGY` | `threshold` | `threshold` or `sma` |
| `DRY_RUN` | `false` | Set `true` to simulate without executing |
| `DATA_DIR` | `/home/pi/.local/share/coinbase-trade/base-sepolia` | Must be POSIX filesystem |
| `ALCHEMY_API_KEY` | (unset) | Optional. Enables ERC20 token auto-discovery via Alchemy. Get a key at dashboard.alchemy.com |

### Optimizer Settings (DB-persisted, editable via dashboard)

These are NOT env vars — they're stored in the `settings` DB table and managed via the dashboard Settings modal. Listed here for reference with their code defaults:

| Key | Default | Notes |
|-----|---------|-------|
| `MAX_POSITION_PCT` | `40` | Max % of portfolio in any single non-primary asset |
| `MAX_DAILY_LOSS_PCT` | `5` | Daily loss % that triggers trading pause |
| `MAX_ROTATION_PCT` | `25` | Max % of portfolio per single rotation |
| `MAX_DAILY_ROTATIONS` | `10` | Max rotations per 24hr window |
| `PORTFOLIO_FLOOR_USD` | `100` | Absolute USD kill switch threshold |
| `MIN_ROTATION_GAIN_PCT` | `2` | Min net gain after fees to execute rotation |
| `MAX_CASH_PCT` | `80` | Max USDC % in risk-off mode |
| `OPTIMIZER_INTERVAL_SECONDS` | `300` | Optimizer tick interval |
| `ROTATION_SELL_THRESHOLD` | `-20` | Score below which held asset is sell candidate |
| `ROTATION_BUY_THRESHOLD` | `30` | Score above which asset is buy candidate |
| `MIN_ROTATION_SCORE_DELTA` | `40` | Min gap between sell and buy scores |
| `RISK_OFF_THRESHOLD` | `-10` | All-asset score below which risk-off activates |
| `RISK_ON_THRESHOLD` | `15` | Score above which risk-off deactivates |
| `DEFAULT_FEE_ESTIMATE_PCT` | `1.0` | Fallback fee estimate when quote unavailable |
| `DASHBOARD_THEME` | `dark` | Dashboard colour theme (light/dark) |
