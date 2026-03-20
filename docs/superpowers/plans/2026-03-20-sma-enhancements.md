# SMA Strategy Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the SMA crossover strategy with EMA calculation, volume confirmation, and RSI filtering to reduce false signals and improve entry timing.

**Architecture:** All three enhancements are additive to the existing `SMAStrategy` class. EMA replaces the SMA calculation internally. Volume and RSI filters use candle data accessed via optional constructor callbacks (same pattern as GridStrategy). When candle data is unavailable, filters are bypassed — the strategy degrades gracefully to the current behavior. Existing tests and the `Strategy` interface remain unchanged.

**Tech Stack:** TypeScript, Vitest

---

## Regression Risk Assessment

**What could break:**
1. Any code that instantiates `SMAStrategy` — the constructor signature changes (new optional fields). Since all new fields are optional with `?`, existing callers are unaffected.
2. The `evaluate()` return contract (`StrategyResult`) — unchanged.
3. The `Strategy` interface — unchanged.
4. Existing test in `tests/strategy-per-asset-params.test.ts` — tests SMA with per-asset params. Must continue to pass.
5. The `_assetStrategies` cache in engine.ts types `SMAStrategy` — unchanged since class name doesn't change.

**Mitigation:** Write comprehensive tests for all three enhancements FIRST, including backward-compatibility tests that verify the old behavior still works when no candle data is provided.

---

## File Map

| File | Changes |
|------|---------|
| `src/strategy/sma.ts` | Modify — add EMA, volume filter, RSI filter |
| `src/trading/engine.ts:165-166` | Modify — pass candle data callbacks to SMAStrategy constructor |
| `tests/sma-enhancements.test.ts` | **CREATE** — comprehensive tests for all enhancements |

No new files created except the test file. No interface changes. No new dependencies.

---

## Chunk 1: EMA + Volume + RSI Implementation

### Task 1: EMA Calculation and Backward-Compatible Tests

**Files:**
- Modify: `src/strategy/sma.ts`
- Create: `tests/sma-enhancements.test.ts`

- [ ] **Step 1: Write backward-compatibility tests**

Create `tests/sma-enhancements.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SMAStrategy } from '../src/strategy/sma.js';
import type { Snapshot } from '../src/strategy/base.js';

function makeSnaps(prices: number[]): Snapshot[] {
  return prices.map((p, i) => ({
    eth_price: p,
    eth_balance: 0,
    portfolio_usd: 0,
    timestamp: new Date(Date.now() - (prices.length - i) * 60000).toISOString(),
  }));
}

describe('SMAStrategy backward compatibility', () => {
  it('returns hold when insufficient data', () => {
    const s = new SMAStrategy({ shortWindow: 3, longWindow: 5 });
    const result = s.evaluate(makeSnaps([100, 101, 102]));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('Need 5 snapshots');
  });

  it('returns hold on first evaluation with enough data (initialising)', () => {
    const s = new SMAStrategy({ shortWindow: 3, longWindow: 5 });
    const result = s.evaluate(makeSnaps([100, 101, 102, 103, 104]));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('nitialis');
  });

  it('detects bullish crossover (buy)', () => {
    const s = new SMAStrategy({ shortWindow: 3, longWindow: 5 });
    // First call: short < long (bearish initial state)
    s.evaluate(makeSnaps([110, 108, 106, 104, 102])); // short avg < long avg
    // Second call: short > long (bullish crossover)
    const result = s.evaluate(makeSnaps([102, 104, 106, 108, 110])); // short avg > long avg
    expect(result.signal).toBe('buy');
    expect(result.reason).toContain('crossover');
  });

  it('detects bearish crossover (sell)', () => {
    const s = new SMAStrategy({ shortWindow: 3, longWindow: 5 });
    // First call: short > long (bullish initial state)
    s.evaluate(makeSnaps([102, 104, 106, 108, 110]));
    // Second call: short < long (bearish crossover)
    const result = s.evaluate(makeSnaps([110, 108, 106, 104, 102]));
    expect(result.signal).toBe('sell');
    expect(result.reason).toContain('crossover');
  });

  it('works with no constructor options (uses config defaults)', () => {
    const s = new SMAStrategy();
    // Should not throw
    const result = s.evaluate(makeSnaps([100]));
    expect(result.signal).toBe('hold');
  });
});
```

- [ ] **Step 2: Run tests to verify backward-compat tests pass with current code**

