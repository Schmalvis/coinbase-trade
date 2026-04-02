# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

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

**Phase 4.5 (P&L visibility + notification control) complete** — Performance panel on dashboard showing today/7d/30d/total P&L with portfolio value chart. Telegram notification modes: `all` (default), `important_only` (risk alerts only), `digest` (batched summaries at scheduled UTC times), `off`. Quiet hours with configurable UTC window — only critical alerts (portfolio floor, kill switch, wallet change) break through. New commands: `/pnl` (performance summary), `/notify <mode>` (change notification mode). All notification settings DB-persisted via Settings modal → Notifications tab.

**Phase 5 (new strategies) complete** — Bollinger Bands indicator added to CandleStrategy scoring (squeeze detection, ±25pts buy/sell). Grid Trading strategy implemented as new per-asset strategy type with auto-calculated bounds from 24hr candle data, manual override, and persistent grid state. Dashboard updated with grid config fields and GRID status badge. Grid-strategy assets excluded from optimizer rotation.

**Phase 5.5 (unified strategy control) complete** — Registry assets (ETH, CBBTC, CBETH) seeded into `discovered_assets` on boot. All tradeable assets now have identical per-asset strategy controls (threshold/SMA/grid) via the Asset Management modal. The separate global ETH strategy loop has been removed — all assets use the same `startAssetLoop` path. USDC remains the base currency with no strategy.

**Next steps:**
- Deploy and verify optimizer in DRY_RUN mode — watch scores and rotation decisions in logs/dashboard before enabling real trades
- Tune optimizer thresholds via dashboard Settings (ROTATION_SELL_THRESHOLD, ROTATION_BUY_THRESHOLD, MIN_ROTATION_SCORE_DELTA)
- Add assets to watchlist via Telegram (/watch SYMBOL ADDRESS) or dashboard
- Set per-asset strategies via Asset Management modal (ETH, CBBTC, CBETH now have full strategy controls)

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

## Deployment Workflow

**Never build the Docker image manually or restart containers directly.**

1. Push changes to GitHub (`main` branch)
2. GitHub Actions automatically rebuilds the image → `ghcr.io/schmalvis/coinbase-trade:latest`
3. Once the image is published, use **Portainer** to pull the new image and redeploy the stack (`coinbase-trade-bot`, stack ID 68, endpoint ID 5 on RPi5)

Portainer UI: `https://192.168.68.139:9443` → Stacks → coinbase-trade-bot → Pull and redeploy.

---

## Running the Bot

```bash
cd /home/pi/share/coinbase-trade

# Dev (backend, live reload)
npm run dev

# Dev (frontend with HMR — proxies API to localhost:3003)
npm run dev:frontend

# Production build (backend + frontend)
npm run build && npm start

# Container
docker compose up -d

# CLI (bot must be running)
npx tsx cli.ts status
npx tsx cli.ts pause
npx tsx cli.ts resume
npx tsx cli.ts trades

# Tests (vitest — no bot running required)
npm test                          # run all tests once
npm run test:watch                # watch mode
npx vitest run tests/optimizer.test.ts  # single test file

# Type check without building
npx tsc --noEmit
```

**Note:** tsx/esm cold-start takes ~15 seconds on the Pi — this is normal, not a hang.

**Note:** Two separate npm installs are required. After cloning, run `npm ci` (backend) and `cd src/frontend && npm ci` (Svelte/Vite/Tailwind). The Dockerfile handles both automatically.

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
  services/
    alchemy.ts       # AlchemyService: ERC20 token discovery via Alchemy JSON-RPC
    candles.ts       # CandleService: OHLCV from Coinbase API + synthetic candle aggregation
  strategy/
    base.ts          # Strategy interface
    threshold.ts     # Buy on price drop %, sell on price rise %
    sma.ts           # SMA crossover (short/long window)
    candle.ts        # CandleStrategy: RSI, MACD, volume, candle patterns, Bollinger Bands
    grid.ts          # GridStrategy: price-level grid trading with auto-bounds
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
    public/
      login.html     # TOTP login page (static, served directly)
      setup.html     # TOTP setup page (static, served directly)
src/frontend/        # Svelte + Vite + Tailwind dashboard (builds to dist/web/public/)
  src/
    App.svelte       # Root component
    main.ts          # Entry point
    app.css          # Global styles
    lib/
      api.ts         # Typed fetch wrappers for all API endpoints
      types.ts       # TypeScript interfaces for API responses
      stores/        # Svelte writable stores (status, assets, candles, scores, risk, performance, settings, polling)
      components/    # Svelte components (Header, AssetsTable, CandleChart, OpportunityScores, etc.)
