import { describe, it, expect } from 'vitest';
import { verifyDleqProofs, isDleqValid } from '../cashu/dleq-verify';

describe('verifyDleqProofs', () => {
  it('skips all proofs when none have DLEQ data', async () => {
    const proofs = [
      { amount: 4, id: 'k1', secret: 's', C: 'c' },
      { amount: 2, id: 'k2', secret: 's2', C: 'c2' },
    ];
    const result = await verifyDleqProofs('https://testmint.example', proofs as any);
    expect(result.skipped).toBe(2);
    expect(result.verified).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(2);
  });

  it('skips verification gracefully when mint is unreachable', async () => {
    const proofs = [
      { amount: 4, id: 'k1', secret: 's', C: 'c', dleq: { e: 'ab', s: 'cd', r: 'ef' } },
    ];
    // Use a non-existent mint — should skip, not throw
    const result = await verifyDleqProofs('https://nonexistent-mint.invalid', proofs as any);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe('isDleqValid', () => {
  it('returns true when no proofs have DLEQ data (all skipped)', async () => {
    const proofs = [
      { amount: 4, id: 'k1', secret: 's', C: 'c' },
    ];
    expect(await isDleqValid('https://testmint.example', proofs as any)).toBe(true);
  });

  it('returns true when mint is unreachable (graceful skip)', async () => {
    const proofs = [
      { amount: 4, id: 'k1', secret: 's', C: 'c', dleq: { e: 'ab', s: 'cd', r: 'ef' } },
    ];
    expect(await isDleqValid('https://nonexistent-mint.invalid', proofs as any)).toBe(true);
  });
});
