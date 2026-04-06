import { describe, it, expect } from 'vitest';
import { assertP2PKLocked } from '../protocol/cashu-transfer-protocol';
import { generateP2pkKeyPair } from '../cashu/p2pk';
import type { TransferData } from '../protocol/cashu-transfer-protocol';

/**
 * Create a fake V3 cashuA token with P2PK-locked proof secrets.
 * The token format is: cashuA + base64(JSON).
 * V3 JSON: { token: [{ mint: "...", proofs: [...] }], unit: "sat" }
 * P2PK secret format: ["P2PK", {"nonce": "...", "data": "<pubkey>"}]
 */
function makeFakeP2pkToken(mintUrl: string, pubkey: string): string {
  const tokenJson = {
    token: [{
      mint: mintUrl,
      proofs: [{
        amount: 4,
        id: '00test',
        secret: JSON.stringify(['P2PK', { nonce: 'abc123', data: pubkey }]),
        C: '02abcdef1234567890',
      }],
    }],
    unit: 'sat',
  };
  return 'cashuA' + btoa(JSON.stringify(tokenJson));
}

/** Create a fake V3 token WITHOUT P2PK locking (plain secret). */
function makeFakeUnlockedToken(mintUrl: string): string {
  const tokenJson = {
    token: [{
      mint: mintUrl,
      proofs: [{
        amount: 4,
        id: '00test',
        secret: 'regular-hex-secret-not-p2pk',
        C: '02abcdef1234567890',
      }],
    }],
    unit: 'sat',
  };
  return 'cashuA' + btoa(JSON.stringify(tokenJson));
}

describe('assertP2PKLocked', () => {
  const validKey = generateP2pkKeyPair();
  const mintUrl = 'https://testnut.cashu.space';

  const validTransfer: TransferData = {
    token           : makeFakeP2pkToken(mintUrl, validKey.publicKey),
    amount          : 100,
    unit            : 'sat',
    mintUrl,
    senderDid       : 'did:dht:sender123',
    recipientPubkey : validKey.publicKey,
  };

  // --- Metadata validation ---

  it('accepts valid P2PK-locked transfer', () => {
    expect(() => assertP2PKLocked(validTransfer)).not.toThrow();
  });

  it('accepts transfer with memo', () => {
    expect(() => assertP2PKLocked({ ...validTransfer, memo: 'test' })).not.toThrow();
  });

  it('rejects empty token', () => {
    expect(() => assertP2PKLocked({ ...validTransfer, token: '' })).toThrow('token is empty');
  });

  it('rejects whitespace-only token', () => {
    expect(() => assertP2PKLocked({ ...validTransfer, token: '   ' })).toThrow('token is empty');
  });

  it('rejects empty senderDid', () => {
    expect(() => assertP2PKLocked({ ...validTransfer, senderDid: '' })).toThrow('senderDid is empty');
  });

  it('rejects missing recipientPubkey', () => {
    expect(() => assertP2PKLocked({ ...validTransfer, recipientPubkey: '' })).toThrow('missing recipientPubkey');
  });

  it('rejects invalid recipientPubkey', () => {
    expect(() => assertP2PKLocked({ ...validTransfer, recipientPubkey: 'not-a-key' })).toThrow('Invalid recipientPubkey');
  });

  it('rejects uncompressed public key', () => {
    expect(() => assertP2PKLocked({ ...validTransfer, recipientPubkey: '04' + 'a'.repeat(128) })).toThrow('Invalid recipientPubkey');
  });

  // --- Token-level P2PK verification ---

  it('rejects token that is not P2PK-locked', () => {
    const unlockedTransfer: TransferData = {
      ...validTransfer,
      token: makeFakeUnlockedToken(mintUrl),
    };
    expect(() => assertP2PKLocked(unlockedTransfer)).toThrow('not P2PK-locked');
  });

  it('rejects arbitrary string as token (not parseable as cashu token)', () => {
    const badTransfer: TransferData = {
      ...validTransfer,
      token: 'cashuBsomegarbage',
    };
    expect(() => assertP2PKLocked(badTransfer)).toThrow('not P2PK-locked');
  });

  // --- Critical security test ---

  it('enforces that every transfer has both valid metadata AND P2PK-locked proofs', () => {
    // A transfer with valid metadata but unlocked token = unsafe
    const unsafeTransfer: TransferData = {
      token           : makeFakeUnlockedToken(mintUrl),
      amount          : 1000,
      unit            : 'sat',
      mintUrl,
      senderDid       : 'did:dht:sender',
      recipientPubkey : validKey.publicKey,
    };
    expect(() => assertP2PKLocked(unsafeTransfer)).toThrow('not P2PK-locked');
  });

  it('rejects transfer with no P2PK key at all', () => {
    const noKeyTransfer: TransferData = {
      token           : makeFakeP2pkToken(mintUrl, validKey.publicKey),
      amount          : 1000,
      unit            : 'sat',
      mintUrl,
      senderDid       : 'did:dht:sender',
      recipientPubkey : '',
    };
    expect(() => assertP2PKLocked(noKeyTransfer)).toThrow();
  });
});
