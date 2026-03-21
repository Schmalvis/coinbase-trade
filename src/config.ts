import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  MCP_SERVER_URL: z.string().url().default('http://192.168.68.139:3002/mcp'),
  NETWORK_ID: z.string().default('base-sepolia'),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().transform(s =>
    s.split(',').map(id => parseInt(id.trim(), 10))
  ).optional(),

  POLL_INTERVAL_SECONDS: z.coerce.number().default(30),
  TRADE_INTERVAL_SECONDS: z.coerce.number().default(60),

  STRATEGY: z.enum(['threshold', 'sma']).default('threshold'),
  PRICE_DROP_THRESHOLD_PCT: z.coerce.number().default(2.0),
  PRICE_RISE_TARGET_PCT: z.coerce.number().default(3.0),
  SMA_SHORT_WINDOW: z.coerce.number().default(5),
  SMA_LONG_WINDOW: z.coerce.number().default(20),

  MAX_TRADE_SIZE_ETH: z.coerce.number().default(0.01),
  MAX_TRADE_SIZE_USDC: z.coerce.number().default(10),
  TRADE_COOLDOWN_SECONDS: z.coerce.number().default(300),

  WEB_PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DRY_RUN: z.string().transform(s => s === 'true').default('true'),

  DATA_DIR: z.string().default('/home/pi/.local/share/coinbase-trade/base-sepolia'),
  ALCHEMY_API_KEY: z.string().optional(),
  DASHBOARD_SECRET: z.string().optional().default(''),
  SESSION_SECRET: z.string().default(''),
  ALLOWED_IPS: z.string().default(''),

  MAX_POSITION_PCT: z.coerce.number().default(40),
  MAX_DAILY_LOSS_PCT: z.coerce.number().default(5),
  MAX_ROTATION_PCT: z.coerce.number().default(25),
  MAX_DAILY_ROTATIONS: z.coerce.number().default(10),
  PORTFOLIO_FLOOR_USD: z.coerce.number().default(100),
  MIN_ROTATION_GAIN_PCT: z.coerce.number().default(2),
  MAX_CASH_PCT: z.coerce.number().default(80),
  OPTIMIZER_INTERVAL_SECONDS: z.coerce.number().default(300),
  ROTATION_SELL_THRESHOLD: z.coerce.number().default(-20),
  ROTATION_BUY_THRESHOLD: z.coerce.number().default(30),
  MIN_ROTATION_SCORE_DELTA: z.coerce.number().default(40),
  RISK_OFF_THRESHOLD: z.coerce.number().default(-10),
  RISK_ON_THRESHOLD: z.coerce.number().default(15),
  DEFAULT_FEE_ESTIMATE_PCT: z.coerce.number().default(1.0),
  DASHBOARD_THEME: z.string().default('dark'),
  TELEGRAM_MODE: z.string().default('all'),
  TELEGRAM_DIGEST_TIMES: z.string().default('08:00,20:00'),
  TELEGRAM_QUIET_START: z.string().default(''),
  TELEGRAM_QUIET_END: z.string().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export const availableNetworks = config.NETWORK_ID.split(',').map(n => n.trim()).filter(Boolean);