cli.ts               # CLI (talks to running bot via HTTP)
tests/               # Vitest test suite (supertest for Express endpoints, mocked MCP client)
Dockerfile           # Multi-stage build (arm64)
docker-compose.yml   # Portainer-compatible stack
stack.env.example    # Environment variable template for Portainer deployment
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
- **Candle data warmup:** On startup, CandleService synthesises 15m candles from existing `asset_snapshots` history, eliminating most of the warmup gap. CandleStrategy still needs 26+ candles per timeframe for full signals — but with warmup, this is available immediately if the bot has been running previously.
- **Optimizer config is DB-persisted:** All optimizer settings (thresholds, limits, intervals) are stored in the `settings` table and survive restarts/repulls. Env vars only set initial defaults.
- **Per-asset strategy is primary:** The global `STRATEGY` setting only sets the default for newly added assets. Per-asset config in the `discovered_assets` table (editable via dashboard Asset Management) takes precedence and persists across restarts. Registry assets (ETH, CBBTC, CBETH) are seeded on boot but existing config is never overwritten.
- **Alchemy discovery must skip registry assets:** Registry assets seeded into `discovered_assets` must be excluded from the Alchemy pricing loop — native tokens (ETH) have no ERC20 hex balance, so Alchemy writes balance=0, overwriting the correct value from the main poll.
- **botState is unreliable for display:** `botState.lastBalance`, `lastPrice`, and `assetBalances` may be null/stale between poll cycles. Dashboard API endpoints should read from DB tables (`asset_snapshots`, `portfolio_snapshots`) as authoritative source, with botState as fallback only.
- **Header strategy vs per-asset strategy:** The header now shows ETH's actual per-asset strategy from `discovered_assets`, not the global default. The global `STRATEGY` key only sets the default for newly seeded assets.
- **Docker volume permissions:** Container runs as `USER node` (UID 1000). DATA_DIR volume must be owned by 1000:1000 or logger/DB fails with EACCES. Fix: `chown -R 1000:1000 /home/pi/.local/share/coinbase-trade`
- **Asset address lookup must be fuzzy:** Registry assets seeded with addresses from `registry.ts` (e.g., `0xeeee...` for ETH). All asset management endpoints use case-insensitive + symbol fallback lookup because frontend address may not exactly match DB address.
- **Alchemy discovers spam tokens:** Random ERC20 airdrops (common on Base) appear as discovered assets. Users should DISMISS unknown tokens.
- **SMA strategy enhanced:** SMA now uses EMA by default (faster reaction to price changes). Crossover signals are filtered by volume (>1.5x 20-period average required) and RSI (buy blocked when RSI>70, sell blocked when RSI<30). Filters require 15m candle data — they're bypassed gracefully when candles haven't accumulated yet. All three enhancements (EMA, volume filter, RSI filter) are toggleable per-asset via the inline config panel checkboxes when SMA strategy is selected.
- **Trade sanity check:** Executor rejects trades where USD value exceeds 2x portfolio value. Prevents phantom trades from MCP response parsing errors. Skipped when portfolio is 0 (fresh start).
- **Inline asset management:** Click any asset row in the ASSETS table to expand an inline config panel with strategy selection, params, and save/disable. No separate ASSETS modal.
- **TOTP authentication:** Dashboard is protected by TOTP (authenticator app). On first boot with no TOTP secret, redirects to `/auth/setup` showing QR code. Scan with Google Authenticator/Authy/1Password, verify code, done. Subsequent visits require 6-digit code. Sessions persist for 7 days via signed cookie. Rate limited to 5 login attempts per minute. IP allowlist optional via `ALLOWED_IPS` env var. To reset TOTP (e.g., lost authenticator): `curl -X POST http://192.168.68.139:3003/auth/reset` (LAN only — rejects non-192.168.x.x IPs). After reset, next visit shows the setup QR again.
- **Frontend build:** Dashboard JS is split into TypeScript modules in `src/web/public/js/` and bundled by esbuild into `bundle.js`. Run `npm run build:frontend` to rebuild just the frontend. The full `npm run build` runs tsc + esbuild + copies static files. Chart.js is loaded via CDN `<script>` tags; the TS modules reference `Chart` as a global via `declare const Chart: any`. Inline `onclick` handlers in the HTML call functions exposed on `window` from `main.ts`.

---

## .env Keys

| Key | Default | Notes |
|-----|---------|-------|
| `MCP_SERVER_URL` | `http://YOUR_MCP_SERVER_IP:3002/mcp` | |
| `NETWORK_ID` | `base-sepolia` | Change to `base-mainnet` for real trading |
| `TELEGRAM_BOT_TOKEN` | set | |
| `TELEGRAM_ALLOWED_CHAT_IDS` | `8423651207` | |
| `STRATEGY` | `threshold` | `threshold`, `sma`, or `grid` — sets default for new assets only |
| `DRY_RUN` | `false` | Set `true` to simulate without executing. Read-only at runtime — cannot be changed via dashboard API |
| `DASHBOARD_SECRET` | (unset) | Optional. Bearer token for mutating API endpoints (POST/PUT/DELETE). If unset, all requests allowed. Set this if dashboard is network-accessible |
| `SESSION_SECRET` | (auto-generated) | Secret for signing session cookies. If unset, a random 32-byte key is generated on each boot (sessions won't survive restarts). Set a fixed value for persistent sessions |
| `ALLOWED_IPS` | (unset) | Optional. Comma-separated CIDR ranges or IPs (e.g., `192.168.1.0/24,10.0.0.5`). If set, requests from outside are rejected with 403. If unset, all IPs allowed |
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
| `BB_PERIOD` | `20` | Bollinger Bands lookback period |
| `BB_STD_DEV` | `2.0` | Bollinger Bands standard deviation multiplier |
| `GRID_LEVELS` | `10` | Number of price levels in grid strategy |
| `GRID_AMOUNT_PCT` | `5` | % of portfolio per grid order |
| `GRID_UPPER_BOUND` | (auto) | Global default upper bound (per-asset overrides) |
| `GRID_LOWER_BOUND` | (auto) | Global default lower bound (per-asset overrides) |
| `GRID_RECALC_HOURS` | `6` | Hours between auto-recalculation of grid bounds |
