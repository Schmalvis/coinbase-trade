import type { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as QRCode from 'qrcode';
import { generateSecret, verifyToken, encryptSecret, decryptSecret } from './totp.js';
import { logger } from '../core/logger.js';
import { checkRateLimit, resetRateLimit } from './middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

interface SettingQueries {
  getSetting: { get: (key: string) => { value: string } | undefined };
  upsertSetting: { run: (key: string, value: string) => void };
}

export function registerTotpRoutes(
  router: Router,
  settingQueries: SettingQueries,
  sessionSecret: string,
): void {
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
    } catch (err: any) {
      logger.error(`TOTP decrypt failed: ${err.message} (secret length: ${encryptedSecret.length}, sessionSecret length: ${sessionSecret.length})`);
      return res.status(500).json({ error: 'Failed to decrypt TOTP secret' });
    }

    if (!verifyToken(secret, token)) {
      logger.warn(`TOTP login failed for ${ip} — invalid code`);
      return res.status(401).json({ error: 'Invalid code' });
    }
    resetRateLimit(ip);
    (req.session as any).authenticated = true;
    res.json({ ok: true });
  });

  // POST /auth/logout
  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
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
}
