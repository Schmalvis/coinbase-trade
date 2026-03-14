import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type Database as DB } from 'better-sqlite3';

const WATCHLIST_DDL = `
  CREATE TABLE IF NOT EXISTS watchlist (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol        TEXT NOT NULL,
    network       TEXT NOT NULL,
    address       TEXT,
    source        TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'trending', 'suggested')),
    added_at      TEXT NOT NULL DEFAULT (datetime('now')),
    status        TEXT NOT NULL DEFAULT 'watching' CHECK(status IN ('watching', 'promoted', 'removed')),
    coinbase_pair TEXT,
    UNIQUE(symbol, network)
  );

  CREATE TABLE IF NOT EXISTS discovered_assets (
    address     TEXT NOT NULL,
    network     TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    decimals    INTEGER NOT NULL DEFAULT 18,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','dismissed')),
    drop_pct    REAL NOT NULL DEFAULT 2.0,
    rise_pct    REAL NOT NULL DEFAULT 3.0,
    sma_short   INTEGER NOT NULL DEFAULT 5,
    sma_long    INTEGER NOT NULL DEFAULT 20,
    strategy    TEXT NOT NULL DEFAULT 'threshold' CHECK(strategy IN ('threshold','sma')),
    discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (address, network)
  );
`;

interface WatchlistRow {
  id: number; symbol: string; network: string; address: string | null;
  source: string; added_at: string; status: string; coinbase_pair: string | null;
}

interface DiscoveredAssetRow {
  address: string; network: string; symbol: string; status: string;
}

let db: DB;

// Helpers that mirror the real query objects but use the in-memory DB
function insertItem(symbol: string, network: string, address: string | null, coinbasePair: string | null, source = 'manual') {
  db.prepare(`
    INSERT OR IGNORE INTO watchlist (symbol, network, address, source, coinbase_pair)
    VALUES (@symbol, @network, @address, @source, @coinbase_pair)
  `).run({ symbol, network, address, source, coinbase_pair: coinbasePair });
}

function removeItem(symbol: string, network: string) {
  db.prepare(`UPDATE watchlist SET status = 'removed' WHERE symbol = ? AND network = ?`).run(symbol, network);
}

function getAll(network: string): WatchlistRow[] {
  return db.prepare(`SELECT * FROM watchlist WHERE network = ? AND status = 'watching'`).all(network) as WatchlistRow[];
}

function promote(symbol: string, network: string) {
  const items = getAll(network);
  const item = items.find(i => i.symbol === symbol);
  if (!item) throw new Error(`${symbol} not on watchlist for ${network}`);
  if (!item.address) throw new Error(`Cannot promote ${symbol}: contract address is required`);

  db.prepare(`
    INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals)
    VALUES (@address, @network, @symbol, @name, @decimals)
  `).run({ address: item.address, network, symbol, name: symbol, decimals: 18 });

  db.prepare(`UPDATE discovered_assets SET status = @status WHERE address = @address AND network = @network`)
    .run({ status: 'active', address: item.address, network });

  db.prepare(`UPDATE watchlist SET status = @status WHERE symbol = @symbol AND network = @network`)
    .run({ status: 'promoted', symbol, network });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(WATCHLIST_DDL);
});

afterEach(() => {
  db.close();
});

const NET = 'base-sepolia';

describe('WatchlistManager', () => {
  it('add() inserts a watchlist item; getAll() returns it', () => {
    insertItem('DEGEN', NET, '0xabc', 'DEGEN-USD', 'manual');
    const items = getAll(NET);
    expect(items).toHaveLength(1);
    expect(items[0].symbol).toBe('DEGEN');
    expect(items[0].address).toBe('0xabc');
    expect(items[0].coinbase_pair).toBe('DEGEN-USD');
    expect(items[0].status).toBe('watching');
  });

  it('add() with duplicate symbol+network is silently ignored', () => {
    insertItem('DEGEN', NET, '0xabc', null, 'manual');
    insertItem('DEGEN', NET, '0xdef', null, 'trending'); // duplicate — should be ignored
    const items = getAll(NET);
    expect(items).toHaveLength(1);
    expect(items[0].address).toBe('0xabc'); // first insert wins
  });

  it('remove() sets status to removed; item no longer in getAll()', () => {
    insertItem('DEGEN', NET, '0xabc', null, 'manual');
    expect(getAll(NET)).toHaveLength(1);
    removeItem('DEGEN', NET);
    expect(getAll(NET)).toHaveLength(0);

    // Verify the row still exists with status 'removed'
    const all = db.prepare('SELECT * FROM watchlist WHERE symbol = ?').all('DEGEN') as WatchlistRow[];
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('removed');
  });

  it('promote() throws if address is null', () => {
    insertItem('DEGEN', NET, null, null, 'manual');
    expect(() => promote('DEGEN', NET)).toThrow('contract address is required');
  });

  it('promote() with valid address moves item to discovered_assets', () => {
    insertItem('DEGEN', NET, '0xabc123', null, 'manual');
    promote('DEGEN', NET);

    // Watchlist item should now be 'promoted'
    const watchAll = db.prepare('SELECT * FROM watchlist WHERE symbol = ?').all('DEGEN') as WatchlistRow[];
    expect(watchAll[0].status).toBe('promoted');

    // discovered_assets should have the asset as 'active'
    const discovered = db.prepare('SELECT * FROM discovered_assets WHERE address = ? AND network = ?')
      .get('0xabc123', NET) as DiscoveredAssetRow;
    expect(discovered).toBeDefined();
    expect(discovered.symbol).toBe('DEGEN');
    expect(discovered.status).toBe('active');
  });
});
