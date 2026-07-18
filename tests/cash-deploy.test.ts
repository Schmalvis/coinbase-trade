import { describe, it, expect } from 'vitest';
import { selectCashDeployBuy } from '../src/trading/optimizer.js';

type S = { symbol: string; score: number; currentWeight: number };

const base = (over: Partial<Record<string, Partial<S>>> = {}): S[] => [
  { symbol: 'USDC', score: 0, currentWeight: 85, ...(over.USDC ?? {}) },
  { symbol: 'ETH', score: 10, currentWeight: 8, ...(over.ETH ?? {}) },
  { symbol: 'CBBTC', score: 5, currentWeight: 4, ...(over.CBBTC ?? {}) },
  { symbol: 'CBETH', score: 2, currentWeight: 3, ...(over.CBETH ?? {}) },
];

const opts = (o: Partial<{ maxCashPct: number; maxPosPct: number; selfManaged: Set<string>; macroGateActive: boolean }> = {}) => ({
  maxCashPct: 40,
  maxPosPct: 35,
  selfManaged: new Set<string>(),
  macroGateActive: false,
  ...o,
});

describe('selectCashDeployBuy', () => {
  it('returns null when the macro gate is active (ETH downtrend)', () => {
    expect(selectCashDeployBuy(base(), opts({ macroGateActive: true }))).toBeNull();
  });

  it('returns null when USDC is at or under the cash cap', () => {
    expect(selectCashDeployBuy(base({ USDC: { currentWeight: 40 } }), opts())).toBeNull();
    expect(selectCashDeployBuy(base({ USDC: { currentWeight: 30 } }), opts())).toBeNull();
  });

  it('deploys into the highest-scoring eligible asset when over the cash cap', () => {
    expect(selectCashDeployBuy(base(), opts())).toBe('ETH'); // ETH score 10 > CBBTC 5 > CBETH 2
  });

  it('skips self-managed assets even if highest-scoring', () => {
    // ETH is self-managed → next best eligible is CBBTC
    expect(selectCashDeployBuy(base(), opts({ selfManaged: new Set(['ETH']) }))).toBe('CBBTC');
  });

  it('skips assets already at or over the position cap', () => {
    // ETH already at 35% (== cap) → excluded; CBBTC is next best
    expect(selectCashDeployBuy(base({ ETH: { currentWeight: 35 } }), opts())).toBe('CBBTC');
  });

  it('does not deploy into negatively-scored assets; returns null when all are negative', () => {
    const allNeg = base({ ETH: { score: -5 }, CBBTC: { score: -2 }, CBETH: { score: -1 } });
    expect(selectCashDeployBuy(allNeg, opts())).toBeNull();
  });

  it('includes a zero-scored asset (neutral is eligible)', () => {
    const neutralOnly = base({ ETH: { score: -5 }, CBBTC: { score: -3 }, CBETH: { score: 0 } });
    expect(selectCashDeployBuy(neutralOnly, opts())).toBe('CBETH');
  });

  it('returns null when there is no USDC score row', () => {
    const noUsdc = base().filter(s => s.symbol !== 'USDC');
    expect(selectCashDeployBuy(noUsdc, opts())).toBeNull();
  });
});
