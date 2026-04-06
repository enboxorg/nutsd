import { describe, it, expect } from 'vitest';
import { verifyDleqProofs, isDleqValid } from '../cashu/dleq-verify';

describe('verifyDleqProofs', () => {
  it('verifies proofs with valid DLEQ data', () => {
    const proofs = [
      { amount: 4, id: 'k1', secret: 's', C: 'c', dleq: { e: 'ab01', s: 'cd02', r: 'ef03' } },
    ];
    const result = verifyDleqProofs(proofs as any);
    expect(result.verified).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('skips proofs without DLEQ', () => {
    const proofs = [
      { amount: 4, id: 'k1', secret: 's', C: 'c' },
    ];
    const result = verifyDleqProofs(proofs as any);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('fails proofs with empty DLEQ fields', () => {
    const proofs = [
      { amount: 4, id: 'k1', secret: 's', C: 'c', dleq: { e: '', s: 'cd', r: 'ef' } },
    ];
    const result = verifyDleqProofs(proofs as any);
    expect(result.failed).toBe(1);
    expect(result.failedIndices).toEqual([0]);
  });

  it('fails proofs with non-hex DLEQ data', () => {
    const proofs = [
      { amount: 4, id: 'k1', secret: 's', C: 'c', dleq: { e: 'xyz', s: 'abc', r: 'def' } },
    ];
    const result = verifyDleqProofs(proofs as any);
    // 'abc' and 'def' are valid hex, 'xyz' is not
    expect(result.failed).toBe(1);
  });

  it('handles mixed proofs', () => {
    const proofs = [
      { amount: 4, id: 'k1', secret: 's', C: 'c', dleq: { e: 'ab', s: 'cd', r: 'ef' } },
      { amount: 2, id: 'k1', secret: 's2', C: 'c2' }, // no DLEQ
      { amount: 1, id: 'k1', secret: 's3', C: 'c3', dleq: { e: '', s: '', r: '' } }, // invalid
    ];
    const result = verifyDleqProofs(proofs as any);
    expect(result.total).toBe(3);
    expect(result.verified).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
  });
});

describe('isDleqValid', () => {
  it('returns true when no DLEQ failures', () => {
    const proofs = [
      { amount: 4, id: 'k1', secret: 's', C: 'c', dleq: { e: 'ab', s: 'cd', r: 'ef' } },
      { amount: 2, id: 'k1', secret: 's2', C: 'c2' }, // skipped is OK
    ];
    expect(isDleqValid(proofs as any)).toBe(true);
  });

  it('returns false when any DLEQ fails', () => {
    const proofs = [
      { amount: 4, id: 'k1', secret: 's', C: 'c', dleq: { e: '', s: '', r: '' } },
    ];
    expect(isDleqValid(proofs as any)).toBe(false);
  });
});
