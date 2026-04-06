/**
 * LNURL-withdraw — claim Lightning from a service.
 *
 * The opposite of LNURL-pay: the service pays YOU.
 * Used for: faucets, rewards, cashback, withdrawals from exchanges.
 *
 * @module
 */

export type LnurlWithdrawInfo = {
  /** Callback URL to submit the invoice. */
  callback: string;
  /** Unique identifier (optional). */
  k1: string;
  /** Minimum withdrawable amount in millisatoshis. */
  minWithdrawable: number;
  /** Maximum withdrawable amount in millisatoshis. */
  maxWithdrawable: number;
  /** Default description. */
  defaultDescription: string;
  /** Tag (should be 'withdrawRequest'). */
  tag: string;
};

/**
 * Fetch LNURL-withdraw info from a LNURL endpoint.
 */
export async function fetchLnurlWithdrawInfo(url: string): Promise<LnurlWithdrawInfo> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`LNURL-withdraw endpoint failed: ${res.status}`);

  const data = await res.json();
  if (data.status === 'ERROR') {
    throw new Error(data.reason || 'LNURL-withdraw endpoint returned an error');
  }
  if (data.tag !== 'withdrawRequest') {
    throw new Error(`Expected withdrawRequest, got: ${data.tag || 'unknown'}`);
  }

  return {
    callback          : data.callback,
    k1                : data.k1,
    minWithdrawable   : data.minWithdrawable,
    maxWithdrawable   : data.maxWithdrawable,
    defaultDescription: data.defaultDescription || '',
    tag               : data.tag,
  };
}

/**
 * Submit a Lightning invoice to the LNURL-withdraw callback.
 *
 * @param callback - The withdraw callback URL
 * @param k1 - The unique identifier from the withdraw info
 * @param invoice - BOLT-11 Lightning invoice to be paid
 */
export async function submitLnurlWithdraw(
  callback: string,
  k1: string,
  invoice: string,
): Promise<void> {
  const separator = callback.includes('?') ? '&' : '?';
  const url = `${callback}${separator}k1=${encodeURIComponent(k1)}&pr=${encodeURIComponent(invoice)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`LNURL-withdraw callback failed: ${res.status}`);

  const data = await res.json();
  if (data.status === 'ERROR') {
    throw new Error(data.reason || 'Withdraw callback returned an error');
  }
}

/** Convert millisatoshis to satoshis (floor). */
export function msatToSats(msat: number): number {
  return Math.floor(msat / 1000);
}
