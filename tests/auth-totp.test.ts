import { describe, it, expect, beforeEach } from 'vitest';
import { generateSecret, verifyToken, encryptSecret, decryptSecret, generateCurrentToken } from '../src/web/totp.js';
import { isIpAllowed, checkRateLimit, resetRateLimit, clearRateLimits, requireAuth, registerAuthRoutes } from '../src/web/auth.js';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

describe('TOTP utility', () => {
  it('generateSecret returns base32 string and URI', () => {
    const result = generateSecret('admin');
    expect(result.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(result.uri).toContain('otpauth://totp/');
    expect(result.uri).toContain('CoinbaseTrade');
  });

  it('verifyToken accepts valid token', () => {
    const { secret } = generateSecret('test');
    const token = generateCurrentToken(secret);
    expect(verifyToken(secret, token)).toBe(true);
  });

  it('verifyToken rejects invalid token', () => {
    const { secret } = generateSecret('test');
    expect(verifyToken(secret, '000000')).toBe(false);
  });

  it('encryptSecret produces different output than input', () => {
    const encrypted = encryptSecret('MY_SECRET', 'my-key');
    expect(encrypted).not.toBe('MY_SECRET');
    expect(encrypted).toContain(':');
  });

  it('decryptSecret reverses encryptSecret', () => {
    const original = 'JBSWY3DPEHPK3PXP';
    const key = 'session-secret-key';
    const encrypted = encryptSecret(original, key);
    const decrypted = decryptSecret(encrypted, key);
    expect(decrypted).toBe(original);
  });

  it('decryptSecret fails with wrong key', () => {
    const encrypted = encryptSecret('MY_SECRET', 'correct-key');
    expect(() => decryptSecret(encrypted, 'wrong-key')).toThrow();
  });
});

describe('IP allowlist', () => {
  it('allows IP in CIDR range', () => {
    expect(isIpAllowed('192.168.1.5', '192.168.1.0/24')).toBe(true);
  });
  it('rejects IP outside CIDR range', () => {
    expect(isIpAllowed('10.0.0.1', '192.168.1.0/24')).toBe(false);
  });
  it('allows all when allowlist is empty', () => {
    expect(isIpAllowed('10.0.0.1', '')).toBe(true);
  });
  it('supports multiple CIDRs', () => {
    expect(isIpAllowed('10.0.0.1', '192.168.1.0/24,10.0.0.0/8')).toBe(true);
  });
  it('strips IPv6-mapped prefix', () => {
    expect(isIpAllowed('::ffff:192.168.1.5', '192.168.1.0/24')).toBe(true);
  });
  it('allows exact IP match', () => {
    expect(isIpAllowed('192.168.1.100', '192.168.1.100')).toBe(true);
  });
});

describe('Rate limiting', () => {
  beforeEach(() => {
    clearRateLimits();
  });

  it('allows first request', () => {
    expect(checkRateLimit('1.2.3.4')).toBe(true);
  });

  it('allows up to 5 requests', () => {
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit('1.2.3.4')).toBe(true);
    }
  });

  it('blocks 6th request within window', () => {
    for (let i = 0; i < 5; i++) checkRateLimit('1.2.3.4');
    expect(checkRateLimit('1.2.3.4')).toBe(false);
  });

  it('tracks IPs independently', () => {
    for (let i = 0; i < 5; i++) checkRateLimit('1.2.3.4');
    expect(checkRateLimit('5.6.7.8')).toBe(true);
  });

  it('resetRateLimit clears an IP', () => {
    for (let i = 0; i < 5; i++) checkRateLimit('1.2.3.4');
    resetRateLimit('1.2.3.4');
    expect(checkRateLimit('1.2.3.4')).toBe(true);
  });
});

