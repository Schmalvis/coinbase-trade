import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (must be declared before vi.mock factories are evaluated) ──
const {
  mockLastTradeForSymbol,
  mockGetLatestAssetSnapshot,
  mockInsertTrade,
  mockInsertEvent,
  mockRecentAssetSnapshots,
  mockTodayRealizedPnl,
  mockGetActiveAssets,
  mockGetAssetBySymbol,
  mockGetAddressBySymbol,
  mockGetRecentRealizedTrades,
  mockRecentPortfolioSnapshots,
  mockAssetBalances,
  mockEmitAlert,
  mockRecordTrade,
  mockEmitTrade,
  mockSetStatus,
} = vi.hoisted(() => ({
  mockLastTradeForSymbol: { get: vi.fn() },
  mockGetLatestAssetSnapshot: { get: vi.fn() },
  mockInsertTrade: { run: vi.fn() },
  mockInsertEvent: { run: vi.fn() },
  mockRecentAssetSnapshots: { all: vi.fn().mockReturnValue([]) },
  mockTodayRealizedPnl: { get: vi.fn().mockReturnValue({ total: 0 }) },
  mockRecentPortfolioSnapshots: { all: vi.fn().mockReturnValue([{ portfolio_usd: 500 }]) },
  mockGetActiveAssets: { all: vi.fn().mockReturnValue([]) },
  mockGetAssetBySymbol: { get: vi.fn().mockReturnValue(null) },
  mockGetAddressBySymbol: { get: vi.fn().mockReturnValue(undefined) },
  mockGetRecentRealizedTrades: { all: vi.fn().mockReturnValue([]) },
  mockAssetBalances: new Map<string, number>(),
  mockEmitAlert: vi.fn(),
  mockRecordTrade: vi.fn(),
  mockEmitTrade: vi.fn(),
  mockSetStatus: vi.fn(),
}));

vi.mock('../src/data/db.js', () => ({
  queries: {
    lastTradeForSymbol: mockLastTradeForSymbol,
    getLatestAssetSnapshot: mockGetLatestAssetSnapshot,
    insertTrade: mockInsertTrade,
    insertEvent: mockInsertEvent,
    recentAssetSnapshots: mockRecentAssetSnapshots,
    recentPortfolioSnapshots: mockRecentPortfolioSnapshots,
    todayRealizedPnl: mockTodayRealizedPnl,
  },
  discoveredAssetQueries: {
    getActiveAssets: mockGetActiveAssets,
    getAssetBySymbol: mockGetAssetBySymbol,
    getAddressBySymbol: mockGetAddressBySymbol,
    getRecentRealizedTrades: mockGetRecentRealizedTrades,
  },
  dailyPnlQueries: {
    getTodayPnl: { get: vi.fn(() => undefined) },
  },
}));

vi.mock('../src/core/state.js', () => ({
  botState: {
    get assetBalances() { return mockAssetBalances; },
    get lastPrice() { return 2000; },
    emitAlert: mockEmitAlert,
    recordTrade: mockRecordTrade,
    emitTrade: mockEmitTrade,
    setStatus: mockSetStatus,
    isPaused: false,
    activeNetwork: 'base-mainnet',
  },
}));

// ── Mock logger ──
vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Mock assets registry — only symbols needed, full AssetDefinition not required ──
vi.mock('../src/assets/registry.js', () => ({
  ASSET_REGISTRY: [
    { symbol: 'ETH',   tradeMethod: 'agentkit', priceSource: 'pyth',      network: ['base-mainnet'] },
    { symbol: 'USDC',  tradeMethod: 'none',     priceSource: 'fixed',     network: ['base-mainnet'] },
    { symbol: 'CBBTC', tradeMethod: 'agentkit', priceSource: 'pyth',      network: ['base-mainnet'] },
    { symbol: 'CBETH', tradeMethod: 'agentkit', priceSource: 'defillama', network: ['base-mainnet'] },
  ],
}));

// ── Mock risk-guard ──
vi.mock('../src/trading/risk-guard.js', () => ({
  getMemecoincapVeto: vi.fn().mockResolvedValue(null),
  RiskGuard: class {},
}));

// ── Mock slippage-cache ──
vi.mock('../src/trading/slippage-cache.js', () => ({
  SlippageCache: class {
    get() { return null; }
    set() {}
  },
}));

// ── Minimal runtime config mock ──
const mockRuntimeConfig = {
  get: vi.fn((key: string) => {
    const defaults: Record<string, unknown> = {
      DRY_RUN: true,
      TRADE_COOLDOWN_SECONDS: 0,
      PORTFOLIO_FLOOR_USD: 0,
      MAX_POSITION_PCT: 100,
      MAX_TRADE_SIZE_ETH: 10,
      MAX_TRADE_SIZE_USDC: 10000,
    };
    return defaults[key] ?? null;
  }),
  subscribeMany: vi.fn(),
};

// ── Minimal tools mock ──
const mockTools = {
  swap: vi.fn().mockResolvedValue({ txHash: '0xabc123' }),
  getEthBalance: vi.fn().mockResolvedValue('1.0'),
};

