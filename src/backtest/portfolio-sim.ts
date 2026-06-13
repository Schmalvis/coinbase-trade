import type { BacktestConfig, SimulatedRotation, VetoRecord } from './types.js';

export class VirtualPortfolio {
  readonly balances: Map<string, number>;      // native units per symbol
  readonly prices: Map<string, number>;        // USD per native unit
  readonly rotations: SimulatedRotation[] = [];
  readonly vetoed: VetoRecord[] = [];

  private readonly hodlBalances: Map<string, number>;  // snapshot of initial balances
  private readonly hodlStartPrices: Map<string, number>;
  private readonly dailyCounts = new Map<string, number>();    // date → rotation count
  private readonly lastPairTime = new Map<string, number>();   // 'sell->buy' → ms

  readonly startPortfolioUsd: number;

  constructor(private readonly config: BacktestConfig) {
    this.balances = new Map(config.initialBalances);
    this.prices = new Map(config.initialPrices);
    this.hodlBalances = new Map(config.initialBalances);
    this.hodlStartPrices = new Map(config.initialPrices);
    this.startPortfolioUsd = this.getPortfolioUsd();
  }

  updatePrices(prices: Map<string, number>): void {
    for (const [sym, price] of prices) this.prices.set(sym, price);
  }

  getPortfolioUsd(): number {
    let total = 0;
    for (const [sym, bal] of this.balances) total += bal * (this.prices.get(sym) ?? 0);
    return total;
  }

  /** Hold initial composition, reprice at current prices. */
  getHodlPortfolioUsd(): number {
    let total = 0;
    for (const [sym, bal] of this.hodlBalances) total += bal * (this.prices.get(sym) ?? 0);
    return total;
  }

  /** Convert all starting USD to ETH at start price, hold at current ETH price. */
  getHodlEthUsd(): number {
    const ethStart = this.hodlStartPrices.get('ETH') ?? 0;
    if (ethStart === 0) return this.startPortfolioUsd;
    const ethUnits = this.startPortfolioUsd / ethStart;
    return ethUnits * (this.prices.get('ETH') ?? ethStart);
  }

  /** Hold all as USDC — always equals starting USD value. */
  getHodlUsdcUsd(): number {
    return this.startPortfolioUsd;
  }

  canRotate(
    sellSymbol: string,
    buySymbol: string,
    tick: string,
  ): { ok: boolean; reason?: string } {
    const day = tick.slice(0, 10);
    const dayCount = this.dailyCounts.get(day) ?? 0;
    if (dayCount >= this.config.maxDailyRotations) {
      return { ok: false, reason: `Daily rotation cap (${dayCount}/${this.config.maxDailyRotations})` };
    }

    if (this.config.pairCooldownMs > 0) {
      const pairKey = `${sellSymbol}->${buySymbol}`;
      const lastMs = this.lastPairTime.get(pairKey) ?? 0;
      const tickMs = new Date(tick).getTime();
      if (tickMs - lastMs < this.config.pairCooldownMs) {
        return { ok: false, reason: `Same-pair cooldown (${pairKey}, ${this.config.pairCooldownMs / 3600000}h)` };
      }
    }

    return { ok: true };
  }

  executeRotation(
    sellSymbol: string,
    buySymbol: string,
    scoreDelta: number,
    sellScore: number,
    buyScore: number,
    tick: string,
  ): SimulatedRotation | null {
    const sellBal = this.balances.get(sellSymbol) ?? 0;
    const sellPrice = this.prices.get(sellSymbol) ?? 0;
    const sellAmountNative = sellBal * this.config.rotationSizePct;
    const sellAmountUsd = sellAmountNative * sellPrice;

    if (sellAmountUsd < 2) return null;  // below $2 minimum, matches executor guard

    const feeUsd = sellAmountUsd * this.config.feePct;
    const netUsd = sellAmountUsd - feeUsd;
    const buyPrice = this.prices.get(buySymbol) ?? 0;
    const buyAmountNative = buyPrice > 0 ? netUsd / buyPrice : 0;

    const portfolioUsdBefore = this.getPortfolioUsd();

    this.balances.set(sellSymbol, sellBal - sellAmountNative);
    this.balances.set(buySymbol, (this.balances.get(buySymbol) ?? 0) + buyAmountNative);

    const portfolioUsdAfter = this.getPortfolioUsd();

    const day = tick.slice(0, 10);
    this.dailyCounts.set(day, (this.dailyCounts.get(day) ?? 0) + 1);
    this.lastPairTime.set(`${sellSymbol}->${buySymbol}`, new Date(tick).getTime());

    const rotation: SimulatedRotation = {
      tick,
      sellSymbol,
      buySymbol,
      scoreDelta,
      sellScore,
      buyScore,
      sellAmountUsd,
      buyAmountUsd: netUsd,
      feePaidUsd: feeUsd,
      portfolioUsdBefore,
      portfolioUsdAfter,
    };
    this.rotations.push(rotation);
    return rotation;
  }
}
