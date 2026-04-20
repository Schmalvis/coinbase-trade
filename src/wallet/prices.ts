export interface TokenPrice {
  [coinId: string]: { usd: number };
}

// Hardcoded Pyth price feed IDs
const PYTH_FEED_IDS: Record<string, string> = {
  ETH:   '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  BTC:   '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  CBBTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  CBETH: '0x15ecddd26d49e1a8f1de9376ebebc03916ede873447c1255d2d5891b92ce5717',
  USDC:  '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
};

const PYTH_HERMES_BASE = 'https://hermes.pyth.network/v2';

/**
 * Resolve a Pyth price feed ID for a token symbol.
 * Checks hardcoded map first; falls back to Pyth search API.
 */
export async function fetchPriceFeedId(symbol: string): Promise<string> {
  const upper = symbol.toUpperCase();
  if (PYTH_FEED_IDS[upper]) return PYTH_FEED_IDS[upper];

  // Fallback: search Pyth
  const res = await fetch(`${PYTH_HERMES_BASE}/price_feeds?query=${upper}&asset_type=crypto`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Pyth feed search failed: ${res.status}`);
  const data = await res.json() as Array<{ id: string; attributes: { base: string } }>;
  const match = data.find(f => f.attributes?.base?.toUpperCase() === upper);
  if (!match) throw new Error(`No Pyth price feed found for: ${symbol}`);
  return `0x${match.id}`;
}

/**
 * Fetch the current price (USD) for a Pyth price feed ID.
 */
export async function fetchPrice(priceFeedId: string): Promise<number> {
  const id = priceFeedId.startsWith('0x') ? priceFeedId.slice(2) : priceFeedId;
  const res = await fetch(`${PYTH_HERMES_BASE}/updates/price/latest?ids[]=${id}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Pyth price fetch failed: ${res.status}`);
  const data = await res.json() as {
    parsed: Array<{ price: { price: string; expo: number } }>;
  };
  const parsed = data?.parsed?.[0];
  if (!parsed) throw new Error(`No price data returned for feed: ${priceFeedId}`);
  const { price, expo } = parsed.price;
  return parseFloat(price) * Math.pow(10, expo);
}

// DeFiLlama coingecko ID map for known tokens
const DEFILLAMA_IDS: Record<string, string> = {
  ETH:   'coingecko:ethereum',
  USDC:  'coingecko:usd-coin',
  CBBTC: 'coingecko:coinbase-wrapped-btc',
  CBETH: 'coingecko:coinbase-wrapped-staked-eth',
  BTC:   'coingecko:bitcoin',
};

/**
 * Fetch prices from DeFiLlama for an array of token symbols or coingecko IDs.
 * Returns a map of { coinId: { usd: number } }.
 */
export async function getTokenPrices(tokens: string[]): Promise<TokenPrice> {
  // Normalise: accept symbols or raw coingecko IDs
  const ids = tokens.map(t => DEFILLAMA_IDS[t.toUpperCase()] ?? t);
  const url = `https://coins.llama.fi/prices/current/${ids.join(',')}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`DeFiLlama price fetch failed: ${res.status}`);
  const data = await res.json() as { coins: Record<string, { price: number }> };

  const result: TokenPrice = {};
  for (const [coinId, info] of Object.entries(data.coins ?? {})) {
    result[coinId] = { usd: info.price };
  }
  return result;
}