import { TradeExecutor } from '../src/trading/executor.js';

describe('TradeExecutor.seedOpenPositions', () => {
  let executor: TradeExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAssetBalances.clear();
    mockGetActiveAssets.all.mockReturnValue([]);
    mockGetLatestAssetSnapshot.get.mockReturnValue(null);
    mockLastTradeForSymbol.get.mockReturnValue(undefined);
    executor = new TradeExecutor(mockTools as any, mockRuntimeConfig as any);
  });

  it('case 1: seeds from last buy trade (rule 1) — entryPrice=buy price, qty=min(buy qty, balance)', () => {
    mockGetLatestAssetSnapshot.get.mockImplementation((sym: string) =>
      sym === 'CBBTC' ? { balance: 0.5, price_usd: 100 } : null,
    );
    mockLastTradeForSymbol.get.mockImplementation((sym: string) =>
      sym === 'CBBTC'
        ? { action: 'buy', price_usd: 100, amount_eth: 0.5, entry_price: null }
        : undefined,
    );

    executor.seedOpenPositions('base-mainnet');

    expect(executor.getOpenPositions().get('CBBTC')).toEqual({ entryPrice: 100, qty: 0.5 });
  });

  it('case 2: seeds registry asset at snapshot price when no trade history (rule 3 fallback)', () => {
    mockGetLatestAssetSnapshot.get.mockImplementation((sym: string) =>
      sym === 'ETH' ? { balance: 0.01, price_usd: 3000 } : null,
    );
    // lastTradeForSymbol returns undefined for all → rule 3

    executor.seedOpenPositions('base-mainnet');

    expect(executor.getOpenPositions().get('ETH')).toEqual({ entryPrice: 3000, qty: 0.01 });
  });

  it('case 3: seeds from sell row entry_price when last trade is a partial sell (rule 2)', () => {
    mockGetLatestAssetSnapshot.get.mockImplementation((sym: string) =>
      sym === 'CBBTC' ? { balance: 0.2, price_usd: 95 } : null,
    );
    mockLastTradeForSymbol.get.mockImplementation((sym: string) =>
      sym === 'CBBTC'
        ? { action: 'sell', price_usd: 95, amount_eth: 0.1, entry_price: 90 }
        : undefined,
    );

    executor.seedOpenPositions('base-mainnet');

    expect(executor.getOpenPositions().get('CBBTC')).toEqual({ entryPrice: 90, qty: 0.2 });
  });

  it('case 4: skips zero-balance and dust assets', () => {
    mockGetLatestAssetSnapshot.get.mockImplementation((sym: string) => {
      if (sym === 'ETH')   return { balance: 0,        price_usd: 3000  }; // zero balance
      if (sym === 'CBETH') return { balance: 0.000001, price_usd: 2000  }; // dust ($0.002)
      if (sym === 'CBBTC') return { balance: 0.00001,  price_usd: 50000 }; // $0.50 — OK
      return null;
    });
    mockLastTradeForSymbol.get.mockImplementation((sym: string) =>
      sym === 'CBBTC'
        ? { action: 'buy', price_usd: 50000, amount_eth: 0.00001, entry_price: null }
        : undefined,
    );

    executor.seedOpenPositions('base-mainnet');

    const positions = executor.getOpenPositions();
    expect(positions.has('ETH')).toBe(false);
    expect(positions.has('CBETH')).toBe(false);
    expect(positions.has('USDC')).toBe(false);
    expect(positions.has('CBBTC')).toBe(true); // $0.50 — above $0.01 threshold
  });

  it('case 5: dry-run partial sell decrements qty and keeps position alive', async () => {
    // Seed CBBTC at entryPrice=100, qty=1.0
    mockGetLatestAssetSnapshot.get.mockImplementation((sym: string) =>
      sym === 'CBBTC' ? { balance: 1.0, price_usd: 100 } : null,
    );
    mockLastTradeForSymbol.get.mockImplementation((sym: string) =>
      sym === 'CBBTC'
        ? { action: 'buy', price_usd: 100, amount_eth: 1.0, entry_price: null }
        : undefined,
    );
    // Make asset snapshot available for price lookup during sell
    mockRecentAssetSnapshots.all.mockReturnValue([{ price_usd: 105 }]);
    mockAssetBalances.set('CBBTC', 1.0);

    executor.seedOpenPositions('base-mainnet');

    const before = executor.getOpenPositions().get('CBBTC');
    expect(before).toEqual({ entryPrice: 100, qty: 1.0 });

    // Dry-run sell — no network call, no real swap
    await executor.executeForAsset('CBBTC', 'sell', 'test partial sell');

    const after = executor.getOpenPositions().get('CBBTC');
    // Position must survive (decrement, not delete)
    expect(after).toBeDefined();
    expect(after!.entryPrice).toBe(100); // cost basis unchanged
    expect(after!.qty).toBeLessThan(1.0); // qty reduced
    expect(after!.qty).toBeGreaterThan(0); // but not gone
  });
});
