import { useState, useEffect } from 'react';
import {
  ArrowLeftIcon,
  ServerIcon,
  TrashIcon,
  CopyIcon,
  CheckIcon,
  ShieldCheckIcon,
  ZapIcon,
  InfoIcon,
  BarChart3Icon,
  PencilIcon,
} from 'lucide-react';
import { formatAmount, truncateMintUrl, toastSuccess, toastError } from '@/lib/utils';
import { getMintInfo, type MintInfo } from '@/cashu/wallet-ops';
import { SwapConsolidateDialog } from './swap-consolidate-dialog';
import type { Mint, StoredProof } from '@/hooks/use-wallet';
import type { Proof } from '@cashu/cashu-ts';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

interface MintDetailProps {
  mint: Mint;
  balance: number;
  /** Number of unspent proofs at this mint. */
  proofCount?: number;
  onBack: () => void;
  onDelete: (mintId: string) => void;
  /** Update mint metadata (e.g., custom name). */
  onUpdateMint?: (id: string, updates: { name?: string }) => Promise<void>;
  /** Props for swap/consolidation dialog */
  getUnspentProofs?: (mintUrl: string) => StoredProof[];
  onNewProofs?: (mintContextId: string, proofs: Proof[]) => Promise<void>;
  onOldProofsSpent?: (ids: string[]) => Promise<void>;
  onMarkPending?: (ids: string[]) => Promise<void>;
  onTransactionCreated?: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}

/** NUT number → short description. */
const NUT_LABELS: Record<string, string> = {
  '4':  'Minting tokens',
  '5':  'Melting tokens',
  '7':  'Token state check',
  '8':  'Overpaid fees',
  '9':  'Signature restore',
  '10': 'Spending conditions',
  '11': 'Pay-to-Pubkey',
  '12': 'DLEQ proofs',
  '14': 'HTLCs',
  '15': 'Multi-path payments',
  '17': 'WebSocket subscriptions',
  '19': 'Cached responses',
  '20': 'Signed mint quotes',
  '21': 'Clear auth',
  '22': 'Blind auth',
};

