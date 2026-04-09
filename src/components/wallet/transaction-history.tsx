import { useState, useMemo } from 'react';
import { XIcon, SearchIcon, FilterIcon } from 'lucide-react';
import { truncateMintUrl } from '@/lib/utils';
import { TransactionRow } from '@/components/wallet/transaction-list-card';
import type { Transaction, Mint } from '@/hooks/use-wallet';

interface TransactionHistoryProps {
  transactions: Transaction[];
  mints: Mint[];
  onClose: () => void;
  onCheckTokenSpent?: (tx: Transaction) => Promise<boolean | null>;
  onReclaimToken?: (tx: Transaction) => Promise<void>;
  onShowInvoiceQr?: (tx: Transaction) => void;
  onDeleteTransaction?: (tx: Transaction) => Promise<void>;
}

const PAGE_SIZE = 25;

const TYPE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'mint', label: 'Deposits' },
  { value: 'melt', label: 'Withdrawals' },
  { value: 'send', label: 'Sent' },
  { value: 'receive', label: 'Received' },
];

export const TransactionHistory: React.FC<TransactionHistoryProps> = ({
  transactions,
  mints,
  onClose,
  onCheckTokenSpent,
  onReclaimToken,
  onShowInvoiceQr,
  onDeleteTransaction,
}) => {
  const [typeFilter, setTypeFilter] = useState('all');
  const [mintFilter, setMintFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    let result = transactions;

    if (typeFilter !== 'all') {
      result = result.filter(tx => tx.type === typeFilter);
    }
    if (mintFilter !== 'all') {
      result = result.filter(tx => tx.mintUrl === mintFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(tx =>
        (tx.memo && tx.memo.toLowerCase().includes(q)) ||
        String(tx.amount).includes(q) ||
        tx.mintUrl.toLowerCase().includes(q),
      );
    }

    return result;
  }, [transactions, typeFilter, mintFilter, search]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Transaction History</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="h-5 w-5" />
          </button>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-4 space-y-3">
        {/* Search */}
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by memo or amount..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-background border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        {/* Filters */}
        <div className="flex gap-2 overflow-x-auto">
          <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <FilterIcon className="h-3 w-3" />
          </div>
          {TYPE_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => { setTypeFilter(f.value); setPage(0); }}
              className={`px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                typeFilter === f.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label}
            </button>
          ))}
          {mints.length > 1 && (
            <select
              value={mintFilter}
              onChange={(e) => { setMintFilter(e.target.value); setPage(0); }}
              className="px-2.5 py-1 rounded-full text-xs bg-muted border-none text-muted-foreground"
            >
              <option value="all">All mints</option>
              {mints.map(m => (
                <option key={m.url} value={m.url}>{m.name || truncateMintUrl(m.url)}</option>
              ))}
            </select>
          )}
        </div>

        {/* Results count */}
        <p className="text-xs text-muted-foreground">
          {filtered.length} transaction{filtered.length !== 1 ? 's' : ''}
          {typeFilter !== 'all' || mintFilter !== 'all' || search ? ' (filtered)' : ''}
        </p>

        {/* Transaction list */}
        <div className="rounded-xl bg-card border border-border overflow-hidden divide-y divide-border">
          {pageItems.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No transactions match your filters.
            </div>
          ) : pageItems.map(tx => (
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

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-muted disabled:opacity-50 transition-colors"
            >
              Previous
            </button>
            <span className="text-xs text-muted-foreground">
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-muted disabled:opacity-50 transition-colors"
            >
              Next
            </button>
          </div>
        )}
      </main>
    </div>
  );
};
