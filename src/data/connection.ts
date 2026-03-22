import Database, { type Database as DB } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';

fs.mkdirSync(config.DATA_DIR, { recursive: true });

const dbPath = path.join(config.DATA_DIR, 'trades.db');
export const db: DB = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
