import { db } from './db.js';
import { logger } from '../core/logger.js';

interface TokenSeed {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  network: string;
  is_memecoin: 0 | 1;
  drop_pct: number;
  rise_pct: number;
  strategy: string;
}

const CURATED_TOKENS: TokenSeed[] = [
  { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO',    name: 'Aerodrome Finance', decimals: 18, network: 'base-mainnet', is_memecoin: 0, drop_pct: 0.7, rise_pct: 1.0, strategy: 'sma' },
  { address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', symbol: 'VIRTUAL', name: 'Virtual Protocol',  decimals: 18, network: 'base-mainnet', is_memecoin: 0, drop_pct: 0.7, rise_pct: 1.0, strategy: 'sma' },
  { address: '0xBAa5CC21fd487B8Fcc2F45f966f723E0191b3d8E', symbol: 'MORPHO',  name: 'Morpho',            decimals: 18, network: 'base-mainnet', is_memecoin: 0, drop_pct: 0.7, rise_pct: 1.0, strategy: 'sma' },
  { address: '0xA88594D404727625A9437C3f886C7643872296AE', symbol: 'WELL',    name: 'Moonwell',          decimals: 18, network: 'base-mainnet', is_memecoin: 0, drop_pct: 0.7, rise_pct: 1.0, strategy: 'sma' },
  { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN',   name: 'Degen',             decimals: 18, network: 'base-mainnet', is_memecoin: 1, drop_pct: 0.7, rise_pct: 1.0, strategy: 'sma' },
  { address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT',   name: 'Brett',             decimals: 18, network: 'base-mainnet', is_memecoin: 1, drop_pct: 0.7, rise_pct: 1.0, strategy: 'sma' },
];

export function seedCuratedTokens(): void {
  const stmt = db.prepare(`
    INSERT INTO discovered_assets
      (address, network, symbol, name, decimals, status, drop_pct, rise_pct, strategy, is_memecoin, discovered_at)
    VALUES
      (@address, @network, @symbol, @name, @decimals, 'pending', @drop_pct, @rise_pct, @strategy, @is_memecoin, @discovered_at)
    ON CONFLICT(address, network) DO NOTHING
  `);

  let seeded = 0;
  const now = Date.now();
  for (const token of CURATED_TOKENS) {
    const result = stmt.run({ ...token, discovered_at: now });
    if (result.changes > 0) seeded++;
  }
  if (seeded > 0) logger.info(`Seeded ${seeded} curated tokens into discovered_assets (pending)`);
}

/**
 * Repairs discovered_assets rows where Alchemy seeded a curated token with an empty/null
 * address before the curated seed ran. The correct-address row (from seedCuratedTokens) exists
 * as 'pending' while the bad empty-address row is 'active' — we transfer the status and dismiss
 * the bad row so GeckoTerminal and the pricing loop can operate correctly.
 */
export function repairCuratedTokenAddresses(): void {
  const findBad = db.prepare(`
    SELECT status FROM discovered_assets
    WHERE UPPER(symbol) = UPPER(?) AND network = ? AND (address = '' OR address IS NULL) AND status != 'dismissed'
  `);
  const promoteCorrect = db.prepare(`
    UPDATE discovered_assets SET status = ? WHERE address = ? AND network = ?
  `);
  const dismissBad = db.prepare(`
    UPDATE discovered_assets SET status = 'dismissed'
    WHERE (address = '' OR address IS NULL) AND UPPER(symbol) = UPPER(?) AND network = ?
  `);

  for (const token of CURATED_TOKENS) {
    const badRow = findBad.get(token.symbol, token.network) as { status: string } | undefined;
    if (!badRow) continue;
    promoteCorrect.run(badRow.status, token.address, token.network);
    dismissBad.run(token.symbol, token.network);
    logger.info(`Repaired ${token.symbol}: transferred status '${badRow.status}' from empty-address row to ${token.address}`);
  }
}
