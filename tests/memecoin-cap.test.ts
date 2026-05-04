import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

// Import after mocks
import { SlippageCache } from '../src/trading/slippage-cache.js';

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
