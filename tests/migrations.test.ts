import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, getSchemaVersion } from '../src/data/migrations.js';

function freshDb() { return new Database(':memory:'); }

describe('runMigrations', () => {
  it('creates the schema_version table', () => {
    const db = freshDb();
    runMigrations(db);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`
    ).all();
    expect(tables).toHaveLength(1);
    db.close();
  });

  it('records at least one migration version', () => {
    const db = freshDb();
    runMigrations(db);
    expect(getSchemaVersion(db)).toBeGreaterThan(0);
    db.close();
  });

  it('is idempotent — second call does not throw or increment version', () => {
    const db = freshDb();
    runMigrations(db);
    const v1 = getSchemaVersion(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(v1);
    db.close();
  });

  it('adds network column when trades table exists but column is missing', () => {
    const db = freshDb();
    db.exec('CREATE TABLE trades (id INTEGER PRIMARY KEY, action TEXT)');
    runMigrations(db);
    const info = db.prepare('PRAGMA table_info(trades)').all() as { name: string }[];
    expect(info.some(c => c.name === 'network')).toBe(true);
    db.close();
  });

  it('skips migrations already recorded in schema_version', () => {
    const db = freshDb();
    runMigrations(db);
    const rows = db.prepare('SELECT COUNT(*) as n FROM schema_version').get() as { n: number };
    runMigrations(db);
    const rows2 = db.prepare('SELECT COUNT(*) as n FROM schema_version').get() as { n: number };
    expect(rows2.n).toBe(rows.n);
    db.close();
  });
});
