# P&L Tracking Fix Plan — 2026-07-11

## Root Cause Analysis

`TradeExecutor._openPositions` (src/trading/executor.ts L26) is a pure in-memory Map that is never seeded from the DB, so after any restart/redeploy every sell path finds no position and records `realized_pnl = NULL` (rotation sells at L526–529, per-asset sells at L340–344). Compounding this, all three sell paths **delete the entire position on a partial sell** (L350, L384, L530) even though only ~10% of the balance is sold — so even without a restart, the second sell of any position records NULL P&L. `todayRealizedPnl` (src/data/queries/core.ts L50–54) COALESCEs the SUM to 0, so the dashboard performance panel shows $0 despite executed trades.

## Tasks

### Task 1: Add a `lastTradeForSymbol` query
**File:** `src/data/queries/core.ts`
**Change:** Add one prepared statement to the `queries` object (after `todayRealizedPnl`, ~L54):
```ts
lastTradeForSymbol: db.prepare(`
  SELECT action, price_usd, amount_eth, entry_price
  FROM trades
  WHERE symbol = ? AND network = ?
    AND status IN ('executed', 'dry_run')
    AND triggered_by != 'shadow-period'
    AND price_usd > 0
  ORDER BY id DESC LIMIT 1
`),
```
This returns the most recent real trade per symbol. Shadow-period rows are excluded because they are recorded with `price_usd = 0` and don't represent positions. Both `executed` and `dry_run` statuses are included because `_openPositions` is maintained identically in both modes (executor.ts L349/L382).
**Lines affected:** ~L50–55 (insert after `todayRealizedPnl`)
**Risk:** Low — additive prepared statement, no behaviour change.

### Task 2: Seed `_openPositions` from DB on startup
**File:** `src/trading/executor.ts`
**Change:** Add a public method to `TradeExecutor`:
```ts
/**
 * Rebuild _openPositions from the DB after a restart. Called once from index.ts
 * after the network is known. Cost basis rules, per currently-held asset
 * (latest asset_snapshot balance > 0, symbol !== 'USDC'):
 *  1. Last trade was a BUY  → entryPrice = that buy's price_usd,
 *     qty = min(that buy's amount_eth, current balance).
 *  2. Last trade was a SELL with entry_price set (partial sell of a position)
 *     → entryPrice = that entry_price, qty = current balance.
 *  3. No usable trade history (registry assets ETH/CBBTC/CBETH held before the
 *     bot ever bought them) → entryPrice = latest snapshot price_usd,
 *     qty = current balance. P&L is then measured from restart time —
 *     conservative, never fabricates gains. Log this case at info level.
 */
seedOpenPositions(network: string): void { ... }
```
Implementation notes for the subagent:
- Iterate the union of `ASSET_REGISTRY` symbols and `discoveredAssetQueries.getActiveAssets.all(network)` symbols; skip `USDC`.
- For each symbol, read `queries.getLatestAssetSnapshot.get(symbol)` — skip if missing or `balance <= 0` (or balance × price < $0.01 dust).
- Apply rules 1–3 above using `queries.lastTradeForSymbol.get(symbol, network)`; skip seeding if the resolved `entryPrice <= 0`.
- Wrap the whole method body in try/catch — a seeding failure must log an error and never prevent boot.
- Finish with `logger.info(\`Seeded ${n} open positions from DB: ${symbols.join(', ')}\`)`.
**Lines affected:** new method after the constructor, ~L108
**Risk:** Low — read-only DB access at boot; positions were previously just empty, so any seed is strictly better. Rule 3 marks pre-existing holdings at current price, understating (never overstating) P&L.

### Task 3: Wire the seed call in the entry point
**File:** `src/index.ts`
**Change:** Immediately after `const executor = new TradeExecutor(tools, runtimeConfig);` (L103), add:
```ts
executor.seedOpenPositions(botState.activeNetwork);
```
`botState.activeNetwork` is already set by this point (logged at L78). Do NOT put the seed inside the constructor — tests construct `TradeExecutor` against mocked DBs and the network isn't a constructor argument.
**Lines affected:** ~L103–104
**Risk:** Low — single synchronous call; better-sqlite3 is sync so no race with the first strategy tick.

