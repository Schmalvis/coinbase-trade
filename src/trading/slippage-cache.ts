const TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  impactPct: number;
  fetchedAt: number;
}

export class SlippageCache {
  private readonly cache = new Map<string, CacheEntry>();

  get(symbol: string): number | null {
    const entry = this.cache.get(symbol);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > TTL_MS) {
      this.cache.delete(symbol);
      return null;
    }
    return entry.impactPct;
  }

  set(symbol: string, impactPct: number): void {
    this.cache.set(symbol, { impactPct, fetchedAt: Date.now() });
  }
}
