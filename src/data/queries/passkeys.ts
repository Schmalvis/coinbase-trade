import { db } from '../connection.js';
import type { Statement } from 'better-sqlite3';

export interface PasskeyRow {
  id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  created_at: string;
  label: string;
}

export const passkeyQueries = {
  insertPasskey: db.prepare(`
    INSERT INTO passkeys (id, public_key, counter, transports, label)
    VALUES (@id, @public_key, @counter, @transports, @label)
  `) as Statement<{ id: string; public_key: string; counter: number; transports: string | null; label: string }>,

  getPasskeyById: db.prepare(`
    SELECT * FROM passkeys WHERE id = ?
  `) as Statement<[string], PasskeyRow>,

  getAllPasskeys: db.prepare(`
    SELECT * FROM passkeys
  `) as Statement<[], PasskeyRow>,

  updatePasskeyCounter: db.prepare(`
    UPDATE passkeys SET counter = ? WHERE id = ?
  `) as Statement<[number, string]>,

  deletePasskey: db.prepare(`
    DELETE FROM passkeys WHERE id = ?
  `) as Statement<[string]>,
};
