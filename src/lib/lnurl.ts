/**
 * LNURL-pay resolution for Lightning addresses and LNURL bech32 strings.
 *
 * Supports:
 * - Lightning addresses (user@domain) via .well-known/lnurlp/ resolution
 * - LNURL bech32 strings (lnurl1...) via bech32 decoding
 *
 * The two-step flow is:
 * 1. Resolve → fetch payee metadata (name, description, min/max amounts)
 * 2. Get invoice → request a BOLT-11 invoice for a specific amount
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LnurlPayResponse = {
  /** Minimum sendable amount in millisatoshis. */
  minSendable: number;
  /** Maximum sendable amount in millisatoshis. */
  maxSendable: number;
  /** Callback URL to request a BOLT-11 invoice. */
  callback: string;
  /** Payee metadata as JSON-encoded array of [mime, content] tuples. */
  metadata: string;
  /** Optional: short description tag. */
  tag: string;
  /** Parsed: payee display name (from metadata text/plain). */
  displayName?: string;
  /** Parsed: payee description (from metadata text/long-desc). */
  description?: string;
  /** Parsed: payee avatar URL (from metadata image/png;base64 or image/jpeg;base64). */
  avatarUrl?: string;
};

export type LnurlInvoiceResponse = {
  /** BOLT-11 Lightning invoice. */
  pr: string;
  /** Optional: routes hint. */
  routes?: unknown[];
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a Lightning address (user@domain) to its LNURL-pay endpoint.
 *
 * Fetches `https://{domain}/.well-known/lnurlp/{user}` and parses the
 * LNURL-pay response.
 *
 * @throws if the address is invalid or the endpoint returns an error
 */
export async function resolveLightningAddress(address: string): Promise<LnurlPayResponse> {
  const parts = address.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid Lightning address: ${address}`);
  }
  const [user, domain] = parts;
  const url = `https://${domain}/.well-known/lnurlp/${user}`;
  return fetchLnurlPay(url);
}

/**
 * Resolve an LNURL bech32 string to its LNURL-pay endpoint.
 *
 * Decodes the bech32 string to a URL and fetches the LNURL-pay response.
 *
 * @throws if the bech32 string is invalid or the endpoint returns an error
 */
export async function resolveLnurl(lnurl: string): Promise<LnurlPayResponse> {
  const url = decodeLnurl(lnurl);
  return fetchLnurlPay(url);
}

/**
 * Request a BOLT-11 invoice from an LNURL-pay callback.
 *
 * @param callback - The callback URL from the LNURL-pay response
 * @param amountMsat - Amount to request in millisatoshis
 * @returns The BOLT-11 invoice string
 * @throws if the callback returns an error
 */
export async function requestLnurlInvoice(
  callback: string,
  amountMsat: number,
): Promise<string> {
  const separator = callback.includes('?') ? '&' : '?';
  const url = `${callback}${separator}amount=${amountMsat}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`LNURL callback failed: ${res.status}`);

  const data = await res.json();
  if (data.status === 'ERROR') {
    throw new Error(data.reason || 'LNURL callback returned an error');
  }
  if (!data.pr) {
    throw new Error('LNURL callback did not return an invoice');
  }
  return data.pr;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert sats to millisatoshis. */
export function satsToMsat(sats: number): number {
  return sats * 1000;
}

/** Convert millisatoshis to sats (floor). */
export function msatToSats(msat: number): number {
  return Math.floor(msat / 1000);
}

/**
 * Fetch and parse an LNURL-pay endpoint response.
 */
async function fetchLnurlPay(url: string): Promise<LnurlPayResponse> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`LNURL endpoint failed: ${res.status}`);

  const data = await res.json();
  if (data.status === 'ERROR') {
    throw new Error(data.reason || 'LNURL endpoint returned an error');
  }
  if (data.tag !== 'payRequest') {
    throw new Error(`Expected LNURL payRequest, got: ${data.tag || 'unknown'}`);
  }

  const result: LnurlPayResponse = {
    minSendable : data.minSendable,
    maxSendable : data.maxSendable,
    callback    : data.callback,
    metadata    : data.metadata || '[]',
    tag         : data.tag,
  };

  // Parse metadata to extract display name and description
  try {
    const metaArray: [string, string][] = JSON.parse(result.metadata);
    for (const [mime, content] of metaArray) {
      if (mime === 'text/plain' && !result.displayName) {
        result.displayName = content;
      }
      if (mime === 'text/long-desc' && !result.description) {
        result.description = content;
      }
      if ((mime === 'image/png;base64' || mime === 'image/jpeg;base64') && !result.avatarUrl) {
        result.avatarUrl = `data:${mime.split(';')[0]};base64,${content}`;
      }
    }
  } catch {
    // Metadata parsing failed — not critical
  }

  return result;
}

/**
 * Decode an LNURL bech32 string to a URL.
 *
 * LNURL uses bech32 encoding with HRP "lnurl". The data portion
 * is the UTF-8 URL.
 */
function decodeLnurl(lnurl: string): string {
  const lower = lnurl.toLowerCase();
  if (!lower.startsWith('lnurl1')) {
    throw new Error('Invalid LNURL: must start with lnurl1');
  }

  // Find the separator (last '1' in the string after the HRP)
  const sepIdx = lower.lastIndexOf('1');
  if (sepIdx < 1) throw new Error('Invalid LNURL: missing separator');

  const dataStr = lower.slice(sepIdx + 1);
  // Remove the 6-character checksum
  const payload = dataStr.slice(0, -6);

  // Bech32 character set
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const values: number[] = [];
  for (const ch of payload) {
    const idx = CHARSET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid LNURL: bad character '${ch}'`);
    values.push(idx);
  }

  // Convert from 5-bit groups to 8-bit bytes
  const bytes = convertBits(values, 5, 8, false);
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Convert between bit groups (bech32 uses 5-bit, bytes are 8-bit).
 */
function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      throw new Error('Invalid value during bit conversion');
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    // Discard incomplete trailing bits only if they're non-zero
    // This is common in bech32 — trailing padding bits are allowed
  }

  return ret;
}
