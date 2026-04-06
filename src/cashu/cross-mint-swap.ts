/**
 * Cross-mint swap — move ecash from a foreign mint to a trusted mint.
 *
 * Uses Lightning as a bridge:
 * 1. Get a melt quote from the foreign mint for a dummy invoice (to learn the fee)
 * 2. Compute receiveAmount = tokenAmount - meltFee
 * 3. Get a mint quote from the trusted mint for receiveAmount
 * 4. Get a final melt quote from the foreign mint for THAT invoice
 * 5. Melt the foreign proofs (pays the Lightning invoice)
 * 6. Mint new proofs at the trusted mint
 *
 * The key insight: the trusted-mint invoice amount must be LESS than the
 * foreign token amount, because the foreign melt also needs fee_reserve.
 * Requesting an invoice for the full token amount would underfund the melt.
 *
 * @module
 */

import type { Proof } from '@cashu/cashu-ts';
import {
  createMintQuote,
  checkMintQuote,
  mintTokens,
  createMeltQuote,
  meltTokens,
  type MintQuoteBolt11Response,
  type MeltQuoteBolt11Response,
} from './wallet-ops';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CrossMintSwapEstimate = {
  /** Amount that will arrive at the trusted mint (after all fees). */
  receiveAmount: number;
  /** Lightning fee reserve from the foreign mint's melt quote. */
  lightningFee: number;
  /** Total fee deducted from the token amount. */
  totalFee: number;
  /** The mint quote from the trusted mint (for receiveAmount, not full amount). */
  mintQuote: MintQuoteBolt11Response;
  /** The melt quote from the foreign mint (for the trusted mint's invoice). */
  meltQuote: MeltQuoteBolt11Response;
};

export type CrossMintSwapResult = {
  /** New proofs at the trusted mint. */
  proofs: Proof[];
  /** Total amount received at trusted mint. */
  amount: number;
  /** Change proofs from the foreign mint (if any — MUST be persisted). */
  change: Proof[];
};

/**
 * Persistent state for recovering an interrupted swap.
 * Stored in a DWN transaction record so the second leg can resume.
 */
export type PendingSwapState = {
  /** Trusted mint quote ID — needed to poll and mint. */
  trustedMintQuoteId: string;
  /** Trusted mint URL. */
  trustedMintUrl: string;
  /** Expected receive amount. */
  receiveAmount: number;
  /** Foreign mint URL (for change attribution). */
  foreignMintUrl: string;
  /** Unit. */
  unit: string;
};

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the cost and result of a cross-mint swap.
 *
 * The correct order is:
 * 1. Estimate the foreign melt fee by requesting a melt quote for the amount
 * 2. Subtract the fee to get receiveAmount
 * 3. Request a mint quote at the trusted mint for receiveAmount
 * 4. Get a final melt quote for the actual invoice
 *
 * This ensures the melt is never underfunded.
 */
