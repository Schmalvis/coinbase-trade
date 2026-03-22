import { db } from '../connection.js';
import type { Statement } from 'better-sqlite3';

export const settingQueries = {
  getSetting:    db.prepare('SELECT value FROM settings WHERE key = ?') as Statement<[string], { value: string }>,
  upsertSetting: db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `) as Statement<[string, string]>,
  getAllSettings: db.prepare('SELECT key, value FROM settings') as Statement<[], { key: string; value: string }>,
};
