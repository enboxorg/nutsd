import { describe, it, expect } from 'vitest';
import { CashuWalletDefinition } from '../protocol/cashu-wallet-protocol';
import { assertP2PKLocked } from '../protocol/cashu-transfer-protocol';
import { generateP2pkKeyPair } from '../cashu/p2pk';

describe('CashuWalletDefinition security', () => {
  // --- Encryption ---

  it('requires encryption on proof type', () => {
    expect(CashuWalletDefinition.types.proof.encryptionRequired).toBe(true);
  });

  it('requires encryption on keyset type', () => {
    expect(CashuWalletDefinition.types.keyset.encryptionRequired).toBe(true);
  });

  it('requires encryption on transaction type', () => {
    expect(CashuWalletDefinition.types.transaction.encryptionRequired).toBe(true);
  });

  it('does not require encryption on mint type (public info)', () => {
    expect((CashuWalletDefinition.types.mint as any).encryptionRequired).toBeUndefined();
  });

  // --- Tag policy: encrypted types must not leak metadata ---

  it('proof records carry no tags', () => {
    const proofRuleSet = CashuWalletDefinition.structure.mint.proof;
    expect(proofRuleSet).toEqual({});
    expect((proofRuleSet as any).$tags).toBeUndefined();
  });

  it('keyset records carry no tags', () => {
    const keysetRuleSet = CashuWalletDefinition.structure.mint.keyset;
    expect(keysetRuleSet).toEqual({});
    expect((keysetRuleSet as any).$tags).toBeUndefined();
  });

  it('transaction records carry no tags', () => {
    const txRuleSet = CashuWalletDefinition.structure.transaction;
    expect(txRuleSet).toEqual({});
    expect((txRuleSet as any).$tags).toBeUndefined();
  });

  it('mint records may have tags (unencrypted, public info)', () => {
    const mintTags = (CashuWalletDefinition.structure.mint as any).$tags;
    expect(mintTags).toBeDefined();
    // Only public info tags — no amounts, keysetIds, balances
    expect(mintTags.url).toBeDefined();
    expect(mintTags.unit).toBeDefined();
    expect(mintTags.amount).toBeUndefined();
    expect(mintTags.keysetId).toBeUndefined();
    expect(mintTags.state).toBeUndefined();
  });

  // --- Protocol is unpublished (private) ---

  it('wallet protocol is unpublished', () => {
    expect(CashuWalletDefinition.published).toBe(false);
  });
});

describe('ProofData state field', () => {
  it('ProofState type allows unspent and pending', () => {
    // Type-level assertion: ProofState = 'unspent' | 'pending' | 'spent'
    // The protocol type only uses unspent and pending; spent proofs are deleted
    const validStates: import('../protocol/cashu-wallet-protocol').ProofState[] = [
      'unspent',
      'pending',
      'spent',
    ];
    expect(validStates).toHaveLength(3);
    expect(validStates).toContain('unspent');
    expect(validStates).toContain('pending');
    expect(validStates).toContain('spent');
  });

  it('state field is optional in ProofData (backward compat)', () => {
    // ProofData.state is `state?: ProofState` — optional for records
    // written before state tracking. The hook defaults to 'unspent'.
    const proofWithoutState: import('../protocol/cashu-wallet-protocol').ProofData = {
      amount: 4, id: 'abc', secret: 'sec', C: '02',
    };
    expect(proofWithoutState.state).toBeUndefined();
  });

  it('state field can be set in ProofData', () => {
    const proof = {
      amount: 4, id: 'abc', secret: 'sec', C: '02', state: 'pending' as const,
    } satisfies import('../protocol/cashu-wallet-protocol').ProofData;
    expect(proof.state).toBe('pending');
  });
});

/** Build a fake V3 cashuA token with P2PK-locked proofs for testing. */
function makeFakeP2pkToken(pubkey: string): string {
  const json = { token: [{ mint: 'https://test.mint', proofs: [{
    amount: 4, id: '00t', C: '02ab',
    secret: JSON.stringify(['P2PK', { nonce: 'n', data: pubkey }]),
  }] }], unit: 'sat' };
  return 'cashuA' + btoa(JSON.stringify(json));
}

describe('CashuTransferProtocol safety', () => {
  it('assertP2PKLocked rejects transfer without P2PK key', () => {
    const kp = generateP2pkKeyPair();
    expect(() => assertP2PKLocked({
      token           : makeFakeP2pkToken(kp.publicKey),
      amount          : 100,
      unit            : 'sat',
      mintUrl         : 'https://testnut.cashu.space',
      senderDid       : 'did:dht:sender',
      recipientPubkey : '',
    })).toThrow('missing recipientPubkey');
  });

  it('assertP2PKLocked accepts transfer with valid P2PK key and locked token', () => {
    const kp = generateP2pkKeyPair();
    expect(() => assertP2PKLocked({
      token           : makeFakeP2pkToken(kp.publicKey),
      amount          : 100,
      unit            : 'sat',
      mintUrl         : 'https://testnut.cashu.space',
      senderDid       : 'did:dht:sender',
      recipientPubkey : kp.publicKey,
    })).not.toThrow();
  });
});
