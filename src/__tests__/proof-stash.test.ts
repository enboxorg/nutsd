import { describe, it, expect } from 'vitest';
import type { ProofData, ProofStashData } from '../protocol/cashu-wallet-protocol';

/**
 * Tests for the proof stash (WAL) crash-safety pattern.
 *
 * The proof stash ensures that proofs received from an irreversible mint swap
 * are not lost if per-proof DWN writes fail. A single stash record is written
 * first, then individual proof records, then the stash is deleted.
 *
 * These tests validate the data structures and deduplication logic used by
 * safeStoreReceivedProofs() and recoverProofStashes().
 */

const makeProofData = (amount: number, secret: string): ProofData => ({
  amount,
  id    : 'test-keyset',
  secret,
  C     : `C-${secret}`,
  state : 'unspent',
});

describe('ProofStashData structure', () => {
  it('contains all fields needed for recovery', () => {
    const stash: ProofStashData = {
      mintUrl        : 'https://testnut.cashu.space',
      mintContextId  : 'ctx-123',
      unit           : 'sat',
      proofs         : [
        makeProofData(4, 'secret-a'),
        makeProofData(2, 'secret-b'),
        makeProofData(1, 'secret-c'),
      ],
      createdAt      : '2026-04-06T00:00:00Z',
    };

    expect(stash.proofs).toHaveLength(3);
    expect(stash.proofs[0].secret).toBe('secret-a');
    expect(stash.mintUrl).toBe('https://testnut.cashu.space');
    expect(stash.mintContextId).toBe('ctx-123');
  });

  it('preserves proof state as unspent', () => {
    const stash: ProofStashData = {
      mintUrl        : 'https://mint.example.com',
      mintContextId  : 'ctx-456',
      unit           : 'sat',
      proofs         : [makeProofData(8, 'secret-x')],
      createdAt      : new Date().toISOString(),
    };

    expect(stash.proofs[0].state).toBe('unspent');
  });

  it('preserves optional DLEQ and witness', () => {
    const proof: ProofData = {
      amount  : 4,
      id      : 'keyset-1',
      secret  : 'secret-dleq',
      C       : 'C-dleq',
      state   : 'unspent',
      dleq    : { e: 'e-val', s: 's-val', r: 'r-val' },
      witness : '{"signatures":["sig1"]}',
    };

    const stash: ProofStashData = {
      mintUrl        : 'https://mint.example.com',
      mintContextId  : 'ctx-789',
      unit           : 'sat',
      proofs         : [proof],
      createdAt      : new Date().toISOString(),
    };

    expect(stash.proofs[0].dleq?.e).toBe('e-val');
    expect(stash.proofs[0].witness).toBe('{"signatures":["sig1"]}');
  });
});

