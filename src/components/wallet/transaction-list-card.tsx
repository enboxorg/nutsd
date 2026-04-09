import { useState } from 'react';
import {
  ArrowUpIcon,
  ArrowDownIcon,
  SendIcon,
  DownloadIcon,
  RefreshCwIcon,
  UsersIcon,
  CopyIcon,
  CheckIcon,
  CircleCheckIcon,
  ClockIcon,
  Loader2Icon,
  RotateCcwIcon,
  QrCodeIcon,
  Trash2Icon,
  AlertCircleIcon,
} from 'lucide-react';
import { formatAmount, formatDate, truncateMintUrl, toastSuccess, toastError } from '@/lib/utils';
import type { Transaction } from '@/hooks/use-wallet';

interface TransactionListCardProps {
  transactions: Transaction[];
  onViewAll?: () => void;
  onCheckTokenSpent?: (tx: Transaction) => Promise<boolean | null>;
  onReclaimToken?: (tx: Transaction) => Promise<void>;
  /** Show the QR code for a pending invoice. */
  onShowInvoiceQr?: (tx: Transaction) => void;
  /** Delete an expired pending invoice from history. */
  onDeleteTransaction?: (tx: Transaction) => Promise<void>;
}

const TX_ICONS: Record<string, React.FC<{ className?: string }>> = {
  'mint':        ArrowDownIcon,
  'melt':        ArrowUpIcon,
  'send':        SendIcon,
  'receive':     DownloadIcon,
  'swap':        RefreshCwIcon,
  'p2p-send':    UsersIcon,
  'p2p-receive': UsersIcon,
};

const TX_LABELS: Record<string, string> = {
  'mint':        'Deposit',
  'melt':        'Withdraw',
  'send':        'Sent',
  'receive':     'Received',
  'swap':        'Swap',
  'p2p-send':    'Sent to DID',
  'p2p-receive': 'Received from DID',
};

const TX_COLORS: Record<string, string> = {
  'mint':        'text-[var(--color-success)]',
  'melt':        'text-[var(--color-warning)]',
  'send':        'text-primary',
  'receive':     'text-[var(--color-info)]',
  'swap':        'text-muted-foreground',
  'p2p-send':    'text-primary',
  'p2p-receive': 'text-[var(--color-info)]',
};

/** Check whether a pending invoice is expired based on its expiresAt timestamp. */
function isPendingInvoiceExpired(tx: Transaction): boolean {
  return tx.status === 'pending' && !!tx.expiresAt && new Date(tx.expiresAt).getTime() < Date.now();
}

/** Check whether a transaction is a pending invoice (pending mint with invoice). */
function isPendingInvoice(tx: Transaction): boolean {
  return tx.type === 'mint' && tx.status === 'pending' && !!tx.invoice;
}

