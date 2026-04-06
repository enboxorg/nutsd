/**
 * NUT-18 Payment Request parsing and creation.
 *
 * Payment requests allow recipients to specify how they want to be paid:
 * which mints they accept, what amount, what unit, and an optional description.
 *
 * Encoded format: `creqA` + base64url(JSON)
 *
 * @module
 */

export type PaymentRequest = {
  /** Unique payment request ID. */
  id?: string;
  /** Requested amount (0 = any amount). */
  amount?: number;
  /** Currency unit. */
  unit?: string;
  /** Accepted mint URLs. */
  mints?: string[];
  /** Description / memo. */
  description?: string;
};

const PAYMENT_REQUEST_PREFIX = 'creqA';

/**
 * Check if a string is a NUT-18 payment request.
 */
export function isPaymentRequest(str: string): boolean {
  return str.trim().toLowerCase().startsWith('creqa');
}

/**
 * Decode a NUT-18 payment request string.
 *
 * Format: `creqA` + base64url(JSON)
 *
 * @throws if the string is not a valid payment request
 */
export function decodePaymentRequest(encoded: string): PaymentRequest {
  const trimmed = encoded.trim();
  if (!trimmed.toLowerCase().startsWith('creqa')) {
    throw new Error('Invalid payment request: must start with creqA');
  }

  const b64 = trimmed.slice(PAYMENT_REQUEST_PREFIX.length);
  try {
    // base64url to base64
    const base64 = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = atob(padded);
    const data = JSON.parse(json);

    return {
      id          : data.i ?? data.id,
      amount      : data.a ?? data.amount ?? 0,
      unit        : data.u ?? data.unit ?? 'sat',
      mints       : data.m ?? data.mints ?? [],
      description : data.d ?? data.description,
    };
  } catch {
    throw new Error('Invalid payment request: could not decode');
  }
}

/**
 * Encode a NUT-18 payment request.
 *
 * @returns `creqA` + base64url(JSON)
 */
export function encodePaymentRequest(request: PaymentRequest): string {
  const data: Record<string, unknown> = {};
  if (request.id) data.i = request.id;
  if (request.amount) data.a = request.amount;
  if (request.unit) data.u = request.unit;
  if (request.mints?.length) data.m = request.mints;
  if (request.description) data.d = request.description;

  const json = JSON.stringify(data);
  const base64 = btoa(json);
  // base64 to base64url
  const b64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return PAYMENT_REQUEST_PREFIX + b64url;
}
