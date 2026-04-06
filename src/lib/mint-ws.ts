/**
 * NUT-17 WebSocket subscription for real-time mint quote status.
 *
 * Connects to the mint's WebSocket endpoint (from NUT-17 in mint info)
 * and subscribes to quote state changes. Falls back to HTTP polling
 * when the mint doesn't support NUT-17.
 *
 * @module
 */

import { startMintQuotePolling, type MintQuotePollStatus } from './mint-quote-poller';

export type QuoteSubscriptionCallbacks = {
  onPaid: () => Promise<void> | void;
  onExpired?: () => void;
  onIssued?: () => void;
  isActive?: () => boolean;
};

type SubscribeQuoteOptions = {
  /** Mint URL. */
  mintUrl: string;
  /** Quote ID to subscribe to. */
  quoteId: string;
  /** Quote type: 'bolt11_mint_quote' or 'bolt11_melt_quote'. */
  quoteType: 'bolt11_mint_quote' | 'bolt11_melt_quote';
  /** Callbacks for state transitions. */
  callbacks: QuoteSubscriptionCallbacks;
  /** Fallback: check function for HTTP polling. */
  checkFn: () => Promise<MintQuotePollStatus>;
  /** Quote expiry (unix seconds). */
  expiry?: number | null;
};

/**
 * Subscribe to a mint quote's state changes.
 *
 * Tries NUT-17 WebSocket first. If the mint doesn't support it,
 * or the connection fails, falls back to HTTP polling.
 *
 * @returns A stop function that closes the subscription.
 */
export function subscribeToQuote({
  mintUrl,
  quoteId,
  quoteType,
  callbacks,
  checkFn,
  expiry,
}: SubscribeQuoteOptions): () => void {
  // Try to connect via WebSocket
  const wsUrl = getWebSocketUrl(mintUrl);
  if (!wsUrl) {
    // No WebSocket URL available, fall back to polling
    return startMintQuotePolling({
      check: checkFn,
      onPaid: callbacks.onPaid,
      onExpired: callbacks.onExpired,
      onIssued: callbacks.onIssued,
      isActive: callbacks.isActive,
      expiry,
    });
  }

  let ws: WebSocket | null = null;
  let disposed = false;
  let settled = false;
  let fallbackStop: (() => void) | null = null;
  let expiryTimerId: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    disposed = true;
    settled = true;
    if (expiryTimerId) clearTimeout(expiryTimerId);
    ws?.close();
    ws = null;
    fallbackStop?.();
  };

  const fallbackToPolling = () => {
    if (disposed || settled) return;
    // Clean up the WS expiry timer — the polling fallback handles expiry on its own
    if (expiryTimerId) { clearTimeout(expiryTimerId); expiryTimerId = undefined; }
    fallbackStop = startMintQuotePolling({
      check: checkFn,
      onPaid: callbacks.onPaid,
      onExpired: callbacks.onExpired,
      onIssued: callbacks.onIssued,
      isActive: callbacks.isActive,
      expiry,
    });
  };

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      if (disposed) { ws?.close(); return; }

      // Schedule expiry timer — the WebSocket path must also respect quote expiry.
      // Without this, the dialog stays in "waiting" state forever if the quote
      // expires while the socket is open.
      if (expiry != null) {
        const msUntilExpiry = expiry * 1000 - Date.now();
        if (msUntilExpiry <= 0) {
          settled = true;
          ws?.close();
          callbacks.onExpired?.();
          return;
        }
        expiryTimerId = setTimeout(() => {
          if (!disposed && !settled) {
            settled = true;
            ws?.close();
            callbacks.onExpired?.();
          }
        }, msUntilExpiry);
      }

      // Send NUT-17 subscription request
      const subRequest = JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: {
          kind: quoteType,
          filters: [quoteId],
          subId: `nutsd-${quoteId.slice(0, 8)}`,
        },
        id: 1,
      });
      ws?.send(subRequest);
    };

    ws.onmessage = (event) => {
      if (disposed || settled) return;
      try {
        const msg = JSON.parse(event.data);
        // NUT-17 notification format
        const payload = msg.params ?? msg.result;
        if (!payload) return;

        const state = payload.state ?? payload.status;
        if (state === 'PAID') {
          settled = true;
          ws?.close();
          callbacks.onPaid();
        } else if (state === 'ISSUED') {
          settled = true;
          ws?.close();
          callbacks.onIssued?.();
        }
      } catch {
        // Expected: non-JSON or non-NUT-17 message from WebSocket — ignore
      }
    };

    ws.onerror = () => {
      if (disposed || settled) return;
      ws?.close();
      fallbackToPolling();
    };

    ws.onclose = () => {
      if (disposed || settled) return;
      // Connection lost unexpectedly — fall back to polling
      fallbackToPolling();
    };
  } catch (err) {
    // WebSocket constructor threw — fall back to polling
    console.warn('[nutsd] WebSocket connection failed, falling back to polling:', err);
    fallbackToPolling();
  }

  return stop;
}

/**
 * Derive the WebSocket URL from a mint URL.
 *
 * Converts https://mint.example.com → wss://mint.example.com/v1/ws
 * Converts http://localhost:3338 → ws://localhost:3338/v1/ws
 *
 * Returns null if the URL scheme is not http/https.
 */
function getWebSocketUrl(mintUrl: string): string | null {
  try {
    const url = new URL(mintUrl);
    const wsScheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    return `${wsScheme}//${url.host}${path}/v1/ws`;
  } catch {
    // Expected: invalid URL string — cannot derive WebSocket URL
    return null;
  }
}
