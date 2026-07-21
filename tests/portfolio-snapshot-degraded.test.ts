import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockInsertPortfolioSnapshot,
  mockGetDiscoveredAssets,
} = vi.hoisted(() => ({
  mockInsertPortfolioSnapshot: vi.fn(),
  mockGetDiscoveredAssets: vi.fn(),
}));

vi.mock('../src/data/db.js', () => ({
  queries: {
    insertAssetSnapshot: { run: vi.fn() },
    insertPortfolioSnapshot: { run: mockInsertPortfolioSnapshot },
  },
  discoveredAssetQueries: {
    getDiscoveredAssets: { all: mockGetDiscoveredAssets },
    getAssetByAddress: { get: vi.fn().mockReturnValue(null) },
    upsertDiscoveredAsset: { run: vi.fn() },
    getActiveAssets: { all: vi.fn().mockReturnValue([]) },
  },
  settingQueries: {
    getSetting: { get: vi.fn().mockReturnValue(undefined) },
    upsertSetting: { run: vi.fn() },
  },
  candleQueries: {
    getCandles: { all: vi.fn().mockReturnValue([]) },
  },
}));

vi.mock('../src/core/state.js', () => ({
  botState: {
    activeNetwork: 'base-sepolia',
    updateAssetBalance: vi.fn(),
    updatePrice: vi.fn(),
    setPendingTokenCount: vi.fn(),
    setWalletAddress: vi.fn(),
    setStatus: vi.fn(),
    emitAlert: vi.fn(),
  },
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// No registry assets — isolates the discovered-token (Alchemy) pricing path under test.
vi.mock('../src/assets/registry.js', () => ({
  assetsForNetwork: () => [],
}));

const mockRuntimeConfig = {
  get: vi.fn((k: string) => (k === 'POLL_INTERVAL_SECONDS' ? 30 : undefined)),
  subscribe: vi.fn(),
};

const mockTools = {
  getWalletDetails: vi.fn().mockResolvedValue({ address: '0xABC', balance: '0' }),
  fetchPriceFeedId: vi.fn(),
  fetchPrice: vi.fn(),
  getErc20Balance: vi.fn(),
  getTokenPrices: vi.fn().mockResolvedValue({}), // always unpriceable — no DefiLlama listing
} as any;

function makeAlchemyService() {
  return {
    getTokenBalances: vi.fn().mockResolvedValue([{ contractAddress: '0xspam', tokenBalance: '0x1' }]),
    getTokenMetadata: vi.fn(),
  } as any;
}

import { startPortfolioTracker } from '../src/portfolio/tracker.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockTools.getWalletDetails.mockResolvedValue({ address: '0xABC', balance: '0' });
  mockTools.getTokenPrices.mockResolvedValue({});
});

describe('portfolio snapshot vs unpriceable discovered tokens', () => {
  it('skips the snapshot when an ACTIVE discovered asset is held but unpriceable', async () => {
    mockGetDiscoveredAssets.mockReturnValue([
      { address: '0xspam', symbol: 'SPAM', decimals: 0, status: 'active' },
    ]);

    await startPortfolioTracker(mockTools, mockRuntimeConfig as any, makeAlchemyService());

    expect(mockInsertPortfolioSnapshot).not.toHaveBeenCalled();
  });

  it('still records a snapshot when only a PENDING (unvetted) discovered asset is unpriceable', async () => {
    // Regression: an undismissed spam/airdrop token sitting in 'pending' used to degrade
    // every poll forever (it can never be priced), silently starving portfolio_snapshots
    // and P&L history. Pending tokens aren't relied on for risk-guard decisions, so an
    // unpriceable one shouldn't block the authoritative snapshot.
    mockGetDiscoveredAssets.mockReturnValue([
      { address: '0xspam', symbol: 'SPAM', decimals: 0, status: 'pending' },
    ]);

    await startPortfolioTracker(mockTools, mockRuntimeConfig as any, makeAlchemyService());

    expect(mockInsertPortfolioSnapshot).toHaveBeenCalled();
  });
});
