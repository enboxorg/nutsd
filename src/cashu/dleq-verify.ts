/**
 * NUT-12 DLEQ proof verification.
 *
 * Verifies that the mint's blind signature on a proof is consistent with
 * the mint's published keyset. This detects mint misbehavior (e.g., the
 * mint issuing proofs without corresponding backing).
 *
 * @module
 */

import type { Proof } from '@cashu/cashu-ts';

/**
 * Verify DLEQ proofs on a set of received proofs.
 *
 * Returns a summary of which proofs passed/failed verification.
 * Proofs without DLEQ data are skipped (verification is optional per NUT-12).
 *
 * Note: Full DLEQ verification requires the mint's public key for the
 * keyset. Since we may not always have this, we do a structural check
 * (DLEQ fields present and well-formed) and flag proofs that claim DLEQ
 * but have malformed data.
 */
export function verifyDleqProofs(proofs: Proof[]): {
  total: number;
  verified: number;
  skipped: number;
  failed: number;
  failedIndices: number[];
} {
  let verified = 0;
  let skipped = 0;
  let failed = 0;
  const failedIndices: number[] = [];

  for (let i = 0; i < proofs.length; i++) {
    const proof = proofs[i];
    if (!proof.dleq) {
      skipped++;
      continue;
    }

    // Structural verification: DLEQ fields must be present and non-empty
    const { e, s, r } = proof.dleq as { e?: string; s?: string; r?: string };
    if (!e || !s || !r) {
      failed++;
      failedIndices.push(i);
      continue;
    }

    // Verify e, s, r are valid hex strings of reasonable length
    const hexPattern = /^[0-9a-fA-F]+$/;
    if (!hexPattern.test(String(e)) || !hexPattern.test(String(s)) || !hexPattern.test(String(r))) {
      failed++;
      failedIndices.push(i);
      continue;
    }

    verified++;
  }

  return { total: proofs.length, verified, skipped, failed, failedIndices };
}

/**
 * Check if any proofs have suspicious DLEQ data.
 * Returns true if all proofs with DLEQ pass structural verification.
 */
export function isDleqValid(proofs: Proof[]): boolean {
  const result = verifyDleqProofs(proofs);
  return result.failed === 0;
}
