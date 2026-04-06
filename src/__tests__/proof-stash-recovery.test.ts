import { describe, it, expect, vi } from 'vitest';
import { recoverStashes, type StashRecord, type RecoveryDeps } from '../cashu/proof-stash-recovery';
import type { ProofData, ProofStashData } from '../protocol/cashu-wallet-protocol';

/**
 * Implementation-level regression tests for proof stash recovery.
 *
 * These test the actual recoverStashes() function with injected mock
 * dependencies, validating the real control flow including:
 * - partial replay failure preserving stashes
 * - retry resuming from where the previous attempt left off
 * - stash deletion only when all proofs are accounted for
 */

const makeProof = (secret: string, amount = 4): ProofData => ({
  amount,
  id     : 'test-keyset',
  secret,
  C      : `C-${secret}`,
  state  : 'unspent',
});

const makeStash = (proofs: ProofData[], mintUrl = 'https://testmint.com'): ProofStashData => ({
  mintUrl,
  mintContextId : 'ctx-1',
  unit          : 'sat',
  proofs,
  createdAt     : new Date().toISOString(),
});

function makeStashRecord(data: ProofStashData): StashRecord & { deleted: boolean } {
  const record: StashRecord & { deleted: boolean } = {
    data,
    deleted: false,
    delete: vi.fn(async () => { record.deleted = true; }),
  };
  return record;
}

