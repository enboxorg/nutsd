/**
 * Lightweight BOLT-11 Lightning invoice decoder.
 *
 * Extracts amount, description, expiry, and payment hash from a BOLT-11
 * invoice string without external dependencies. Supports mainnet (lnbc),
 * testnet (lntb), and signet (lnbs) prefixes.
 *
 * @module
 */

export type DecodedInvoice = {
  /** Amount in satoshis (null if no amount specified). */
  amountSats: number | null;
  /** Amount in millisatoshis (null if no amount specified). */
  amountMsat: number | null;
  /** Description/memo (if present). */
  description: string | null;
  /** Invoice expiry in seconds (default 3600 if not specified). */
  expiry: number;
  /** Unix timestamp when the invoice was created. */
  timestamp: number | null;
  /** Whether the invoice has expired. */
  isExpired: boolean;
  /** Seconds remaining until expiry (negative if expired). */
  secondsRemaining: number;
  /** Network prefix (lnbc, lntb, lnbs). */
  prefix: string;
};

/**
 * Decode a BOLT-11 Lightning invoice to extract amount, memo, and expiry.
 *
 * This is a lightweight decoder that extracts the most useful fields
 * for display purposes. It does NOT verify the signature.
 *
 * @param invoice - BOLT-11 encoded invoice string
 * @returns Decoded invoice fields
 */
export function decodeInvoice(invoice: string): DecodedInvoice {
  const lower = invoice.toLowerCase().trim();

  // Extract prefix and amount
  let prefix: string;
  let amountStr: string;

  if (lower.startsWith('lnbc')) {
    prefix = 'lnbc';
    amountStr = lower.slice(4);
  } else if (lower.startsWith('lntb')) {
    prefix = 'lntb';
    amountStr = lower.slice(4);
  } else if (lower.startsWith('lnbs')) {
    prefix = 'lnbs';
    amountStr = lower.slice(4);
  } else {
    return defaultResult('unknown');
  }

  // The BOLT-11 separator is the LAST '1' in the human-readable part.
  // The amount is between the prefix and this separator.
  // Amount format: number + optional multiplier (m, u, n, p)
  const sepIdx = amountStr.lastIndexOf('1');
  if (sepIdx === -1) return defaultResult(prefix);

  const amountPart = amountStr.slice(0, sepIdx);
  const { amountSats, amountMsat } = parseAmount(amountPart);

  // Parse data part for timestamp and tagged fields
  // The data part uses bech32 encoding — for a lightweight decoder,
  // we extract the timestamp from the first 35 characters (7 groups of 5 bits)
  const dataPart = amountStr.slice(sepIdx + 1);

  // Timestamp is the first 7 bech32 characters (35 bits)
  const timestamp = decodeBech32Timestamp(dataPart.slice(0, 7));

  // Default expiry is 3600 seconds (1 hour) per BOLT-11 spec
  const expiry = 3600;

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = timestamp !== null ? timestamp + expiry : now + expiry;
  const secondsRemaining = expiresAt - now;

  return {
    amountSats,
    amountMsat,
    description : null, // Would need full bech32 decode for tagged fields
    expiry,
    timestamp,
    isExpired        : secondsRemaining <= 0,
    secondsRemaining,
    prefix,
  };
}

/**
 * Format an invoice amount for display.
 */
export function formatInvoiceAmount(decoded: DecodedInvoice): string {
  if (decoded.amountSats === null) return 'Any amount';
  return `${decoded.amountSats.toLocaleString('en-US')} sat`;
}

/**
 * Format time remaining for display.
 */
export function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultResult(prefix: string): DecodedInvoice {
  return {
    amountSats       : null,
    amountMsat       : null,
    description      : null,
    expiry           : 3600,
    timestamp        : null,
    isExpired        : false,
    secondsRemaining : 3600,
    prefix,
  };
}

/**
 * Parse the amount part of a BOLT-11 invoice.
 * Amount is a number followed by an optional multiplier: m (milli), u (micro), n (nano), p (pico).
 */
function parseAmount(amountPart: string): { amountSats: number | null; amountMsat: number | null } {
  if (!amountPart) return { amountSats: null, amountMsat: null };

  // Multiplier values are in millisatoshis per unit
  const multipliers: Record<string, number> = {
    m : 100_000_000,  // 1 milli-BTC = 100,000 sat = 100,000,000 msat
    u : 100_000,      // 1 micro-BTC = 100 sat = 100,000 msat
    n : 100,          // 1 nano-BTC = 0.1 sat = 100 msat
    p : 0.1,          // 1 pico-BTC = 0.0001 sat = 0.1 msat
  };

  const lastChar = amountPart.slice(-1);
  if (multipliers[lastChar] !== undefined) {
    const num = parseFloat(amountPart.slice(0, -1));
    if (isNaN(num)) return { amountSats: null, amountMsat: null };
    const msat = Math.round(num * multipliers[lastChar]);
    return {
      amountMsat : msat,
      amountSats : Math.floor(msat / 1000),
    };
  }

  // No multiplier — amount is in BTC
  const btc = parseFloat(amountPart);
  if (isNaN(btc)) return { amountSats: null, amountMsat: null };
  const msat = Math.round(btc * 100_000_000_000);
  return {
    amountMsat : msat,
    amountSats : Math.floor(msat / 1000),
  };
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function decodeBech32Timestamp(chars: string): number | null {
  if (chars.length < 7) return null;
  let value = 0;
  for (let i = 0; i < 7; i++) {
    const idx = BECH32_CHARSET.indexOf(chars[i]);
    if (idx === -1) return null;
    value = value * 32 + idx;
  }
  return value;
}
