import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { toast } from "sonner";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function toastError(title: string, error: unknown) {
  console.error(title, error);
  toast.error(title, {
    description: error instanceof Error ? error.message : String(error),
  });
}

export function toastSuccess(title: string, description?: string) {
  toast.success(title, { description });
}

// ---------------------------------------------------------------------------
// Unit formatting
// ---------------------------------------------------------------------------

/** Known unit display configuration. */
const UNIT_CONFIG: Record<string, { symbol: string; decimals: number; prefix: boolean }> = {
  sat  : { symbol: 'sat',  decimals: 0, prefix: false },
  msat : { symbol: 'msat', decimals: 0, prefix: false },
  usd  : { symbol: '$',    decimals: 2, prefix: true },
  eur  : { symbol: '\u20AC', decimals: 2, prefix: true },  // €
  gbp  : { symbol: '\u00A3', decimals: 2, prefix: true },  // £
  jpy  : { symbol: '\u00A5', decimals: 0, prefix: true },  // ¥
  btc  : { symbol: 'BTC',  decimals: 8, prefix: false },
};

/**
 * Format an amount with unit-aware display.
 *
 * - `sat`: `1,000 sat` (no decimals, suffix)
 * - `usd`: `$10.00` (2 decimals, prefix)
 * - `eur`: `€5.50` (2 decimals, prefix)
 * - Unknown units: `100 xyz` (no decimals, suffix)
 */
export function formatAmount(amount: number, unit = 'sat'): string {
  const config = UNIT_CONFIG[unit.toLowerCase()];

  if (!config) {
    // Unknown unit: basic formatting with suffix
    return `${amount.toLocaleString('en-US')} ${unit}`;
  }

  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits : config.decimals,
    maximumFractionDigits : config.decimals,
  });

  return config.prefix
    ? `${config.symbol}${formatted}`
    : `${formatted} ${config.symbol}`;
}

/**
 * Get the display symbol for a unit.
 */
export function getUnitSymbol(unit: string): string {
  return UNIT_CONFIG[unit.toLowerCase()]?.symbol ?? unit;
}

/**
 * Get the number of decimal places for a unit.
 */
export function getUnitDecimals(unit: string): number {
  return UNIT_CONFIG[unit.toLowerCase()]?.decimals ?? 0;
}

/** Truncate a string in the middle: "abcdefgh" → "abcd...efgh" */
export function truncateMiddle(str: string, startChars = 8, endChars = 8): string {
  if (str.length <= startChars + endChars + 3) return str;
  return `${str.slice(0, startChars)}...${str.slice(-endChars)}`;
}

/** Truncate a mint URL for display */
export function truncateMintUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host.length > 24) return truncateMiddle(host, 10, 10);
    return host;
  } catch {
    // Expected: malformed URL string — fall back to simple truncation
    return truncateMiddle(url, 12, 8);
  }
}

/** Generate a short human-readable timestamp */
export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