export const MintDetail: React.FC<MintDetailProps> = ({
  mint,
  balance,
  proofCount,
  onBack,
  onDelete,
  onUpdateMint,
  getUnspentProofs,
  onNewProofs,
  onOldProofsSpent,
  onMarkPending,
  onTransactionCreated,
}) => {
  const [info, setInfo] = useState<MintInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showSwapDialog, setShowSwapDialog] = useState(false);
  const [mintOnline, setMintOnline] = useState<boolean | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState(mint.name ?? '');

  useEffect(() => {
    let cancelled = false;
    setLoadingInfo(true);
    getMintInfo(mint.url, mint.unit)
      .then((i) => { if (!cancelled) { setInfo(i); setMintOnline(true); } })
      .catch((err) => { if (!cancelled) { setMintOnline(false); console.warn('[nutsd] Mint info fetch failed (using cached):', err); } })
      .finally(() => { if (!cancelled) setLoadingInfo(false); });
    return () => { cancelled = true; };
  }, [mint.url, mint.unit]);

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(mint.url);
      setCopied(true);
      toastSuccess('Mint URL copied');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('[nutsd] Clipboard write failed:', err);
      toastError('Copy failed', new Error('Clipboard access denied'));
    }
  };

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete(mint.id);
    onBack();
  };

  // Collect supported NUTs from the info object
  const supportedNuts: Array<{ num: string; label: string }> = [];
  if (info) {
    const nuts = info.nuts;
    for (const [num, label] of Object.entries(NUT_LABELS)) {
      const nutInfo = (nuts as Record<string, unknown>)?.[num];
      if (nutInfo) {
        // NUT 4 and 5 are always present; others have a 'supported' flag
        if (num === '4' || num === '5') {
          supportedNuts.push({ num, label });
        } else if (typeof nutInfo === 'object' && nutInfo !== null && 'supported' in nutInfo && (nutInfo as { supported: boolean }).supported) {
          supportedNuts.push({ num, label });
        }
      }
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <div className="text-sm font-semibold truncate flex-1 flex items-center gap-2">
            {mint.name || truncateMintUrl(mint.url)}
            {mintOnline !== null && (
              <span
                className={`inline-block h-2 w-2 rounded-full shrink-0 ${mintOnline ? 'bg-[var(--color-success)]' : 'bg-destructive'}`}
                title={mintOnline ? 'Mint is online' : 'Mint is offline'}
              />
            )}
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-4">
        {/* Balance card */}
        <div className="rounded-xl bg-card border border-border p-5 space-y-1">
          <div className="flex items-center gap-2 text-muted-foreground">
            <ServerIcon className="h-4 w-4 text-primary" />
            <span className="text-xs font-medium uppercase tracking-wider">Mint Balance</span>
          </div>
          <div className="amount-display text-3xl font-bold tracking-tight">
            {formatAmount(balance, mint.unit)}
          </div>
          {balance === 0 && (
            <p className="text-xs text-muted-foreground text-center py-2">
              No balance yet. Go back and tap Deposit to add funds via Lightning.
            </p>
          )}
        </div>

        {/* Name editing */}
        {onUpdateMint && (
          <div className="rounded-xl bg-card border border-border p-4 space-y-2">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Custom Name
            </div>
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Enter a name..."
                  className="flex-1 px-3 py-1.5 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  autoFocus
                />
                <button
                  onClick={async () => {
                    await onUpdateMint(mint.id, { name: editName.trim() || undefined });
                    setEditingName(false);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium"
                >
                  Save
                </button>
                <button
                  onClick={() => { setEditName(mint.name ?? ''); setEditingName(false); }}
                  className="px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-sm">{mint.name || <span className="text-muted-foreground italic">No custom name</span>}</span>
                <button
                  onClick={() => setEditingName(true)}
                  className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Mint URL */}
        <div className="rounded-xl bg-card border border-border p-4 space-y-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Mint URL
          </div>
          <div className="flex items-center gap-2">
            <code className="text-xs font-mono text-foreground break-all flex-1">
              {mint.url}
            </code>
            <button
              onClick={handleCopyUrl}
              className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground shrink-0"
            >
              {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {/* Proof management */}
        {getUnspentProofs && proofCount !== undefined && proofCount > 0 && (
          <div className="rounded-xl bg-card border border-border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Proofs</div>
                <div className="text-sm font-medium">{proofCount} proof{proofCount !== 1 ? 's' : ''}</div>
              </div>
              <button
                onClick={() => setShowSwapDialog(true)}
                className="px-3 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-muted transition-colors flex items-center gap-1.5"
              >
                <BarChart3Icon className="h-3 w-3" />
                Manage
              </button>
            </div>
          </div>
        )}

        {/* Mint Info */}
        <div className="rounded-xl bg-card border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <InfoIcon className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Mint Info</h3>
            </div>
          </div>

          {loadingInfo ? (
            <div className="p-4 text-xs text-muted-foreground text-center">Loading...</div>
          ) : info ? (
            <div className="divide-y divide-border">
              {info.name && (
                <div className="px-4 py-2.5 flex justify-between text-sm">
                  <span className="text-muted-foreground">Name</span>
                  <span className="font-medium">{info.name}</span>
                </div>
              )}
              {info.version && (
                <div className="px-4 py-2.5 flex justify-between text-sm">
                  <span className="text-muted-foreground">Version</span>
                  <span className="font-mono text-xs">{info.version}</span>
                </div>
              )}
              {info.description && (
                <div className="px-4 py-2.5 text-sm">
                  <div className="text-muted-foreground mb-1">Description</div>
                  <div className="text-xs">{info.description}</div>
                </div>
              )}
              {info.pubkey && (
                <div className="px-4 py-2.5 text-sm">
                  <div className="text-muted-foreground mb-1">Public Key</div>
                  <code className="text-xs font-mono break-all">{info.pubkey}</code>
                </div>
              )}
              {info.motd && (
                <div className="px-4 py-2.5 text-sm">
                  <div className="text-muted-foreground mb-1">Message of the Day</div>
                  <div className="text-xs italic">{info.motd}</div>
                </div>
              )}
              {info.contact && info.contact.length > 0 && (
                <div className="px-4 py-2.5 text-sm">
                  <div className="text-muted-foreground mb-1">Contact</div>
                  <div className="space-y-1">
                    {info.contact.map((c, i) => (
                      <div key={i} className="text-xs">
                        <span className="text-muted-foreground">{c.method}: </span>
                        <span className="font-mono">{c.info}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 text-xs text-muted-foreground text-center">
              Could not load mint info
            </div>
          )}
        </div>

        {/* Supported NUTs */}
        {supportedNuts.length > 0 && (
          <div className="rounded-xl bg-card border border-border overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <ShieldCheckIcon className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold">Supported Features</h3>
              </div>
            </div>
            <div className="p-3 flex flex-wrap gap-2">
              {supportedNuts.map(({ num, label }) => (
                <div
                  key={num}
                  className="px-2.5 py-1 rounded-full bg-muted text-xs flex items-center gap-1.5"
                >
                  <ZapIcon className="h-3 w-3 text-primary" />
                  <span className="text-muted-foreground">NUT-{num.padStart(2, '0')}</span>
                  <span className="font-medium">{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Danger zone */}
        <div className="rounded-xl bg-card border border-destructive/20 p-4">
          <button
            onClick={handleDelete}
            className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              confirmDelete
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'border border-destructive/30 text-destructive hover:bg-destructive/10'
            }`}
          >
            <TrashIcon className="h-4 w-4" />
            {confirmDelete ? 'Confirm Remove Mint' : 'Remove Mint'}
          </button>
          {confirmDelete && (
            <div className="mt-2 space-y-1">
              {balance > 0 && (
                <p className="text-xs text-destructive font-medium text-center">
                  Warning: This mint has a balance of {formatAmount(balance, mint.unit)}. Removing it will delete all stored proofs.
                </p>
              )}
              <p className="text-xs text-destructive/70 text-center">
                This will remove the mint and all its stored proofs. Click again to confirm.
              </p>
            </div>
          )}
        </div>
      </main>

      {showSwapDialog && getUnspentProofs && onNewProofs && onOldProofsSpent && onMarkPending && onTransactionCreated && (
        <SwapConsolidateDialog
          mint={mint}
          getUnspentProofs={getUnspentProofs}
          onClose={() => setShowSwapDialog(false)}
          onNewProofs={onNewProofs}
          onOldProofsSpent={onOldProofsSpent}
          onMarkPending={onMarkPending}
          onTransactionCreated={onTransactionCreated}
        />
      )}
    </div>
  );
};
