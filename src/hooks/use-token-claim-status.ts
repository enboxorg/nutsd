/**
 * Shared hook for tracking Cashu token claim status.
 *
 * Polls the mint (NUT-07) to check whether a sent token has been
 * claimed (all proofs SPENT). Centralizes the polling logic used
 * by both the plain send dialog and the send-to-DID dialog.
 *
 * Behavior:
 * - If the mint does NOT support NUT-07, returns status 'unsupported'
 *   and stops polling. UI should show neutral copy instead of a
 *   misleading "waiting for claim" spinner.
 * - Polls every 5 seconds while the dialog is open.
 * - Transitions to 'claimed' as soon as all proofs are SPENT.
 * - After `staleAfterMs`, transitions to 'stale' to let the UI show
 *   a "still waiting..." nudge or a "check again" button.
 * - Provides a `checkNow()` callback for manual re-check.
 *
 * For persistent background tracking across sessions (when the dialog
 * is closed), see `useBackgroundClaimCheck` which reads pending
 * transactions from history and updates them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { checkTokenSpent, mintSupportsNut07 } from '@/cashu/wallet-ops';

/** Claim status states. */
export type ClaimStatus =
  | 'checking'    // Capability check in progress
  | 'unsupported' // Mint does not support NUT-07
  | 'pending'     // Waiting for claim (polling active)
  | 'stale'       // Pending for a long time (show "still waiting")
  | 'claimed';    // All proofs are SPENT

export interface UseTokenClaimStatusOptions {
  /** The encoded Cashu token to track. */
  token: string;
  /** Mint URL that issued the token. */
  mintUrl: string;
  /** Mint unit (e.g. 'sat'). */
  unit: string;
  /** Whether the hook should actively poll. Default: true. */
  enabled?: boolean;
  /** Polling interval in ms. Default: 5000. */
  intervalMs?: number;
  /** Mark as 'stale' after this many ms. Default: 60000 (1 minute). */
  staleAfterMs?: number;
  /** Called once when status transitions to 'claimed'. */
  onClaimed?: () => void | Promise<void>;
}

export interface UseTokenClaimStatusResult {
  /** Current claim status. */
  status: ClaimStatus;
  /** True if currently polling the mint. */
  isPolling: boolean;
  /** Manually trigger a claim check. */
  checkNow: () => Promise<void>;
}

export function useTokenClaimStatus(
  options: UseTokenClaimStatusOptions,
): UseTokenClaimStatusResult {
  const {
    token,
    mintUrl,
    unit,
    enabled = true,
    intervalMs = 5_000,
    staleAfterMs = 60_000,
    onClaimed,
  } = options;

  const [status, setStatus] = useState<ClaimStatus>('checking');
  const [isPolling, setIsPolling] = useState(false);
  const startedAtRef = useRef<number>(0);
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const staleTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const onClaimedRef = useRef(onClaimed);
  const claimedFiredRef = useRef(false);

  // Keep callback ref current without re-triggering the effect.
  useEffect(() => { onClaimedRef.current = onClaimed; }, [onClaimed]);

  const performCheck = useCallback(async (): Promise<void> => {
    const spent = await checkTokenSpent(token, mintUrl, unit);
    if (spent === true) {
      setStatus('claimed');
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = undefined; }
      if (staleTimerRef.current) { clearTimeout(staleTimerRef.current); staleTimerRef.current = undefined; }
      setIsPolling(false);
      if (!claimedFiredRef.current) {
        claimedFiredRef.current = true;
        try { await onClaimedRef.current?.(); } catch { /* best-effort */ }
      }
    }
  }, [token, mintUrl, unit]);

  const checkNow = useCallback(async (): Promise<void> => {
    if (!enabled || !token || !mintUrl) return;
    await performCheck();
  }, [enabled, token, mintUrl, performCheck]);

  // Main lifecycle: capability check → polling.
  useEffect(() => {
    if (!enabled || !token || !mintUrl) {
      setStatus('checking');
      return;
    }

    let cancelled = false;
    setStatus('checking');
    claimedFiredRef.current = false;
    startedAtRef.current = Date.now();

    (async () => {
      const supported = await mintSupportsNut07(mintUrl, unit);
      if (cancelled) return;

      if (supported !== true) {
        // Either not supported or mint info failed — don't poll.
        setStatus('unsupported');
        setIsPolling(false);
        return;
      }

      // Run an initial check immediately, then poll.
      setStatus('pending');
      setIsPolling(true);
      await performCheck();
      if (cancelled) return;

      pollRef.current = setInterval(() => {
        performCheck().catch(() => { /* best-effort */ });
      }, intervalMs);

      // Stale timer: after N ms, transition pending → stale so UI can nudge.
      staleTimerRef.current = setTimeout(() => {
        setStatus((curr) => (curr === 'pending' ? 'stale' : curr));
      }, staleAfterMs);
    })();

    return () => {
      cancelled = true;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = undefined; }
      if (staleTimerRef.current) { clearTimeout(staleTimerRef.current); staleTimerRef.current = undefined; }
      setIsPolling(false);
    };
  }, [enabled, token, mintUrl, unit, intervalMs, staleAfterMs, performCheck]);

  return { status, isPolling, checkNow };
}
