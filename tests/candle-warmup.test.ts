import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so these refs are available inside vi.mock factories
const { mockInsertCandle, mockGetCandles, mockRecentAssetSnapshots } = vi.hoisted(() => ({
  mockInsertCandle: vi.fn(),
  mockGetCandles: vi.fn(),
  mockRecentAssetSnapshots: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  config: {
    NETWORK_ID: 'base-sepolia',
    MCP_SERVER_URL: 'http://localhost:3002/mcp',
    ALCHEMY_API_KEY: undefined,
  },
  availableNetworks: ['base-sepolia'],
}));

vi.mock('../src/data/db.js', () => ({
  candleQueries: {
    insertCandle: { run: mockInsertCandle },
    getCandles: { all: mockGetCandles },
    deleteOldCandles: { run: vi.fn() },
  },
  queries: {
    recentAssetSnapshots: { all: mockRecentAssetSnapshots },
  },
  settingQueries: {
    getSetting: { get: vi.fn(() => undefined) },
    upsertSetting: { run: vi.fn() },
  },
  discoveredAssetQueries: {
    seedRegistryAsset: { run: vi.fn() },
  },
}));

vi.mock('../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { CandleService } from '../src/services/candles.js';

// Helper: build N snapshots spaced intervalMinutes apart, oldest first
function makeSnapshots(count: number, intervalMinutes: number, basePrice = 3000): {
  price_usd: number; balance: number; timestamp: string;
}[] {
  const base = Date.now() - count * intervalMinutes * 60 * 1000;
  return Array.from({ length: count }, (_, i) => ({
    price_usd: basePrice + i,
    balance: 1,
    timestamp: new Date(base + i * intervalMinutes * 60 * 1000).toISOString(),
  }));
}

describe('CandleService.warmupFromSnapshots', () => {
  let service: CandleService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CandleService('base-sepolia');
  });

  it('synthesises 15m candles from 10 snapshots 2min apart', () => {
    mockGetCandles.mockReturnValue([]);
    // 10 snapshots, 2 minutes apart → spans 18 minutes → at least 1 complete 15m window
    const snaps = makeSnapshots(10, 2);
    // recentAssetSnapshots returns newest-first; warmupFromSnapshots reverses them
    mockRecentAssetSnapshots.mockReturnValue([...snaps].reverse());

    service.warmupFromSnapshots(['ETH'], 'base-sepolia');

    expect(mockInsertCandle).toHaveBeenCalled();
    for (const [arg] of mockInsertCandle.mock.calls) {
      expect(arg.interval).toBe('15m');
      expect(arg.source).toBe('synthetic');
      expect(arg.symbol).toBe('ETH');
      expect(arg.network).toBe('base-sepolia');
    }
  });

  it('skips warmup when candles already exist for a symbol', () => {
    mockGetCandles.mockReturnValue([{ symbol: 'ETH', interval: '15m' }]);

    service.warmupFromSnapshots(['ETH'], 'base-sepolia');

    expect(mockRecentAssetSnapshots).not.toHaveBeenCalled();
    expect(mockInsertCandle).not.toHaveBeenCalled();
  });

  it('handles empty snapshots gracefully without inserting candles', () => {
    mockGetCandles.mockReturnValue([]);
    mockRecentAssetSnapshots.mockReturnValue([]);

    service.warmupFromSnapshots(['ETH'], 'base-sepolia');

    expect(mockInsertCandle).not.toHaveBeenCalled();
  });

  it('handles fewer than 2 snapshots gracefully', () => {
    mockGetCandles.mockReturnValue([]);
    mockRecentAssetSnapshots.mockReturnValue([{
      price_usd: 3000, balance: 1, timestamp: new Date().toISOString(),
    }]);

    service.warmupFromSnapshots(['ETH'], 'base-sepolia');

    expect(mockInsertCandle).not.toHaveBeenCalled();
  });
});
