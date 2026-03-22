import type { Router } from 'express';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { logger } from '../core/logger.js';
import { checkRateLimit, resetRateLimit } from './middleware.js';

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

export function registerWebAuthnRoutes(
  router: Router,
  _settingQueries: SettingQueries,
  passkeyQueries: PasskeyQueries,
  webauthnConfig: WebAuthnConfig,
): void {
  const rpID = webauthnConfig.rpId;
  const rpName = webauthnConfig.rpName;
  const expectedOrigin = webauthnConfig.origin;

  // GET /auth/passkey/register-options
  router.get('/passkey/register-options', async (req, res) => {
    try {
      const existingPasskeys = passkeyQueries.getAllPasskeys.all();
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
      passkeyQueries.insertPasskey.run({
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
      const existingPasskeys = passkeyQueries.getAllPasskeys.all();
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
      const passkey = passkeyQueries.getPasskeyById.get(credentialId);
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
      passkeyQueries.updatePasskeyCounter.run(
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
