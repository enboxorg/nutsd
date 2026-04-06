/**
 * Proof analysis and consolidation utilities.
 *
 * Provides denomination breakdown, proof counting, and consolidation
 * analysis for the swap/consolidation UI.
 *
 * @module
 */

import type { Proof } from '@cashu/cashu-ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DenominationBreakdown = {
  /** Denomination value. */
  value: number;
  /** Number of proofs at this denomination. */
  count: number;
  /** Total value (value * count). */
  total: number;
};

export type ProofAnalysis = {
  /** Total number of proofs. */
  proofCount: number;
  /** Total value of all proofs. */
  totalValue: number;
  /** Breakdown by denomination, sorted largest first. */
  denominations: DenominationBreakdown[];
  /** Number of distinct denominations. */
  distinctDenominations: number;
  /**
   * Whether consolidation would reduce proof count.
   * True when proofs can be combined into fewer, larger-denomination proofs.
   * False when proofs are already at optimal denominations.
   */
  canConsolidate: boolean;
  /**
   * Estimated proof count after consolidation.
   * Based on binary decomposition of the total value.
   */
  estimatedConsolidatedCount: number;
};

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a set of proofs: denomination breakdown, consolidation potential.
 *
 * @param proofs - Proofs to analyze (cashu-ts format: amount, id, secret, C)
 * @returns Analysis with denomination breakdown and consolidation info
 */
export function analyzeProofs(proofs: Proof[]): ProofAnalysis {
  if (proofs.length === 0) {
    return {
      proofCount               : 0,
      totalValue               : 0,
      denominations            : [],
      distinctDenominations    : 0,
      canConsolidate           : false,
      estimatedConsolidatedCount : 0,
    };
  }

  // Count proofs by denomination
  const denomMap = new Map<number, number>();
  let totalValue = 0;
  for (const proof of proofs) {
    denomMap.set(proof.amount, (denomMap.get(proof.amount) ?? 0) + 1);
    totalValue += proof.amount;
  }

  // Build sorted breakdown
  const denominations: DenominationBreakdown[] = [];
  for (const [value, count] of denomMap) {
    denominations.push({ value, count, total: value * count });
  }
  denominations.sort((a, b) => b.value - a.value);

  // Estimate optimal proof count via binary decomposition
  const estimatedConsolidatedCount = binaryDecompositionCount(totalValue);

  return {
    proofCount                : proofs.length,
    totalValue,
    denominations,
    distinctDenominations     : denominations.length,
    canConsolidate            : proofs.length > estimatedConsolidatedCount,
    estimatedConsolidatedCount,
  };
}

/**
 * Count the number of 1-bits in the binary representation of a number.
 *
 * Cashu uses power-of-2 denominations (1, 2, 4, 8, 16, ...). The minimum
 * number of proofs to represent a value is its popcount (number of 1-bits).
 * For example: 13 = 8 + 4 + 1 = 3 proofs.
 */
export function binaryDecompositionCount(value: number): number {
  if (value <= 0) return 0;
  let n = Math.floor(value);
  let count = 0;
  while (n > 0) {
    count += n & 1;
    n >>= 1;
  }
  return count;
}

/**
 * Get the power-of-2 denominations that compose a value.
 *
 * @returns Array of denomination values, sorted largest first.
 * @example binaryDecomposition(13) => [8, 4, 1]
 */
export function binaryDecomposition(value: number): number[] {
  if (value <= 0) return [];
  const result: number[] = [];
  let n = Math.floor(value);
  let bit = 1;
  while (n > 0) {
    if (n & 1) result.push(bit);
    n >>= 1;
    bit <<= 1;
  }
  return result.reverse();
}
