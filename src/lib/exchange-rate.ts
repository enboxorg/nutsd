/**
 * Exchange rate fetching for fiat display.
 *
 * Uses the mempool.space price API (no API key, no tracking).
 * Caches the rate for 5 minutes to avoid excessive requests.
 *
 * @module
 */

type PriceCache = {
  btcUsd: number;
  btcEur: number;
  btcGbp: number;
  fetchedAt: number;
};

let cache: PriceCache | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get the current BTC price in fiat currencies.
 * Cached for 5 minutes.
 */
export async function getBtcPrice(): Promise<PriceCache> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return cache;
  }

  try {
    const res = await fetch('https://mempool.space/api/v1/prices');
    if (!res.ok) throw new Error(`Price API error: ${res.status}`);
    const data = await res.json();

    cache = {
      btcUsd    : data.USD ?? 0,
      btcEur    : data.EUR ?? 0,
      btcGbp    : data.GBP ?? 0,
      fetchedAt : Date.now(),
    };
    return cache;
  } catch (err) {
    console.warn('[nutsd] Failed to fetch exchange rates:', err);
    if (cache) return cache; // Return stale cache on error
    return { btcUsd: 0, btcEur: 0, btcGbp: 0, fetchedAt: 0 };
  }
}

/**
 * Convert satoshis to a fiat amount.
 * Returns null if exchange rate is unavailable.
 */
export function satsToFiat(sats: number, currency: 'usd' | 'eur' | 'gbp'): number | null {
  if (!cache || cache.fetchedAt === 0) return null;
  const btcAmount = sats / 100_000_000;
  switch (currency) {
    case 'usd': return btcAmount * cache.btcUsd;
    case 'eur': return btcAmount * cache.btcEur;
    case 'gbp': return btcAmount * cache.btcGbp;
    default: return null;
  }
}

/**
 * Format a fiat amount for display.
 */
export function formatFiat(amount: number, currency: 'usd' | 'eur' | 'gbp'): string {
  const symbols: Record<string, string> = { usd: '$', eur: '\u20AC', gbp: '\u00A3' };
  const symbol = symbols[currency] ?? currency;
  return `${symbol}${amount.toFixed(2)}`;
}