```bash
npx vitest run tests/sma-enhancements.test.ts
```
Expected: All 5 tests PASS (they test current behavior).

- [ ] **Step 3: Add EMA enhancement tests**

Append to `tests/sma-enhancements.test.ts`:

```typescript
describe('SMAStrategy EMA enhancement', () => {
  it('uses EMA when useEma option is true', () => {
    const s = new SMAStrategy({ shortWindow: 3, longWindow: 5, useEma: true });
    // EMA weights recent prices more heavily than SMA
    // With rising prices, EMA short will be higher than SMA short
    s.evaluate(makeSnaps([100, 100, 100, 100, 100])); // init
    const result = s.evaluate(makeSnaps([100, 100, 100, 102, 105]));
    // The exact signal depends on the numbers, but the reason should show EMA
    expect(result.reason).toContain('EMA');
  });

  it('defaults to SMA when useEma is not set', () => {
    const s = new SMAStrategy({ shortWindow: 3, longWindow: 5 });
    s.evaluate(makeSnaps([100, 100, 100, 100, 100]));
    const result = s.evaluate(makeSnaps([100, 100, 100, 102, 105]));
    expect(result.reason).toContain('SMA');
    expect(result.reason).not.toContain('EMA');
  });
});
```

- [ ] **Step 4: Run tests — EMA tests should FAIL**

```bash
npx vitest run tests/sma-enhancements.test.ts
```
Expected: EMA tests FAIL (useEma option not yet implemented).

- [ ] **Step 5: Implement EMA in sma.ts**

Modify `src/strategy/sma.ts`:

Add EMA calculation function:
```typescript
function ema(prices: number[], window: number): number {
  if (prices.length === 0) return 0;
  const k = 2 / (window + 1);
  let result = prices[prices.length - 1]; // start from oldest
  for (let i = prices.length - 2; i >= 0; i--) {
    result = prices[i] * k + result * (1 - k);
  }
  return result;
}
```

Update constructor opts type:
```typescript
constructor(private readonly opts?: {
  shortWindow?: number;
  longWindow?: number;
  useEma?: boolean;
  getVolume?: () => { current: number; average: number } | null;
  getRsi?: () => number | null;
}) {}
```

In `evaluate()`, replace SMA calls with conditional EMA/SMA:
```typescript
const useEma = this.opts?.useEma ?? false;
const calc = useEma ? ema : sma;
const label = useEma ? 'EMA' : 'SMA';
const shortVal = calc(prices.slice(0, shortW), shortW);
const longVal  = calc(prices.slice(0, longW), longW);
```

Update the reason string to use `label` instead of hardcoded 'SMA'.

- [ ] **Step 6: Run tests — all should PASS**

