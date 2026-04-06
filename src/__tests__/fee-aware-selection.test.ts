import { describe, it, expect } from 'vitest';
import { selectProofsWithFees, sumProofs } from '../cashu/token-utils';

const makeProof = (amount: number) => ({
  amount,
  id: 'test-keyset',
  secret: `secret-${amount}-${Math.random()}`,
  C: `C-${amount}`,
});

describe('selectProofsWithFees', () => {
  // --- Zero fee (should behave like selectProofs) ---

  it('delegates to selectProofs when feePpk is 0', () => {
    const proofs = [makeProof(8), makeProof(4), makeProof(2)];
    const result = selectProofsWithFees(proofs, 5, 0);
    expect(result.fee).toBe(0);
    expect(sumProofs(result.selected)).toBeGreaterThanOrEqual(5);
    expect(result.change).toBe(sumProofs(result.selected) - 5);
  });

  it('delegates to selectProofs when feePpk is negative', () => {
    const proofs = [makeProof(4), makeProof(2)];
    const result = selectProofsWithFees(proofs, 3, -10);
    expect(result.fee).toBe(0);
    expect(sumProofs(result.selected)).toBeGreaterThanOrEqual(3);
  });

  // --- With fees ---

  it('throws when fee makes tight balance insufficient', () => {
    // 3 proofs of 4, 2, 1 = 7 total
    // Want to send 5, fee at 1000 ppk (1 sat/input)
    // With all 3 proofs: fee = 3, total needed = 5 + 3 = 8 > 7
    const proofs = [makeProof(4), makeProof(2), makeProof(1)];
    expect(() => selectProofsWithFees(proofs, 5, 1000)).toThrow('Insufficient balance');
  });

  it('selects enough proofs to cover amount + fee', () => {
    // 4 proofs: 8, 4, 2, 1 = 15 total
    // Want 10, fee at 1000 ppk (1 sat/input)
    const proofs = [makeProof(8), makeProof(4), makeProof(2), makeProof(1)];
    const result = selectProofsWithFees(proofs, 10, 1000);

    // First attempt: select for 10 -> {8, 4} = 12, fee = ceil(2 * 1000/1000) = 2
    // 12 >= 10 + 2 = 12? Yes!
    expect(result.fee).toBe(2);
    expect(sumProofs(result.selected)).toBe(12);
    expect(result.change).toBe(0); // 12 - 10 - 2 = 0
  });

  it('iterates when initial selection is insufficient after fees', () => {
    // 4 proofs: 16, 8, 4, 2 = 30 total
    // Want 20, fee at 1000 ppk (1 sat/input)
    const proofs = [makeProof(16), makeProof(8), makeProof(4), makeProof(2)];
    const result = selectProofsWithFees(proofs, 20, 1000);

    // Attempt 1: select for 20 -> {16, 8} = 24, fee = ceil(2 * 1000/1000) = 2
    // 24 >= 20 + 2 = 22? Yes!
    expect(result.fee).toBe(2);
    expect(sumProofs(result.selected)).toBe(24);
    expect(result.change).toBe(2); // 24 - 20 - 2 = 2
  });

  it('succeeds when total balance is sufficient', () => {
    // 4 proofs: 8, 4, 2, 1 = 15 total
    // Want 5, fee at 100 ppk
    const proofs = [makeProof(8), makeProof(4), makeProof(2), makeProof(1)];
    const result = selectProofsWithFees(proofs, 5, 100);

    // Attempt 1: select for 5 -> {8} = 8, fee = ceil(1 * 100/1000) = 1
    // 8 >= 5 + 1 = 6? Yes!
    expect(result.fee).toBe(1);
    expect(sumProofs(result.selected)).toBe(8);
    expect(result.change).toBe(2); // 8 - 5 - 1 = 2
  });

  it('handles low fee rate where fee rounds up to 1', () => {
    const proofs = [makeProof(64), makeProof(32), makeProof(16)];
    const result = selectProofsWithFees(proofs, 50, 1);

    // Select for 50 -> {64} = 64, fee = ceil(1 * 1/1000) = 1
    // 64 >= 50 + 1 = 51? Yes!
    expect(result.fee).toBe(1);
    expect(sumProofs(result.selected)).toBe(64);
    expect(result.change).toBe(13); // 64 - 50 - 1 = 13
  });

  it('returns exact match when amount + fee equals total', () => {
    // 2 proofs: 8, 4 = 12
    // Want 10, fee at 1000 ppk (2 proofs = 2 sats fee)
    // 10 + 2 = 12, exact match
    const proofs = [makeProof(8), makeProof(4)];
    const result = selectProofsWithFees(proofs, 10, 1000);

    expect(result.fee).toBe(2);
    expect(sumProofs(result.selected)).toBe(12);
    expect(result.change).toBe(0);
    expect(result.remaining.length).toBe(0);
  });

  it('throws when balance is insufficient to cover amount + fee', () => {
    // 2 proofs: 4, 2 = 6
    // Want 5, fee at 1000 ppk (2 proofs = 2 sats fee)
    // Need 5 + 2 = 7, have 6
    const proofs = [makeProof(4), makeProof(2)];
    expect(() => selectProofsWithFees(proofs, 5, 1000)).toThrow('Insufficient balance');
  });

  it('throws when balance covers amount but not amount + fee', () => {
    // 1 proof: 10 = 10
    // Want 10, fee at 1000 ppk (1 proof = 1 sat fee)
    // Need 10 + 1 = 11, have 10
    const proofs = [makeProof(10)];
    expect(() => selectProofsWithFees(proofs, 10, 1000)).toThrow('Insufficient balance');
  });

  // --- Change calculation ---

  it('calculates change correctly with fees', () => {
    // 3 proofs: 16, 8, 4 = 28
    // Want 10, fee at 100 ppk
    const proofs = [makeProof(16), makeProof(8), makeProof(4)];
    const result = selectProofsWithFees(proofs, 10, 100);

    // Select for 10 -> {16} = 16, fee = ceil(1 * 100/1000) = 1
    // 16 >= 10 + 1 = 11? Yes!
    expect(result.fee).toBe(1);
    expect(result.change).toBe(5); // 16 - 10 - 1 = 5
    expect(result.remaining.length).toBe(2);
    expect(sumProofs(result.remaining)).toBe(12);
  });
});