describe('Proof stash deduplication logic', () => {
  /**
   * Simulates the dedup logic from recoverProofStashes():
   * given a stash and a set of already-persisted proof secrets,
   * returns only the proofs that need to be written.
   */
  function getMissingProofs(
    stash: ProofStashData,
    existingSecrets: Set<string>,
  ): ProofData[] {
    return stash.proofs.filter(p => !existingSecrets.has(p.secret));
  }

  it('returns all proofs when none exist yet (full crash recovery)', () => {
    const stash: ProofStashData = {
      mintUrl: 'https://mint.example.com', mintContextId: 'ctx', unit: 'sat',
      proofs: [makeProofData(4, 'a'), makeProofData(2, 'b'), makeProofData(1, 'c')],
      createdAt: new Date().toISOString(),
    };
    const existing = new Set<string>();
    const missing = getMissingProofs(stash, existing);
    expect(missing).toHaveLength(3);
  });

  it('returns no proofs when all already exist (stash cleanup only)', () => {
    const stash: ProofStashData = {
      mintUrl: 'https://mint.example.com', mintContextId: 'ctx', unit: 'sat',
      proofs: [makeProofData(4, 'a'), makeProofData(2, 'b')],
      createdAt: new Date().toISOString(),
    };
    const existing = new Set(['a', 'b']);
    const missing = getMissingProofs(stash, existing);
    expect(missing).toHaveLength(0);
  });

  it('returns only missing proofs on partial write (gap fill)', () => {
    const stash: ProofStashData = {
      mintUrl: 'https://mint.example.com', mintContextId: 'ctx', unit: 'sat',
      proofs: [
        makeProofData(8, 'written-1'),
        makeProofData(4, 'missing-2'),
        makeProofData(2, 'written-3'),
        makeProofData(1, 'missing-4'),
      ],
      createdAt: new Date().toISOString(),
    };
    const existing = new Set(['written-1', 'written-3']);
    const missing = getMissingProofs(stash, existing);
    expect(missing).toHaveLength(2);
    expect(missing[0].secret).toBe('missing-2');
    expect(missing[1].secret).toBe('missing-4');
  });

  it('handles empty stash', () => {
    const stash: ProofStashData = {
      mintUrl: 'https://mint.example.com', mintContextId: 'ctx', unit: 'sat',
      proofs: [],
      createdAt: new Date().toISOString(),
    };
    const missing = getMissingProofs(stash, new Set());
    expect(missing).toHaveLength(0);
  });

  it('deduplicates by exact secret match', () => {
    const stash: ProofStashData = {
      mintUrl: 'https://mint.example.com', mintContextId: 'ctx', unit: 'sat',
      proofs: [
        makeProofData(4, 'secret-exact'),
        makeProofData(4, 'secret-exact-but-different'),
      ],
      createdAt: new Date().toISOString(),
    };
    const existing = new Set(['secret-exact']);
    const missing = getMissingProofs(stash, existing);
    expect(missing).toHaveLength(1);
    expect(missing[0].secret).toBe('secret-exact-but-different');
  });
});

describe('Proof stash replay with failures', () => {
  /**
   * Simulates recoverProofStashes() replay logic with injected failures.
   *
   * This mirrors the actual code in use-wallet.ts:
   * - iterates stash proofs
   * - skips already-written (dedup by secret)
   * - attempts to write missing ones
   * - tracks failures
   * - returns whether the stash should be deleted
   */
  function simulateReplay(
    stash: ProofStashData,
    existingSecrets: Set<string>,
    failOnSecrets: Set<string>,
  ): { recovered: number; failed: number; shouldDeleteStash: boolean; remainingForRetry: string[] } {
    let recovered = 0;
    let failed = 0;
    const remainingForRetry: string[] = [];

    for (const proof of stash.proofs) {
      if (existingSecrets.has(proof.secret)) continue; // already written
      if (failOnSecrets.has(proof.secret)) {
        failed++;
        remainingForRetry.push(proof.secret);
        continue; // simulate addProof failure
      }
      recovered++;
      existingSecrets.add(proof.secret); // simulate successful write
    }

    return {
      recovered,
      failed,
      shouldDeleteStash: failed === 0,
      remainingForRetry,
    };
  }

  it('deletes stash when all proofs recovered successfully', () => {
    const stash: ProofStashData = {
      mintUrl: 'https://mint.example.com', mintContextId: 'ctx', unit: 'sat',
      proofs: [makeProofData(4, 'a'), makeProofData(2, 'b'), makeProofData(1, 'c')],
      createdAt: new Date().toISOString(),
    };

    const result = simulateReplay(stash, new Set(), new Set());
    expect(result.recovered).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.shouldDeleteStash).toBe(true);
    expect(result.remainingForRetry).toHaveLength(0);
  });

  it('preserves stash when some proofs fail to write', () => {
    const stash: ProofStashData = {
      mintUrl: 'https://mint.example.com', mintContextId: 'ctx', unit: 'sat',
      proofs: [makeProofData(4, 'a'), makeProofData(2, 'b'), makeProofData(1, 'c')],
      createdAt: new Date().toISOString(),
    };

    // Proof 'b' fails to write
    const result = simulateReplay(stash, new Set(), new Set(['b']));
    expect(result.recovered).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.shouldDeleteStash).toBe(false);
    expect(result.remainingForRetry).toEqual(['b']);
  });

  it('preserves stash when all proofs fail to write', () => {
    const stash: ProofStashData = {
      mintUrl: 'https://mint.example.com', mintContextId: 'ctx', unit: 'sat',
      proofs: [makeProofData(4, 'a'), makeProofData(2, 'b')],
      createdAt: new Date().toISOString(),
    };

    const result = simulateReplay(stash, new Set(), new Set(['a', 'b']));
    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.shouldDeleteStash).toBe(false);
    expect(result.remainingForRetry).toEqual(['a', 'b']);
  });

  it('retry succeeds after previous partial failure', () => {
    const stash: ProofStashData = {
      mintUrl: 'https://mint.example.com', mintContextId: 'ctx', unit: 'sat',
      proofs: [makeProofData(4, 'a'), makeProofData(2, 'b'), makeProofData(1, 'c')],
      createdAt: new Date().toISOString(),
    };

    // First attempt: 'a' succeeds, 'b' fails, 'c' succeeds
    const existing = new Set<string>();
    const attempt1 = simulateReplay(stash, existing, new Set(['b']));
    expect(attempt1.recovered).toBe(2);
    expect(attempt1.failed).toBe(1);
    expect(attempt1.shouldDeleteStash).toBe(false);
    // existing now has 'a' and 'c'

    // Second attempt: 'a' and 'c' are deduped, 'b' succeeds this time
    const attempt2 = simulateReplay(stash, existing, new Set());
    expect(attempt2.recovered).toBe(1); // only 'b' was missing
    expect(attempt2.failed).toBe(0);
    expect(attempt2.shouldDeleteStash).toBe(true);
  });

  it('skips already-written proofs without counting as failures', () => {
    const stash: ProofStashData = {
      mintUrl: 'https://mint.example.com', mintContextId: 'ctx', unit: 'sat',
      proofs: [makeProofData(4, 'a'), makeProofData(2, 'b')],
      createdAt: new Date().toISOString(),
    };

    // Both already written
    const result = simulateReplay(stash, new Set(['a', 'b']), new Set());
    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.shouldDeleteStash).toBe(true); // safe to delete — all accounted for
  });
});

