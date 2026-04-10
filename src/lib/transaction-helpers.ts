import type { Transaction } from '@/hooks/use-wallet';

/**
 * Check whether a transaction represents a Lightning invoice that hasn't completed.
 * Covers both pre-expiry (`status: 'pending'`) and post-restart expired
 * invoices that startup recovery rewrites to `status: 'failed'`.
 */
export function isUnfulfilledInvoice(tx: Transaction): boolean {
  return tx.type === 'mint' && (tx.status === 'pending' || tx.status === 'failed') && !!tx.invoice;
}

/** An unfulfilled invoice whose expiry has passed (or was marked failed by recovery). */
export function isExpiredInvoice(tx: Transaction): boolean {
  if (!isUnfulfilledInvoice(tx)) return false;
  if (tx.status === 'failed') return true; // recovery already confirmed expiry
  return !!tx.expiresAt && new Date(tx.expiresAt).getTime() < Date.now();
}
