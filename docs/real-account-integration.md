# Real Account Integration: Approaches & Testing

Martin is exploring how to connect real onchain assets (rather than testnet-only) to the trading bot. This document outlines two approaches and the chosen path forward.

---

## Option A: Coinbase Exchange Account (Not recommended)

**What it is:** Your regular Coinbase account where you buy/sell BTC, ETH on coinbase.com.

**Integration method:**
- Requires **Coinbase Advanced Trade API** (separate from AgentKit)
- Needs different API keys: API key + secret (not the `CDP_WALLET_SECRET`)
- Bot would place orders on the exchange, not onchain
- Custodial (Coinbase holds your assets)

**Pros:**
- Familiar interface
- Easy fiat on/off ramps
- Traditional exchange features (limit orders, etc.)

**Cons:**
- Requires pulling Coinbase API credentials into bot (security consideration)
- Not integrated with AgentKit — would need parallel CDP client + Coinbase client
- Custodial (counterparty risk)
- More complex integration effort

**Status:** Shelved for now.

---

## Option B: Self-Custodial Onchain Assets (Chosen approach)

**What it is:** Transfer real ETH and/or USDC from your wallet to the bot's wallet. Bot executes swaps directly onchain via `CdpEvmWalletActionProvider_swap`.

**Integration method:**

1. **Decide which network** — base-mainnet (real assets, real cost) or keep using base-sepolia (testnet, free)
   - Martin is leaning towards **mainnet** but starting with a **single small transfer to prove it works**

2. **Get the bot's mainnet wallet address:**
   ```bash
   # From the bot (running or via HTTP API)
   curl http://192.168.68.148:8080/api/status | jq '.wallet'
   ```
   Currently: `0xBDadF45Fc80095Ec9BB8A0acAbc961f185095dA6`

3. **Transfer a small amount of a single asset** (e.g., 0.001 ETH or 5 USDC) from your personal wallet to the bot's wallet using any standard wallet tool:
   - MetaMask (easy)
   - Rabby (easy)
   - Command line / ethers.js (if scripting)
   - Any CEX withdrawal to this address

4. **Verify receipt:**
   ```bash
   npx tsx cli.ts status
   ```
   Should show the new asset in the bot's portfolio.

5. **Test a swap** (still in dry-run mode first):
   ```bash
   # Via Telegram or CLI
   /buy   # or /sell
   ```
   Should log the swap details (dry-run: not executed)

6. **Enable live trading** (once confident):
   ```bash
   # Set in .env
   DRY_RUN=false
   ```
   Restart bot. Next signal will execute a real onchain swap.

**Pros:**
- Full control — you hold the keys (self-custodial)
- Direct onchain swaps — no exchange middleman
- Lower fees (DEX swaps vs. exchange)
- Already integrated with AgentKit/CDP
- Test with small amount first, scale up later

**Cons:**
- You manage the wallet address (don't lose it)
- Real ETH/USDC cost (use testnet first if worried)
- Onchain gas fees apply

---

## Test Plan: Single Asset Transfer

**Goal:** Prove the bot can see, hold, and trade real assets.

**Steps:**

1. **Choose your test asset:**
   - Recommend: **0.001 ETH** (small, easily available, gas for future swaps)
   - Alternative: **5 USDC** (stablecoin, good for testing swaps)

2. **Send from your wallet to bot's mainnet address:**
   - Address: `0xBDadF45Fc80095Ec9BB8A0acAbc961f185095dA6` (base-mainnet)
   - Amount: 0.001 ETH (or equivalent USDC)
   - Wait for confirmation (~2–5 mins on Base)

3. **Verify bot sees it:**
   ```bash
   npx tsx cli.ts status
   ```
   Check `portfolio.assets` — should list the transferred asset.

4. **Test a dry-run swap** (if you sent ETH, swap to USDC or vice versa):
   - Via Telegram: `/buy` or `/sell` (or manually via strategy)
   - Check logs — should show swap quote and details, but NOT execute

5. **Once confident, enable live mode:**
   - Set `DRY_RUN=false` in `.env`
   - Restart bot
   - Next strategy signal executes a real swap
   - Telegram notifications confirm execution

---

## Next Steps

This document will be handed to the next Claude session with instructions to:
1. Walk through the test transfer step-by-step
2. Confirm receipt and dry-run swap
3. Enable live trading once verified
4. Scale up asset holdings if happy

---

## Quick Reference

| Network | Bot Wallet Address | Status |
|---------|-------------------|--------|
| base-sepolia | `0xDca1571e62515b8fFF7CEA62794324fE3434833e` | Active (testnet: 0.0001 ETH, 1.00 USDC) |
| base-mainnet | `0xBDadF45Fc80095Ec9BB8A0acAbc961f185095dA6` | Empty (ready for test transfer) |

**Wallet is deterministic** — same address every boot. Safe to link to your own assets.
