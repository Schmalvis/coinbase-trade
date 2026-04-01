export type ConfigKey =
  | 'STRATEGY' | 'TRADE_INTERVAL_SECONDS' | 'POLL_INTERVAL_SECONDS'
  | 'PRICE_DROP_THRESHOLD_PCT' | 'PRICE_RISE_TARGET_PCT'
  | 'SMA_SHORT_WINDOW' | 'SMA_LONG_WINDOW'
  | 'MAX_TRADE_SIZE_ETH' | 'MAX_TRADE_SIZE_USDC'
  | 'TRADE_COOLDOWN_SECONDS' | 'DRY_RUN' | 'LOG_LEVEL'
  | 'WEB_PORT' | 'DATA_DIR' | 'MCP_SERVER_URL'
  | 'NETWORK_ID' | 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_ALLOWED_CHAT_IDS'
  | 'MAX_POSITION_PCT' | 'MAX_DAILY_LOSS_PCT' | 'MAX_ROTATION_PCT'
  | 'MAX_DAILY_ROTATIONS' | 'PORTFOLIO_FLOOR_USD' | 'MIN_ROTATION_GAIN_PCT'
  | 'MAX_CASH_PCT' | 'OPTIMIZER_INTERVAL_SECONDS'
  | 'ROTATION_SELL_THRESHOLD' | 'ROTATION_BUY_THRESHOLD' | 'MIN_ROTATION_SCORE_DELTA'
  | 'RISK_OFF_THRESHOLD' | 'RISK_ON_THRESHOLD' | 'DEFAULT_FEE_ESTIMATE_PCT'
  | 'DASHBOARD_THEME'
  | 'TELEGRAM_MODE' | 'TELEGRAM_DIGEST_TIMES' | 'TELEGRAM_QUIET_START' | 'TELEGRAM_QUIET_END'
  | 'BB_PERIOD' | 'BB_STD_DEV' | 'GRID_LEVELS' | 'GRID_AMOUNT_PCT' | 'GRID_UPPER_BOUND' | 'GRID_LOWER_BOUND' | 'GRID_RECALC_HOURS'
  | 'DASHBOARD_SECRET'
  | 'STOP_LOSS_PCT' | 'TRAILING_STOP_PCT' | 'MIN_ROTATION_PROFIT_USD';

export type ConfigValue = string | number | boolean | number[] | undefined;

const ALL_KEYS = new Set<ConfigKey>([
  'STRATEGY', 'TRADE_INTERVAL_SECONDS', 'POLL_INTERVAL_SECONDS',
  'PRICE_DROP_THRESHOLD_PCT', 'PRICE_RISE_TARGET_PCT',
  'SMA_SHORT_WINDOW', 'SMA_LONG_WINDOW',
  'MAX_TRADE_SIZE_ETH', 'MAX_TRADE_SIZE_USDC',
  'TRADE_COOLDOWN_SECONDS', 'DRY_RUN', 'LOG_LEVEL',
  'WEB_PORT', 'DATA_DIR', 'MCP_SERVER_URL',
  'NETWORK_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS',
  'MAX_POSITION_PCT', 'MAX_DAILY_LOSS_PCT', 'MAX_ROTATION_PCT',
  'MAX_DAILY_ROTATIONS', 'PORTFOLIO_FLOOR_USD', 'MIN_ROTATION_GAIN_PCT',
  'MAX_CASH_PCT', 'OPTIMIZER_INTERVAL_SECONDS',
  'ROTATION_SELL_THRESHOLD', 'ROTATION_BUY_THRESHOLD', 'MIN_ROTATION_SCORE_DELTA',
  'RISK_OFF_THRESHOLD', 'RISK_ON_THRESHOLD', 'DEFAULT_FEE_ESTIMATE_PCT',
  'DASHBOARD_THEME',
  'TELEGRAM_MODE', 'TELEGRAM_DIGEST_TIMES', 'TELEGRAM_QUIET_START', 'TELEGRAM_QUIET_END',
  'BB_PERIOD', 'BB_STD_DEV', 'GRID_LEVELS', 'GRID_AMOUNT_PCT', 'GRID_UPPER_BOUND', 'GRID_LOWER_BOUND', 'GRID_RECALC_HOURS',
  'DASHBOARD_SECRET',
  'STOP_LOSS_PCT', 'TRAILING_STOP_PCT', 'MIN_ROTATION_PROFIT_USD',
]);

