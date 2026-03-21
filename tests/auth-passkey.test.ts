import { describe, it, expect, beforeEach } from 'vitest';
import { clearRateLimits, registerAuthRoutes } from '../src/web/auth.js';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

/**
 * In-memory mock of the passkeys DB table for testing.
 */
function createMockPasskeyQueries() {
  const passkeys = new Map<string, {
    id: string; public_key: string; counter: number;
    transports: string | null; created_at: string; label: string;
  }>();

  return {
    passkeys,
    insertPasskey: {
      run: (params: { id: string; public_key: string; counter: number; transports: string | null; label: string }) => {
        passkeys.set(params.id, { ...params, created_at: new Date().toISOString() });
      },
    },
    getPasskeyById: {
      get: (id: string) => passkeys.get(id),
    },
    getAllPasskeys: {
      all: () => Array.from(passkeys.values()),
    },
    updatePasskeyCounter: {
      run: (counter: number, id: string) => {
        const pk = passkeys.get(id);
        if (pk) pk.counter = counter;
      },
    },
    deletePasskey: {
      run: (id: string) => { passkeys.delete(id); },
    },
  };
}

describe('Passkey DB operations (mock)', () => {
  it('insert and retrieve a passkey', () => {
    const mock = createMockPasskeyQueries();
    mock.insertPasskey.run({
      id: 'cred-123',
      public_key: 'pk-base64url',
      counter: 0,
      transports: JSON.stringify(['internal']),
      label: 'My Phone',
    });
    const pk = mock.getPasskeyById.get('cred-123');
    expect(pk).toBeDefined();
    expect(pk!.public_key).toBe('pk-base64url');
    expect(pk!.label).toBe('My Phone');
  });

  it('getAllPasskeys returns all entries', () => {
    const mock = createMockPasskeyQueries();
    mock.insertPasskey.run({ id: 'a', public_key: 'pk-a', counter: 0, transports: null, label: 'A' });
    mock.insertPasskey.run({ id: 'b', public_key: 'pk-b', counter: 0, transports: null, label: 'B' });
    expect(mock.getAllPasskeys.all()).toHaveLength(2);
  });

  it('updatePasskeyCounter changes the counter', () => {
    const mock = createMockPasskeyQueries();
    mock.insertPasskey.run({ id: 'c', public_key: 'pk-c', counter: 0, transports: null, label: 'C' });
    mock.updatePasskeyCounter.run(5, 'c');
    expect(mock.getPasskeyById.get('c')!.counter).toBe(5);
  });

  it('deletePasskey removes the entry', () => {
    const mock = createMockPasskeyQueries();
    mock.insertPasskey.run({ id: 'd', public_key: 'pk-d', counter: 0, transports: null, label: 'D' });
    mock.deletePasskey.run('d');
    expect(mock.getPasskeyById.get('d')).toBeUndefined();
  });
});

describe('Passkey auth routes', () => {
  const SESSION_SECRET = 'test-passkey-session-secret';

  function makeApp() {
    const settings = new Map<string, string>();
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

    const mockPk = createMockPasskeyQueries();

    const app = express();
    app.use(express.json());
    app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true }));
    registerAuthRoutes(app, settingQueries, SESSION_SECRET, mockPk, {
      rpId: 'localhost',
      rpName: 'Test',
      origin: 'http://localhost:3000',
    });

    return { app, mockPk, settings };
  }

  beforeEach(() => {
    clearRateLimits();
  });

  it('GET /auth/passkey/register-options returns valid challenge', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/auth/passkey/register-options');
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBeDefined();
    expect(typeof res.body.challenge).toBe('string');
    expect(res.body.rp).toBeDefined();
    expect(res.body.rp.id).toBe('localhost');
    expect(res.body.rp.name).toBe('Test');
    expect(res.body.user).toBeDefined();
    expect(res.body.user.name).toBe('admin');
  });

  it('GET /auth/passkey/login-options returns 404 when no passkeys registered', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/auth/passkey/login-options');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No passkeys registered');
  });

  it('GET /auth/passkey/login-options returns options when passkeys exist', async () => {
    const { app, mockPk } = makeApp();
    mockPk.insertPasskey.run({
      id: 'test-cred',
      public_key: 'dGVzdC1wdWJsaWMta2V5',
      counter: 0,
      transports: JSON.stringify(['internal']),
      label: 'test',
    });
    const res = await request(app).get('/auth/passkey/login-options');
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBeDefined();
    expect(res.body.allowCredentials).toBeDefined();
    expect(res.body.allowCredentials.length).toBe(1);
  });

  it('POST /auth/passkey/login returns 400 when no pending challenge', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/auth/passkey/login').send({ id: 'fake' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No pending challenge');
  });

  it('POST /auth/passkey/register returns 400 when no pending challenge', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/auth/passkey/register').send({ id: 'fake' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No pending challenge');
  });

  it('rate limits passkey login attempts', async () => {
    const { app, mockPk } = makeApp();
    mockPk.insertPasskey.run({
      id: 'test-cred',
      public_key: 'dGVzdC1wdWJsaWMta2V5',
      counter: 0,
      transports: null,
      label: 'test',
    });

    const agent = request.agent(app);

    // Get a challenge first
    await agent.get('/auth/passkey/login-options');

    // Exhaust rate limit (5 attempts)
    for (let i = 0; i < 5; i++) {
      await agent.post('/auth/passkey/login').send({
        id: 'test-cred',
        rawId: 'dGVzdC1jcmVk',
        response: {
          authenticatorData: 'fake',
          clientDataJSON: 'fake',
          signature: 'fake',
        },
        type: 'public-key',
      });
    }

    // 6th should be rate limited
    const res = await agent.post('/auth/passkey/login').send({
      id: 'test-cred',
      rawId: 'dGVzdC1jcmVk',
      response: {
        authenticatorData: 'fake',
        clientDataJSON: 'fake',
        signature: 'fake',
      },
      type: 'public-key',
    });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('Too many attempts');
  });
});
