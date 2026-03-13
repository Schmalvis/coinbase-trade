import { describe, it, expect } from 'vitest';
import { ASSET_REGISTRY, assetsForNetwork, getAsset } from '../src/assets/registry.js';

describe('asset registry', () => {
  it('all assets have a symbol and decimals', () => {
    for (const a of ASSET_REGISTRY) {
      expect(typeof a.symbol).toBe('string');
      expect(a.symbol.length).toBeGreaterThan(0);
      expect(typeof a.decimals).toBe('number');
    }
  });

  it('ETH is in the registry with isNative=true', () => {
    const eth = getAsset('ETH');
    expect(eth.isNative).toBe(true);
  });

  it('assetsForNetwork base-mainnet includes ETH, USDC, CBBTC, CBETH', () => {
    const symbols = assetsForNetwork('base-mainnet').map(a => a.symbol);
    expect(symbols).toContain('ETH');
    expect(symbols).toContain('USDC');
    expect(symbols).toContain('CBBTC');
    expect(symbols).toContain('CBETH');
  });

  it('assetsForNetwork base-sepolia does NOT include CBBTC or CBETH', () => {
    const symbols = assetsForNetwork('base-sepolia').map(a => a.symbol);
    expect(symbols).not.toContain('CBBTC');
    expect(symbols).not.toContain('CBETH');
  });

  it('getAsset throws for unknown symbol', () => {
    expect(() => getAsset('FAKECOIN')).toThrow('Asset not found in registry: FAKECOIN');
  });

  it('all pyth assets have a pythSymbol', () => {
    for (const a of ASSET_REGISTRY.filter(a => a.priceSource === 'pyth')) {
      expect(typeof a.pythSymbol).toBe('string');
    }
  });

  it('assetsForNetwork returns empty array for unknown network', () => {
    const assets = assetsForNetwork('base-unknown');
    expect(assets).toHaveLength(0);
  });
});
