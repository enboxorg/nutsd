import { describe, it, expect } from 'vitest';
import { isP2pkLockedProof, extractP2pkPubkey } from '../cashu/token-utils';

describe('isP2pkLockedProof', () => {
  it('detects P2PK-locked proof', () => {
    const proof = {
      amount: 4,
      id: 'keyset-1',
      secret: '["P2PK",{"nonce":"abc123","data":"02a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"}]',
      C: '02abcdef',
    };
    expect(isP2pkLockedProof(proof)).toBe(true);
  });

  it('rejects regular proof (random hex secret)', () => {
    const proof = {
      amount: 4,
      id: 'keyset-1',
      secret: 'abcdef1234567890abcdef1234567890',
      C: '02abcdef',
    };
    expect(isP2pkLockedProof(proof)).toBe(false);
  });

  it('rejects HTLC-locked proof', () => {
    const proof = {
      amount: 4,
      id: 'keyset-1',
      secret: '["HTLC",{"nonce":"abc","data":"hash123"}]',
      C: '02abcdef',
    };
    expect(isP2pkLockedProof(proof)).toBe(false);
  });

  it('rejects empty secret', () => {
    expect(isP2pkLockedProof({ amount: 4, id: 'k', secret: '', C: 'c' })).toBe(false);
  });

  it('rejects non-string secret', () => {
    expect(isP2pkLockedProof({ amount: 4, id: 'k', secret: 123 as any, C: 'c' })).toBe(false);
  });
});

describe('extractP2pkPubkey', () => {
  it('extracts pubkey from P2PK secret', () => {
    const proof = {
      amount: 4,
      id: 'keyset-1',
      secret: '["P2PK",{"nonce":"abc123","data":"02a1b2c3"}]',
      C: '02abcdef',
    };
    expect(extractP2pkPubkey(proof)).toBe('02a1b2c3');
  });

  it('returns null for non-P2PK proof', () => {
    const proof = {
      amount: 4,
      id: 'keyset-1',
      secret: 'regular-secret',
      C: '02abcdef',
    };
    expect(extractP2pkPubkey(proof)).toBe(null);
  });

  it('returns null for HTLC proof', () => {
    const proof = {
      amount: 4,
      id: 'keyset-1',
      secret: '["HTLC",{"nonce":"abc","data":"hash123"}]',
      C: '02abcdef',
    };
    expect(extractP2pkPubkey(proof)).toBe(null);
  });
});
