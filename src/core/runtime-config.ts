export type ConfigKey =
  | 'STRATEGY' | 'TRADE_INTERVAL_SECONDS' | 'POLL_INTERVAL_SECONDS'
  | 'PRICE_DROP_THRESHOLD_PCT' | 'PRICE_RISE_TARGET_PCT'
  | 'SMA_SHORT_WINDOW' | 'SMA_LONG_WINDOW'
  | 'MAX_TRADE_SIZE_ETH' | 'MAX_TRADE_SIZE_USDC'
  | 'TRADE_COOLDOWN_SECONDS' | 'DRY_RUN' | 'LOG_LEVEL'
  | 'WEB_PORT' | 'DATA_DIR' | 'MCP_SERVER_URL'
  | 'NETWORK_ID' | 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_ALLOWED_CHAT_IDS';

export type ConfigValue = string | number | boolean | number[] | undefined;

const ALL_KEYS = new Set<ConfigKey>([
  'STRATEGY', 'TRADE_INTERVAL_SECONDS', 'POLL_INTERVAL_SECONDS',
  'PRICE_DROP_THRESHOLD_PCT', 'PRICE_RISE_TARGET_PCT',
  'SMA_SHORT_WINDOW', 'SMA_LONG_WINDOW',
  'MAX_TRADE_SIZE_ETH', 'MAX_TRADE_SIZE_USDC',
  'TRADE_COOLDOWN_SECONDS', 'DRY_RUN', 'LOG_LEVEL',
  'WEB_PORT', 'DATA_DIR', 'MCP_SERVER_URL',
  'NETWORK_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS',
]);

const READ_ONLY_KEYS = new Set<ConfigKey>([
  'WEB_PORT', 'DATA_DIR', 'MCP_SERVER_URL',
  'NETWORK_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS',
]);

// Returns null if valid, error string if invalid
type Validator = (v: unknown) => string | null;

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown) => typeof v === 'number' && !isNaN(v);

const VALIDATORS: Record<ConfigKey, Validator> = {
  STRATEGY:               v => ['threshold', 'sma'].includes(String(v)) ? null : 'must be "threshold" or "sma"',
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
