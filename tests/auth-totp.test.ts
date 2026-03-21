import { describe, it, expect } from 'vitest';
import { generateSecret, verifyToken, encryptSecret, decryptSecret, generateCurrentToken } from '../src/web/totp.js';

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
