import { describe, it, expect } from 'vitest';
import { calculateInputFee, estimateInputFee } from '../cashu/wallet-ops';

// ---------------------------------------------------------------------------
// calculateInputFee (NUT-02)
// ---------------------------------------------------------------------------

describe('calculateInputFee', () => {
  it('returns 0 when feePpk is 0', () => {
    expect(calculateInputFee(10, 0)).toBe(0);
  });

  it('returns 0 when numInputs is 0', () => {
    expect(calculateInputFee(0, 100)).toBe(0);
  });

  it('returns 0 when feePpk is negative', () => {
    expect(calculateInputFee(5, -10)).toBe(0);
  });

  it('returns 0 when numInputs is negative', () => {
    expect(calculateInputFee(-3, 100)).toBe(0);
  });

  it('calculates fee for 1 input at 100 ppk', () => {
    // ceil(1 * 100 / 1000) = ceil(0.1) = 1
    expect(calculateInputFee(1, 100)).toBe(1);
  });

  it('calculates fee for 10 inputs at 100 ppk', () => {
    // ceil(10 * 100 / 1000) = ceil(1.0) = 1
    expect(calculateInputFee(10, 100)).toBe(1);
  });

  it('calculates fee for 11 inputs at 100 ppk', () => {
    // ceil(11 * 100 / 1000) = ceil(1.1) = 2
    expect(calculateInputFee(11, 100)).toBe(2);
  });

  it('calculates fee for 1 input at 1000 ppk (1 sat per input)', () => {
    // ceil(1 * 1000 / 1000) = 1
    expect(calculateInputFee(1, 1000)).toBe(1);
  });

  it('calculates fee for 5 inputs at 1000 ppk', () => {
    // ceil(5 * 1000 / 1000) = 5
    expect(calculateInputFee(5, 1000)).toBe(5);
  });

  it('handles common fee rate of 1 ppk', () => {
    // ceil(1 * 1 / 1000) = ceil(0.001) = 1
    expect(calculateInputFee(1, 1)).toBe(1);
    // ceil(999 * 1 / 1000) = ceil(0.999) = 1
    expect(calculateInputFee(999, 1)).toBe(1);
    // ceil(1000 * 1 / 1000) = ceil(1.0) = 1
    expect(calculateInputFee(1000, 1)).toBe(1);
    // ceil(1001 * 1 / 1000) = ceil(1.001) = 2
    expect(calculateInputFee(1001, 1)).toBe(2);
  });

  it('handles large proof counts', () => {
    // ceil(100 * 100 / 1000) = ceil(10) = 10
    expect(calculateInputFee(100, 100)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// estimateInputFee (multi-keyset)
// ---------------------------------------------------------------------------

describe('estimateInputFee', () => {
  const makeProof = (amount: number, keysetId: string) => ({
    amount,
    id: keysetId,
    secret: `secret-${amount}-${Math.random()}`,
    C: `C-${amount}`,
  });

  it('returns 0 when no proofs', () => {
    const fees = new Map([['keyset-1', 100]]);
    expect(estimateInputFee([], fees)).toBe(0);
  });

  it('returns 0 when all keysets have 0 fee', () => {
    const proofs = [makeProof(4, 'keyset-1'), makeProof(2, 'keyset-1')];
    const fees = new Map([['keyset-1', 0]]);
    expect(estimateInputFee(proofs, fees)).toBe(0);
  });

  it('returns 0 when keyset not found in fee map', () => {
    const proofs = [makeProof(4, 'unknown-keyset')];
    const fees = new Map([['keyset-1', 100]]);
    expect(estimateInputFee(proofs, fees)).toBe(0);
  });

  it('calculates fee for single keyset', () => {
    const proofs = [
      makeProof(4, 'keyset-1'),
      makeProof(2, 'keyset-1'),
      makeProof(1, 'keyset-1'),
    ];
    const fees = new Map([['keyset-1', 100]]);
    // 3 proofs at 100 ppk: ceil(3 * 100 / 1000) = ceil(0.3) = 1
    expect(estimateInputFee(proofs, fees)).toBe(1);
  });

  it('calculates fee across multiple keysets independently', () => {
    const proofs = [
      makeProof(8, 'keyset-a'),
      makeProof(4, 'keyset-a'),
      makeProof(2, 'keyset-b'),
      makeProof(1, 'keyset-b'),
      makeProof(1, 'keyset-b'),
    ];
    const fees = new Map([
      ['keyset-a', 1000], // 1 sat per input
      ['keyset-b', 100],  // 0.1 sat per input
    ]);
    // keyset-a: 2 proofs at 1000 ppk = ceil(2 * 1000 / 1000) = 2
    // keyset-b: 3 proofs at 100 ppk = ceil(3 * 100 / 1000) = 1
    // Total: 3
    expect(estimateInputFee(proofs, fees)).toBe(3);
  });

  it('handles mixed known and unknown keysets', () => {
    const proofs = [
      makeProof(4, 'known-keyset'),
      makeProof(2, 'unknown-keyset'),
    ];
    const fees = new Map([['known-keyset', 1000]]);
    // known: 1 proof at 1000 ppk = 1
    // unknown: 1 proof at 0 ppk = 0
    expect(estimateInputFee(proofs, fees)).toBe(1);
  });
});
