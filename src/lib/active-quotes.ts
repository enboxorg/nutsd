/**
 * Registry of quoteIds that are actively being monitored by an open dialog.
 *
 * The background invoice sweep in use-wallet.ts checks this set before
 * attempting to settle an invoice. If a dialog is already subscribed to
 * a quote (via WS or polling), the sweep skips it to avoid concurrent
 * settlement races.
 *
 * Dialogs call `registerActiveQuote` when they start subscribing and
 * `unregisterActiveQuote` when they tear down (unmount or stop polling).
 *
 * @module
 */

const activeQuotes = new Set<string>();

export function registerActiveQuote(quoteId: string): void {
  activeQuotes.add(quoteId);
}

export function unregisterActiveQuote(quoteId: string): void {
  activeQuotes.delete(quoteId);
}

export function isQuoteActive(quoteId: string): boolean {
  return activeQuotes.has(quoteId);
}
