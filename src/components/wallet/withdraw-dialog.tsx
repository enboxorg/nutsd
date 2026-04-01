import { useState, useRef } from 'react';
import { Loader2Icon, XIcon, ArrowUpIcon } from 'lucide-react';
import { toastError, toastSuccess, truncateMintUrl, formatAmount } from '@/lib/utils';
import { createMeltQuote, meltTokens } from '@/cashu/wallet-ops';
import type { Mint, StoredProof } from '@/hooks/use-wallet';
import type { Proof } from '@cashu/cashu-ts';
import type { MeltQuoteBolt11Response } from '@/cashu/wallet-ops';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

interface WithdrawDialogProps {
  mints: Mint[];
  mintBalances: Map<string, number>;
  getUnspentProofs: (mintUrl: string) => StoredProof[];
  onClose: () => void;
  onNewProofs: (mintContextId: string, proofs: Proof[]) => Promise<void>;
  /** Delete specific proof DWN records by their IDs. */
  onOldProofsSpent: (ids: string[]) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<void>;
}

type Step = 'invoice' | 'confirm' | 'paying' | 'done' | 'error';

export const WithdrawDialog: React.FC<WithdrawDialogProps> = ({
  mints,
  mintBalances,
  getUnspentProofs,
  onClose,
  onNewProofs,
  onOldProofsSpent,
  onTransactionCreated,
}) => {
  const [selectedMint, setSelectedMint] = useState<Mint | null>(mints[0] ?? null);
  const [invoice, setInvoice] = useState('');
  const [step, setStep] = useState<Step>('invoice');
  const [quoteAmount, setQuoteAmount] = useState(0);
  const [quoteFee, setQuoteFee] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const quoteRef = useRef<MeltQuoteBolt11Response | null>(null);
  const [loading, setLoading] = useState(false);
  const busyRef = useRef(false);

  const balance = selectedMint ? (mintBalances.get(selectedMint.url) ?? 0) : 0;

  const handleGetQuote = async () => {
    if (!selectedMint || !invoice.trim() || busyRef.current) return;

    busyRef.current = true;
    setLoading(true);
    try {
      const quote = await createMeltQuote(selectedMint.url, invoice.trim(), selectedMint.unit);
      quoteRef.current = quote;
      setQuoteAmount(quote.amount);
      setQuoteFee(quote.fee_reserve);
      setStep('confirm');
    } catch (err) {
      toastError('Failed to get quote', err);
    } finally {
      setLoading(false);
      busyRef.current = false;
    }
  };

  const handleMelt = async () => {
    if (!selectedMint || !quoteRef.current || busyRef.current) return;

    const totalNeeded = quoteAmount + quoteFee;
    if (totalNeeded > balance) {
      toastError('Insufficient balance', new Error(`Need ${totalNeeded} but have ${balance}`));
      return;
    }

    busyRef.current = true;
    setLoading(true);
    setStep('paying');
    try {
      // Snapshot proofs and their DWN IDs before the mint call
      const storedProofs = getUnspentProofs(selectedMint.url);
      const spentIds = storedProofs.map(p => p.id);
      const cashuProofs: Proof[] = storedProofs.map(p => ({
        amount: p.amount, id: p.keysetId, secret: p.secret, C: p.C,
      }));

      const { paid, change } = await meltTokens(
        selectedMint.url, quoteRef.current, cashuProofs, selectedMint.unit,
      );

      if (paid) {
        // STORE-BEFORE-DELETE: persist change proofs first
        if (change.length > 0) {
          await onNewProofs(selectedMint.contextId, change);
        }
        await onOldProofsSpent(spentIds);

        await onTransactionCreated({
          type: 'melt',
          amount: quoteAmount,
          unit: selectedMint.unit,
          mintUrl: selectedMint.url,
          status: 'completed',
          lightningInvoice: invoice.trim(),
        });

        setStep('done');
        toastSuccess('Withdrawal complete');
      } else {
        // Payment not completed. Proofs may be PENDING at the mint.
        // Do NOT delete them — they might still be spent if the
        // Lightning payment settles later.
        setErrorMsg(
          'The Lightning payment was not completed. Your proofs may be temporarily locked by the mint. ' +
          'Try checking your balance again in a few minutes.',
        );
        setStep('error');
      }
    } catch (err) {
      // On error, proofs were submitted but we don't know their state.
      // Leave them in DWN — user can check with NUT-07 later.
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    } finally {
      setLoading(false);
      busyRef.current = false;
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border p-6 rounded-xl shadow-xl max-w-sm w-full space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowUpIcon className="h-5 w-5 text-[var(--color-warning)]" />
            <h3 className="text-lg font-semibold">Withdraw</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {step === 'invoice' && (
          <div className="space-y-4">
            {mints.length > 1 && (
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Mint</label>
                <select
                  value={selectedMint?.url ?? ''}
                  onChange={(e) => setSelectedMint(mints.find(m => m.url === e.target.value) ?? null)}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
                >
                  {mints.map(m => (
                    <option key={m.url} value={m.url}>
                      {m.name || truncateMintUrl(m.url)} ({formatAmount(mintBalances.get(m.url) ?? 0, m.unit)})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Lightning Invoice</label>
              <textarea
                value={invoice}
                onChange={(e) => setInvoice(e.target.value)}
                placeholder="lnbc..."
                rows={3}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                autoFocus
              />
            </div>

            <button
              onClick={handleGetQuote}
              disabled={!invoice.trim() || loading}
              className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading && <Loader2Icon className="h-3 w-3 animate-spin" />}
              Get Quote
            </button>
          </div>
        )}

        {step === 'confirm' && (
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-background border border-border space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Amount</span>
                <span className="amount-display font-medium">{formatAmount(quoteAmount)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Fee reserve</span>
                <span className="amount-display font-medium">{formatAmount(quoteFee)}</span>
              </div>
              <div className="border-t border-border pt-2 flex justify-between text-sm font-semibold">
                <span>Total</span>
                <span className="amount-display">{formatAmount(quoteAmount + quoteFee)}</span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setStep('invoice')}
                className="flex-1 px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleMelt}
                disabled={loading}
                className="flex-1 px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                Confirm
              </button>
            </div>
          </div>
        )}

        {step === 'paying' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Paying Lightning invoice...</p>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <div className="text-4xl text-[var(--color-success)]">&#x2713;</div>
            <p className="text-sm font-medium text-[var(--color-success)]">Withdrawal complete!</p>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          </div>
        )}

        {step === 'error' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <div className="text-4xl text-destructive">!</div>
            <p className="text-sm font-medium text-destructive">Withdrawal issue</p>
            <p className="text-xs text-muted-foreground text-center">{errorMsg}</p>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
