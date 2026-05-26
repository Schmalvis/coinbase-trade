import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/data/db.js', () => ({
  queries: {},
  discoveredAssetQueries: { getActiveAssets: { all: vi.fn().mockReturnValue([]) } },
  watchlistQueries: { getWatchlist: { all: vi.fn().mockReturnValue([]) } },
  rotationQueries: {},
  dailyPnlQueries: {},
  runTransaction: vi.fn(),
}));
vi.mock('../src/core/state.js', () => ({
  botState: { assetBalances: new Map(), lastPrice: 3000 },
}));
vi.mock('../src/assets/registry.js', () => ({
  assetsForNetwork: vi.fn().mockReturnValue([{ symbol: 'ETH' }, { symbol: 'USDC' }]),
}));

import { PortfolioOptimizer } from '../src/trading/optimizer.js';
import type { ScoreInputs } from '../src/trading/optimizer.js';

function makeRc() {
  return { get: vi.fn(), subscribe: vi.fn(), subscribeMany: vi.fn() };
}
function makeStrategy(signal = 'hold', strength = 0) {
  return { evaluate: vi.fn().mockReturnValue({ signal, strength, reason: 'mock' }) };
}
function makeCandleService(candles: unknown[] = []) {
  return { getStoredCandles: vi.fn().mockReturnValue(candles) };
}

describe('PortfolioOptimizer.computeScores() — pure path via ScoreInputs', () => {
  it('returns a score entry per symbol', () => {
    const optimizer = new PortfolioOptimizer(
      makeCandleService() as any, makeStrategy() as any,
      {} as any, {} as any, makeRc() as any,
    );
    const inputs: ScoreInputs = {
      symbols: ['ETH', 'USDC'],
      balances: new Map([['ETH', 0.1], ['USDC', 50]]),
      prices:   new Map([['ETH', 3000], ['USDC', 1]]),
    };
    const scores = optimizer.computeScores('base-sepolia', inputs);
    expect(scores).toHaveLength(2);
    expect(scores.map(s => s.symbol)).toContain('ETH');
  });

  it('score is 0 when no candles are available', () => {
    const optimizer = new PortfolioOptimizer(
      makeCandleService() as any, makeStrategy() as any,
      {} as any, {} as any, makeRc() as any,
    );
    const [score] = optimizer.computeScores('base-sepolia', {
      symbols: ['ETH'],
      balances: new Map([['ETH', 0.1]]),
      prices:   new Map([['ETH', 3000]]),
    });
    expect(score.score).toBe(0);
  });

  it('applies volume bonus (+10) on a buy signal with high volume', () => {
    const highVolCandle = { open: 3000, high: 3050, low: 2950, close: 3020, volume: 300, source: 'coinbase' };
    const baseCandles = Array.from({ length: 25 }, () => ({
      open: 3000, high: 3010, low: 2990, close: 3000, volume: 100, source: 'coinbase',
    }));
    const candles = [highVolCandle, ...baseCandles];
    const strategy = makeStrategy('buy', 60);
    const optimizer = new PortfolioOptimizer(
      makeCandleService(candles) as any, strategy as any,
      {} as any, {} as any, makeRc() as any,
    );
    const [score] = optimizer.computeScores('base-sepolia', {
      symbols: ['ETH'],
      balances: new Map([['ETH', 0.1]]),
      prices:   new Map([['ETH', 3000]]),
    });
    // raw = 60*0.5 + 60*0.3 + 60*0.2 = 60; confidence=1.0; score=60; volume bonus +10 → 70
    expect(score.score).toBe(70);
    expect(score.confidence).toBe(1.0);
  });

  it('clamps score to [-100, 100]', () => {
    const candles = Array.from({ length: 26 }, () => ({
      open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, source: 'coinbase',
    }));
    const optimizer = new PortfolioOptimizer(
      makeCandleService(candles) as any, makeStrategy('buy', 150) as any,
      {} as any, {} as any, makeRc() as any,
    );
    const [score] = optimizer.computeScores('base-sepolia', {
      symbols: ['ETH'],
      balances: new Map([['ETH', 0.1]]),
      prices:   new Map([['ETH', 3000]]),
    });
    expect(score.score).toBeLessThanOrEqual(100);
  });

  it('marks asset as held when USD value >= $2', () => {
    const optimizer = new PortfolioOptimizer(
      makeCandleService() as any, makeStrategy() as any,
      {} as any, {} as any, makeRc() as any,
    );
    const scores = optimizer.computeScores('base-sepolia', {
      symbols: ['ETH', 'USDC'],
      balances: new Map([['ETH', 0.001], ['USDC', 50]]),
      prices:   new Map([['ETH', 3000], ['USDC', 1]]),
    });
    const eth  = scores.find(s => s.symbol === 'ETH')!;
    const usdc = scores.find(s => s.symbol === 'USDC')!;
    expect(eth.isHeld).toBe(true);   // 0.001 * 3000 = $3 ≥ $2
    expect(usdc.isHeld).toBe(true);  // 50 * 1 = $50 ≥ $2
  });
});