const READ_ONLY_KEYS = new Set<ConfigKey>([
  'WEB_PORT', 'DATA_DIR', 'MCP_SERVER_URL',
  'NETWORK_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS',
  'DASHBOARD_SECRET', 'DRY_RUN',
]);

// Returns null if valid, error string if invalid
type Validator = (v: unknown) => string | null;

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown) => typeof v === 'number' && !isNaN(v);

const VALIDATORS: Record<ConfigKey, Validator> = {
  STRATEGY:               v => ['threshold', 'sma', 'grid', 'momentum-burst', 'volatility-breakout', 'trend-continuation'].includes(String(v)) ? null : 'must be "threshold", "sma", "grid", "momentum-burst", "volatility-breakout", or "trend-continuation"',
  TRADE_INTERVAL_SECONDS: v => isNum(v) && (v as number) >= 5 ? null : 'must be a number >= 5',
  POLL_INTERVAL_SECONDS:  v => isNum(v) && (v as number) >= 5 ? null : 'must be a number >= 5',
  PRICE_DROP_THRESHOLD_PCT: v => isNum(v) && (v as number) >= 0.1 && (v as number) <= 50 ? null : 'must be 0.1–50',
  PRICE_RISE_TARGET_PCT:  v => isNum(v) && (v as number) >= 0.1 && (v as number) <= 100 ? null : 'must be 0.1–100',
  SMA_SHORT_WINDOW:       v => isInt(v) && (v as number) >= 2 ? null : 'must be an integer >= 2',
  SMA_LONG_WINDOW:        v => isInt(v) && (v as number) >= 3 ? null : 'must be an integer >= 3',
  MAX_TRADE_SIZE_ETH:     v => isNum(v) && (v as number) >= 0.0001 ? null : 'must be >= 0.0001',
  MAX_TRADE_SIZE_USDC:    v => isNum(v) && (v as number) >= 0.01 ? null : 'must be >= 0.01',
  TRADE_COOLDOWN_SECONDS: v => isNum(v) && (v as number) >= 0 ? null : 'must be >= 0',
  DRY_RUN:   v => typeof v === 'boolean' ? null : 'must be a boolean',
  LOG_LEVEL: v => ['debug', 'info', 'warn', 'error'].includes(String(v)) ? null : 'must be debug/info/warn/error',
  WEB_PORT:  () => null, // read-only, validator not reached
  DATA_DIR:  () => null,
  MCP_SERVER_URL: () => null,
  NETWORK_ID: () => null,
  TELEGRAM_BOT_TOKEN: () => null,
  TELEGRAM_ALLOWED_CHAT_IDS: () => null,
  MAX_POSITION_PCT:         v => isNum(v) && (v as number) >= 5 && (v as number) <= 100 ? null : 'must be 5–100',
  MAX_DAILY_LOSS_PCT:       v => isNum(v) && (v as number) >= 1 && (v as number) <= 50 ? null : 'must be 1–50',
  MAX_ROTATION_PCT:         v => isNum(v) && (v as number) >= 5 && (v as number) <= 100 ? null : 'must be 5–100',
  MAX_DAILY_ROTATIONS:      v => isInt(v) && (v as number) >= 1 && (v as number) <= 100 ? null : 'must be 1–100',
  PORTFOLIO_FLOOR_USD:      v => isNum(v) && (v as number) >= 0 && (v as number) <= 100000 ? null : 'must be 0–100000',
  MIN_ROTATION_GAIN_PCT:    v => isNum(v) && (v as number) >= 0.5 && (v as number) <= 50 ? null : 'must be 0.5–50',
  MAX_CASH_PCT:             v => isNum(v) && (v as number) >= 10 && (v as number) <= 100 ? null : 'must be 10–100',
  OPTIMIZER_INTERVAL_SECONDS: v => isNum(v) && (v as number) >= 30 && (v as number) <= 3600 ? null : 'must be 30–3600',
  ROTATION_SELL_THRESHOLD:  v => isNum(v) && (v as number) >= -100 && (v as number) <= 0 ? null : 'must be -100–0',
  ROTATION_BUY_THRESHOLD:   v => isNum(v) && (v as number) >= 0 && (v as number) <= 100 ? null : 'must be 0–100',
  MIN_ROTATION_SCORE_DELTA: v => isNum(v) && (v as number) >= 10 && (v as number) <= 200 ? null : 'must be 10–200',
  RISK_OFF_THRESHOLD:       v => isNum(v) && (v as number) >= -100 && (v as number) <= 0 ? null : 'must be -100–0',
  RISK_ON_THRESHOLD:        v => isNum(v) && (v as number) >= 0 && (v as number) <= 100 ? null : 'must be 0–100',
  DEFAULT_FEE_ESTIMATE_PCT: v => isNum(v) && (v as number) >= 0.1 && (v as number) <= 10 ? null : 'must be 0.1–10',
  DASHBOARD_THEME:          v => ['light', 'dark'].includes(String(v)) ? null : 'must be "light" or "dark"',
  TELEGRAM_MODE:            v => ['all', 'important_only', 'digest', 'off'].includes(String(v)) ? null : 'must be all/important_only/digest/off',
  TELEGRAM_DIGEST_TIMES:    v => typeof v === 'string' && /^(\d{2}:\d{2})(,\d{2}:\d{2})*$/.test(v) ? null : 'must be comma-separated HH:MM times (e.g. "08:00,20:00")',
  TELEGRAM_QUIET_START:     v => !v || (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) ? null : 'must be HH:MM or empty',
  TELEGRAM_QUIET_END:       v => !v || (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) ? null : 'must be HH:MM or empty',
  BB_PERIOD:         v => isInt(v) && (v as number) >= 5 && (v as number) <= 100 ? null : 'must be 5-100',
  BB_STD_DEV:        v => isNum(v) && (v as number) >= 0.5 && (v as number) <= 5 ? null : 'must be 0.5-5',
  GRID_LEVELS:       v => isInt(v) && (v as number) >= 3 && (v as number) <= 50 ? null : 'must be 3-50',
  GRID_AMOUNT_PCT:   v => isNum(v) && (v as number) >= 1 && (v as number) <= 25 ? null : 'must be 1-25',
  GRID_UPPER_BOUND:  v => !v || (isNum(v) && (v as number) > 0) ? null : 'must be a positive number or empty',
  GRID_LOWER_BOUND:  v => !v || (isNum(v) && (v as number) > 0) ? null : 'must be a positive number or empty',
  GRID_RECALC_HOURS: v => isNum(v) && (v as number) >= 1 && (v as number) <= 48 ? null : 'must be 1-48',
  DASHBOARD_SECRET:  () => null, // read-only, validator not reached
  STOP_LOSS_PCT:          v => isNum(v) && (v as number) >= 1 && (v as number) <= 50 ? null : 'must be 1–50',
  TRAILING_STOP_PCT:      v => isNum(v) && (v as number) >= 0.5 && (v as number) <= 30 ? null : 'must be 0.5–30',
  MIN_ROTATION_PROFIT_USD: v => isNum(v) && (v as number) >= 0 && (v as number) <= 1000 ? null : 'must be 0–1000',
};

