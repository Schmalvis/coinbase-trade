# Candle Warmup + SMA Enhancement Toggles

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 6.5-hour optimizer blind spot after restart by synthesising candles from existing snapshots, and add per-asset toggles for SMA enhancements (EMA, volume filter, RSI filter).

**Architecture:** Warmup reads asset_snapshots on startup and rolls them into synthetic 15m candles in the candles table. SMA toggles add 3 boolean columns to discovered_assets and wire them through the asset config panel and engine.

**Tech Stack:** TypeScript ESM, better-sqlite3, Vitest

---

## Chunk 1: Candle Warmup Pre-Population

### Task 1: Add warmupFromSnapshots method to CandleService

**Files:**
- Modify: `src/services/candles.ts` - add warmupFromSnapshots method + import queries
- Modify: `src/index.ts` - call warmup on startup
- Create: `tests/candle-warmup.test.ts`

- [ ] **Step 1: Write failing test** (see test code in spec)
- [ ] **Step 2: Run test to verify it fails** - `npx vitest run tests/candle-warmup.test.ts`
- [ ] **Step 3: Implement warmupFromSnapshots** - reads last 500 snapshots, groups into 15m windows, writes synthetic candles
- [ ] **Step 4: Run tests** - 3/3 PASS expected
- [ ] **Step 5: Wire warmup into index.ts** - after CandleService created, before optimizer enabled
- [ ] **Step 6: Commit** - `feat: candle warmup from snapshots eliminates 6.5hr optimizer blind spot`

---

## Chunk 2: SMA Enhancement Per-Asset Toggles

### Task 2: Add DB columns for SMA toggles

**Files:**
- Modify: `src/data/db.ts` - migrations + interface + prepared statement update

- [ ] **Step 1: Add migration columns** - sma_use_ema, sma_volume_filter, sma_rsi_filter (INTEGER DEFAULT 1)
- [ ] **Step 2: Update DiscoveredAssetRow interface** - add 3 number fields
- [ ] **Step 3: Update updateAssetStrategyConfig** - include new columns in SET clause
- [ ] **Step 4: Run typecheck** - `npx tsc --noEmit`
- [ ] **Step 5: Commit** - `feat: add sma_use_ema, sma_volume_filter, sma_rsi_filter columns`

### Task 3: Wire toggles into TradingEngine

**Files:**
- Modify: `src/trading/engine.ts` - AssetStrategyParams + SMAStrategy construction

- [ ] **Step 1: Add fields to AssetStrategyParams** - smaUseEma, smaVolumeFilter, smaRsiFilter booleans
- [ ] **Step 2: Update SMAStrategy construction** - useEma from params, conditionalise getVolume/getRsi
- [ ] **Step 3: Update all AssetStrategyParams construction sites** - pass row.sma_use_ema etc
- [ ] **Step 4: Run typecheck + tests** - `npx tsc --noEmit && npx vitest run tests/sma-enhancements.test.ts`
- [ ] **Step 5: Commit** - `feat: wire per-asset SMA toggle flags into strategy construction`

### Task 4: Add toggles to dashboard + server

**Files:**
- Modify: `src/web/public/index.html` - checkbox toggles in config panel
- Modify: `src/web/server.ts` - accept new fields in save endpoint, return in API

- [ ] **Step 1: Add checkbox toggles to inline config panel** - show when strategy is sma
- [ ] **Step 2: Update saveAssetConfig** - read checkbox values, include in POST body
- [ ] **Step 3: Update server save endpoint** - accept and persist new fields
- [ ] **Step 4: Update API response** - return toggle values in asset list
- [ ] **Step 5: Run typecheck** - `npx tsc --noEmit`
- [ ] **Step 6: Commit** - `ui: add per-asset SMA enhancement toggles (EMA, volume, RSI)`

### Task 5: Update CLAUDE.md and push

- [ ] **Step 1: Update known issues** - warmup note, SMA toggles note
- [ ] **Step 2: Commit and push** - `docs: update CLAUDE.md with warmup and SMA toggle notes`
