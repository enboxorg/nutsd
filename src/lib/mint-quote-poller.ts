/**
 * Single-flight mint quote poller.
 *
 * Uses recursive `setTimeout` instead of `setInterval` so a slow quote
 * check cannot queue a second concurrent mint attempt. The `onPaid`
 * callback fires exactly once even if the quote stays PAID across polls.
 *
 * Handles three terminal states:
 * - PAID: the invoice was paid, mint tokens
 * - ISSUED: tokens were already minted (e.g. another tab)
 * - Expired: quote expiry time has passed
 *
 * @module
 */

type MintQuotePollState = 'UNPAID' | 'PAID' | 'ISSUED';

export type MintQuotePollStatus = {
  state: MintQuotePollState;
  expiry: number | null;
};

type MintQuotePollerOptions = {
  /** Async function that checks the quote status with the mint. */
  check: () => Promise<MintQuotePollStatus>;
  /** Called exactly once when the quote transitions to PAID. */
  onPaid: () => Promise<void> | void;
  /** Called when the quote expiry time has passed. */
  onExpired?: () => void;
  /** Called when the quote is already ISSUED (minted by another session). */
  onIssued?: () => void;
  /** Return false to stop polling (e.g. component unmounted). */
  isActive?: () => boolean;
  /** Polling interval in ms (default 3000). */
  intervalMs?: number;
  /** Quote expiry (unix seconds) from the mint quote response. */
  expiry?: number | null;
};

/**
 * Start polling a mint quote without overlapping requests or duplicate settlement.
 *
 * @returns A stop function that cancels the poller.
 */
export function startMintQuotePolling({
  check,
  onPaid,
  onExpired,
  onIssued,
  isActive = () => true,
  intervalMs = 3000,
  expiry,
}: MintQuotePollerOptions): () => void {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let settled = false;

  const clear = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };

  const stop = () => {
    disposed = true;
    clear();
  };

  const getExpiry = (status: MintQuotePollStatus): number | null =>
    status.expiry ?? expiry ?? null;

  const schedule = () => {
    if (disposed || settled || !isActive()) return;
    timeoutId = setTimeout(run, intervalMs);
  };

  const run = async () => {
    clear();
    if (disposed || settled || !isActive()) return;

    try {
      const status = await check();
      if (disposed || settled || !isActive()) return;

      const currentExpiry = getExpiry(status);

      if (status.state === 'PAID') {
        settled = true;
        await onPaid();
        return;
      }

      if (status.state === 'ISSUED') {
        settled = true;
        onIssued?.();
        return;
      }

      if (currentExpiry !== null && Date.now() >= currentExpiry * 1000) {
        settled = true;
        onExpired?.();
        return;
      }
    } catch {
      // Transient quote-check failures should not fail the flow permanently.
    }

    schedule();
  };

  schedule();
  return stop;
}