// Coerce string input → typed value (handles numeric keys, bool, arrays)
function coerce(key: ConfigKey, value: unknown): ConfigValue {
  if (key === 'DRY_RUN') {
    if (typeof value === 'boolean') return value;
    return String(value) === 'true';
  }
  if (key === 'TELEGRAM_ALLOWED_CHAT_IDS') {
    if (Array.isArray(value)) return value as number[];
    if (typeof value === 'string') return JSON.parse(value) as number[];
    return undefined;
  }
  const numericKeys: ConfigKey[] = [
    'TRADE_INTERVAL_SECONDS', 'POLL_INTERVAL_SECONDS',
    'PRICE_DROP_THRESHOLD_PCT', 'PRICE_RISE_TARGET_PCT',
    'SMA_SHORT_WINDOW', 'SMA_LONG_WINDOW',
    'MAX_TRADE_SIZE_ETH', 'MAX_TRADE_SIZE_USDC',
    'TRADE_COOLDOWN_SECONDS', 'WEB_PORT',
    'MAX_POSITION_PCT', 'MAX_DAILY_LOSS_PCT', 'MAX_ROTATION_PCT',
    'MAX_DAILY_ROTATIONS', 'PORTFOLIO_FLOOR_USD', 'MIN_ROTATION_GAIN_PCT',
    'MAX_CASH_PCT', 'OPTIMIZER_INTERVAL_SECONDS',
    'ROTATION_SELL_THRESHOLD', 'ROTATION_BUY_THRESHOLD', 'MIN_ROTATION_SCORE_DELTA',
    'RISK_OFF_THRESHOLD', 'RISK_ON_THRESHOLD', 'DEFAULT_FEE_ESTIMATE_PCT',
    'BB_PERIOD', 'BB_STD_DEV', 'GRID_LEVELS', 'GRID_AMOUNT_PCT', 'GRID_UPPER_BOUND', 'GRID_LOWER_BOUND', 'GRID_RECALC_HOURS',
    'STOP_LOSS_PCT', 'TRAILING_STOP_PCT', 'MIN_ROTATION_PROFIT_USD',
  ];
  if (numericKeys.includes(key) && typeof value !== 'number') {
    const n = Number(value);
    return isNaN(n) ? value as ConfigValue : n;
  }
  return value as ConfigValue;
}

