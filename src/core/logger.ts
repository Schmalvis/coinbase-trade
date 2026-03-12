import { config } from '../config.js';
import fs from 'fs';
import path from 'path';

const levels = { debug: 0, info: 1, warn: 2, error: 3 };

// Mutable — can be updated at runtime via setLevel()
let currentLevel = levels[config.LOG_LEVEL];

export function setLevel(level: string): void {
  currentLevel = levels[level as keyof typeof levels] ?? levels.info;
}

const logDir = path.join(config.DATA_DIR, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'bot.log');

function write(level: string, msg: string, meta?: unknown) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
}

export const logger = {
  debug: (msg: string, meta?: unknown) => levels.debug >= currentLevel && write('debug', msg, meta),
  info:  (msg: string, meta?: unknown) => levels.info  >= currentLevel && write('info',  msg, meta),
  warn:  (msg: string, meta?: unknown) => levels.warn  >= currentLevel && write('warn',  msg, meta),
  error: (msg: string, meta?: unknown) => levels.error >= currentLevel && write('error', msg, meta),
};
