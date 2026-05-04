import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

// Mock config to avoid process.exit
vi.mock('../src/config.ts', () => ({ getConfig: () => ({}) }));

// Mock state and other dependencies
vi.mock('../src/core/state.js', () => ({ botState: {} }));
vi.mock('../src/data/db.js', () => ({ db: {}, queries: {} }));
vi.mock('../src/wallet/tools.js', () => ({ CoinbaseTools: {} }));
vi.mock('../src/assets/registry.js', () => ({ ASSET_REGISTRY: [] }));

// Import after mocks
import { SlippageCache } from '../src/trading/slippage-cache.js';
import { isShadowPeriod } from '../src/trading/executor.js';

describe('SlippageCache', () => {
  let cache: SlippageCache;

  beforeEach(() => {
    cache = new SlippageCache();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('returns null on cache miss', () => {
    expect(cache.get('AERO')).toBeNull();
  });

  it('returns cached impact within 5 minutes', () => {
    cache.set('AERO', 0.8);
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(cache.get('AERO')).toBe(0.8);
  });

  it('returns null after 5 minutes (cache expired)', () => {
    cache.set('AERO', 0.8);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(cache.get('AERO')).toBeNull();
  });
});

describe('shadow period gate', () => {
  it('isShadowPeriod returns true when shadow_until is in the future', () => {
    const futureTs = Date.now() + 60_000;
    expect(isShadowPeriod(futureTs)).toBe(true);
  });

  it('isShadowPeriod returns false when shadow_until is null', () => {
    expect(isShadowPeriod(null)).toBe(false);
  });

  it('isShadowPeriod returns false when shadow_until is in the past', () => {
    const pastTs = Date.now() - 60_000;
    expect(isShadowPeriod(pastTs)).toBe(false);
  });
});
