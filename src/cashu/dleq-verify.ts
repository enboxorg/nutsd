/**
 * NUT-12 DLEQ proof verification.
 *
 * Cryptographically verifies that the mint's blind signature on each
 * proof is consistent with the mint's published keyset public keys.
 * This detects mint misbehavior (e.g., issuing proofs without backing).
 *
 * Uses cashu-ts `hasValidDleq()` which performs the full verification:
 *   1. Compute Y = hash_to_curve(secret)
 *   2. Unblind: C' = C - r*G
 *   3. R1 = s*G - e*K, R2 = s*Y - e*C'
 *   4. e' = hash(R1 || R2 || K || C')
 *   5. Verify e' === e
 *
 * @module
 */

import type { Proof } from '@cashu/cashu-ts';
import { hasValidDleq, Mint } from '@cashu/cashu-ts';

/** Per-keyset key data needed for DLEQ verification. */
type KeysetWithKeys = {
  id: string;
  keys: Record<string, string>;
};

/**
 * Verify DLEQ proofs cryptographically against the mint's public keys.
 *
 * Fetches the mint's keysets, matches each proof to its keyset, and
 * runs the full NUT-12 DLEQ verification. Proofs without DLEQ data
 * are skipped (DLEQ is optional per the Cashu spec).
 *
 * @param mintUrl - The mint that issued the proofs.
 * @param proofs - The proofs to verify.
 * @returns Summary of verification results.
 */
export async function verifyDleqProofs(
  mintUrl: string,
  proofs: Proof[],
): Promise<{
  total: number;
  verified: number;
  skipped: number;
  failed: number;
  failedIndices: number[];
}> {
  let verified = 0;
  let skipped = 0;
  let failed = 0;
  const failedIndices: number[] = [];

  // Only fetch keys if any proof has DLEQ data.
  const hasAnyDleq = proofs.some(p => !!p.dleq);
  if (!hasAnyDleq) {
    return {
      total          : proofs.length,
      verified       : 0,
      skipped        : proofs.length,
      failed         : 0,
      failedIndices  : [],
    };
  }

  // Fetch the mint's keysets with full public keys.
  let keysetMap: Map<string, KeysetWithKeys>;
  try {
    const mint = new Mint(mintUrl);
    const { keysets } = await mint.getKeys();
    keysetMap = new Map((keysets as KeysetWithKeys[]).map(k => [k.id, k]));
  } catch {
    // Can't reach the mint — skip verification entirely.
    return {
      total          : proofs.length,
      verified       : 0,
      skipped        : proofs.length,
      failed         : 0,
      failedIndices  : [],
    };
  }

  for (let i = 0; i < proofs.length; i++) {
    const proof = proofs[i];
    if (!proof.dleq) {
      skipped++;
      continue;
    }

    const keyset = keysetMap.get(proof.id);
    if (!keyset) {
      // Unknown keyset — can't verify.
      failed++;
      failedIndices.push(i);
      continue;
    }

    try {
      const valid = hasValidDleq(proof, keyset);
      if (valid) {
        verified++;
      } else {
        failed++;
        failedIndices.push(i);
      }
    } catch {
      // Verification threw (malformed data, etc.) — count as failed.
      failed++;
      failedIndices.push(i);
    }
  }

  return { total: proofs.length, verified, skipped, failed, failedIndices };
}

/**
 * Quick check: are all DLEQ proofs cryptographically valid?
 *
 * Returns true if no proofs failed verification. Proofs without
 * DLEQ data are skipped (not counted as failures).
 *
 * @param mintUrl - The mint that issued the proofs.
 * @param proofs - The proofs to check.
 */
export async function isDleqValid(mintUrl: string, proofs: Proof[]): Promise<boolean> {
  const result = await verifyDleqProofs(mintUrl, proofs);
  return result.failed === 0;
}
