import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB modules ──
const mockInsertEvent = { run: vi.fn() };
const mockGetTodayPnl = { get: vi.fn() };
const mockGetTodayRotationCount = { get: vi.fn() };
// db.prepare used by getMemePositionsUsd — return empty list (no memecoins)
const mockDbPrepare = vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined) }));

vi.mock('../src/data/db.js', () => ({
  queries: { insertEvent: mockInsertEvent },
  dailyPnlQueries: { getTodayPnl: mockGetTodayPnl },
  rotationQueries: { getTodayRotationCount: mockGetTodayRotationCount },
  db: { prepare: mockDbPrepare },
}));

// ── Mock botState ──
const mockSetStatus = vi.fn();
const mockEmitAlert = vi.fn();

vi.mock('../src/core/state.js', () => ({
  botState: {
    setStatus: mockSetStatus,
    emitAlert: mockEmitAlert,
    assetBalances: new Map(),
  },
}));

// ── Mock logger ──
vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Import after mocks ──
const { RiskGuard } = await import('../src/trading/risk-guard.js');
import type { RotationProposal } from '../src/trading/risk-guard.js';

// ── Mock RuntimeConfig ──
function makeMockConfig(overrides: Record<string, number> = {}) {
  const defaults: Record<string, number> = {
    PORTFOLIO_FLOOR_USD: 50,
    MAX_DAILY_LOSS_PCT: 5,
    MAX_DAILY_ROTATIONS: 10,
    MAX_POSITION_PCT: 40,
    MAX_ROTATION_PCT: 25,
    MIN_ROTATION_PROFIT_USD: 0.01,
    ...overrides,
  };
  return { get: (key: string) => defaults[key] } as any;
}

function baseProposal(overrides: Partial<RotationProposal> = {}): RotationProposal {
  return {
    sellSymbol: 'ETH',
    buySymbol: 'CBBTC',
    sellAmount: 100,
    estimatedGainPct: 3,
    estimatedFeePct: 0.5,
    buyTargetWeightPct: 30,
    ...overrides,
  };
}

