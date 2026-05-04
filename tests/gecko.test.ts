import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Mock logger
vi.mock('../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

// Mock db queries — pool cache stored in settings table
vi.mock('../src/data/db.js', () => ({
  db: {},
  queries: {
    getSetting: { get: vi.fn() },
    upsertSetting: { run: vi.fn() },
  },
}));

import { GeckoTerminalService } from '../src/services/gecko.js';
import { queries } from '../src/data/db.js';

describe('GeckoTerminalService.getPoolAddress', () => {
  let svc: GeckoTerminalService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new GeckoTerminalService();
  });

  it('returns cached pool address from settings table', async () => {
    const mockGet = queries.getSetting.get as ReturnType<typeof vi.fn>;
    mockGet.mockReturnValue({ value: '0xpooladdress' });

    const result = await svc.getPoolAddress('0xtokenaddress');
    expect(result).toBe('0xpooladdress');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches pool from API when not cached, stores result', async () => {
    const mockGet = queries.getSetting.get as ReturnType<typeof vi.fn>;
    mockGet.mockReturnValue(undefined);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ attributes: { address: '0xfreshpool' } }],
      }),
    });

    const result = await svc.getPoolAddress('0xtoken123');
    expect(result).toBe('0xfreshpool');
    expect(queries.getSetting.get).toHaveBeenCalledWith('gecko_pool_0xtoken123');
    expect(queries.upsertSetting.run).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'gecko_pool_0xtoken123', value: '0xfreshpool' }),
    );
  });

  it('returns null when API returns no pools', async () => {
    const mockGet = queries.getSetting.get as ReturnType<typeof vi.fn>;
    mockGet.mockReturnValue(undefined);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });

    const result = await svc.getPoolAddress('0xunknown');
    expect(result).toBeNull();
  });
});
