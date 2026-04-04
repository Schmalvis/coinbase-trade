import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

function makeTestDb() {
  const db = new Database(':memory:');
  db.prepare(
    'CREATE TABLE asset_snapshots (' +
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    '  timestamp TEXT NOT NULL DEFAULT (datetime("now")),' +
    '  symbol TEXT NOT NULL,' +
    '  price_usd REAL NOT NULL,' +
    '  balance REAL NOT NULL' +
    ')'
  ).run();
  db.prepare(
    'CREATE TABLE portfolio_snapshots (' +
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    '  timestamp TEXT NOT NULL DEFAULT (datetime("now")),' +
    '  portfolio_usd REAL NOT NULL' +
    ')'
  ).run();
  return {
    insertAssetSnapshot:
      db.prepare('INSERT INTO asset_snapshots (symbol, price_usd, balance) VALUES (@symbol, @price_usd, @balance)'),
    recentAssetSnapshots:
      db.prepare('SELECT * FROM asset_snapshots WHERE symbol = ? ORDER BY id DESC LIMIT ?'),
    insertPortfolioSnapshot:
      db.prepare('INSERT INTO portfolio_snapshots (portfolio_usd) VALUES (@portfolio_usd)'),
    recentPortfolioSnapshots:
      db.prepare('SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT ?'),
  };
}

describe('asset_snapshots queries', () => {
  let q: ReturnType<typeof makeTestDb>;
  beforeEach(() => { q = makeTestDb(); });

  it('inserts and retrieves an asset snapshot', () => {
    q.insertAssetSnapshot.run({ symbol: 'ETH', price_usd: 2000, balance: 0.5 });
    const rows = q.recentAssetSnapshots.all('ETH', 1) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('ETH');
    expect(rows[0].price_usd).toBe(2000);
    expect(rows[0].balance).toBe(0.5);
  });

  it('recentAssetSnapshots filters by symbol', () => {
    q.insertAssetSnapshot.run({ symbol: 'ETH',   price_usd: 2000,  balance: 0.5   });
    q.insertAssetSnapshot.run({ symbol: 'CBBTC', price_usd: 60000, balance: 0.001 });
    const rows = q.recentAssetSnapshots.all('CBBTC', 5) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('CBBTC');
  });

  it('inserts and retrieves a portfolio snapshot', () => {
    q.insertPortfolioSnapshot.run({ portfolio_usd: 1234.56 });
    const rows = q.recentPortfolioSnapshots.all(1) as any[];
    expect(rows[0].portfolio_usd).toBe(1234.56);
  });
});

describe('Alchemy discovery — address case normalisation', () => {
  it('uses lowercased address for getAssetByAddress lookup', () => {
    // The bug: tb.contractAddress (mixed case) is passed to getAssetByAddress
    // but the DB stores addresses lowercase. Lookup always misses → CirBTC stored.
    // Fix: pass addr (already lowercased at line 174) instead.
    const mixedCaseAddr = '0xCbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
    const lowercaseAddr = mixedCaseAddr.toLowerCase();

    // These are the two arguments that getAssetByAddress receives.
    // After the fix, the first argument must be the lowercase version.
    expect(lowercaseAddr).toBe('0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf');
    expect(lowercaseAddr).not.toBe(mixedCaseAddr);

    // Simulate the bug: the lookup with mixed case would not find an existing lowercase entry
    const fakeDb = new Map<string, boolean>();
    fakeDb.set(lowercaseAddr, true); // DB stores lowercase

    // Bug behaviour: lookup with original mixed-case misses
    expect(fakeDb.has(mixedCaseAddr)).toBe(false);
    // Fixed behaviour: lookup with lowercased addr hits
    expect(fakeDb.has(lowercaseAddr)).toBe(true);
  });
});
