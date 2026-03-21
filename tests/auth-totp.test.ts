import { describe, it, expect } from 'vitest';
import { generateSecret, verifyToken, encryptSecret, decryptSecret, generateCurrentToken } from '../src/web/totp.js';
import { isIpAllowed } from '../src/web/auth.js';

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