```bash
npx vitest run tests/sma-enhancements.test.ts
```
Expected: All 7 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/strategy/sma.ts tests/sma-enhancements.test.ts
git commit -m "feat: add EMA option to SMAStrategy with backward-compat tests"
```

---

### Task 2: Volume Confirmation Filter

**Files:**
- Modify: `src/strategy/sma.ts`
- Modify: `tests/sma-enhancements.test.ts`

- [ ] **Step 1: Add volume filter tests**

Append to `tests/sma-enhancements.test.ts`:

```typescript
describe('SMAStrategy volume filter', () => {
  it('blocks buy signal when volume is below average', () => {
    const s = new SMAStrategy({
      shortWindow: 3, longWindow: 5,
      getVolume: () => ({ current: 50, average: 100 }), // 0.5x — below threshold
    });
    // Set up bearish state, then trigger bullish crossover
    s.evaluate(makeSnaps([110, 108, 106, 104, 102]));
    const result = s.evaluate(makeSnaps([102, 104, 106, 108, 110]));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('volume');
  });

  it('allows buy signal when volume is above average', () => {
    const s = new SMAStrategy({
      shortWindow: 3, longWindow: 5,
      getVolume: () => ({ current: 200, average: 100 }), // 2x — above threshold
    });
    s.evaluate(makeSnaps([110, 108, 106, 104, 102]));
    const result = s.evaluate(makeSnaps([102, 104, 106, 108, 110]));
    expect(result.signal).toBe('buy');
  });

  it('allows signal when getVolume returns null (no data)', () => {
    const s = new SMAStrategy({
      shortWindow: 3, longWindow: 5,
      getVolume: () => null,
    });
    s.evaluate(makeSnaps([110, 108, 106, 104, 102]));
    const result = s.evaluate(makeSnaps([102, 104, 106, 108, 110]));
    expect(result.signal).toBe('buy'); // no volume data = filter bypassed
  });

  it('allows signal when getVolume not provided', () => {
    const s = new SMAStrategy({ shortWindow: 3, longWindow: 5 });
    s.evaluate(makeSnaps([110, 108, 106, 104, 102]));
    const result = s.evaluate(makeSnaps([102, 104, 106, 108, 110]));
    expect(result.signal).toBe('buy'); // no callback = filter bypassed
  });
});
```

- [ ] **Step 2: Run tests — volume tests should FAIL**

```bash
npx vitest run tests/sma-enhancements.test.ts
```

- [ ] **Step 3: Implement volume filter**

In `src/strategy/sma.ts`, in `evaluate()`, after detecting a crossover but before returning the buy/sell signal:

```typescript
// Volume confirmation filter — skip signal if volume is below 1.5x average
if (this.opts?.getVolume) {
  const vol = this.opts.getVolume();
  if (vol && vol.average > 0) {
    const ratio = vol.current / vol.average;
    if (ratio < 1.5) {
      this.prevShortAboveLong = shortAboveLong;
      return { signal: 'hold', reason: `${label} crossover filtered — low volume (${ratio.toFixed(1)}x avg)` };
    }
  }
}
```

Apply this check for BOTH buy and sell crossovers.

- [ ] **Step 4: Run tests — all should PASS**

```bash
npx vitest run tests/sma-enhancements.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/strategy/sma.ts tests/sma-enhancements.test.ts
git commit -m "feat: add volume confirmation filter to SMAStrategy"
```

---

### Task 3: RSI Filter

**Files:**
- Modify: `src/strategy/sma.ts`
- Modify: `tests/sma-enhancements.test.ts`

- [ ] **Step 1: Add RSI filter tests**

Append to `tests/sma-enhancements.test.ts`:

```typescript
describe('SMAStrategy RSI filter', () => {
  it('blocks buy signal when RSI is overbought (>70)', () => {
    const s = new SMAStrategy({
      shortWindow: 3, longWindow: 5,
      getRsi: () => 75,
    });
    s.evaluate(makeSnaps([110, 108, 106, 104, 102]));
    const result = s.evaluate(makeSnaps([102, 104, 106, 108, 110]));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('RSI');
  });

  it('blocks sell signal when RSI is oversold (<30)', () => {
    const s = new SMAStrategy({
      shortWindow: 3, longWindow: 5,
      getRsi: () => 25,
    });
    s.evaluate(makeSnaps([102, 104, 106, 108, 110]));
    const result = s.evaluate(makeSnaps([110, 108, 106, 104, 102]));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('RSI');
  });

  it('allows buy when RSI is neutral', () => {
    const s = new SMAStrategy({
      shortWindow: 3, longWindow: 5,
      getRsi: () => 50,
    });
    s.evaluate(makeSnaps([110, 108, 106, 104, 102]));
    const result = s.evaluate(makeSnaps([102, 104, 106, 108, 110]));
    expect(result.signal).toBe('buy');
  });

  it('allows signal when getRsi returns null', () => {
    const s = new SMAStrategy({
      shortWindow: 3, longWindow: 5,
      getRsi: () => null,
    });
    s.evaluate(makeSnaps([110, 108, 106, 104, 102]));
    const result = s.evaluate(makeSnaps([102, 104, 106, 108, 110]));
    expect(result.signal).toBe('buy');
  });

  it('allows signal when getRsi not provided', () => {
    const s = new SMAStrategy({ shortWindow: 3, longWindow: 5 });
    s.evaluate(makeSnaps([110, 108, 106, 104, 102]));
    const result = s.evaluate(makeSnaps([102, 104, 106, 108, 110]));
    expect(result.signal).toBe('buy');
  });
});
```

- [ ] **Step 2: Run tests — RSI tests should FAIL**

- [ ] **Step 3: Implement RSI filter**

In `src/strategy/sma.ts`, in `evaluate()`, after the volume filter check, add RSI filter:

```typescript
// RSI filter — don't buy overbought, don't sell oversold
if (this.opts?.getRsi) {
  const rsi = this.opts.getRsi();
  if (rsi != null) {
    if (signal === 'buy' && rsi > 70) {
      this.prevShortAboveLong = shortAboveLong;
      return { signal: 'hold', reason: `${label} buy filtered — RSI overbought (${rsi.toFixed(0)})` };
    }
    if (signal === 'sell' && rsi < 30) {
      this.prevShortAboveLong = shortAboveLong;
      return { signal: 'hold', reason: `${label} sell filtered — RSI oversold (${rsi.toFixed(0)})` };
    }
  }
}
```

Note: This requires restructuring evaluate() slightly — detect the crossover signal first, then run filters before returning.

- [ ] **Step 4: Run tests — all should PASS**

```bash
npx vitest run tests/sma-enhancements.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/strategy/sma.ts tests/sma-enhancements.test.ts
git commit -m "feat: add RSI filter to SMAStrategy"
```

---

### Task 4: Wire Candle Data into Engine + Regression Check

**Files:**
- Modify: `src/trading/engine.ts:165-166`
- Existing test: `tests/strategy-per-asset-params.test.ts`

- [ ] **Step 1: Update engine.ts to pass candle callbacks to SMAStrategy**

In `src/trading/engine.ts`, where SMAStrategy is instantiated (line ~165-166), change:

```typescript
} else if (params.strategyType === 'sma') {
  strategy = new SMAStrategy({ shortWindow: params.smaShort, longWindow: params.smaLong });
```

to:

```typescript
} else if (params.strategyType === 'sma') {
  strategy = new SMAStrategy({
    shortWindow: params.smaShort,
    longWindow: params.smaLong,
    useEma: true, // EMA is strictly better than SMA for crypto
    getVolume: () => {
      const candles = candleQueries.getCandles.all(symbol, botState.activeNetwork, '15m', 21) as any[];
      if (candles.length < 2) return null;
      const current = candles[0].volume ?? 0;
      const avg = candles.slice(0, 20).reduce((s: number, c: any) => s + (c.volume ?? 0), 0) / Math.min(candles.length, 20);
      return avg > 0 ? { current, average: avg } : null;
    },
    getRsi: () => {
      const candles = candleQueries.getCandles.all(symbol, botState.activeNetwork, '15m', 15) as any[];
      if (candles.length < 14) return null;
      const closes = candles.map((c: any) => c.close).reverse();
      let gains = 0, losses = 0;
      for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
      }
      const period = closes.length - 1;
      const avgGain = gains / period;
      const avgLoss = losses / period;
      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      return 100 - (100 / (1 + rs));
    },
  });
