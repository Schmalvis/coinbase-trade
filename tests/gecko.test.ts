import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Mock logger
vi.mock('../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

// Mock db queries — pool cache stored in settings table
vi.mock('../src/data/db.js', () => ({
  db: {},
  queries: {},
  settingQueries: {
    getSetting: { get: vi.fn() },
    upsertSetting: { run: vi.fn() },
  },
}));

import { GeckoTerminalService } from '../src/services/gecko.js';
import { settingQueries } from '../src/data/db.js';

describe('GeckoTerminalService.getPoolAddress', () => {
  let svc: GeckoTerminalService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new GeckoTerminalService();
  });

  it('returns cached pool address from settings table', async () => {
    const mockGet = settingQueries.getSetting.get as ReturnType<typeof vi.fn>;
    mockGet.mockReturnValue({ value: '0xpooladdress' });

    const result = await svc.getPoolAddress('0xtokenaddress');
    expect(result).toBe('0xpooladdress');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches pool from API when not cached, stores result', async () => {
    const mockGet = settingQueries.getSetting.get as ReturnType<typeof vi.fn>;
    mockGet.mockReturnValue(undefined);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ attributes: { address: '0xfreshpool' } }],
      }),
    });

    const result = await svc.getPoolAddress('0xtoken123');
    expect(result).toBe('0xfreshpool');
    expect(settingQueries.getSetting.get).toHaveBeenCalledWith('gecko_pool_0xtoken123');
    expect(settingQueries.upsertSetting.run).toHaveBeenCalledWith('gecko_pool_0xtoken123', '0xfreshpool');
  });

  it('returns null when API returns no pools', async () => {
    const mockGet = settingQueries.getSetting.get as ReturnType<typeof vi.fn>;
    mockGet.mockReturnValue(undefined);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });

    const result = await svc.getPoolAddress('0xunknown');
    expect(result).toBeNull();
  });
});

describe('GeckoTerminalService.fetchCandles', () => {
  let svc: GeckoTerminalService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new GeckoTerminalService();
    // Pool already cached
    (settingQueries.getSetting.get as ReturnType<typeof vi.fn>).mockReturnValue({ value: '0xpool' });
  });

  it('maps GeckoTerminal OHLCV list to Candle objects', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          attributes: {
            ohlcv_list: [
              [1746000000, 1.0, 1.2, 0.9, 1.1, 5000],
              [1746003600, 1.1, 1.3, 1.0, 1.2, 6000],
            ],
          },
        },
      }),
    });

    const candles = await svc.fetchCandles('0xtoken', 'AERO', 'base-mainnet', '15m');
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({
      symbol: 'AERO',
      network: 'base-mainnet',
      interval: '15m',
      open: 1.0,
      high: 1.2,
      low: 0.9,
      close: 1.1,
      volume: 5000,
      source: 'dex',
    });
    expect(candles[0].openTime).toBe(new Date(1746000000 * 1000).toISOString());
  });

  it('returns [] when pool not found', async () => {
    (settingQueries.getSetting.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });

    const candles = await svc.fetchCandles('0xunknown', 'UNKNOWN', 'base-mainnet', '1h');
    expect(candles).toEqual([]);
  });

  it('returns [] on API error, logs warning', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });
    const candles = await svc.fetchCandles('0xtoken', 'AERO', 'base-mainnet', '15m');
    expect(candles).toEqual([]);
  });
});