describe('requireAuth middleware', () => {
  function makeApp(totpSecret: string | undefined) {
    const app = express();
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use(requireAuth(() => totpSecret));
    app.get('/api/status', (_req, res) => res.json({ ok: true }));
    app.get('/dashboard', (_req, res) => res.send('dashboard'));
    app.get('/auth/login', (_req, res) => res.send('login page'));
    app.get('/api/health', (_req, res) => res.json({ healthy: true }));
    app.get('/login.html', (_req, res) => res.send('login static'));
    return app;
  }

  it('allows /auth/* routes through', async () => {
    const app = makeApp('some-secret');
    const res = await request(app).get('/auth/login');
    expect(res.status).toBe(200);
    expect(res.text).toBe('login page');
  });

  it('allows /api/health through', async () => {
    const app = makeApp('some-secret');
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('allows /login.html through', async () => {
    const app = makeApp('some-secret');
    const res = await request(app).get('/login.html');
    expect(res.status).toBe(200);
  });

  it('redirects to /auth/setup when no TOTP configured (browser)', async () => {
    const app = makeApp(undefined);
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/setup');
  });

  it('returns 401 for API when no TOTP configured', async () => {
    const app = makeApp(undefined);
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Setup required');
  });

  it('redirects unauthenticated browser to /auth/login', async () => {
    const app = makeApp('some-secret');
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  it('returns 401 for unauthenticated API', async () => {
    const app = makeApp('some-secret');
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  it('allows requests with Bearer token through', async () => {
    const app = makeApp('some-secret');
    const res = await request(app).get('/api/status').set('Authorization', 'Bearer my-token');
    expect(res.status).toBe(200);
  });
});

describe('Auth routes integration', () => {
  const SESSION_SECRET = 'test-session-secret-for-auth';
  let settings: Map<string, string>;

  function makeApp() {
    settings = new Map();
    const settingQueries = {
      getSetting: {
        get: (key: string) => {
          const value = settings.get(key);
          return value ? { value } : undefined;
        },
      },
      upsertSetting: {
        run: (key: string, value: string) => { settings.set(key, value); },
      },
    };

    const app = express();
    app.use(express.json());
    app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true }));
    registerAuthRoutes(app, settingQueries, SESSION_SECRET);
    return app;
  }

  beforeEach(() => {
    clearRateLimits();
  });

  it('POST /auth/login returns 400 when TOTP not configured', async () => {
    const app = makeApp();
    const res = await request(app).post('/auth/login').send({ token: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TOTP not configured');
  });

  it('POST /auth/login returns 401 for invalid token', async () => {
    const app = makeApp();
    // Store an encrypted TOTP secret
    const { secret } = generateSecret('test');
    const encrypted = encryptSecret(secret, SESSION_SECRET);
    settings.set('TOTP_SECRET', encrypted);

    const res = await request(app).post('/auth/login').send({ token: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid code');
  });

  it('POST /auth/login succeeds with valid token', async () => {
    const app = makeApp();
    const { secret } = generateSecret('test');
    const encrypted = encryptSecret(secret, SESSION_SECRET);
    settings.set('TOTP_SECRET', encrypted);

    const validToken = generateCurrentToken(secret);
    const res = await request(app).post('/auth/login').send({ token: validToken });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /auth/login rate limits after 5 attempts', async () => {
    const app = makeApp();
    const { secret } = generateSecret('test');
    const encrypted = encryptSecret(secret, SESSION_SECRET);
    settings.set('TOTP_SECRET', encrypted);

    // 5 bad attempts
    for (let i = 0; i < 5; i++) {
      await request(app).post('/auth/login').send({ token: '000000' });
    }
    // 6th should be rate limited
    const res = await request(app).post('/auth/login').send({ token: '000000' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('Too many attempts');
  });

  it('POST /auth/logout destroys session', async () => {
    const app = makeApp();
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /auth/setup redirects to login when TOTP already configured', async () => {
    const app = makeApp();
    settings.set('TOTP_SECRET', 'some-encrypted-value');
    const res = await request(app).get('/auth/setup');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  it('GET /auth/setup-qr returns 403 when TOTP already configured', async () => {
    const app = makeApp();
    settings.set('TOTP_SECRET', 'some-encrypted-value');
    const res = await request(app).get('/auth/setup-qr');
    expect(res.status).toBe(403);
  });

  it('GET /auth/setup-info returns 400 when no pending setup', async () => {
    const app = makeApp();
    const res = await request(app).get('/auth/setup-info');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No pending setup');
  });

  it('POST /auth/setup-confirm returns 400 when no pending setup', async () => {
    const app = makeApp();
    const res = await request(app).post('/auth/setup-confirm').send({ token: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No pending setup');
  });

  it('full setup flow: setup-qr → setup-confirm stores secret', async () => {
    const app = makeApp();
    const agent = request.agent(app);

    // Step 1: Get QR code (generates pending secret in session)
    const qrRes = await agent.get('/auth/setup-qr');
    expect(qrRes.status).toBe(200);
    expect(qrRes.body.qr).toContain('data:image/png;base64,');

    // Step 2: Get the pending secret for manual entry
    const infoRes = await agent.get('/auth/setup-info');
    expect(infoRes.status).toBe(200);
    const pendingSecret = infoRes.body.secret;
    expect(pendingSecret).toBeTruthy();

    // Step 3: Generate a valid token from the pending secret
    const validToken = generateCurrentToken(pendingSecret);

    // Step 4: Confirm setup with valid token
    const confirmRes = await agent.post('/auth/setup-confirm').send({ token: validToken });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.ok).toBe(true);

    // Verify secret was stored (encrypted)
    expect(settings.has('TOTP_SECRET')).toBe(true);
    const stored = settings.get('TOTP_SECRET')!;
    expect(stored).toContain(':'); // encrypted format: iv:ciphertext
    // Verify it decrypts back correctly
    const decrypted = decryptSecret(stored, SESSION_SECRET);
    expect(decrypted).toBe(pendingSecret);
  });

  it('setup-confirm rejects invalid token', async () => {
    const app = makeApp();
    const agent = request.agent(app);

    // Generate pending secret
    await agent.get('/auth/setup-qr');

    // Try to confirm with bad token
    const res = await agent.post('/auth/setup-confirm').send({ token: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid code');
    // Secret should NOT be stored
    expect(settings.has('TOTP_SECRET')).toBe(false);
  });
});
