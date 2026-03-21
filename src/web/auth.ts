import type { Request, Response, NextFunction, Express } from 'express';
import { Router } from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import * as QRCode from 'qrcode';
import { generateSecret, verifyToken, encryptSecret, decryptSecret } from './totp.js';
import { logger } from '../core/logger.js';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

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

/* ── Rate limiting ─────────────────────────────────────────────── */

const loginAttempts: Map<string, { count: number; resetAt: number }> = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_ATTEMPTS;
}

export function resetRateLimit(ip: string): void {
  loginAttempts.delete(ip);
}

/** Exported for testing — clears all rate limit entries */
export function clearRateLimits(): void {
  loginAttempts.clear();
}

/* ── Auth routes ───────────────────────────────────────────────── */

interface SettingQueries {
  getSetting: { get: (key: string) => { value: string } | undefined };
  upsertSetting: { run: (key: string, value: string) => void };
}

interface PasskeyQueries {
  insertPasskey: { run: (params: { id: string; public_key: string; counter: number; transports: string | null; label: string }) => void };
  getPasskeyById: { get: (id: string) => { id: string; public_key: string; counter: number; transports: string | null; created_at: string; label: string } | undefined };
  getAllPasskeys: { all: () => Array<{ id: string; public_key: string; counter: number; transports: string | null; created_at: string; label: string }> };
  updatePasskeyCounter: { run: (counter: number, id: string) => void };
  deletePasskey: { run: (id: string) => void };
}

interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  origin: string;
}

