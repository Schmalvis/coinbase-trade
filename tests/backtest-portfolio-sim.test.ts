import { describe, it, expect } from 'vitest';
import { VirtualPortfolio } from '../src/backtest/portfolio-sim.js';
import type { BacktestConfig } from '../src/backtest/types.js';

const baseConfig: BacktestConfig = {
  network: 'base-mainnet',
  fromDate: '2026-06-01',
  toDate: '2026-06-13',
  dbPath: '',
  symbols: ['ETH', 'USDC'],
  feePct: 0.01,
  rotationSizePct: 0.25,
  sellThreshold: -20,
  buyThreshold: 30,
  minScoreDelta: 40,
  maxDailyRotations: 10,
  pairCooldownMs: 4 * 60 * 60 * 1000,
  initialBalances: new Map([['ETH', 0.05], ['USDC', 50]]),
  initialPrices: new Map([['ETH', 3000], ['USDC', 1]]),
};

describe('VirtualPortfolio', () => {
  it('computes starting portfolio USD correctly', () => {
    const p = new VirtualPortfolio(baseConfig);
    // 0.05 ETH * $3000 + 50 USDC * $1 = $200
    expect(p.getPortfolioUsd()).toBeCloseTo(200, 2);
    expect(p.startPortfolioUsd).toBeCloseTo(200, 2);
  });

  it('HODL-USDC always equals starting portfolio', () => {
    const p = new VirtualPortfolio(baseConfig);
    p.updatePrices(new Map([['ETH', 4000], ['USDC', 1]]));
    expect(p.getHodlUsdcUsd()).toBeCloseTo(200, 2);
  });

  it('HODL-ETH rises when ETH price rises', () => {
    const p = new VirtualPortfolio(baseConfig);
    const before = p.getHodlEthUsd();
    p.updatePrices(new Map([['ETH', 4000], ['USDC', 1]]));
    expect(p.getHodlEthUsd()).toBeGreaterThan(before);
  });

  it('HODL-portfolio uses initial balances at current prices', () => {
    const p = new VirtualPortfolio(baseConfig);
    p.updatePrices(new Map([['ETH', 6000], ['USDC', 1]]));
    // 0.05 * 6000 + 50 * 1 = $350
    expect(p.getHodlPortfolioUsd()).toBeCloseTo(350, 2);
  });

  it('executes a rotation and updates balances correctly', () => {
    const p = new VirtualPortfolio(baseConfig);
    // Sell 25% of 0.05 ETH ($37.50), 1% fee = $0.375, net $37.125 → USDC
    p.executeRotation('ETH', 'USDC', 50, -25, 35, '2026-06-02T10:00:00Z');
    expect(p.balances.get('ETH')!).toBeCloseTo(0.05 - 0.0125, 5);
    expect(p.balances.get('USDC')!).toBeCloseTo(50 + 37.125, 3);
    expect(p.rotations).toHaveLength(1);
    expect(p.rotations[0].feePaidUsd).toBeCloseTo(0.375, 3);
  });

  it('returns null for rotation below $2 minimum', () => {
    const cfg = {
      ...baseConfig,
      initialBalances: new Map([['ETH', 0.0001], ['USDC', 0]]),
    };
    const p = new VirtualPortfolio(cfg);
    // 0.0001 ETH * 25% * $3000 = $0.075 < $2
    const result = p.executeRotation('ETH', 'USDC', 50, -25, 35, '2026-06-02T10:00:00Z');
    expect(result).toBeNull();
    expect(p.rotations).toHaveLength(0);
  });

  it('respects daily rotation cap', () => {
    const cfg = { ...baseConfig, maxDailyRotations: 1 };
    const p = new VirtualPortfolio(cfg);
    p.executeRotation('ETH', 'USDC', 50, -25, 35, '2026-06-02T10:00:00Z');
    const check = p.canRotate('ETH', 'USDC', '2026-06-02T11:00:00Z');
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/cap/);
  });

  it('respects same-pair cooldown', () => {
    const p = new VirtualPortfolio(baseConfig);
    p.executeRotation('ETH', 'USDC', 50, -25, 35, '2026-06-02T10:00:00Z');
    // 1 hour later — within 4h cooldown
    const check = p.canRotate('ETH', 'USDC', '2026-06-02T11:00:00Z');
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/cooldown/);
  });

  it('allows rotation after cooldown expires', () => {
    const p = new VirtualPortfolio(baseConfig);
    p.executeRotation('ETH', 'USDC', 50, -25, 35, '2026-06-02T10:00:00Z');
    // 5 hours later — past 4h cooldown
    const check = p.canRotate('ETH', 'USDC', '2026-06-02T15:00:00Z');
    expect(check.ok).toBe(true);
  });

  it('does not apply cooldown to different pair', () => {
    const cfg = {
      ...baseConfig,
      initialBalances: new Map([['ETH', 0.05], ['CBBTC', 0.001], ['USDC', 50]]),
      initialPrices: new Map([['ETH', 3000], ['CBBTC', 90000], ['USDC', 1]]),
    };
    const p = new VirtualPortfolio(cfg);
    p.executeRotation('ETH', 'USDC', 50, -25, 35, '2026-06-02T10:00:00Z');
    // Different pair — no cooldown
    const check = p.canRotate('CBBTC', 'USDC', '2026-06-02T10:01:00Z');
    expect(check.ok).toBe(true);
  });
});
