import type { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import { logger } from '../core/logger.js';

/**
 * Bearer-token authentication middleware for mutating API endpoints.
 * - GET requests always pass (read-only dashboard viewing)
 * - If no secret is configured, all requests pass (backwards-compatible)
 * - POST/PUT/DELETE require Authorization: Bearer <secret>
 */
export function createAuthMiddleware(getSecret: () => string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Read-only methods always pass
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }

    const secret = getSecret();

    // No secret configured — allow all (backwards-compatible)
    if (!secret) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn(`Unauthorized ${req.method} ${req.path} from ${req.ip} — missing Bearer token`);
      res.status(401).json({ error: 'Authorization required — set Dashboard Secret in Settings' });
      return;
    }

    const token = authHeader.slice(7);
    if (token !== secret) {
      logger.warn(`Unauthorized ${req.method} ${req.path} from ${req.ip} — invalid Bearer token`);
      res.status(403).json({ error: 'Invalid dashboard secret' });
      return;
    }

    next();
  };
}

/* ── IP allowlist ─────────────────────────────────────────────── */

export function isIpAllowed(ip: string, allowlist: string): boolean {
  if (!allowlist || allowlist.trim() === '') return true;
  const cidrs = allowlist.split(',').map(s => s.trim()).filter(Boolean);
  const normalizedIp = ip.replace(/^::ffff:/, '');
  for (const cidr of cidrs) {
    if (cidr.includes('/')) {
      const [network, bits] = cidr.split('/');
      if (ipInSubnet(normalizedIp, network, parseInt(bits))) return true;
    } else {
      if (normalizedIp === cidr) return true;
    }
  }
  return false;
}

function ipInSubnet(ip: string, network: string, bits: number): boolean {
  const ipNum = ipToNumber(ip);
  const netNum = ipToNumber(network);
  const mask = ~((1 << (32 - bits)) - 1) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

function ipToNumber(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
}

/* ── Session middleware ────────────────────────────────────────── */

export function createSessionMiddleware(secret: string) {
  return session({
    secret,
    resave: false,
    saveUninitialized: false,
    name: 'trade_session',
    cookie: {
      httpOnly: true,
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  });
}
