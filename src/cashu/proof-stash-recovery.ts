/**
 * Proof stash recovery logic — extracted as a pure function for testability.
 *
 * This is the core of `recoverProofStashes()` from use-wallet.ts, but
 * decoupled from React hooks and DWN record types. It takes injected
 * functions for reading stashes, reading existing proofs, writing proofs,
 * and deleting stashes.
 *
 * @module
 */

import type { ProofData, ProofStashData } from '@/protocol/cashu-wallet-protocol';

// ---------------------------------------------------------------------------
// Types for dependency injection
// ---------------------------------------------------------------------------

export type StashRecord = {
  data: ProofStashData;
  delete: () => Promise<void>;
};

export type RecoveryDeps = {
  /** Read all stash records from the DWN. */
  getStashes: () => Promise<StashRecord[]>;
  /** Get secrets of all existing proofs for a given mint context. */
  getExistingSecrets: (mintContextId: string) => Promise<Set<string>>;
  /** Write a single proof record. May throw on failure. */
  writeProof: (mintContextId: string, proof: ProofData) => Promise<void>;
  /**
   * Ensure a mint record exists for the given URL.
   * Returns the mint context ID, or null if the mint is unreachable.
   */
  ensureMint: (mintUrl: string, unit: string) => Promise<string | null>;
};

export type RecoveryResult = {
  /** Total stashes found. */
  stashesFound: number;
  /** Stashes fully recovered and deleted. */
  stashesCompleted: number;
  /** Stashes with partial or failed recovery (preserved for retry). */
  stashesRetained: number;
  /** Total proofs recovered across all stashes. */
  proofsRecovered: number;
  /** Total proofs that failed to write (stash preserved). */
  proofsFailed: number;
  /** Total proofs skipped (already existed via dedup). */
  proofsSkipped: number;
};

// ---------------------------------------------------------------------------
// Recovery function
// ---------------------------------------------------------------------------

/**
 * Recover proof stashes from the DWN.
 *
 * For each stash:
 * 1. Resolve/ensure the mint exists
 * 2. Load existing proof secrets for deduplication
 * 3. Write missing proofs
 * 4. Delete the stash ONLY if all proofs are accounted for
 *
 * If any proof write fails, the stash is preserved for the next startup.
 */
export async function recoverStashes(deps: RecoveryDeps): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    stashesFound     : 0,
    stashesCompleted : 0,
    stashesRetained  : 0,
    proofsRecovered  : 0,
    proofsFailed     : 0,
    proofsSkipped    : 0,
  };

  const stashes = await deps.getStashes();
  result.stashesFound = stashes.length;
  if (stashes.length === 0) return result;

  for (const stash of stashes) {
    const { data } = stash;

    // Resolve mint
    let mintContextId = data.mintContextId;
    if (!mintContextId) {
      const resolved = await deps.ensureMint(data.mintUrl, data.unit);
      if (!resolved) {
        result.stashesRetained++;
        continue; // Mint unreachable — retry next startup
      }
      mintContextId = resolved;
    }

    // Dedup: load existing proof secrets for this mint
    const existingSecrets = await deps.getExistingSecrets(mintContextId);

    // Write missing proofs
    let recovered = 0;
    let failed = 0;
    for (const proof of data.proofs) {
      if (existingSecrets.has(proof.secret)) {
        result.proofsSkipped++;
        continue;
      }
      try {
        await deps.writeProof(mintContextId, proof);
        recovered++;
        existingSecrets.add(proof.secret); // prevent re-write within same stash
      } catch (err) {
        console.warn('[nutsd:financial] Failed to write proof during stash recovery:', err);
        failed++;
      }
    }

    result.proofsRecovered += recovered;
    result.proofsFailed += failed;

    // CRITICAL: only delete stash if ALL proofs are accounted for
    if (failed > 0) {
      result.stashesRetained++;
    } else {
      try {
        await stash.delete();
        result.stashesCompleted++;
      } catch (err) {
        console.warn('[nutsd:financial] Failed to delete completed stash (will retry on next startup):', err);
        result.stashesRetained++;
      }
    }
  }

  return result;
}