function TransactionRow({
  tx,
  onCheckSpent,
  onReclaimToken,
  onShowInvoiceQr,
  onDeleteTransaction,
}: {
  tx: Transaction;
  onCheckSpent?: (tx: Transaction) => Promise<boolean | null>;
  onReclaimToken?: (tx: Transaction) => Promise<void>;
  onShowInvoiceQr?: (tx: Transaction) => void;
  onDeleteTransaction?: (tx: Transaction) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [reclaiming, setReclaiming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Derive initial spent state from the persisted claim status on the transaction.
  // Background sweep in use-wallet.ts updates tx.claimStatus to 'claimed' automatically.
  const initialSpentState: 'unknown' | 'checking' | 'pending' | 'spent' | 'reclaimed' =
    tx.claimStatus === 'claimed' ? 'spent'
    : tx.claimStatus === 'pending' ? 'pending'
    : 'unknown';
  const [manualSpentState, setManualSpentState] = useState<'unknown' | 'checking' | 'pending' | 'spent' | 'reclaimed'>('unknown');
  // Prefer the persisted claim status, fall back to whatever the user manually checked.
  const spentState = manualSpentState !== 'unknown' ? manualSpentState : initialSpentState;
  const setSpentState = setManualSpentState;

  const Icon = TX_ICONS[tx.type] ?? RefreshCwIcon;
  const label = TX_LABELS[tx.type] ?? tx.type;
  const color = TX_COLORS[tx.type] ?? 'text-muted-foreground';
  const isIncoming = ['mint', 'receive', 'p2p-receive'].includes(tx.type);
  const sign = isIncoming ? '+' : '-';
  const hasCopyableToken = (tx.type === 'send' || tx.type === 'p2p-send') && !!tx.cashuToken;

  // Pending invoice state
  const pendingInvoice = isPendingInvoice(tx);
  const expired = isPendingInvoiceExpired(tx);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!tx.cashuToken) return;
    try {
      await navigator.clipboard.writeText(tx.cashuToken);
      setCopied(true);
      toastSuccess('Token copied');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('[nutsd] Clipboard write failed:', err);
      toastError('Copy failed', new Error('Clipboard access denied'));
    }
  };

  const handleCheckSpent = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onCheckSpent || spentState === 'checking') return;
    setSpentState('checking');
    try {
      const isSpent = await onCheckSpent(tx);
      if (isSpent === null) {
        setSpentState('unknown');
      } else {
        setSpentState(isSpent ? 'spent' : 'pending');
      }
    } catch (err) {
      console.warn('[nutsd] Token spent check failed:', err);
      setSpentState('unknown');
    }
  };

  const handleReclaim = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onReclaimToken || reclaiming) return;
    setReclaiming(true);
    try {
      await onReclaimToken(tx);
      setSpentState('reclaimed');
    } catch (err) {
      console.warn('[nutsd] Token reclaim failed:', err);
      toastError('Reclaim failed', new Error('Could not reclaim token. It may have already been claimed.'));
    } finally {
      setReclaiming(false);
    }
  };

  const handleShowQr = (e: React.MouseEvent) => {
    e.stopPropagation();
    onShowInvoiceQr?.(tx);
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onDeleteTransaction || deleting) return;
    setDeleting(true);
    try {
      await onDeleteTransaction(tx);
    } catch (err) {
      console.warn('[nutsd] Transaction delete failed:', err);
      toastError('Delete failed', err instanceof Error ? err : new Error('Failed to delete'));
      setDeleting(false);
    }
  };

  return (
    <div className="flex items-center justify-between px-4 py-3 group">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`p-1.5 rounded-md bg-muted ${pendingInvoice && !expired ? 'text-[var(--color-warning)]' : pendingInvoice && expired ? 'text-muted-foreground' : color}`}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">{label}</span>
            {/* Pending invoice badges */}
            {pendingInvoice && !expired && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[var(--color-warning)]/10 text-[var(--color-warning)] text-[10px] font-medium">
                <ClockIcon className="h-2.5 w-2.5" />
                awaiting payment
              </span>
            )}
            {pendingInvoice && expired && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px] font-medium">
                <AlertCircleIcon className="h-2.5 w-2.5" />
                expired
              </span>
            )}
            {/* Claim status badge — uses persisted claimStatus or manual check */}
            {(tx.type === 'send' || tx.type === 'p2p-send') && spentState === 'spent' && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[var(--color-success)]/10 text-[var(--color-success)] text-[10px] font-medium">
                <CircleCheckIcon className="h-2.5 w-2.5" />
                claimed
              </span>
            )}
            {hasCopyableToken && spentState === 'pending' && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[var(--color-warning)]/10 text-[var(--color-warning)] text-[10px] font-medium">
                <ClockIcon className="h-2.5 w-2.5" />
                pending
              </span>
            )}
            {hasCopyableToken && spentState === 'reclaimed' && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[var(--color-info)]/10 text-[var(--color-info)] text-[10px] font-medium">
                <RotateCcwIcon className="h-2.5 w-2.5" />
                reclaimed
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {truncateMintUrl(tx.mintUrl)} &middot; {formatDate(tx.createdAt)}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0 ml-3">
        {/* Action buttons for pending invoices */}
        {pendingInvoice && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {/* Show QR — only for active (non-expired) invoices */}
            {!expired && onShowInvoiceQr && (
              <button
                onClick={handleShowQr}
                className="p-1 rounded hover:bg-muted text-[var(--color-info)] hover:text-foreground transition-colors"
                title="Show invoice QR"
              >
                <QrCodeIcon className="h-3 w-3" />
              </button>
            )}
            {/* Delete — only for expired invoices */}
            {expired && onDeleteTransaction && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="p-1 rounded hover:bg-muted text-destructive hover:text-destructive transition-colors disabled:opacity-50"
                title="Delete expired invoice"
              >
                {deleting
                  ? <Loader2Icon className="h-3 w-3 animate-spin" />
                  : <Trash2Icon className="h-3 w-3" />
                }
              </button>
            )}
          </div>
        )}
        {/* Action buttons for sent tokens */}
        {hasCopyableToken && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {onReclaimToken && spentState === 'pending' && (
              <button
                onClick={handleReclaim}
                disabled={reclaiming}
                className="p-1 rounded hover:bg-muted text-[var(--color-info)] hover:text-foreground transition-colors disabled:opacity-50"
                title="Reclaim unclaimed token"
              >
                {reclaiming
                  ? <Loader2Icon className="h-3 w-3 animate-spin" />
                  : <RotateCcwIcon className="h-3 w-3" />
                }
              </button>
            )}
            {onCheckSpent && spentState !== 'spent' && spentState !== 'reclaimed' && (
              <button
                onClick={handleCheckSpent}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                title="Check if claimed"
              >
                {spentState === 'checking'
                  ? <Loader2Icon className="h-3 w-3 animate-spin" />
                  : <RefreshCwIcon className="h-3 w-3" />
                }
              </button>
            )}
            <button
              onClick={handleCopy}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title="Copy token"
            >
              {copied
                ? <CheckIcon className="h-3 w-3 text-[var(--color-success)]" />
                : <CopyIcon className="h-3 w-3" />
              }
            </button>
          </div>
        )}
        <div className={`amount-display text-sm font-medium ${
          pendingInvoice
            ? (expired ? 'text-muted-foreground' : 'text-[var(--color-warning)]')
            : (isIncoming ? 'text-[var(--color-success)]' : 'text-foreground')
        }`}>
          {sign}{formatAmount(tx.amount, tx.unit)}
        </div>
      </div>
    </div>
  );
}

export const TransactionListCard: React.FC<TransactionListCardProps> = ({
  transactions,
  onViewAll,
  onCheckTokenSpent,
  onReclaimToken,
  onShowInvoiceQr,
  onDeleteTransaction,
}) => {
  const recent = transactions.slice(0, 10);

  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">Recent Activity</h3>
        {transactions.length > 10 && onViewAll && (
          <button
            onClick={onViewAll}
            className="text-xs text-primary hover:underline"
          >
            View all
          </button>
        )}
      </div>

      {recent.length === 0 ? (
        <div className="p-4 text-center space-y-1">
          <p className="text-xs text-muted-foreground">
            No transactions yet.
          </p>
          <p className="text-xs text-muted-foreground">
            Tap <span className="font-medium text-foreground">Receive</span> to get started.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {recent.map((tx) => (
            <TransactionRow
              key={tx.id}
              tx={tx}
              onCheckSpent={onCheckTokenSpent}
              onReclaimToken={onReclaimToken}
              onShowInvoiceQr={onShowInvoiceQr}
              onDeleteTransaction={onDeleteTransaction}
            />
          ))}
        </div>
      )}
    </div>
  );
};
