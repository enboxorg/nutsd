/**
 * Brand configuration derived from VITE_PRODUCT_THEME.
 *
 * Default build → nutsd (gold accent)
 * VITE_PRODUCT_THEME=dnuts → dnuts (teal accent)
 */

const theme = import.meta.env.VITE_PRODUCT_THEME ?? '';

export const brand = {
  /** Short name used in headers and titles. */
  name: theme === 'dnuts' ? 'dnuts' : 'nutsd',
  /** Accent letter in the logo (the "d"). */
  accentLetter: 'd',
  /** Base part of the logo name (before the accent letter). */
  baseName: theme === 'dnuts' ? 'dnuts' : 'nuts',
  /** Full human-readable description. */
  description: theme === 'dnuts'
    ? 'Decentralized Cashu ecash wallet powered by Enbox'
    : 'Decentralized Cashu ecash wallet powered by Enbox',
  /** localStorage key prefix to avoid collision between variants. */
  storagePrefix: theme === 'dnuts' ? 'dnuts' : 'nutsd',
  /** Preferred hosted Enbox wallet URL for delegated connect flows. */
  preferredWalletUrl: theme === 'dnuts'
    ? 'https://blue-enbox-wallet.pages.dev/'
    : 'https://enbox-wallet.pages.dev/',
} as const;
