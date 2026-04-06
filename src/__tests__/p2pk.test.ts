import { describe, it, expect } from 'vitest';
import { generateP2pkKeyPair, publicKeyFromPrivate, isValidP2pkPublicKey } from '../cashu/p2pk';

describe('generateP2pkKeyPair', () => {
  it('generates a valid keypair', () => {
    const kp = generateP2pkKeyPair();
    expect(kp.publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(kp.privateKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique keypairs', () => {
    const kp1 = generateP2pkKeyPair();
    const kp2 = generateP2pkKeyPair();
    expect(kp1.privateKey).not.toBe(kp2.privateKey);
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
  });

  it('public key is derived from private key', () => {
    const kp = generateP2pkKeyPair();
    const derived = publicKeyFromPrivate(kp.privateKey);
    expect(derived).toBe(kp.publicKey);
  });
});

describe('publicKeyFromPrivate', () => {
  it('derives compressed public key', () => {
    const kp = generateP2pkKeyPair();
    const pub = publicKeyFromPrivate(kp.privateKey);
    // Compressed public keys start with 02 or 03
    expect(pub).toMatch(/^0[23][0-9a-f]{64}$/);
  });

  it('produces consistent results', () => {
    const kp = generateP2pkKeyPair();
    const pub1 = publicKeyFromPrivate(kp.privateKey);
    const pub2 = publicKeyFromPrivate(kp.privateKey);
    expect(pub1).toBe(pub2);
  });
});

describe('isValidP2pkPublicKey', () => {
  it('accepts valid compressed public key (02 prefix)', () => {
    const kp = generateP2pkKeyPair();
    // Ensure we have a 02 or 03 key
    expect(isValidP2pkPublicKey(kp.publicKey)).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidP2pkPublicKey('')).toBe(false);
  });

  it('rejects too short string', () => {
    expect(isValidP2pkPublicKey('02abcdef')).toBe(false);
  });

  it('rejects uncompressed key (04 prefix)', () => {
    expect(isValidP2pkPublicKey('04' + 'a'.repeat(128))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidP2pkPublicKey('02' + 'g'.repeat(64))).toBe(false);
  });

  it('rejects wrong prefix', () => {
    expect(isValidP2pkPublicKey('05' + 'a'.repeat(64))).toBe(false);
  });

  it('rejects random hex of correct length', () => {
    // A random 33-byte hex with 02 prefix is almost certainly not on the curve,
    // but it depends on the specific value. Generate a known invalid one:
    // All zeros after prefix is not a valid point
    expect(isValidP2pkPublicKey('02' + '0'.repeat(64))).toBe(false);
  });
});
