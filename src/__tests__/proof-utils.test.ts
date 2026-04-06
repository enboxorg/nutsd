import { describe, it, expect } from 'vitest';
import { analyzeProofs, binaryDecompositionCount, binaryDecomposition } from '../cashu/proof-utils';

const makeProof = (amount: number) => ({
  amount,
  id: 'test-keyset',
  secret: `secret-${amount}-${Math.random()}`,
  C: `C-${amount}`,
});

describe('binaryDecompositionCount', () => {
  it('returns 0 for 0', () => {
    expect(binaryDecompositionCount(0)).toBe(0);
  });

  it('returns 1 for powers of 2', () => {
    expect(binaryDecompositionCount(1)).toBe(1);
    expect(binaryDecompositionCount(2)).toBe(1);
    expect(binaryDecompositionCount(4)).toBe(1);
    expect(binaryDecompositionCount(8)).toBe(1);
    expect(binaryDecompositionCount(64)).toBe(1);
    expect(binaryDecompositionCount(1024)).toBe(1);
  });

  it('returns popcount for mixed values', () => {
    // 3 = 11 binary = 2 bits
    expect(binaryDecompositionCount(3)).toBe(2);
    // 7 = 111 = 3 bits
    expect(binaryDecompositionCount(7)).toBe(3);
    // 13 = 1101 = 3 bits
    expect(binaryDecompositionCount(13)).toBe(3);
    // 15 = 1111 = 4 bits
    expect(binaryDecompositionCount(15)).toBe(4);
    // 100 = 1100100 = 3 bits
    expect(binaryDecompositionCount(100)).toBe(3);
  });

  it('returns 0 for negative values', () => {
    expect(binaryDecompositionCount(-5)).toBe(0);
  });
});

describe('binaryDecomposition', () => {
  it('returns empty for 0', () => {
    expect(binaryDecomposition(0)).toEqual([]);
  });

  it('decomposes powers of 2', () => {
    expect(binaryDecomposition(8)).toEqual([8]);
    expect(binaryDecomposition(64)).toEqual([64]);
  });

  it('decomposes mixed values', () => {
    expect(binaryDecomposition(13)).toEqual([8, 4, 1]);
    expect(binaryDecomposition(7)).toEqual([4, 2, 1]);
    expect(binaryDecomposition(15)).toEqual([8, 4, 2, 1]);
  });

  it('returns sorted largest first', () => {
    const result = binaryDecomposition(100);
    expect(result).toEqual([64, 32, 4]);
    // verify sorted
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeLessThan(result[i - 1]);
    }
  });
});

describe('analyzeProofs', () => {
  it('handles empty proof set', () => {
    const result = analyzeProofs([]);
    expect(result.proofCount).toBe(0);
    expect(result.totalValue).toBe(0);
    expect(result.denominations).toEqual([]);
    expect(result.canConsolidate).toBe(false);
  });

  it('counts proofs and total value', () => {
    const proofs = [makeProof(8), makeProof(4), makeProof(2), makeProof(1)];
    const result = analyzeProofs(proofs);
    expect(result.proofCount).toBe(4);
    expect(result.totalValue).toBe(15);
  });

  it('breaks down denominations sorted largest first', () => {
    const proofs = [makeProof(2), makeProof(4), makeProof(2), makeProof(8)];
    const result = analyzeProofs(proofs);
    expect(result.denominations).toEqual([
      { value: 8, count: 1, total: 8 },
      { value: 4, count: 1, total: 4 },
      { value: 2, count: 2, total: 4 },
    ]);
    expect(result.distinctDenominations).toBe(3);
  });

  it('detects consolidation potential', () => {
    // 5 proofs of 1 sat each = 5 sats total
    // Optimal: 4 + 1 = 2 proofs
    const proofs = [makeProof(1), makeProof(1), makeProof(1), makeProof(1), makeProof(1)];
    const result = analyzeProofs(proofs);
    expect(result.canConsolidate).toBe(true);
    expect(result.estimatedConsolidatedCount).toBe(2); // 5 = 100 + 1 = 2 bits
    expect(result.proofCount).toBe(5);
  });

  it('detects already-optimal proofs', () => {
    // 3 proofs: 8 + 4 + 1 = 13
    // Optimal: 3 proofs (8 + 4 + 1)
    const proofs = [makeProof(8), makeProof(4), makeProof(1)];
    const result = analyzeProofs(proofs);
    expect(result.canConsolidate).toBe(false);
    expect(result.estimatedConsolidatedCount).toBe(3);
  });

  it('single proof is always optimal', () => {
    const result = analyzeProofs([makeProof(64)]);
    expect(result.canConsolidate).toBe(false);
    expect(result.estimatedConsolidatedCount).toBe(1);
  });
});
