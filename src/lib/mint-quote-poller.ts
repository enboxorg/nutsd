type MintQuotePollState = 'UNPAID' | 'PAID' | 'ISSUED';

export type MintQuotePollStatus = {
  state: MintQuotePollState;
  expiry: number | null;
};

type MintQuotePollerOptions = {
  check: () => Promise<MintQuotePollStatus>;
  onPaid: () => Promise<void> | void;
  onExpired?: () => void;
  onIssued?: () => void;
  isActive?: () => boolean;
  intervalMs?: number;
  expiry?: number | null;
};

/**
 * Poll a mint quote without overlapping requests or duplicate settlement.
 *
 * Uses recursive setTimeout scheduling instead of setInterval so a slow quote
 * check cannot queue a second concurrent mint attempt.
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

  const getExpiry = (status: MintQuotePollStatus): number | null => status.expiry ?? expiry ?? null;

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
