/**
 * Cross-mint swap — move ecash from a foreign mint to a trusted mint.
 *
 * Uses Lightning as a bridge:
 * 1. Get a mint quote from the trusted mint (generates a Lightning invoice)
 * 2. Get a melt quote from the foreign mint (cost to pay that invoice)
 * 3. Melt the foreign proofs (pays the Lightning invoice)
 * 4. Mint new proofs at the trusted mint (using the paid invoice)
 *
 * This enables users to receive tokens from any mint and consolidate
 * them to their preferred/trusted mint.
 *
 * Fee = Lightning routing fee (melt quote fee_reserve) + input fees (NUT-02)
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
  /** Total fee (Lightning + any input fees). */
  totalFee: number;
  /** The mint quote from the trusted mint. */
  mintQuote: MintQuoteBolt11Response;
  /** The melt quote from the foreign mint. */
  meltQuote: MeltQuoteBolt11Response;
};

export type CrossMintSwapResult = {
  /** New proofs at the trusted mint. */
  proofs: Proof[];
  /** Total amount received. */
  amount: number;
  /** Change proofs from the foreign mint (if any). */
  change: Proof[];
};

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the cost and result of a cross-mint swap.
 *
 * Does NOT execute the swap — only fetches quotes from both mints.
 * The returned estimate includes the amount that will arrive at the
 * trusted mint and the total fees.
 *
 * @param foreignMintUrl - Mint URL where the token currently lives
 * @param trustedMintUrl - Mint URL to consolidate to
 * @param amount - Amount to swap (in the token's unit)
 * @param unit - Currency unit
 */
export async function estimateCrossMintSwap(
  foreignMintUrl: string,
  trustedMintUrl: string,
  amount: number,
  unit = 'sat',
): Promise<CrossMintSwapEstimate> {
  // Step 1: Get a mint quote from the trusted mint for the target amount.
  // This generates a Lightning invoice that the foreign mint will pay.
  const mintQuote = await createMintQuote(trustedMintUrl, amount, unit);

  // Step 2: Get a melt quote from the foreign mint for that invoice.
  // This tells us the total cost (amount + fee_reserve).
  const meltQuote = await createMeltQuote(foreignMintUrl, mintQuote.request, unit);

  const lightningFee = meltQuote.fee_reserve;
  const totalFee = lightningFee; // Input fees are handled by cashu-ts internally

  return {
    receiveAmount : amount,
    lightningFee,
    totalFee,
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
 * @param foreignMintUrl - Mint URL where the proofs currently live
 * @param trustedMintUrl - Mint URL to receive new proofs
 * @param foreignProofs - Proofs at the foreign mint to spend
 * @param estimate - Pre-fetched quotes from estimateCrossMintSwap()
 * @param unit - Currency unit
 */
export async function executeCrossMintSwap(
  foreignMintUrl: string,
  trustedMintUrl: string,
  foreignProofs: Proof[],
  estimate: CrossMintSwapEstimate,
  unit = 'sat',
): Promise<CrossMintSwapResult> {
  // Step 1: Melt the foreign proofs (pays the Lightning invoice from the mint quote).
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

  // Step 2: Mint new proofs at the trusted mint using the paid invoice.
  // Poll the mint quote until it transitions to PAID, then mint.
  let mintQuoteState = await checkMintQuote(trustedMintUrl, estimate.mintQuote.quote, unit);
  const maxWait = 30_000; // 30 seconds
  const interval = 2_000;
  let waited = 0;

  while (mintQuoteState.state !== 'PAID' && waited < maxWait) {
    await new Promise(r => setTimeout(r, interval));
    waited += interval;
    mintQuoteState = await checkMintQuote(trustedMintUrl, estimate.mintQuote.quote, unit);
  }

  if (mintQuoteState.state !== 'PAID') {
    throw new Error(
      'Cross-mint swap: Lightning payment succeeded but mint quote is not yet PAID. ' +
      'The trusted mint may need more time to detect the payment. ' +
      'Check your deposit history — the funds should appear shortly.',
    );
  }

  const newProofs = await mintTokens(trustedMintUrl, estimate.receiveAmount, estimate.mintQuote.quote, unit);

  return {
    proofs : newProofs,
    amount : newProofs.reduce((s, p) => s + p.amount, 0),
    change,
  };
}

/**
 * Estimate the fee for a cross-mint swap as a percentage of the amount.
 * Returns a human-readable string like "~2 sat (0.5%)".
 */
export function formatSwapFee(fee: number, amount: number, unit = 'sat'): string {
  if (amount <= 0) return `${fee} ${unit}`;
  const pct = ((fee / amount) * 100).toFixed(1);
  return `~${fee} ${unit} (${pct}%)`;
}
