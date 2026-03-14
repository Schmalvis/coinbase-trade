# coinbase-trade

Autonomous trading bot for Base network (sepolia testnet / mainnet) using Coinbase AgentKit via MCP.

---

## Project Status

**Phase 1 complete** — portfolio tracking, strategy engine, web dashboard, Telegram bot, CLI all wired up and tested.
Bot tracks ETH + USDC balances, executes ETH↔USDC swaps via the Coinbase AgentKit MCP server.
Docker support added — image published to `ghcr.io/schmalvis/coinbase-trade:latest`.

**Phase 2 (multi-asset) complete** — asset registry implemented for ETH, USDC, CBBTC, CBETH with per-asset balance tracking. Dashboard updated with asset selector for price chart, Holdings section showing all tracked assets, and dynamic trade pair buttons. LOG_LEVEL hot-reload fixed — Settings modal LOG_LEVEL changes now take effect immediately without restart.

**Phase 3 (ERC20 discovery) complete** — AlchemyService scans the wallet for any ERC20 tokens and persists them as `discovered_assets` in SQLite. Discovered tokens appear in a dynamic asset table on the dashboard with ENABLE/DISMISS actions. Enabled tokens get their own independent strategy loop in TradingEngine. Asset Management modal allows per-asset strategy configuration. Set `ALCHEMY_API_KEY` to activate discovery.

**Next steps:**
- Set `ALCHEMY_API_KEY` to enable ERC20 auto-discovery (get a free key at dashboard.alchemy.com)
- Test mainnet with a small real ETH transfer (see `docs/real-account-options.md`)
- Switch `NETWORK_ID=base-mainnet` and restart when ready for live trading

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
  strategy/
    base.ts          # Strategy interface
    threshold.ts     # Buy on price drop %, sell on price rise %
    sma.ts           # SMA crossover (short/long window)
  trading/
    executor.ts      # Risk checks + trade execution (respects DRY_RUN)
    engine.ts        # Runs strategy on interval; per-asset loops for discovered tokens
  telegram/
    bot.ts           # Telegraf bot: /status /pause /resume /trades /buy /sell
  web/
    server.ts        # Express API + static dashboard
    public/index.html # Dark-mode dashboard with Chart.js price chart
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
- **Per-asset strategy params (known limitation):** discovered-asset loops use the same global `STRATEGY`, `PRICE_DROP_THRESHOLD_PCT`, `PRICE_RISE_TARGET_PCT`, `SMA_SHORT/LONG_WINDOW` config as the main ETH loop — the per-asset `drop_pct`/`rise_pct` stored in `discovered_assets` are saved to DB and shown in the UI but not yet wired into the strategy evaluation. Full per-asset param injection requires strategy constructors to accept explicit params (currently unchanged by design).

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
