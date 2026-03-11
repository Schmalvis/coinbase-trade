# coinbase-trade / base-sepolia-test

Autonomous trading bot for **base-sepolia testnet** using Coinbase AgentKit via MCP.

---

## Project Status

**Phase 1 complete** — portfolio tracking, strategy engine, web dashboard, Telegram bot, CLI all wired up and tested. Bot is running in dry-run mode.

**Next steps:**
- Fund wallet with more testnet ETH as needed (faucet tool available via MCP)
- Confirm strategy signals look sane with a few polling cycles
- Set `DRY_RUN=false` in `.env` when ready to execute real (testnet) swaps
- Push repo to GitHub when happy

---

## Key Facts

- **Wallet address:** `0xF81F9e110Fa9070cb6230bC8c75403d1992a5751` (base-sepolia)
- **Network:** base-sepolia testnet (chain ID 84532)
- **MCP server:** `http://192.168.68.139:3002/mcp` (Streamable HTTP, coinbase AgentKit)
- **Data dir:** `/home/pi/.local/share/coinbase-trade/base-sepolia/` (local, NOT the SMB share — SQLite requires POSIX locking)
- **Web dashboard:** `http://192.168.68.148:8080`
- **Telegram:** configured, chat ID `8423651207`

---

## Running the Bot

```bash
cd /home/pi/share/coinbase-trade/base-sepolia-test

# Dev (live reload)
npm run dev

# Production
npm run build && npm start

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
  config.ts          # Pydantic-style settings via zod + dotenv
  index.ts           # Entry point — wires all components
  core/
    logger.ts        # appendFileSync logger (sync writes survive SIGTERM)
    state.ts         # Shared bot state (price, balance, pause/resume, trade events)
  mcp/
    client.ts        # MCPClient wrapper (StreamableHTTPClientTransport)
    tools.ts         # Typed wrappers for all Coinbase AgentKit tools
  data/
    db.ts            # SQLite via better-sqlite3 (WAL mode)
  portfolio/
    tracker.ts       # Polls wallet + ETH price on interval, writes to DB
  strategy/
    base.ts          # Strategy interface
    threshold.ts     # Buy on price drop %, sell on price rise %
    sma.ts           # SMA crossover (short/long window)
  trading/
    executor.ts      # Risk checks + trade execution (respects DRY_RUN)
    engine.ts        # Runs strategy on interval, calls executor
  telegram/
    bot.ts           # Telegraf bot: /status /pause /resume /trades /buy /sell
  web/
    server.ts        # Express API + static dashboard
    public/index.html # Dark-mode dashboard with Chart.js price chart
cli.ts               # Click-style CLI (talks to running bot via HTTP)
```

---

## Known Issues / Notes

- **MCP tool responses are quirky:** wallet details return as plain text (parsed with regex), price responses are double-JSON-encoded (handled in `mcp/client.ts`).
- **Coinbase MCP tools won't appear as Claude deferred tools** until the NEXT session (server was added mid-session when this project started).
- **Faucet:** call `CdpApiActionProvider_request_faucet_funds` via MCP to top up testnet ETH. Can be triggered with: `curl -s -X POST http://192.168.68.139:3002/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"CdpApiActionProvider_request_faucet_funds","arguments":{}}}'`
- **Strategy signals require history:** threshold needs 2+ snapshots, SMA needs `SMA_LONG_WINDOW` (default 20) snapshots before it fires.
- **Swaps on base-sepolia:** `CdpEvmWalletActionProvider_swap` trades ETH↔USDC. Test `get_swap_price` first before enabling live trading.

---

## .env Keys

| Key | Value |
|-----|-------|
| `MCP_SERVER_URL` | `http://192.168.68.139:3002/mcp` |
| `TELEGRAM_BOT_TOKEN` | set |
| `TELEGRAM_ALLOWED_CHAT_IDS` | `8423651207` |
| `STRATEGY` | `threshold` |
| `DRY_RUN` | `true` ← change to `false` for live trades |
| `DATA_DIR` | `/home/pi/.local/share/coinbase-trade/base-sepolia` |
