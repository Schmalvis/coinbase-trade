import { TOTP, Secret } from 'otpauth';
import * as crypto from 'crypto';

const ISSUER = 'CoinbaseTrade';

export function generateSecret(accountName: string): { secret: string; uri: string } {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({ issuer: ISSUER, label: accountName, secret, digits: 6, period: 30 });
  return { secret: secret.base32, uri: totp.toString() };
}

export function verifyToken(base32Secret: string, token: string): boolean {
  const totp = new TOTP({ secret: Secret.fromBase32(base32Secret), digits: 6, period: 30 });
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

export function encryptSecret(plaintext: string, key: string): string {
  const derivedKey = crypto.scryptSync(key, 'totp-salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decryptSecret(ciphertext: string, key: string): string {
  const derivedKey = crypto.scryptSync(key, 'totp-salt', 32);
  const [ivHex, encHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', derivedKey, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function generateCurrentToken(base32Secret: string): string {
  const totp = new TOTP({ secret: Secret.fromBase32(base32Secret), digits: 6, period: 30 });
  return totp.generate();
}
