import { describe, it, expect } from 'vitest';
import type { Proof } from '@cashu/cashu-ts';
import type { ProofData } from '../protocol/cashu-wallet-protocol';

/**
 * Tests that the proof store/rebuild round-trip preserves all fields.
 *
 * In the app, proofs flow through:
 *   Cashu Proof → ProofData (DWN store) → StoredProof → Cashu Proof (rebuild)
 *
 * These tests verify the mapping functions preserve dleq and witness.
 */

/** Simulates storeNewProofs mapping (App.tsx) */
function cashuProofToProofData(proof: Proof): ProofData {
  const data: ProofData = {
    amount: proof.amount,
    id: proof.id,
    secret: proof.secret,
    C: proof.C,
  };
  if (proof.dleq) {
    data.dleq = {
      e: String(proof.dleq.e),
      s: String(proof.dleq.s),
      r: String(proof.dleq.r),
    };
  }
  if (proof.witness) {
    data.witness = typeof proof.witness === 'string'
      ? proof.witness
      : JSON.stringify(proof.witness);
  }
  return data;
}

/** Simulates proof rebuild (send-dialog.tsx / withdraw-dialog.tsx) */
function storedProofToCashuProof(stored: {
  amount: number;
  keysetId: string;
  secret: string;
  C: string;
  dleq?: { e: string; s: string; r: string };
  witness?: string;
}): Proof {
  return {
    amount: stored.amount,
    id: stored.keysetId,
    secret: stored.secret,
    C: stored.C,
    ...(stored.dleq ? { dleq: stored.dleq } : {}),
    ...(stored.witness ? { witness: stored.witness } : {}),
  } as Proof;
}

describe('proof round-trip preserves all fields', () => {
  it('preserves basic fields', () => {
    const original: Proof = {
      amount: 8,
      id: '00abc123',
      secret: 'secretvalue',
      C: '02abcdef',
    } as Proof;

    const stored = cashuProofToProofData(original);
    const rebuilt = storedProofToCashuProof({
      ...stored,
      keysetId: stored.id,
    });

    expect(rebuilt.amount).toBe(original.amount);
    expect(rebuilt.id).toBe(original.id);
    expect(rebuilt.secret).toBe(original.secret);
    expect(rebuilt.C).toBe(original.C);
  });

  it('preserves dleq proof (NUT-12)', () => {
    const original: Proof = {
      amount: 4,
      id: '00abc123',
      secret: 'secretvalue',
      C: '02abcdef',
      dleq: { e: 'e_value', s: 's_value', r: 'r_value' },
    } as Proof;

    const stored = cashuProofToProofData(original);
    expect(stored.dleq).toEqual({ e: 'e_value', s: 's_value', r: 'r_value' });

    const rebuilt = storedProofToCashuProof({
      ...stored,
      keysetId: stored.id,
    });
    expect(rebuilt.dleq).toEqual(original.dleq);
  });

  it('preserves witness (NUT-10/11)', () => {
    const original: Proof = {
      amount: 2,
      id: '00abc123',
      secret: 'secretvalue',
      C: '02abcdef',
      witness: '{"signatures":["sig1"]}',
    } as Proof;

    const stored = cashuProofToProofData(original);
    expect(stored.witness).toBe('{"signatures":["sig1"]}');

    const rebuilt = storedProofToCashuProof({
      ...stored,
      keysetId: stored.id,
    });
    expect(rebuilt.witness).toBe(original.witness);
  });

  it('omits dleq and witness when absent', () => {
    const original: Proof = {
      amount: 1,
      id: '00abc123',
      secret: 'secretvalue',
      C: '02abcdef',
    } as Proof;

    const stored = cashuProofToProofData(original);
    expect(stored.dleq).toBeUndefined();
    expect(stored.witness).toBeUndefined();

    const rebuilt = storedProofToCashuProof({
      ...stored,
      keysetId: stored.id,
    });
    expect(rebuilt.dleq).toBeUndefined();
    expect(rebuilt.witness).toBeUndefined();
  });
});
