/**
 * Resolve a raw scanned/pasted string for the Receive dialog.
 *
 * Detects the input type and, for LNURL, resolves the endpoint to
 * distinguish pay from withdraw before routing. This avoids blindly
 * assuming an LNURL is a withdraw link.
 *
 * @module
 */

import { detectInput } from '@/lib/input-detect';
import { decodeLnurl } from '@/lib/lnurl';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResolvedReceiveInput =
  /** A cashu token — route to the claim-token pane. */
  | { type: 'cashu-token'; value: string }
  /** An LNURL-withdraw link — route to the LNURL-withdraw pane. */
  | { type: 'lnurl-withdraw'; value: string }
  /** The input was recognized but isn't a receive operation. */
  | { type: 'wrong-context'; message: string }
  /** The input couldn't be recognized at all. */
  | { type: 'unknown'; message: string };

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a raw string from QR scan or clipboard paste for the Receive dialog.
 *
 * - Cashu tokens are returned directly (no network needed).
 * - LNURL strings are resolved to determine their tag before routing.
 * - Other input types (invoices, DIDs, etc.) are returned as `wrong-context`
 *   with a helpful message suggesting the Send dialog.
 */
export async function resolveReceiveInput(raw: string): Promise<ResolvedReceiveInput> {
  const detected = detectInput(raw);

  switch (detected.type) {
    case 'cashu-token':
      return { type: 'cashu-token', value: detected.value };

    case 'lnurl':
      return resolveLnurlForReceive(detected.value);

    case 'lightning-invoice':
      return { type: 'wrong-context', message: 'This is a Lightning invoice. Use Send to pay it.' };

    case 'payment-request':
      return { type: 'wrong-context', message: 'This is a payment request. Use Send to fulfil it.' };

    case 'lightning-address':
      return { type: 'wrong-context', message: 'This is a Lightning address. Use Send to pay it.' };

    case 'did':
      return { type: 'wrong-context', message: 'This is a DID address. Use Send to send ecash to it.' };

    case 'mint-url':
      return { type: 'wrong-context', message: 'This is a mint URL. Add it from Settings.' };

    default:
      return { type: 'unknown', message: 'Not recognized as a Cashu token or LNURL-withdraw link.' };
  }
}

/**
 * Resolve an LNURL string and determine if it's a withdraw request.
 */
async function resolveLnurlForReceive(lnurl: string): Promise<ResolvedReceiveInput> {
  try {
    const url = lnurl.toLowerCase().startsWith('lnurl1')
      ? decodeLnurl(lnurl)
      : lnurl;

    const res = await fetch(url);
    if (!res.ok) {
      return { type: 'unknown', message: `LNURL endpoint returned ${res.status}` };
    }

    const data = await res.json();

    if (data.tag === 'withdrawRequest') {
      return { type: 'lnurl-withdraw', value: lnurl };
    }

    if (data.tag === 'payRequest') {
      return { type: 'wrong-context', message: 'This is an LNURL-pay link. Use Send to pay it.' };
    }

    return { type: 'unknown', message: `Unsupported LNURL type: ${data.tag || 'unknown'}` };
  } catch (err) {
    return {
      type: 'unknown',
      message: err instanceof Error ? err.message : 'Failed to resolve LNURL',
    };
  }
}