describe('recoverStashes — implementation-level', () => {
  it('recovers all proofs and deletes stash on full success', async () => {
    const stash = makeStashRecord(makeStash([
      makeProof('a'), makeProof('b'), makeProof('c'),
    ]));
    const written: string[] = [];

    const deps: RecoveryDeps = {
      getStashes       : vi.fn(async () => [stash]),
      getExistingSecrets : vi.fn(async () => new Set<string>()),
      writeProof       : vi.fn(async (_ctx, proof) => { written.push(proof.secret); }),
      ensureMint       : vi.fn(async () => 'ctx-1'),
    };

    const result = await recoverStashes(deps);

    expect(result.stashesFound).toBe(1);
    expect(result.stashesCompleted).toBe(1);
    expect(result.stashesRetained).toBe(0);
    expect(result.proofsRecovered).toBe(3);
    expect(result.proofsFailed).toBe(0);
    expect(written).toEqual(['a', 'b', 'c']);
    expect(stash.deleted).toBe(true);
  });

  it('preserves stash when some proof writes fail (partial replay failure)', async () => {
    const stash = makeStashRecord(makeStash([
      makeProof('a'), makeProof('b'), makeProof('c'),
    ]));
    const written: string[] = [];

    const deps: RecoveryDeps = {
      getStashes         : vi.fn(async () => [stash]),
      getExistingSecrets : vi.fn(async () => new Set<string>()),
      writeProof         : vi.fn(async (_ctx, proof) => {
        if (proof.secret === 'b') throw new Error('DWN write failed');
        written.push(proof.secret);
      }),
      ensureMint         : vi.fn(async () => 'ctx-1'),
    };

    const result = await recoverStashes(deps);

    expect(result.proofsRecovered).toBe(2);
    expect(result.proofsFailed).toBe(1);
    expect(result.stashesRetained).toBe(1);
    expect(result.stashesCompleted).toBe(0);
    expect(written).toEqual(['a', 'c']);
    // CRITICAL: stash must NOT be deleted
    expect(stash.deleted).toBe(false);
    expect(stash.delete).not.toHaveBeenCalled();
  });

  it('retries after partial failure: skips written proofs, writes remaining', async () => {
    const stashData = makeStash([
      makeProof('a'), makeProof('b'), makeProof('c'),
    ]);

    // --- First attempt: 'b' fails ---
    const stash1 = makeStashRecord(stashData);
    const written1: string[] = [];

    const deps1: RecoveryDeps = {
      getStashes         : vi.fn(async () => [stash1]),
      getExistingSecrets : vi.fn(async () => new Set<string>()),
      writeProof         : vi.fn(async (_ctx, proof) => {
        if (proof.secret === 'b') throw new Error('transient failure');
        written1.push(proof.secret);
      }),
      ensureMint         : vi.fn(async () => 'ctx-1'),
    };

    const result1 = await recoverStashes(deps1);
    expect(result1.proofsRecovered).toBe(2);
    expect(result1.proofsFailed).toBe(1);
    expect(stash1.deleted).toBe(false);

    // --- Second attempt: all writes succeed, 'a' and 'c' already exist ---
    const stash2 = makeStashRecord(stashData);
    const written2: string[] = [];

    const deps2: RecoveryDeps = {
      getStashes         : vi.fn(async () => [stash2]),
      // 'a' and 'c' were written in the first attempt
      getExistingSecrets : vi.fn(async () => new Set(['a', 'c'])),
      writeProof         : vi.fn(async (_ctx, proof) => { written2.push(proof.secret); }),
      ensureMint         : vi.fn(async () => 'ctx-1'),
    };

    const result2 = await recoverStashes(deps2);
    expect(result2.proofsRecovered).toBe(1); // only 'b'
    expect(result2.proofsFailed).toBe(0);
    expect(result2.proofsSkipped).toBe(2); // 'a' and 'c' deduped
    expect(result2.stashesCompleted).toBe(1);
    expect(written2).toEqual(['b']);
    expect(stash2.deleted).toBe(true);
  });

  it('preserves stash when ALL proof writes fail', async () => {
    const stash = makeStashRecord(makeStash([
      makeProof('x'), makeProof('y'),
    ]));

    const deps: RecoveryDeps = {
      getStashes         : vi.fn(async () => [stash]),
      getExistingSecrets : vi.fn(async () => new Set<string>()),
      writeProof         : vi.fn(async () => { throw new Error('DWN down'); }),
      ensureMint         : vi.fn(async () => 'ctx-1'),
    };

    const result = await recoverStashes(deps);

    expect(result.proofsFailed).toBe(2);
    expect(result.proofsRecovered).toBe(0);
    expect(result.stashesRetained).toBe(1);
    expect(stash.deleted).toBe(false);
  });

  it('deletes stash when all proofs already exist (no-op recovery)', async () => {
    const stash = makeStashRecord(makeStash([
      makeProof('already-1'), makeProof('already-2'),
    ]));

    const deps: RecoveryDeps = {
      getStashes         : vi.fn(async () => [stash]),
      getExistingSecrets : vi.fn(async () => new Set(['already-1', 'already-2'])),
      writeProof         : vi.fn(),
      ensureMint         : vi.fn(async () => 'ctx-1'),
    };

    const result = await recoverStashes(deps);

    expect(result.proofsSkipped).toBe(2);
    expect(result.proofsRecovered).toBe(0);
    expect(result.proofsFailed).toBe(0);
    expect(result.stashesCompleted).toBe(1);
    expect(stash.deleted).toBe(true);
    // writeProof should never have been called
    expect(deps.writeProof).not.toHaveBeenCalled();
  });

  it('retains stash when mint is unreachable', async () => {
    const stash = makeStashRecord(makeStash(
      [makeProof('a')],
      'https://unreachable-mint.com',
    ));
    // mintContextId is empty — forces ensureMint call
    stash.data.mintContextId = '';

    const deps: RecoveryDeps = {
      getStashes         : vi.fn(async () => [stash]),
      getExistingSecrets : vi.fn(async () => new Set<string>()),
      writeProof         : vi.fn(),
      ensureMint         : vi.fn(async () => null), // unreachable
    };

    const result = await recoverStashes(deps);

    expect(result.stashesRetained).toBe(1);
    expect(result.stashesCompleted).toBe(0);
    expect(stash.deleted).toBe(false);
    expect(deps.writeProof).not.toHaveBeenCalled();
  });

  it('handles multiple stashes independently', async () => {
    const stash1 = makeStashRecord(makeStash([makeProof('s1-a')]));
    const stash2 = makeStashRecord(makeStash([makeProof('s2-a'), makeProof('s2-b')]));

    // stash1 succeeds, stash2 has a failure
    const deps: RecoveryDeps = {
      getStashes         : vi.fn(async () => [stash1, stash2]),
      getExistingSecrets : vi.fn(async () => new Set<string>()),
      writeProof         : vi.fn(async (_ctx, proof) => {
        if (proof.secret === 's2-b') throw new Error('fail');
      }),
      ensureMint         : vi.fn(async () => 'ctx-1'),
    };

    const result = await recoverStashes(deps);

    expect(result.stashesFound).toBe(2);
    expect(result.stashesCompleted).toBe(1); // stash1
    expect(result.stashesRetained).toBe(1); // stash2
    expect(stash1.deleted).toBe(true);
    expect(stash2.deleted).toBe(false);
  });

  it('returns empty result when no stashes exist', async () => {
    const deps: RecoveryDeps = {
      getStashes         : vi.fn(async () => []),
      getExistingSecrets : vi.fn(),
      writeProof         : vi.fn(),
      ensureMint         : vi.fn(),
    };

    const result = await recoverStashes(deps);

    expect(result.stashesFound).toBe(0);
    expect(result.stashesCompleted).toBe(0);
    expect(result.proofsRecovered).toBe(0);
  });
});