describe('RiskGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTodayPnl.get.mockReturnValue(null);
    mockGetTodayRotationCount.get.mockReturnValue({ cnt: 0 });
  });

  it('approves when all limits within bounds', () => {
    const guard = new RiskGuard(makeMockConfig());
    const result = guard.checkRotation(baseProposal(), 'base-sepolia', 1000);

    expect(result.approved).toBe(true);
    expect(result.adjustedAmount).toBeDefined();
    expect(result.vetoReason).toBeUndefined();
    expect(mockInsertEvent.run).toHaveBeenCalledWith('risk_approved', expect.any(String));
  });

  it('vetoes when portfolioUsd < PORTFOLIO_FLOOR_USD and pauses bot', () => {
    const guard = new RiskGuard(makeMockConfig({ PORTFOLIO_FLOOR_USD: 500 }));
    const result = guard.checkRotation(baseProposal(), 'base-sepolia', 400);

    expect(result.approved).toBe(false);
    expect(result.vetoReason).toContain('Portfolio floor breached');
    expect(mockSetStatus).toHaveBeenCalledWith('paused');
    expect(mockEmitAlert).toHaveBeenCalledWith(expect.stringContaining('PORTFOLIO FLOOR BREACHED'));
  });

  it('vetoes when daily loss exceeds MAX_DAILY_LOSS_PCT', () => {
    mockGetTodayPnl.get.mockReturnValue({ high_water: 1000, current_usd: 900 });
    const guard = new RiskGuard(makeMockConfig({ MAX_DAILY_LOSS_PCT: 5 }));
    // Portfolio is now 940 → loss from high_water 1000 is 6%
    const result = guard.checkRotation(baseProposal(), 'base-sepolia', 940);

    expect(result.approved).toBe(false);
    expect(result.vetoReason).toContain('exceeds');
    expect(mockSetStatus).toHaveBeenCalledWith('paused');
    expect(mockEmitAlert).toHaveBeenCalledWith(expect.stringContaining('Daily loss limit'));
  });

  it('vetoes when rotation count >= MAX_DAILY_ROTATIONS', () => {
    mockGetTodayRotationCount.get.mockReturnValue({ cnt: 10 });
    const guard = new RiskGuard(makeMockConfig({ MAX_DAILY_ROTATIONS: 10 }));
    const result = guard.checkRotation(baseProposal(), 'base-sepolia', 1000);

    expect(result.approved).toBe(false);
    expect(result.vetoReason).toContain('rotation cap');
  });

  // ── Position-limit tests ──

  it('does NOT apply position cap when buySymbol is USDC (safe-haven bypass)', () => {
    // USDC already at 60% of portfolio — cap is 40% — but buy should still be approved
    const guard = new RiskGuard(makeMockConfig({ MAX_POSITION_PCT: 40 }));
    const result = guard.checkRotation(
      baseProposal({ buySymbol: 'USDC', sellAmount: 100, buyTargetWeightPct: 60 }),
      'base-sepolia',
      1000,
    );

    expect(result.approved).toBe(true);
    // Full sellAmount passes through untouched
    expect(result.adjustedAmount).toBe(100);
  });

  it('does NOT reduce when non-USDC buy is already under maxPosPct', () => {
    const guard = new RiskGuard(makeMockConfig({ MAX_POSITION_PCT: 40 }));
    // buyTargetWeightPct = 30, well under 40 — no reduction
    const result = guard.checkRotation(
      baseProposal({ buySymbol: 'CBBTC', sellAmount: 100, buyTargetWeightPct: 30 }),
      'base-sepolia',
      1000,
    );

    expect(result.approved).toBe(true);
    expect(result.adjustedAmount).toBe(100);
  });

  it('correctly caps non-USDC buy amount to room remaining up to maxPosPct', () => {
    // Portfolio: $1000, maxPosPct: 40% (=$400 allowed)
    // sellAmount: $100, buyTargetWeightPct: 55% (=$550 after buy)
    // currentBuyWeightPct before this buy = 55% - (100/1000)*100 = 55 - 10 = 45%
    // Wait — 45% already exceeds 40%. Room = max(0, 40-45)/100*1000 = 0.
    // Use a case where current weight is below cap:
    // sellAmount: $50, buyTargetWeightPct: 45%
    // currentBuyWeightPct = 45 - (50/1000)*100 = 45 - 5 = 40%
    // Room = max(0, (40-40)/100*1000) = 0 → would veto (too small)
    //
    // Better case: sellAmount=$50, buyTargetWeightPct=48%
    // currentBuyWeightPct = 48 - (50/1000)*100 = 48 - 5 = 43% → already over cap → room=0 → veto
    //
    // Correct case: buyTargetWeightPct=44%, sellAmount=$50, portfolio=$1000
    // currentBuyWeightPct = 44 - 5 = 39%  (<40, so room = (40-39)/100*1000 = $10)
    // adjustedAmount = min(50, 10) = $10
    const guard = new RiskGuard(makeMockConfig({ MAX_POSITION_PCT: 40, MAX_ROTATION_PCT: 50 }));
    const result = guard.checkRotation(
      baseProposal({ buySymbol: 'CBBTC', sellAmount: 50, buyTargetWeightPct: 44 }),
      'base-sepolia',
      1000,
    );

    expect(result.approved).toBe(true);
    // Room = (40-39)/100 * 1000 = $10
    expect(result.adjustedAmount).toBeCloseTo(10, 1);
  });

  it('vetoes non-USDC buy when current weight already >= maxPosPct (no room)', () => {
    // sellAmount=$50, buyTargetWeightPct=50%, portfolio=$1000
    // currentBuyWeightPct = 50 - 5 = 45% → already over cap → maxAllowedBuyUsd = 0
    // 0 < 1% of 1000 ($10) → veto
    const guard = new RiskGuard(makeMockConfig({ MAX_POSITION_PCT: 40 }));
    const result = guard.checkRotation(
      baseProposal({ buySymbol: 'CBBTC', sellAmount: 50, buyTargetWeightPct: 50 }),
      'base-sepolia',
      1000,
    );

    expect(result.approved).toBe(false);
    expect(result.vetoReason).toContain('Position limit');
  });

  it('logs decisions via queries.insertEvent', () => {
    const guard = new RiskGuard(makeMockConfig());
    guard.checkRotation(baseProposal(), 'base-sepolia', 1000);

    expect(mockInsertEvent.run).toHaveBeenCalled();
    const [event] = mockInsertEvent.run.mock.calls[0];
    expect(event).toBe('risk_approved');
  });
});