export async function estimateCrossMintSwap(
  foreignMintUrl: string,
  trustedMintUrl: string,
  tokenAmount: number,
  unit = 'sat',
): Promise<CrossMintSwapEstimate> {
  // Step 1: Get a preliminary mint quote to learn the invoice format/routing cost.
  // We request for a conservative receive amount (tokenAmount minus a safety margin).
  // The actual fee comes from the melt quote against this invoice.
  const safetyMargin = Math.max(2, Math.ceil(tokenAmount * 0.02));
  const prelimReceive = Math.max(1, tokenAmount - safetyMargin);

  const prelimMintQuote = await createMintQuote(trustedMintUrl, prelimReceive, unit);
  const prelimMeltQuote = await createMeltQuote(foreignMintUrl, prelimMintQuote.request, unit);

  // Step 2: Now we know the real fee. Compute the exact receiveAmount.
  const lightningFee = prelimMeltQuote.fee_reserve;
  const receiveAmount = Math.max(1, tokenAmount - lightningFee);

  // Step 3: If the preliminary amount was wrong, get a corrected mint quote.
  let mintQuote: MintQuoteBolt11Response;
  let meltQuote: MeltQuoteBolt11Response;

  if (receiveAmount !== prelimReceive) {
    mintQuote = await createMintQuote(trustedMintUrl, receiveAmount, unit);
    meltQuote = await createMeltQuote(foreignMintUrl, mintQuote.request, unit);
  } else {
    mintQuote = prelimMintQuote;
    meltQuote = prelimMeltQuote;
  }

  return {
    receiveAmount,
    lightningFee : meltQuote.fee_reserve,
    totalFee     : tokenAmount - receiveAmount,
    mintQuote,
    meltQuote,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute a cross-mint swap using pre-fetched quotes.
 *
 * Returns the new proofs AND any change from the foreign mint.
 * The caller MUST persist both:
 * - result.proofs → stored at the trusted mint
 * - result.change → stored at the foreign mint (or discarded if zero)
 *
 * If the melt succeeds but minting doesn't complete within the wait window,
 * throws with the PendingSwapState so the caller can persist it for later resume.
 */
export async function executeCrossMintSwap(
  foreignMintUrl: string,
  trustedMintUrl: string,
  foreignProofs: Proof[],
  estimate: CrossMintSwapEstimate,
  unit = 'sat',
): Promise<CrossMintSwapResult> {
  // Step 1: Melt the foreign proofs.
  const { paid, change } = await meltTokens(
    foreignMintUrl,
    estimate.meltQuote,
    foreignProofs,
    unit,
  );

  if (!paid) {
    throw new Error(
      'Cross-mint swap failed: Lightning payment was not completed. ' +
      'The foreign mint may still be processing — check again later.',
    );
  }

  // At this point the melt succeeded — we MUST complete the second leg or
  // provide enough info for the caller to persist and resume later.

  // Step 2: Poll the trusted mint quote until PAID, then mint.
  const maxWait = 30_000;
  const interval = 2_000;
  let waited = 0;
  let mintQuoteState = await checkMintQuote(trustedMintUrl, estimate.mintQuote.quote, unit);

  while (mintQuoteState.state !== 'PAID' && waited < maxWait) {
    await new Promise(r => setTimeout(r, interval));
    waited += interval;
    mintQuoteState = await checkMintQuote(trustedMintUrl, estimate.mintQuote.quote, unit);
  }

  if (mintQuoteState.state !== 'PAID') {
    // Melt succeeded but mint quote not yet paid — the Lightning payment is
    // in-flight or the trusted mint is slow. Throw with recovery info so
    // the caller can persist it and retry later.
    const pendingState: PendingSwapState = {
      trustedMintQuoteId : estimate.mintQuote.quote,
      trustedMintUrl,
      receiveAmount      : estimate.receiveAmount,
      foreignMintUrl,
      unit,
    };
    const err = new Error(
      'Cross-mint swap: melt succeeded but trusted mint has not detected the payment yet. ' +
      'Your funds are safe — the swap will complete when the payment arrives.',
    );
    (err as any).pendingSwapState = pendingState;
    (err as any).change = change;
    throw err;
  }

  const newProofs = await mintTokens(trustedMintUrl, estimate.receiveAmount, estimate.mintQuote.quote, unit);

  return {
    proofs : newProofs,
    amount : newProofs.reduce((s, p) => s + p.amount, 0),
    change,
  };
}

/**
 * Resume a pending swap (second leg only — minting at the trusted mint).
 * Called on startup if a PendingSwapState is found in transaction history.
 */
export async function resumePendingSwap(
  state: PendingSwapState,
): Promise<Proof[]> {
  // Check if the mint quote has been paid
  const mintQuoteState = await checkMintQuote(state.trustedMintUrl, state.trustedMintQuoteId, state.unit);

  if (mintQuoteState.state === 'PAID') {
    return mintTokens(state.trustedMintUrl, state.receiveAmount, state.trustedMintQuoteId, state.unit);
  }

  if (mintQuoteState.state === 'ISSUED') {
    // Already minted (maybe another session completed it)
    return [];
  }

  throw new Error(
    `Swap mint quote ${state.trustedMintQuoteId} is still ${mintQuoteState.state}. ` +
    'The trusted mint has not yet detected the Lightning payment.',
  );
}

/**
 * Format a swap fee for display.
 */
export function formatSwapFee(fee: number, amount: number, unit = 'sat'): string {
  if (amount <= 0) return `${fee} ${unit}`;
  const pct = ((fee / amount) * 100).toFixed(1);
  return `~${fee} ${unit} (${pct}%)`;
}