### Task 4: Decrement quantity on partial sells instead of deleting the position
**File:** `src/trading/executor.ts`
**Change:** All three sell paths currently do `this._openPositions.delete(symbol)` on any sell, but sells are partial (~10% of balance, executor.ts L294; rotations sell `ROTATION_SIZE_PCT`). Replace delete-on-sell with a decrement in all three places:
```ts
const pos = this._openPositions.get(symbol);
if (pos) {
  pos.qty -= soldQty;                         // soldQty = amount (per-asset) or sellTokenAmount (rotation)
  if (pos.qty <= 1e-9) this._openPositions.delete(symbol);
}
```
Apply at:
1. `executeForAsset` dry-run branch — L350 (`soldQty = amount`)
2. `executeForAsset` live branch — L384 (`soldQty = amount`)
3. `executeRotation` leg-1 — L530 (`soldQty = sellTokenAmount`); keep the decrement where the delete currently sits (after computing `sellRealizedPnl`, before `recordTrade`)
Note: `entryPrice` stays unchanged on decrement — remaining tokens keep their original cost basis. The existing `Math.min(amount, pos.qty)` clamps in the P&L formulas (L342, L528) already handle qty over-sell correctly and must stay.
**Lines affected:** L347–356, L380–386, L525–538
**Risk:** Medium — touches live trade accounting in three places; behaviour is only additive (positions survive partial sells) but needs the losing-streak check (L394, L537) left untouched.

### Task 5: Record `entry_price` on rotation sells
**File:** `src/trading/executor.ts`
**Change:** The rotation leg-1 `recordTrade` call (L531–535) passes `realizedPnl` but not `entryPrice`, so `entry_price` is NULL in the DB for rotation sells — which breaks Task 2's rule 2 (re-seeding partially-sold positions) for rotation-sold assets. Add `entryPrice: sellPos?.entryPrice` to the `recordTrade` argument object:
```ts
this.recordTrade({
  signal: 'sell', amountEth: sellTokenAmount, price, txHash: sellTxHash,
  triggeredBy: 'rotation', status: leg1Status, dryRun,
  reason: `rotation → ${buySymbol}`,
  entryPrice: sellPos?.entryPrice,           // ← add
  realizedPnl: sellRealizedPnl, symbol: sellSymbol,
});
```
**Lines affected:** L531–535
**Risk:** Low — one extra nullable column value; `recordTrade` already handles `entryPrice ?? null` (L607).

### Task 6: Regression test for seeding
**File:** `tests/executor-seed.test.ts` (new file)
**Change:** Vitest cases:
1. DB has an executed buy for CBBTC (price 100, qty 0.5) and a latest snapshot with balance 0.5 → after `seedOpenPositions`, `getOpenPositions().get('CBBTC')` equals `{ entryPrice: 100, qty: 0.5 }`.
2. Held ETH with **no** trade history, snapshot price 3000 balance 0.01 → seeded at `{ entryPrice: 3000, qty: 0.01 }` (rule 3 / registry fallback).
3. Latest trade is a sell with `entry_price = 90`, remaining balance 0.2 → seeded `{ entryPrice: 90, qty: 0.2 }`.
4. Zero-balance asset → not seeded.
5. Partial-sell decrement: buy → sell 10% → position remains with reduced qty and original entryPrice; second sell still produces a non-null `realizedPnl`.
**Lines affected:** new file
**Risk:** Low — test only.

## Verification

1. **Unit:** `npx vitest run tests/executor-seed.test.ts` and full `npm test` — all green. `npx tsc --noEmit` clean.
2. **Boot log:** restart the bot and watch for `Seeded N open positions from DB: ...` in the log. N must equal the number of held non-USDC assets.
3. **DB check after the next post-restart sell** (rotation or strategy):
   ```sql
   SELECT id, timestamp, symbol, action, price_usd, entry_price, realized_pnl
   FROM trades WHERE action = 'sell' ORDER BY id DESC LIMIT 10;
   ```
   `realized_pnl` must be non-NULL for every sell of a seeded/held asset (it may legitimately be 0.00 for rule-3 assets sold near the restart price).
4. **Dashboard:** performance panel today-P&L moves off $0 after the first post-restart sell; cross-check with `SELECT COALESCE(SUM(realized_pnl),0) FROM trades WHERE date(timestamp)=date('now') AND network='base-mainnet' AND status='executed';`
5. **Restart-survival:** restart again after a partial sell and confirm the position re-seeds via rule 2 (sell row's `entry_price`).

## Non-Goals

- No DB schema changes — uses the existing `entry_price` / `realized_pnl` columns added by migrations.
- No changes to trading decisions, signals, thresholds, or RiskGuard — this is P&L accounting/display only. (The optimizer's hold-bias reads `getOpenPositions()` and will passively benefit from seeded data; no optimizer code changes.)
- `executeManual` and `executeEnso` still do not update `_openPositions` — manual trades remain outside cost-basis tracking (rare, operator-initiated).
- The legacy `execute()` ETH/USDC path (L110–172) is untouched — the global ETH loop was removed in Phase 5.5.
- No FIFO/average-cost lot accounting — a single entry price per symbol remains the model; a re-buy overwrites the entry (existing behaviour at L382).
- No backfill of historical NULL `realized_pnl` rows — past trades stay as recorded.
