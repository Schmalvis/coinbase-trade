import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

function makeTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return {
    getSetting:    db.prepare('SELECT value FROM settings WHERE key = ?'),
    upsertSetting: db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    getAllSettings: db.prepare('SELECT key, value FROM settings'),
  };
}

describe('settings DB queries', () => {
  let q: ReturnType<typeof makeTestDb>;

  beforeEach(() => { q = makeTestDb(); });

  it('returns undefined for missing key', () => {
    expect(q.getSetting.get('MISSING')).toBeUndefined();
  });

  it('upserts and retrieves a value', () => {
    q.upsertSetting.run('STRATEGY', 'sma');
    expect((q.getSetting.get('STRATEGY') as { value: string }).value).toBe('sma');
  });

  it('overwrites existing value on conflict', () => {
    q.upsertSetting.run('STRATEGY', 'threshold');
    q.upsertSetting.run('STRATEGY', 'sma');
    expect((q.getSetting.get('STRATEGY') as { value: string }).value).toBe('sma');
  });

  it('getAllSettings returns all rows', () => {
    q.upsertSetting.run('STRATEGY', 'sma');
    q.upsertSetting.run('DRY_RUN', 'true');
    expect((q.getAllSettings.all() as unknown[]).length).toBe(2);
  });
});