function serialise(value: ConfigValue): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

export type DbQueries = {
  getSetting:    { get(key: string): { value: string } | undefined };
  upsertSetting: { run(key: string, value: string): void };
  getAllSettings: { all(): Array<{ key: string; value: string }> };
};

// Singleton instance — wired after DB and config are available
// Lazy so logger can import this module without triggering DB init at require time
let _singleton: RuntimeConfig | null = null;

export function setRuntimeConfigSingleton(instance: RuntimeConfig): void {
  _singleton = instance;
}

export const runtimeConfig = {
  get(key: ConfigKey): ConfigValue {
    return _singleton?.get(key);
  },
};

export class RuntimeConfig {
  private values = new Map<ConfigKey, ConfigValue>();
  private listeners = new Map<ConfigKey, Array<(v: ConfigValue) => void>>();
  private groupListeners: Array<{ keys: Set<ConfigKey>; callback: () => void }> = [];

  constructor(
    defaults: Record<string, ConfigValue>,
    private readonly db: DbQueries,
  ) {
    // Load defaults
    for (const key of ALL_KEYS) {
      this.values.set(key, (defaults as Record<ConfigKey, ConfigValue>)[key]);
    }
    // Overlay saved DB values
    for (const { key, value } of db.getAllSettings.all()) {
      if (ALL_KEYS.has(key as ConfigKey)) {
        this.values.set(key as ConfigKey, coerce(key as ConfigKey, value));
      }
    }
  }

  get(key: ConfigKey): ConfigValue {
    return this.values.get(key);
  }

  set(key: ConfigKey, rawValue: unknown): void {
    if (!ALL_KEYS.has(key)) throw new Error(`Unknown config key: ${key}`);
    if (READ_ONLY_KEYS.has(key)) throw new Error(`${key} is read-only and cannot be changed at runtime`);

    const value = coerce(key, rawValue);
    const err = VALIDATORS[key]?.(value);
    if (err) throw new Error(`${key}: ${err}`);

    this.values.set(key, value);
    this.db.upsertSetting.run(key, serialise(value));
    this.fireEvents([key]);
  }

  setBatch(changes: Partial<Record<ConfigKey, unknown>>): void {
    const entries = Object.entries(changes) as Array<[ConfigKey, unknown]>;

    // 1. Validate all first — throw before touching anything
    const coerced: Array<[ConfigKey, ConfigValue]> = [];
    for (const [key, rawValue] of entries) {
      if (!ALL_KEYS.has(key)) throw new Error(`Unknown config key: ${key}`);
      if (READ_ONLY_KEYS.has(key)) throw new Error(`${key} is read-only`);
      const value = coerce(key, rawValue);
      const err = VALIDATORS[key]?.(value);
      if (err) throw new Error(`${key}: ${err}`);
      coerced.push([key, value]);
    }

    // 2. Apply all in-memory + DB
    for (const [key, value] of coerced) {
      this.values.set(key, value);
      this.db.upsertSetting.run(key, serialise(value));
    }

    // 3. Fire events after all values are updated
    this.fireEvents(coerced.map(([k]) => k));
  }

  subscribe(key: ConfigKey, callback: (v: ConfigValue) => void): void {
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key)!.push(callback);
  }

  subscribeMany(keys: ConfigKey[], callback: () => void): void {
    this.groupListeners.push({ keys: new Set(keys), callback });
  }

  getAll(): Record<ConfigKey, ConfigValue> {
    return Object.fromEntries(this.values) as Record<ConfigKey, ConfigValue>;
  }

  private fireEvents(changedKeys: ConfigKey[]): void {
    const changedSet = new Set(changedKeys);
    // Single-key listeners
    for (const key of changedKeys) {
      const val = this.values.get(key);
      this.listeners.get(key)?.forEach(cb => cb(val));
    }
    // Group listeners — fire once per batch if any watched key changed
    for (const { keys, callback } of this.groupListeners) {
      if ([...changedSet].some(k => keys.has(k))) {
        callback();
      }
    }
  }
}
