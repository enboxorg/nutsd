import { describe, it, expect } from 'vitest';
import { CashuWalletDefinition } from '../protocol/cashu-wallet-protocol';
import { assertTransferProtocolDisabled } from '../protocol/cashu-transfer-protocol';

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

describe('CashuTransferProtocol safety', () => {
  it('assertTransferProtocolDisabled throws', () => {
    expect(() => assertTransferProtocolDisabled()).toThrow('cashu-transfer protocol is disabled');
  });

  it('error message mentions NUT-11', () => {
    try {
      assertTransferProtocolDisabled();
    } catch (e) {
      expect((e as Error).message).toContain('NUT-11');
      expect((e as Error).message).toContain('Pay-to-Pubkey');
    }
  });
});
