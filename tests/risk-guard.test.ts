import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB modules ──
const mockInsertEvent = { run: vi.fn() };
const mockGetTodayPnl = { get: vi.fn() };
const mockGetTodayRotationCount = { get: vi.fn() };

vi.mock('../src/data/db.js', () => ({
  queries: { insertEvent: mockInsertEvent },
  dailyPnlQueries: { getTodayPnl: mockGetTodayPnl },
  rotationQueries: { getTodayRotationCount: mockGetTodayRotationCount },
}));

// ── Mock botState ──
const mockSetStatus = vi.fn();
const mockEmitAlert = vi.fn();

vi.mock('../src/core/state.js', () => ({
  botState: {
    setStatus: mockSetStatus,
    emitAlert: mockEmitAlert,
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

  it('reduces amount when buyTargetWeightPct > MAX_POSITION_PCT', () => {
    const guard = new RiskGuard(makeMockConfig({ MAX_POSITION_PCT: 30 }));
    // buyTargetWeightPct = 60, so reduction = (60-30)/60 = 0.5 → adjustedAmount = 100 * 0.5 = 50
    const result = guard.checkRotation(
      baseProposal({ sellAmount: 100, buyTargetWeightPct: 60 }),
      'base-sepolia',
      1000,
    );

    expect(result.approved).toBe(true);
    expect(result.adjustedAmount).toBeLessThan(100);
  });

  it('vetoes if position-limit-reduced amount is too small', () => {
    const guard = new RiskGuard(makeMockConfig({ MAX_POSITION_PCT: 1 }));
    // buyTargetWeightPct=99 → reduction = (99-1)/99 ≈ 0.99 → adjustedAmount ≈ 1 → < 1% of 1000 = 10
    const result = guard.checkRotation(
      baseProposal({ sellAmount: 100, buyTargetWeightPct: 99 }),
      'base-sepolia',
      1000,
    );

    expect(result.approved).toBe(false);
    expect(result.vetoReason).toContain('Position limit');
  });

  it('vetoes when fees >= gain', () => {
    const guard = new RiskGuard(makeMockConfig());
    const result = guard.checkRotation(
      baseProposal({ estimatedFeePct: 3, estimatedGainPct: 2 }),
      'base-sepolia',
      1000,
    );

    expect(result.approved).toBe(false);
    expect(result.vetoReason).toContain('Fees');
  });

  it('logs decisions via queries.insertEvent', () => {
    const guard = new RiskGuard(makeMockConfig());
    guard.checkRotation(baseProposal(), 'base-sepolia', 1000);

    expect(mockInsertEvent.run).toHaveBeenCalled();
    const [event] = mockInsertEvent.run.mock.calls[0];
    expect(event).toBe('risk_approved');
  });
});
