import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetSetting,
  mockUpsertSetting,
  mockSetWalletAddress,
  mockSetStatus,
  mockEmitAlert,
  mockGetWalletDetails,
} = vi.hoisted(() => ({
  mockGetSetting: vi.fn(),
  mockUpsertSetting: vi.fn(),
  mockSetWalletAddress: vi.fn(),
  mockSetStatus: vi.fn(),
  mockEmitAlert: vi.fn(),
  mockGetWalletDetails: vi.fn(),
}));

vi.mock('../src/data/db.js', () => ({
  queries: {
    insertAssetSnapshot: { run: vi.fn() },
    insertSnapshot: { run: vi.fn() },
    insertPortfolioSnapshot: { run: vi.fn() },
  },
  discoveredAssetQueries: {
    getDiscoveredAssets: { all: vi.fn().mockReturnValue([]) },
    getAssetByAddress: { get: vi.fn().mockReturnValue(null) },
    upsertDiscoveredAsset: { run: vi.fn() },
  },
  settingQueries: {
    getSetting: { get: mockGetSetting },
    upsertSetting: { run: mockUpsertSetting },
    getAllSettings: { all: vi.fn().mockReturnValue([]) },
  },
}));

vi.mock('../src/core/state.js', () => ({
  botState: {
    activeNetwork: 'base-sepolia',
    updateAssetBalance: vi.fn(),
    updatePrice: vi.fn(),
    setPendingTokenCount: vi.fn(),
    setWalletAddress: mockSetWalletAddress,
    setStatus: mockSetStatus,
    emitAlert: mockEmitAlert,
  },
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/assets/registry.js', () => ({
  assetsForNetwork: () => [],
}));

const mockRuntimeConfig = {
  get: vi.fn((k: string) => k === 'POLL_INTERVAL_SECONDS' ? 30 : undefined),
  subscribe: vi.fn(),
};

const mockTools = {
  getWalletDetails: mockGetWalletDetails,
  fetchPriceFeedId: vi.fn(),
  fetchPrice: vi.fn().mockResolvedValue(2000),
  getErc20Balance: vi.fn().mockResolvedValue(0),
  getTokenPrices: vi.fn().mockResolvedValue({}),
} as any;

import { startPortfolioTracker } from '../src/portfolio/tracker.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWalletDetails.mockResolvedValue({ address: '0xABC', balance: '1.0' });
});

describe('Wallet address monitoring', () => {
  it('stores address on first poll when not in DB', async () => {
    mockGetSetting.mockReturnValue(undefined); // not stored yet
    await startPortfolioTracker(mockTools, mockRuntimeConfig as any);
    expect(mockUpsertSetting).toHaveBeenCalledWith('EXPECTED_WALLET_ADDRESS', '0xABC');
    expect(mockSetWalletAddress).toHaveBeenCalledWith('0xABC');
  });

  it('does nothing special when address matches stored', async () => {
    mockGetSetting.mockReturnValue({ value: '0xABC' }); // already stored, matches
    await startPortfolioTracker(mockTools, mockRuntimeConfig as any);
    expect(mockSetStatus).not.toHaveBeenCalledWith('paused');
    expect(mockEmitAlert).not.toHaveBeenCalled();
    expect(mockSetWalletAddress).toHaveBeenCalledWith('0xABC');
    expect(mockUpsertSetting).not.toHaveBeenCalled();
  });

  it('pauses bot and emits alert when address changes', async () => {
    mockGetSetting.mockReturnValue({ value: '0xOLDADDRESS' }); // stored = old
    mockGetWalletDetails.mockResolvedValue({ address: '0xNEWADDRESS', balance: '0' });
    await startPortfolioTracker(mockTools, mockRuntimeConfig as any);
    expect(mockSetStatus).toHaveBeenCalledWith('paused');
    expect(mockEmitAlert).toHaveBeenCalledWith(expect.stringContaining('WALLET ADDRESS CHANGED'));
  });
});
