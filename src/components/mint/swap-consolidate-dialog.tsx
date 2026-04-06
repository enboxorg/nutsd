import { useState } from 'react';
import { Loader2Icon, XIcon, BarChart3Icon, ArrowRightIcon } from 'lucide-react';
import { toastError, toastSuccess, formatAmount } from '@/lib/utils';
import { acquireWalletLock } from '@/lib/wallet-mutex';
import { analyzeProofs, type ProofAnalysis } from '@/cashu/proof-utils';
import { swapProofs } from '@/cashu/wallet-ops';
import type { Mint, StoredProof } from '@/hooks/use-wallet';
import type { Proof } from '@cashu/cashu-ts';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

interface SwapConsolidateDialogProps {
  mint: Mint;
  getUnspentProofs: (mintUrl: string) => StoredProof[];
  onClose: () => void;
  onNewProofs: (mintContextId: string, proofs: Proof[]) => Promise<void>;
  onOldProofsSpent: (ids: string[]) => Promise<void>;
  onMarkPending: (ids: string[]) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}

export const SwapConsolidateDialog: React.FC<SwapConsolidateDialogProps> = ({
  mint,
  getUnspentProofs,
  onClose,
  onNewProofs,
  onOldProofsSpent,
  onMarkPending,
  onTransactionCreated,
}) => {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [newAnalysis, setNewAnalysis] = useState<ProofAnalysis | null>(null);

  const storedProofs = getUnspentProofs(mint.url);
  const cashuProofs: Proof[] = storedProofs.map(p => ({
    amount: p.amount, id: p.keysetId, secret: p.secret, C: p.C,
    ...(p.dleq ? { dleq: p.dleq } : {}),
    ...(p.witness ? { witness: p.witness } : {}),
  }));
  const analysis = analyzeProofs(cashuProofs);

  const handleConsolidate = async () => {
    if (loading || !analysis.canConsolidate) return;
    setLoading(true);
    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = await acquireWalletLock('consolidate');
    } catch (err) {
      console.warn('[nutsd] Wallet lock acquisition failed for consolidate:', err);
      toastError('Wallet busy', new Error('Another wallet operation is in progress. Please wait.'));
      setLoading(false);
      return;
    }
    try {
      const spentIds = storedProofs.map(p => p.id);

      // Mark pending before swap
      await onMarkPending(spentIds);

      // Swap all proofs for the full amount — mint returns optimal denominations
      const totalAmount = analysis.totalValue;
      const { send, keep } = await swapProofs(
        mint.url, cashuProofs, totalAmount, mint.unit,
        { includeFees: true },
      );

      // The "send" proofs represent the consolidated set
      // "keep" will typically be empty or contain fee change
      const allNewProofs = [...send, ...keep];

      // Store new proofs, delete old
      if (allNewProofs.length > 0) {
        await onNewProofs(mint.contextId, allNewProofs);
      }
      await onOldProofsSpent(spentIds);

      // Record the swap transaction
      await onTransactionCreated({
        type    : 'swap',
        amount  : totalAmount,
        unit    : mint.unit,
        mintUrl : mint.url,
        status  : 'completed',
        memo    : `Consolidated ${analysis.proofCount} proofs to ${allNewProofs.length}`,
      });

      setNewAnalysis(analyzeProofs(allNewProofs));
      setDone(true);
      toastSuccess('Proofs consolidated', `${analysis.proofCount} → ${allNewProofs.length} proofs`);
    } catch (err) {
      toastError('Consolidation failed', err);
    } finally {
      releaseLock?.();
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border p-6 rounded-xl shadow-xl max-w-sm w-full space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3Icon className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold">Proof Management</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Current state */}
        <div className="p-3 rounded-lg bg-background border border-border space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Total balance</span>
            <span className="amount-display font-medium">{formatAmount(analysis.totalValue, mint.unit)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Proof count</span>
            <span className="font-medium">{analysis.proofCount}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Denominations</span>
            <span className="font-medium">{analysis.distinctDenominations}</span>
          </div>
        </div>

        {/* Denomination breakdown */}
        {analysis.denominations.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground font-medium">Breakdown</div>
            <div className="grid grid-cols-3 gap-1.5">
              {analysis.denominations.map(d => (
                <div key={d.value} className="px-2 py-1.5 rounded-md bg-muted text-center">
                  <div className="text-xs font-medium">{d.value}</div>
                  <div className="text-[10px] text-muted-foreground">&times;{d.count}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Consolidation section */}
        {!done && analysis.canConsolidate && (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
              <span>{analysis.proofCount} proofs</span>
              <ArrowRightIcon className="h-4 w-4 text-primary" />
              <span className="text-foreground font-medium">{analysis.estimatedConsolidatedCount} proofs</span>
            </div>
            <button
              onClick={handleConsolidate}
              disabled={loading}
              className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading && <Loader2Icon className="h-3 w-3 animate-spin" />}
              Consolidate Proofs
            </button>
            <p className="text-[10px] text-muted-foreground text-center">
              Swaps all proofs for optimal denominations. A small input fee may apply.
            </p>
          </div>
        )}

        {!done && !analysis.canConsolidate && analysis.proofCount > 0 && (
          <div className="text-center py-2">
            <p className="text-xs text-muted-foreground">
              Proofs are already at optimal denominations.
            </p>
          </div>
        )}

        {done && newAnalysis && (
          <div className="flex flex-col items-center py-4 gap-3">
            <div className="text-4xl text-[var(--color-success)]">&#x2713;</div>
            <p className="text-sm font-medium text-[var(--color-success)]">
              Consolidated to {newAnalysis.proofCount} proofs
            </p>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
