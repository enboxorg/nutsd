import { describe, it, expect } from 'vitest';
import { assertP2PKLocked } from '../protocol/cashu-transfer-protocol';
import { generateP2pkKeyPair } from '../cashu/p2pk';
import type { TransferData } from '../protocol/cashu-transfer-protocol';

describe('assertP2PKLocked', () => {
  const validKey = generateP2pkKeyPair();

  const validTransfer: TransferData = {
    token: 'cashuBsometoken',
    amount: 100,
    unit: 'sat',
    mintUrl: 'https://testnut.cashu.space',
    senderDid: 'did:dht:sender123',
    recipientPubkey: validKey.publicKey,
  };

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
    const noKey = { ...validTransfer, recipientPubkey: '' };
    expect(() => assertP2PKLocked(noKey)).toThrow('missing recipientPubkey');
  });

  it('rejects invalid recipientPubkey', () => {
    const badKey = { ...validTransfer, recipientPubkey: 'not-a-key' };
    expect(() => assertP2PKLocked(badKey)).toThrow('Invalid recipientPubkey');
  });

  it('rejects uncompressed public key', () => {
    const uncompressed = { ...validTransfer, recipientPubkey: '04' + 'a'.repeat(128) };
    expect(() => assertP2PKLocked(uncompressed)).toThrow('Invalid recipientPubkey');
  });

  // This is the critical security test: without P2PK, tokens are bearer instruments
  // that a DWN operator could steal
  it('enforces that every transfer has a valid P2PK lock', () => {
    // Attempt to create a transfer without any P2PK key
    const unsafeTransfer: TransferData = {
      token: 'cashuBunlockedtoken',
      amount: 1000,
      unit: 'sat',
      mintUrl: 'https://testnut.cashu.space',
      senderDid: 'did:dht:sender',
      recipientPubkey: '', // <-- no P2PK!
    };
    expect(() => assertP2PKLocked(unsafeTransfer)).toThrow();
  });
});
