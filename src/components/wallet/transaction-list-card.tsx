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
} from 'lucide-react';
import { formatAmount, formatDate, truncateMintUrl, toastSuccess, toastError } from '@/lib/utils';
import type { Transaction } from '@/hooks/use-wallet';

interface TransactionListCardProps {
  transactions: Transaction[];
  onViewAll?: () => void;
  onCheckTokenSpent?: (tx: Transaction) => Promise<boolean | null>;
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

function TransactionRow({
  tx,
  onCheckSpent,
}: {
  tx: Transaction;
  onCheckSpent?: (tx: Transaction) => Promise<boolean | null>;
}) {
  const [copied, setCopied] = useState(false);
  const [spentState, setSpentState] = useState<'unknown' | 'checking' | 'pending' | 'spent'>('unknown');

  const Icon = TX_ICONS[tx.type] ?? RefreshCwIcon;
  const label = TX_LABELS[tx.type] ?? tx.type;
  const color = TX_COLORS[tx.type] ?? 'text-muted-foreground';
  const isIncoming = ['mint', 'receive', 'p2p-receive'].includes(tx.type);
  const sign = isIncoming ? '+' : '-';
  const hasCopyableToken = tx.type === 'send' && tx.cashuToken;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!tx.cashuToken) return;
    try {
      await navigator.clipboard.writeText(tx.cashuToken);
      setCopied(true);
      toastSuccess('Token copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
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
    } catch {
      setSpentState('unknown');
    }
  };

  return (
    <div className="flex items-center justify-between px-4 py-3 group">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`p-1.5 rounded-md bg-muted ${color}`}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">{label}</span>
            {/* Spent status badge for sent tokens */}
            {hasCopyableToken && spentState === 'spent' && (
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
          </div>
          <div className="text-xs text-muted-foreground">
            {truncateMintUrl(tx.mintUrl)} &middot; {formatDate(tx.createdAt)}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0 ml-3">
        {/* Action buttons for sent tokens */}
        {hasCopyableToken && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {/* Check spent status */}
            {onCheckSpent && spentState !== 'spent' && (
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
            {/* Copy token */}
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
        <div className={`amount-display text-sm font-medium ${isIncoming ? 'text-[var(--color-success)]' : 'text-foreground'}`}>
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
        <div className="p-4 text-center">
          <p className="text-xs text-muted-foreground">
            No transactions yet. Deposit some sats to get started.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {recent.map((tx) => (
            <TransactionRow
              key={tx.id}
              tx={tx}
              onCheckSpent={onCheckTokenSpent}
            />
          ))}
        </div>
      )}
    </div>
  );
};
