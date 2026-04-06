/**
 * Universal input detection for the paste-anything and QR scanner features.
 *
 * Detects the type of input from a raw string and returns a structured result
 * that the UI can route to the appropriate dialog/flow.
 *
 * Detection order (first match wins):
 * 0. NUT-18 Payment request (creqA / creqB prefix)
 * 1. Cashu token (cashuA / cashuB prefix)
 * 2. Lightning invoice (lnbc / lntb / lnbs prefix)
 * 3. LNURL (lnurl1 bech32 prefix)
 * 4. Lightning address (user@domain)
 * 5. Mint URL (https:// URL)
 *
 * @module
 */

export type DetectedInput =
  | { type: 'payment-request';  value: string }
  | { type: 'cashu-token';       value: string }
  | { type: 'lightning-invoice'; value: string }
  | { type: 'lnurl';            value: string }
  | { type: 'lightning-address'; value: string }
  | { type: 'mint-url';         value: string }
  | { type: 'unknown';          value: string };

/**
 * Detect the type of a pasted or scanned string.
 *
 * Trims whitespace and normalizes case-insensitive prefixes.
 * Returns a tagged union so the caller can route to the appropriate flow.
 */
export function detectInput(raw: string): DetectedInput {
  const trimmed = raw.trim();
  if (!trimmed) return { type: 'unknown', value: trimmed };

  const lower = trimmed.toLowerCase();

  // 0. NUT-18 Payment request (creqA / creqB)
  if (lower.startsWith('creqa') || lower.startsWith('creqb')) {
    return { type: 'payment-request', value: trimmed };
  }

  // 1. Cashu token (V3: cashuA, V4: cashuB)
  if (lower.startsWith('cashua') || lower.startsWith('cashub')) {
    return { type: 'cashu-token', value: trimmed };
  }

  // 2. Lightning invoice (BOLT-11)
  //    lnbc = mainnet, lntb = testnet, lnbs = signet
  if (lower.startsWith('lnbc') || lower.startsWith('lntb') || lower.startsWith('lnbs')) {
    return { type: 'lightning-invoice', value: trimmed };
  }

  // Also handle lightning: URI scheme
  if (lower.startsWith('lightning:')) {
    const inner = trimmed.slice('lightning:'.length).trim();
    return detectInput(inner);
  }

  // 3. LNURL (bech32-encoded)
  if (lower.startsWith('lnurl1')) {
    return { type: 'lnurl', value: trimmed };
  }

  // 4. Lightning address (user@domain.tld)
  //    Must look like an email but NOT be a cashu/lnurl/invoice
  if (isLightningAddress(trimmed)) {
    return { type: 'lightning-address', value: trimmed };
  }

  // 5. Mint URL (https://...)
  if (isMintUrl(trimmed)) {
    return { type: 'mint-url', value: normalizeMintUrl(trimmed) };
  }

  return { type: 'unknown', value: trimmed };
}

/**
 * Check if a string looks like a Lightning address (user@domain).
 * Lightning addresses look like email addresses but resolve to LNURL endpoints.
 */
function isLightningAddress(str: string): boolean {
  // Must contain exactly one @ with non-empty parts
  const parts = str.split('@');
  if (parts.length !== 2) return false;
  const [user, domain] = parts;
  if (!user || !domain) return false;
  // User part: alphanumeric + dots, hyphens, underscores
  if (!/^[a-zA-Z0-9._-]+$/.test(user)) return false;
  // Domain part: must have at least one dot
  if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) return false;
  return true;
}

/**
 * Check if a string looks like a mint URL.
 * Must start with http(s):// or look like a domain (contain a dot, no spaces).
 */
function isMintUrl(str: string): boolean {
  // Reject strings that don't look like URLs at all
  if (!str.startsWith('http://') && !str.startsWith('https://')) {
    // Bare domain must contain a dot and no spaces/special chars
    if (!str.includes('.') || /\s/.test(str) || str.includes('@')) return false;
  }
  try {
    const url = new URL(str.startsWith('http') ? str : `https://${str}`);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    // Expected: invalid URL string — not a mint URL
    return false;
  }
}

/**
 * Normalize a mint URL: ensure https://, strip trailing slash.
 */
function normalizeMintUrl(url: string): string {
  let normalized = url.trim();
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = `https://${normalized}`;
  }
  // Remove trailing slash
  return normalized.replace(/\/+$/, '');
}
