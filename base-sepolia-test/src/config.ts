import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  MCP_SERVER_URL: z.string().url().default('http://192.168.68.139:3002/mcp'),

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
  TRADE_COOLDOWN_SECONDS: z.coerce.number().default(300),

  WEB_PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DRY_RUN: z.string().transform(s => s === 'true').default('true'),

  DATA_DIR: z.string().default('/home/pi/.local/share/coinbase-trade/base-sepolia'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
