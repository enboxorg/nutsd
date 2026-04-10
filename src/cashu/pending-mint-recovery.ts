/**
 * Recovery for pending mint (receive) operations.
 *
 * When a Lightning receive or LNURL-withdraw creates a mint quote, the
 * quote ID is persisted in a pending transaction record. If the page
 * reloads before the quote is paid and tokens are minted, this module
 * resumes the operation on startup.
 *
 * Follows the same pattern as cross-mint-swap recovery:
 * - State is serialized into the `memo` field of a `transaction` record
 *   with `status: 'pending'` and `type: 'mint'`
 * - On startup, pending mint transactions are scanned and resumed
 *
 * @module
 */

import { checkMintQuote, mintTokens } from '@/cashu/wallet-ops';
import { isDleqValid } from '@/cashu/dleq-verify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Persistent state for a pending receive (mint quote waiting for payment).
 * Serialized as JSON into `TransactionData.memo`.
 */
export type PendingMintState = {
  /** Mint quote ID (NUT-04). */
  quoteId: string;
  /** Mint URL. */
  mintUrl: string;
  /** Mint context ID (for proof storage). */
  mintContextId: string;
  /** Amount in the mint's unit. */
  amount: number;
  /** Currency unit (always 'sat' for LNURL-withdraw). */
  unit: string;
  /** Quote expiry (Unix seconds) or null if none. */
  expiry: number | null;
  /** Origin of the receive ('lightning' or 'lnurl-withdraw'). */
  source: 'lightning' | 'lnurl-withdraw';
  /** LNURL-withdraw service description (for memo reconstruction). */
  description?: string;
};

/** Marker prefix so we can quickly identify PendingMintState memos. */
const MEMO_PREFIX = '{"quoteId":';

export function isPendingMintMemo(memo: string | undefined): boolean {
  return !!memo && memo.startsWith(MEMO_PREFIX);
}

export function parsePendingMintState(memo: string): PendingMintState | null {
  try {
    const parsed = JSON.parse(memo);
    if (parsed.quoteId && parsed.mintUrl && parsed.mintContextId) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function serializePendingMintState(state: PendingMintState): string {
  return JSON.stringify(state);
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export type MintRecoveryResult =
  | { status: 'minted'; proofs: import('@cashu/cashu-ts').Proof[] }
  | { status: 'issued' }
  | { status: 'expired' }
  | { status: 'pending' }
  | { status: 'error'; message: string };

/**
 * Attempt to resume a single pending mint quote.
 *
 * - PAID → mint tokens and return proofs
 * - ISSUED → already minted by a previous attempt. This does NOT guarantee
 *   the proofs are in the local wallet. There is a pre-stash crash window:
 *   mintTokens() may have succeeded but the app crashed before the stash
 *   write, leaving proofs unrecoverable. Callers should mark this as
 *   completed but log a warning — the stash (if it exists) will have
 *   already been recovered by an earlier startup step.
 * - Expired → return expired status
 * - UNPAID and not expired → still pending, leave for next check
 */
export async function resumePendingMint(
  state: PendingMintState,
): Promise<MintRecoveryResult> {
  try {
    const quote = await checkMintQuote(state.mintUrl, state.quoteId, state.unit);
    const quoteState = quote.state as string;

    if (quoteState === 'PAID') {
      const proofs = await mintTokens(state.mintUrl, state.amount, state.quoteId, state.unit);

      if (!(await isDleqValid(state.mintUrl, proofs))) {
        console.warn('[nutsd:financial] DLEQ verification failed on recovered mint proofs');
      }

      return { status: 'minted', proofs };
    }

    if (quoteState === 'ISSUED') {
      return { status: 'issued' };
    }

    // Check expiry
    const expiry = quote.expiry ?? state.expiry;
    if (expiry && expiry < Math.floor(Date.now() / 1000)) {
      return { status: 'expired' };
    }

    return { status: 'pending' };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