describe('Proof stash failure mode analysis', () => {
  it('documents the crash windows and their outcomes', () => {
    // This test documents the failure modes rather than testing code.
    // Each scenario describes what happens if the app crashes at that point.

    const scenarios = [
      {
        name: 'Crash between mint swap and stash write',
        stashWritten: false,
        proofsWritten: 0,
        outcome: 'Proofs lost (window: ~milliseconds, single DWN write)',
        recoverable: false,
      },
      {
        name: 'Crash after stash write, before any proof writes',
        stashWritten: true,
        proofsWritten: 0,
        outcome: 'Full recovery from stash on next startup',
        recoverable: true,
      },
      {
        name: 'Crash after stash write, after partial proof writes',
        stashWritten: true,
        proofsWritten: 2, // out of 5
        outcome: 'Partial recovery: 2 already written, 3 recovered from stash',
        recoverable: true,
      },
      {
        name: 'Crash after all proof writes, before stash delete',
        stashWritten: true,
        proofsWritten: 5, // all
        outcome: 'Stash recovery finds all proofs present, deletes stash (no-op)',
        recoverable: true,
      },
      {
        name: 'Everything succeeds',
        stashWritten: false, // deleted
        proofsWritten: 5,
        outcome: 'Clean path, no stash remains',
        recoverable: true,
      },
    ];

    // The only non-recoverable window is the first one: between mint swap
    // and stash write. This is a single DWN write (~milliseconds). Before
    // the stash pattern, the window was N writes (one per proof), which
    // could be hundreds of milliseconds or more with network latency.
    const nonRecoverable = scenarios.filter(s => !s.recoverable);
    expect(nonRecoverable).toHaveLength(1);
    expect(nonRecoverable[0].name).toBe('Crash between mint swap and stash write');
  });
});
