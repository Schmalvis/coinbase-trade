import { db } from '../connection.js';
import type { Statement } from 'better-sqlite3';

export interface CandleRow {
  id: number;
  symbol: string;
  network: string;
  interval: string;
  open_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
}

export const candleQueries = {
  insertCandle: db.prepare(`
    INSERT OR REPLACE INTO candles (symbol, network, interval, open_time, open, high, low, close, volume, source)
    VALUES (@symbol, @network, @interval, @open_time, @open, @high, @low, @close, @volume, @source)
  `) as Statement<{ symbol: string; network: string; interval: string; open_time: string; open: number; high: number; low: number; close: number; volume: number; source: string }>,

  getCandles: db.prepare(`
    SELECT * FROM candles WHERE symbol = ? AND network = ? AND interval = ? ORDER BY open_time DESC LIMIT ?
  `) as Statement<[string, string, string, number], CandleRow>,

  deleteOldCandles: db.prepare(`
    DELETE FROM candles WHERE interval = ? AND open_time < ?
  `) as Statement<[string, string]>,
};
