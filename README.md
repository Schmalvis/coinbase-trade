# coinbase-trade / base-sepolia-test

Autonomous trading bot for the **Base Sepolia testnet** using [Coinbase AgentKit](https://github.com/coinbase/agentkit) via MCP (Model Context Protocol).

Tracks ETH price via Pyth oracle, runs configurable trading strategies, executes swaps via the Coinbase MCP server, and exposes a web dashboard + Telegram bot for monitoring and control.

> **Testnet only.** This is wired to base-sepolia — no real funds at risk.

---

## Features

- Live ETH price tracking via Pyth oracle
- Two trading strategies: price threshold and SMA crossover
- Dry-run mode (simulate trades without executing)
- SQLite portfolio history (WAL mode, crash-safe)
- Web dashboard with Chart.js price chart
- Telegram bot for remote control
- CLI for quick status checks

---

## Architecture

```
src/
  config.ts              # Zod-validated settings from .env
  index.ts               # Entry point — wires all components
  core/
    logger.ts            # Sync file logger (survives SIGTERM)
    state.ts             # Shared bot state (price, balances, events)
  mcp/
    client.ts            # MCP client (StreamableHTTPClientTransport)
    tools.ts             # Typed wrappers for Coinbase AgentKit tools
  data/
    db.ts                # SQLite via better-sqlite3
  portfolio/
    tracker.ts           # Polls wallet + ETH price, writes to DB
  strategy/
    base.ts              # Strategy interface
    threshold.ts         # Buy on price drop %, sell on price rise %
    sma.ts               # SMA crossover (short/long window)
  trading/
    executor.ts          # Risk checks + trade execution
    engine.ts            # Runs strategy on interval
  telegram/
    bot.ts               # Telegraf bot
  web/
    server.ts            # Express API + static dashboard
    public/index.html    # Dark-mode dashboard
cli.ts                   # CLI (talks to running bot via HTTP)
```

---

## Prerequisites

- Node.js 22+
- A running **[coinbase-mcp-server](https://github.com/Schmalvis/coinbase-mcp-server)** — this bot communicates exclusively with the Coinbase AgentKit through that MCP server. All wallet operations, price queries, and swaps go through it. Set `MCP_SERVER_URL` to its address.
- A Telegram bot token (optional, for Telegram control)
- An Alchemy API key (optional, for ERC20 token auto-discovery)

---

## Setup

```bash
git clone https://github.com/Schmalvis/coinbase-trade.git
cd coinbase-trade/base-sepolia-test
npm install
cp .env.example .env   # edit as needed
```

### `.env` reference

| Key | Default | Description |
|-----|---------|-------------|
| `MCP_SERVER_URL` | — | Coinbase AgentKit MCP server URL |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token |
| `TELEGRAM_ALLOWED_CHAT_IDS` | — | Comma-separated allowed chat IDs |
| `POLL_INTERVAL_SECONDS` | `30` | How often to poll price/balance |
| `TRADE_INTERVAL_SECONDS` | `60` | How often to evaluate strategy |
| `STRATEGY` | `threshold` | `threshold` or `sma` |
| `PRICE_DROP_THRESHOLD_PCT` | `2.0` | Threshold strategy: buy trigger (% drop) |
| `PRICE_RISE_TARGET_PCT` | `3.0` | Threshold strategy: sell trigger (% rise from entry) |
| `SMA_SHORT_WINDOW` | `5` | SMA strategy: short window (snapshots) |
| `SMA_LONG_WINDOW` | `20` | SMA strategy: long window (snapshots) |
| `MAX_TRADE_SIZE_ETH` | `0.01` | Max ETH per trade |
| `TRADE_COOLDOWN_SECONDS` | `300` | Min time between trades |
| `WEB_PORT` | `8080` | Dashboard port |
| `DRY_RUN` | `true` | Simulate trades without executing |
| `DATA_DIR` | `~/.local/share/coinbase-trade/base-sepolia` | SQLite data directory |

---

## Running

```bash
# Development (live reload)
npm run dev

# Production
npm run build && npm start
```

Cold-start takes ~15 seconds on a Raspberry Pi — this is normal.

---

## Web Dashboard

Available at `http://localhost:8080` once the bot is running. Shows live ETH price, portfolio value, and trade history with a Chart.js chart.

---

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Current price, balance, bot state |
| `/pause` | Pause trading |
| `/resume` | Resume trading |
| `/trades` | Recent trade history |
| `/buy` | Manual buy |
| `/sell` | Manual sell |

---

## CLI

The bot must be running for the CLI to work (it talks to the HTTP API).

```bash
npx tsx cli.ts status
npx tsx cli.ts pause
npx tsx cli.ts resume
npx tsx cli.ts trades
```

---

## Strategies

### Threshold
Buys when ETH price drops `PRICE_DROP_THRESHOLD_PCT`% from the last recorded price, sells when it rises `PRICE_RISE_TARGET_PCT`% above entry. Requires at least 2 price snapshots before firing.

### SMA Crossover
Buys when the short SMA crosses above the long SMA, sells when it crosses below. Requires `SMA_LONG_WINDOW` snapshots before firing (default: 20).

---

## Testnet Faucet

To top up testnet ETH, call the MCP faucet tool:

```bash
curl -s -X POST http://<MCP_SERVER_URL>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"CdpApiActionProvider_request_faucet_funds","arguments":{}}}'
```

---

## Notes

- MCP tool responses are quirky: wallet details return as plain text (parsed with regex), price responses are double-JSON-encoded — both handled in `mcp/client.ts`.
- SQLite data directory must be on a POSIX filesystem (not SMB/CIFS) — WAL mode requires proper file locking.