export function registerAuthRoutes(
  app: { use: (path: string, router: Router) => void },
  settingQueries: SettingQueries,
  sessionSecret: string,
  passkeyQueriesParam?: PasskeyQueries,
  webauthnConfig?: WebAuthnConfig,
): void {
  const router = Router();

  // GET /auth/login — serve login page
  router.get('/login', (_req, res) => {
    res.sendFile(path.join(publicDir, 'login.html'));
  });

  // GET /auth/setup — serve setup page (only if no TOTP configured)
  router.get('/setup', (req, res) => {
    const existing = settingQueries.getSetting.get('TOTP_SECRET');
    if (existing?.value) {
      return res.redirect('/auth/login');
    }
    res.sendFile(path.join(publicDir, 'setup.html'));
  });

  // GET /auth/setup-qr — return QR code as PNG image
  router.get('/setup-qr', async (req, res) => {
    const existing = settingQueries.getSetting.get('TOTP_SECRET');
    if (existing?.value) {
      return res.status(403).send('Already configured');
    }
    // Generate or reuse pending secret from session
    let pendingSecret = (req.session as any)?._pendingTotpSecret;
    if (!pendingSecret) {
      const result = generateSecret('admin');
      pendingSecret = result.secret;
      (req.session as any)._pendingTotpSecret = pendingSecret;
      (req.session as any)._pendingTotpUri = result.uri;
    }
    const uri = (req.session as any)._pendingTotpUri;
    const pngBuffer = await QRCode.toBuffer(uri, { type: 'png', width: 256 });
    res.setHeader('Content-Type', 'image/png');
    res.send(pngBuffer);
  });

  // GET /auth/setup-info — return secret for manual entry
  router.get('/setup-info', (req, res) => {
    const secret = (req.session as any)?._pendingTotpSecret;
    if (!secret) return res.status(400).json({ error: 'No pending setup' });
    res.json({ secret });
  });

  // POST /auth/setup-confirm — verify token and store secret
  router.post('/setup-confirm', (req, res) => {
    const { token } = req.body;
    const pendingSecret = (req.session as any)?._pendingTotpSecret;
    if (!pendingSecret) return res.status(400).json({ error: 'No pending setup' });
    if (!verifyToken(pendingSecret, token)) {
      return res.status(401).json({ error: 'Invalid code' });
    }
    // Store encrypted secret
    const encrypted = encryptSecret(pendingSecret, sessionSecret);
    settingQueries.upsertSetting.run('TOTP_SECRET', encrypted);
    // Set session as authenticated
    (req.session as any).authenticated = true;
    delete (req.session as any)._pendingTotpSecret;
    delete (req.session as any)._pendingTotpUri;
    res.json({ ok: true });
  });

  // POST /auth/login — verify TOTP token
  router.post('/login', (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many attempts' });
    }
    const { token } = req.body;
    const encryptedSecret = settingQueries.getSetting.get('TOTP_SECRET')?.value;
    if (!encryptedSecret) return res.status(400).json({ error: 'TOTP not configured' });

    let secret: string;
    try {
      secret = decryptSecret(encryptedSecret, sessionSecret);
    } catch {
      return res.status(500).json({ error: 'Failed to decrypt TOTP secret' });
    }

    if (!verifyToken(secret, token)) {
      return res.status(401).json({ error: 'Invalid code' });
    }
    resetRateLimit(ip);
    (req.session as any).authenticated = true;
    res.json({ ok: true });
  });

  // POST /auth/reset — clear TOTP secret and passkeys (LAN only: 192.168.68.x)
  router.post('/reset', (req, res) => {
    const ip = (req.ip || '').replace(/^::ffff:/, '');
    if (!ip.startsWith('192.168.68.')) {
      logger.warn(`Auth reset rejected from ${ip}`);
      return res.status(403).json({ error: 'Reset only allowed from local network' });
    }
    settingQueries.upsertSetting.run('TOTP_SECRET', '');
    logger.info(`Auth reset by ${ip} — TOTP secret cleared`);
    req.session.destroy(() => {
      res.json({ ok: true, message: 'TOTP secret cleared. Visit /auth/setup to reconfigure.' });
    });
  });

  // POST /auth/logout
  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  /* ── Passkey / WebAuthn routes ──────────────────────────────── */

  if (passkeyQueriesParam && webauthnConfig) {
    const pkQueries = passkeyQueriesParam;
    const rpID = webauthnConfig.rpId;
    const rpName = webauthnConfig.rpName;
    const expectedOrigin = webauthnConfig.origin;

    // GET /auth/passkey/register-options
    router.get('/passkey/register-options', async (req, res) => {
      try {
        const existingPasskeys = pkQueries.getAllPasskeys.all();
        const options = await generateRegistrationOptions({
          rpName,
          rpID,
          userName: 'admin',
          userDisplayName: 'Admin',
          attestationType: 'none',
          excludeCredentials: existingPasskeys.map(pk => ({
            id: pk.id,
            transports: pk.transports ? JSON.parse(pk.transports) : undefined,
          })),
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'preferred',
          },
        });
        (req.session as any)._webauthnChallenge = options.challenge;
        res.json(options);
      } catch (err: any) {
        logger.error(`Passkey register-options error: ${err.message}`);
        res.status(500).json({ error: 'Failed to generate registration options' });
      }
    });

    // POST /auth/passkey/register
    router.post('/passkey/register', async (req, res) => {
      const challenge = (req.session as any)?._webauthnChallenge;
      if (!challenge) {
        return res.status(400).json({ error: 'No pending challenge' });
      }
      try {
        const verification = await verifyRegistrationResponse({
          response: req.body,
          expectedChallenge: challenge,
          expectedOrigin,
          expectedRPID: rpID,
        });
        if (!verification.verified || !verification.registrationInfo) {
          return res.status(400).json({ error: 'Verification failed' });
        }
        const { credential } = verification.registrationInfo;
        pkQueries.insertPasskey.run({
          id: credential.id,
          public_key: isoBase64URL.fromBuffer(credential.publicKey),
          counter: credential.counter,
          transports: req.body.response?.transports ? JSON.stringify(req.body.response.transports) : null,
          label: req.body.label || 'default',
        });
        delete (req.session as any)._webauthnChallenge;
        (req.session as any).authenticated = true;
        res.json({ ok: true, credentialId: credential.id });
      } catch (err: any) {
        logger.error(`Passkey register error: ${err.message}`);
        res.status(400).json({ error: err.message || 'Registration failed' });
      }
    });

    // GET /auth/passkey/login-options
    router.get('/passkey/login-options', async (req, res) => {
      try {
        const existingPasskeys = pkQueries.getAllPasskeys.all();
        if (existingPasskeys.length === 0) {
          return res.status(404).json({ error: 'No passkeys registered' });
        }
        const options = await generateAuthenticationOptions({
          rpID,
          allowCredentials: existingPasskeys.map(pk => ({
            id: pk.id,
            transports: pk.transports ? JSON.parse(pk.transports) : undefined,
          })),
          userVerification: 'preferred',
        });
        (req.session as any)._webauthnChallenge = options.challenge;
        res.json(options);
      } catch (err: any) {
        logger.error(`Passkey login-options error: ${err.message}`);
        res.status(500).json({ error: 'Failed to generate authentication options' });
      }
    });

    // POST /auth/passkey/login
    router.post('/passkey/login', async (req, res) => {
      const ip = req.ip || 'unknown';
      if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many attempts' });
      }
      const challenge = (req.session as any)?._webauthnChallenge;
      if (!challenge) {
        return res.status(400).json({ error: 'No pending challenge' });
      }
      try {
        const credentialId = req.body.id;
        const passkey = pkQueries.getPasskeyById.get(credentialId);
        if (!passkey) {
          return res.status(401).json({ error: 'Unknown credential' });
        }
        const verification = await verifyAuthenticationResponse({
          response: req.body,
          expectedChallenge: challenge,
          expectedOrigin,
          expectedRPID: rpID,
          credential: {
            id: passkey.id,
            publicKey: isoBase64URL.toBuffer(passkey.public_key),
            counter: passkey.counter,
            transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
          },
        });
        if (!verification.verified) {
          return res.status(401).json({ error: 'Authentication failed' });
        }
        pkQueries.updatePasskeyCounter.run(
          verification.authenticationInfo.newCounter,
          credentialId,
        );
        delete (req.session as any)._webauthnChallenge;
        resetRateLimit(ip);
        (req.session as any).authenticated = true;
        res.json({ ok: true });
      } catch (err: any) {
        logger.error(`Passkey login error: ${err.message}`);
        res.status(401).json({ error: err.message || 'Authentication failed' });
      }
    });
  }

  app.use('/auth', router);
}

/* ── Route protection middleware ───────────────────────────────── */

export function requireAuth(
  getTotpSecret: () => string | undefined,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Always allow auth routes
    if (req.path.startsWith('/auth/')) { next(); return; }
    // Always allow health check
    if (req.path === '/api/health') { next(); return; }
    // Allow login/setup static files
    if (req.path === '/login.html' || req.path === '/setup.html') { next(); return; }

    const totpSecret = getTotpSecret();

    // No TOTP configured — redirect to setup
    if (!totpSecret) {
      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: 'Setup required' });
      } else {
        res.redirect('/auth/setup');
      }
      return;
    }

    // Check session
    if ((req.session as any)?.authenticated) { next(); return; }

    // Check bearer token (preserve existing API auth for CLI/Telegram)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      next(); return; // Let existing createAuthMiddleware handle bearer validation
    }

    // Not authenticated
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Authentication required' });
    } else {
      res.redirect('/auth/login');
    }
  };
}