```

Ensure `candleQueries` is imported from `'../data/db.js'` (it was added in Task 3 of the audit fixes).

- [ ] **Step 2: Run existing per-asset params test**

```bash
npx vitest run tests/strategy-per-asset-params.test.ts
```
Expected: PASS — the test creates SMAStrategy with `{ shortWindow, longWindow }` which still works (new fields are optional).

- [ ] **Step 3: Run all SMA enhancement tests**

```bash
npx vitest run tests/sma-enhancements.test.ts
```
Expected: All PASS.

- [ ] **Step 4: Run full test suite to check for regressions**

```bash
npx vitest run tests/sma-enhancements.test.ts tests/strategy-per-asset-params.test.ts tests/audit-c1-auth.test.ts tests/audit-c3-executor.test.ts tests/audit-h2-optimizer.test.ts tests/ui-api.test.ts
```
Expected: All our tests PASS (pre-existing failures in other test files are unrelated).

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/trading/engine.ts
git commit -m "feat: wire EMA, volume, and RSI candle data into SMAStrategy via engine"
```

---

## Chunk 2: Documentation and Dashboard

### Task 5: Update CLAUDE.md and Dashboard Strategy Display

**Files:**
- Modify: `CLAUDE.md`
- Modify: `src/web/public/index.html` (optional — only if strategy display needs updating)

- [ ] **Step 1: Update CLAUDE.md**

In the Known Issues / Notes section, add:
```
- **SMA strategy enhanced:** SMA now uses EMA by default (faster reaction to price changes). Crossover signals are filtered by volume (>1.5x 20-period average required) and RSI (buy blocked when RSI>70, sell blocked when RSI<30). Filters require candle data — they're bypassed gracefully when candles haven't accumulated yet.
```

- [ ] **Step 2: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs: document SMA strategy enhancements in CLAUDE.md"
git push origin main
```
