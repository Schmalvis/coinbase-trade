import { config } from '../config.js';
import { runtimeConfig } from './runtime-config.js';
import fs from 'fs';
import path from 'path';

const LEVEL_MAP: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentLevel(): number {
  const lvl = runtimeConfig.get('LOG_LEVEL') as string | undefined;
  return LEVEL_MAP[lvl ?? config.LOG_LEVEL] ?? 1;
}

const logDir = path.join(config.DATA_DIR, 'logs');
let logPath: string | null = null;
try {
  fs.mkdirSync(logDir, { recursive: true });
  logPath = path.join(logDir, 'bot.log');
} catch {
  console.warn(`[WARN] Cannot create log directory ${logDir} — logging to console only`);
}

function write(level: string, msg: string, meta?: unknown) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  console.log(line);
  if (logPath) {
    try { fs.appendFileSync(logPath, line + '\n'); } catch { /* volume not writable */ }
  }
}

export const logger = {
  debug: (msg: string, meta?: unknown) => LEVEL_MAP['debug'] >= currentLevel() && write('debug', msg, meta),
  info:  (msg: string, meta?: unknown) => LEVEL_MAP['info']  >= currentLevel() && write('info',  msg, meta),
  warn:  (msg: string, meta?: unknown) => LEVEL_MAP['warn']  >= currentLevel() && write('warn',  msg, meta),
  error: (msg: string, meta?: unknown) => LEVEL_MAP['error'] >= currentLevel() && write('error', msg, meta),
};

/** @deprecated LOG_LEVEL is now read from runtimeConfig on each call — this is a no-op */
export function setLevel(_level: string): void {
  // no-op: level is read dynamically from runtimeConfig
}
