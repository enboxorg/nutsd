import type { Transaction } from '@/hooks/use-wallet';

/**
 * Check whether a transaction represents a Lightning invoice that hasn't completed.
 * Covers both pre-expiry (`status: 'pending'`) and post-restart expired
 * invoices that startup recovery rewrites to `status: 'failed'`.
 */
export function isUnfulfilledInvoice(tx: Transaction): boolean {
  return tx.type === 'mint' && (tx.status === 'pending' || tx.status === 'failed') && !!tx.invoice;
}

/** An unfulfilled invoice whose expiry has passed (or was marked failed by recovery). */
export function isExpiredInvoice(tx: Transaction): boolean {
  if (!isUnfulfilledInvoice(tx)) return false;
  if (tx.status === 'failed') return true; // recovery already confirmed expiry
  return !!tx.expiresAt && new Date(tx.expiresAt).getTime() < Date.now();
}

// ---------------------------------------------------------------------------
// Settlement decision logic
// ---------------------------------------------------------------------------
// Extracted from dialog onPaid callbacks and background sweep so the
// branching can be tested without React/DWN infrastructure.

/** What the caller should do after minting + proof persistence. */
export type SettlementAction =
  | { type: 'complete'; memo: string }
  | { type: 'defer'; reason: string };

/**
 * Decide whether to mark a pending mint transaction as completed after
 * proofs have been minted and a persistence attempt made.
 *
 * @param fullyPersisted - Return value of safeStoreReceivedProofs
 * @param source - 'lightning' | 'lnurl-withdraw' — determines the memo
 * @param description - Optional LNURL description to include in the memo
 */
export function decideMintSettlement(
  fullyPersisted: boolean,
  source: 'lightning' | 'lnurl-withdraw',
  description?: string,
): SettlementAction {
  if (!fullyPersisted) {
    return {
      type: 'defer',
      reason: 'Proof persistence partial — stash recovery will finish on restart',
    };
  }
  const memo = source === 'lnurl-withdraw'
    ? `LNURL withdraw${description ? `: ${description}` : ''}`
    : 'Lightning receive';
  return { type: 'complete', memo };
}

/** What the sweep should do when it encounters a non-PAID quote state. */
export type SweepQuoteAction =
  | { type: 'complete'; memo: string; needsStashRecovery: boolean }
  | { type: 'markFailed'; memo: string }
  | { type: 'skip' };

/**
 * Decide what the background sweep should do for a given quote state.
 *
 * @param quoteState - The mint quote state string (PAID, ISSUED, UNPAID, etc.)
 * @param source - 'lightning' | 'lnurl-withdraw'
 * @param expiry - Unix seconds expiry, if known
 */
export function decideSweepAction(
  quoteState: string,
  source: 'lightning' | 'lnurl-withdraw',
  expiry: number | null,
): SweepQuoteAction {
  const sourceLabel = source === 'lnurl-withdraw' ? 'LNURL withdraw' : 'Lightning receive';

  if (quoteState === 'ISSUED') {
    return {
      type: 'complete',
      memo: `${sourceLabel} (already minted)`,
      needsStashRecovery: true,
    };
  }

  if (quoteState === 'PAID') {
    // Caller handles PAID — this function is for non-PAID states.
    // Returning skip signals the caller to proceed to the settlement phase.
    return { type: 'skip' };
  }

  // UNPAID — check expiry
  if (expiry && expiry < Math.floor(Date.now() / 1000)) {
    return { type: 'markFailed', memo: 'Quote expired before payment' };
  }

  return { type: 'skip' };
}
