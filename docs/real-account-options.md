# Connecting a Real Account to the Trading Bot

## Overview

There are two approaches to trading with real funds. This document explains both,
with a focus on **Option B** — the recommended path for a first live test.

---

## Option A — Coinbase Exchange Account (Advanced Trade API)

This would connect to the custodial account at coinbase.com — the one where you
buy and sell BTC, ETH etc. through the Coinbase app or website.

**What's needed:**
- Coinbase Advanced Trade API key + secret (generated at coinbase.com → Settings → API)
- A new integration layer in the trading bot — the current MCP server does not support
  the Advanced Trade API; it would need to be built separately

**Pros:**
- Access to full Coinbase exchange portfolio (all assets, full order book)
- Limit orders, market orders, stop-loss etc.

**Cons:**
- Significant rebuild required — different API, different auth, different tool set
- Trades happen on the Coinbase exchange, not on-chain

**Status:** Not currently implemented. Would require a separate integration project.

---

## Option B — Base Mainnet On-Chain Wallet (Recommended)

The trading bot already manages a self-custodial wallet on the **Base mainnet**
(Ethereum L2). This is a real, live blockchain wallet — any funds sent to it are
under your control and can be traded immediately via the existing bot infrastructure.

**Mainnet wallet address:**
```
0xBDadF45Fc80095Ec9BB8A0acAbc961f185095dA6
```

**How it works:**
1. You send a small amount of ETH (or USDC) from your Coinbase account to this address
2. The bot sees the balance on its next 30-second poll
3. The trading strategy evaluates price movements and executes swaps on-chain via the
   Coinbase AgentKit MCP server
4. You can monitor via Telegram (`/status`), the web dashboard, or the logs

**Everything is already set up for this.** The bot, MCP server, and mainnet wallet are
all live. It just needs funding.

---

## Proof-of-Concept: Small Transfer Test

### Step 1 — Transfer ETH from Coinbase to the Base wallet

In the Coinbase app or website:

1. Go to **Send / Pay**
2. Choose **ETH** as the asset
3. Enter the destination address: `0xBDadF45Fc80095Ec9BB8A0acAbc961f185095dA6`
4. **Important:** Select **Base** as the network (not Ethereum mainnet — fees are much
   higher and the bot is configured for Base)
5. Send a small amount — **0.01 ETH** is enough to prove the connection works
6. Confirm the transaction

> Base network transfers from Coinbase typically settle in under a minute.

### Step 2 — Verify the bot sees it

Once the transaction is confirmed, ask the bot via Telegram:
```
/status
```
You should see the ETH balance updated and a portfolio value in USD.

Alternatively, check the web dashboard at `http://192.168.68.148:8080` or the logs:
```bash
tail -f /tmp/coinbase-trade.log
```

### Step 3 — Confirm swaps work (optional but recommended before enabling trading)

Before enabling live trading, test a manual swap via Telegram:
```
/buy
```
This will attempt to buy a small amount of ETH using any USDC in the wallet,
or vice versa with `/sell`. Check the log for the transaction hash and verify
it on [basescan.org](https://basescan.org).

### Step 4 — Enable live trading

Once you're satisfied the connection works:
- The bot is already running with `DRY_RUN=false`
- The strategy will begin executing trades autonomously based on ETH price movements
- You will receive Telegram notifications for every trade

---

## Key Facts for the Next Session

| Item | Value |
|------|-------|
| Project directory | `/home/pi/share/coinbase-trade` |
| Mainnet wallet | `0xBDadF45Fc80095Ec9BB8A0acAbc961f185095dA6` |
| Testnet wallet | `0xDca1571e62515b8fFF7CEA62794324fE3434833e` |
| MCP server | `http://192.168.68.139:3002/mcp` |
| Web dashboard | `http://192.168.68.148:8080` |
| Bot config | `/home/pi/share/coinbase-trade/.env` |
| Bot logs | `/tmp/coinbase-trade.log` |
| Network for real trades | `base-mainnet` |
| Current bot network | `base-sepolia` (testnet) |
| Telegram commands | `/status` `/pause` `/resume` `/buy` `/sell` `/trades` |

### To switch the bot to mainnet

Edit `.env` and change:
```env
NETWORK_ID=base-mainnet
```
Then rebuild and restart:
```bash
cd /home/pi/share/coinbase-trade/base-sepolia-test
npm run build && nohup npm start > /tmp/coinbase-trade.log 2>&1 &
```

> The bot's strategy, executor, and MCP client all automatically use whichever
> network is set in `NETWORK_ID`. No code changes needed.

### What the next Claude session should do

1. Read this file and the project `CLAUDE.md` at
   `/home/pi/share/coinbase-trade/base-sepolia-test/CLAUDE.md`
2. Check the bot is running: `ps aux | grep "node dist"`
3. Walk Martin through the small transfer test above (Step 1–3)
4. Verify the balance appears in the bot before switching to mainnet
5. Switch `NETWORK_ID=base-mainnet` in `.env`, rebuild, and restart the bot
6. Confirm `/status` on Telegram shows the mainnet balance

---

## Risk Notes

- Base mainnet uses **real ETH** — mistakes are irreversible
- Start with a small amount (0.01 ETH) until you're confident everything works
- The bot's `MAX_TRADE_SIZE_ETH` is currently set to `0.01` ETH — it won't trade
  more than this per signal regardless of balance
- `TRADE_COOLDOWN_SECONDS=300` prevents rapid repeated trades (5 minute cooldown)
- You can pause the bot at any time with `/pause` on Telegram
