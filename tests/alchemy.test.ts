import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlchemyService } from '../src/services/alchemy.js';

describe('AlchemyService', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('getTokenBalances — happy path returns tokenBalances array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: { tokenBalances: [
          { contractAddress: '0xabc', tokenBalance: '0x1a4' },
          { contractAddress: '0xdef', tokenBalance: '0x2710' },
        ]},
      }),
    }));
    const svc = new AlchemyService('testkey');
    const result = await svc.getTokenBalances('0xwallet', 'base-mainnet');
    expect(result).toHaveLength(2);
    expect(result[0].contractAddress).toBe('0xabc');
    expect(result[1].tokenBalance).toBe('0x2710');
  });

  it('getTokenMetadata — happy path returns symbol, name, decimals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { symbol: 'PEPE', name: 'Pepe Token', decimals: 18 } }),
    }));
    const svc = new AlchemyService('testkey');
    const meta = await svc.getTokenMetadata('0xcontract', 'base-mainnet');
    expect(meta.symbol).toBe('PEPE');
    expect(meta.name).toBe('Pepe Token');
    expect(meta.decimals).toBe(18);
  });

  it('getTokenBalances — network error propagates as rejected promise', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const svc = new AlchemyService('testkey');
    await expect(svc.getTokenBalances('0xwallet', 'base-mainnet')).rejects.toThrow('Network error');
  });

  it('uses base-sepolia host for testnet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { tokenBalances: [] } }),
    }));
    const svc = new AlchemyService('mykey');
    await svc.getTokenBalances('0xwallet', 'base-sepolia');
    const fetchMock = vi.mocked(fetch);
    expect((fetchMock.mock.calls[0][0] as string)).toContain('base-sepolia.g.alchemy.com');
  });
});
