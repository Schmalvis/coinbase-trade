import type { Request, Response, NextFunction } from 'express';
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
