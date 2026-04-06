import { useState, useRef } from 'react';
import { Loader2Icon, XIcon, ZapIcon, UserIcon } from 'lucide-react';
import { toastError, toastSuccess, truncateMintUrl, formatAmount } from '@/lib/utils';
import { acquireWalletLock, isUnloading } from '@/lib/wallet-mutex';
import {
  resolveLightningAddress,
  resolveLnurl,
  requestLnurlInvoice,
  msatToSats,
  satsToMsat,
  type LnurlPayResponse,
} from '@/lib/lnurl';
import { createMeltQuote, meltTokens, estimateInputFee } from '@/cashu/wallet-ops';
import type { Mint, StoredProof } from '@/hooks/use-wallet';
import type { Proof } from '@cashu/cashu-ts';
import type { MeltQuoteBolt11Response } from '@/cashu/wallet-ops';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

interface LnurlWithdrawDialogProps {
  /** The Lightning address or LNURL to pay. */
  target: string;
  /** 'lightning-address' or 'lnurl'. */
  targetType: 'lightning-address' | 'lnurl';
  mints: Mint[];
  mintBalances: Map<string, number>;
  getUnspentProofs: (mintUrl: string) => StoredProof[];
  keysetFeeMap: Map<string, number>;
  onClose: () => void;
  onNewProofs: (mintContextId: string, proofs: Proof[]) => Promise<void>;
  onOldProofsSpent: (ids: string[]) => Promise<void>;
  onMarkPending: (ids: string[]) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}

type Step = 'resolving' | 'amount' | 'confirm' | 'paying' | 'done' | 'error';

export const LnurlWithdrawDialog: React.FC<LnurlWithdrawDialogProps> = ({
  target,
  targetType,
  mints,
  mintBalances,
  getUnspentProofs,
  keysetFeeMap,
  onClose,
  onNewProofs,
  onOldProofsSpent,
  onMarkPending,
  onTransactionCreated,
}) => {
  const [step, setStep] = useState<Step>('resolving');
  const [payInfo, setPayInfo] = useState<LnurlPayResponse | null>(null);
  const [selectedMint, setSelectedMint] = useState<Mint | null>(mints[0] ?? null);
  const [amount, setAmount] = useState('');
  const [quoteAmount, setQuoteAmount] = useState(0);
  const [quoteFee, setQuoteFee] = useState(0);
  const [inputFee, setInputFee] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const quoteRef = useRef<MeltQuoteBolt11Response | null>(null);
  const invoiceRef = useRef<string>('');
  const busyRef = useRef(false);

  const balance = selectedMint ? (mintBalances.get(selectedMint.url) ?? 0) : 0;
  const minSats = payInfo ? msatToSats(payInfo.minSendable) : 1;
  const maxSats = payInfo ? msatToSats(payInfo.maxSendable) : Infinity;

  // --- Resolve on mount ---
  useState(() => {
    (async () => {
      try {
        const info = targetType === 'lightning-address'
          ? await resolveLightningAddress(target)
          : await resolveLnurl(target);
        setPayInfo(info);
        setStep('amount');
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to resolve address');
        setStep('error');
      }
    })();
  });

  const handleGetInvoice = async () => {
    if (!selectedMint || !amount || !payInfo || busyRef.current) return;
    const amountNum = parseInt(amount, 10);
    if (isNaN(amountNum) || amountNum < minSats || amountNum > maxSats) return;

    busyRef.current = true;
    setLoading(true);
    try {
      // Step 1: Request invoice from LNURL endpoint
      const invoice = await requestLnurlInvoice(payInfo.callback, satsToMsat(amountNum));
      invoiceRef.current = invoice;

      // Step 2: Get melt quote from mint
      const quote = await createMeltQuote(selectedMint.url, invoice, selectedMint.unit);
      quoteRef.current = quote;
      setQuoteAmount(quote.amount);
      setQuoteFee(quote.fee_reserve);

      // Estimate input fee
      const storedProofs = getUnspentProofs(selectedMint.url);
      const cashuProofs: Proof[] = storedProofs.map(p => ({
        amount: p.amount, id: p.keysetId, secret: p.secret, C: p.C,
      }));
      setInputFee(estimateInputFee(cashuProofs, keysetFeeMap));

      setStep('confirm');
    } catch (err) {
      toastError('Failed to get invoice', err);
    } finally {
      setLoading(false);
      busyRef.current = false;
    }
  };

  const handlePay = async () => {
    if (!selectedMint || !quoteRef.current || busyRef.current) return;

    busyRef.current = true;
    setLoading(true);
    setStep('paying');
    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = await acquireWalletLock('lnurl-melt');
    } catch {
      toastError('Wallet busy', new Error('Another wallet operation is in progress. Please wait.'));
      setStep('confirm');
      setLoading(false);
      busyRef.current = false;
      return;
    }
    try {
      const storedProofs = getUnspentProofs(selectedMint.url);
      const spentIds = storedProofs.map(p => p.id);
      const cashuProofs: Proof[] = storedProofs.map(p => ({
        amount: p.amount, id: p.keysetId, secret: p.secret, C: p.C,
        ...(p.dleq ? { dleq: p.dleq } : {}),
        ...(p.witness ? { witness: p.witness } : {}),
      }));

      await onMarkPending(spentIds);

      const { paid, change } = await meltTokens(
        selectedMint.url, quoteRef.current, cashuProofs, selectedMint.unit,
      );

      if (paid) {
        if (change.length > 0) await onNewProofs(selectedMint.contextId, change);
        await onOldProofsSpent(spentIds);

        await onTransactionCreated({
          type: 'melt',
          amount: quoteAmount,
          unit: selectedMint.unit,
          mintUrl: selectedMint.url,
          status: 'completed',
          memo: `Paid ${target}`,
        });

        setStep('done');
        toastSuccess(`Paid ${target}`, `${formatAmount(quoteAmount)}`);
      } else {
        setErrorMsg('Payment was not completed. Proofs will be checked on next startup.');
        setStep('error');
      }
    } catch (err) {
      if (isUnloading()) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    } finally {
      releaseLock?.();
      setLoading(false);
      busyRef.current = false;
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border p-6 rounded-xl shadow-xl max-w-sm w-full space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ZapIcon className="h-5 w-5 text-[var(--color-warning)]" />
            <h3 className="text-lg font-semibold">Pay</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {step === 'resolving' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Resolving {target}...</p>
          </div>
        )}

        {step === 'amount' && payInfo && (
          <div className="space-y-4">
            {/* Payee info */}
            <div className="flex items-center gap-3 p-3 rounded-lg bg-background border border-border">
              <div className="p-2 rounded-full bg-muted">
                <UserIcon className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {payInfo.displayName || target}
                </p>
                {payInfo.description && (
                  <p className="text-xs text-muted-foreground truncate">{payInfo.description}</p>
                )}
                <p className="text-[10px] text-muted-foreground">
                  {formatAmount(minSats)} – {formatAmount(maxSats)}
                </p>
              </div>
            </div>

            {mints.length > 1 && (
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Pay from</label>
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
              <div className="flex justify-between">
                <label className="text-xs text-muted-foreground">Amount (sats)</label>
                <span className="text-xs text-muted-foreground">
                  Balance: {formatAmount(balance, selectedMint?.unit)}
                </span>
              </div>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={String(minSats)}
                min={minSats}
                max={Math.min(maxSats, balance)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoFocus
              />
            </div>

            <button
              onClick={handleGetInvoice}
              disabled={!amount || loading || parseInt(amount) < minSats || parseInt(amount) > maxSats}
              className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading && <Loader2Icon className="h-3 w-3 animate-spin" />}
              Get Invoice
            </button>
          </div>
        )}

        {step === 'confirm' && (
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-background border border-border space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">To</span>
                <span className="font-medium truncate ml-2">{target}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Amount</span>
                <span className="amount-display font-medium">{formatAmount(quoteAmount)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Lightning fee</span>
                <span className="amount-display font-medium">{formatAmount(quoteFee)}</span>
              </div>
              {inputFee > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Input fee</span>
                  <span className="amount-display font-medium">{formatAmount(inputFee)}</span>
                </div>
              )}
              <div className="border-t border-border pt-2 flex justify-between text-sm font-semibold">
                <span>Total</span>
                <span className="amount-display">{formatAmount(quoteAmount + quoteFee + inputFee)}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setStep('amount')} className="flex-1 px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted transition-colors">Back</button>
              <button onClick={handlePay} disabled={loading} className="flex-1 px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">Confirm</button>
            </div>
          </div>
        )}

        {step === 'paying' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Paying {target}...</p>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <div className="text-4xl text-[var(--color-success)]">&#x2713;</div>
            <p className="text-sm font-medium text-[var(--color-success)]">Payment sent!</p>
            <button onClick={onClose} className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity">Done</button>
          </div>
        )}

        {step === 'error' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <div className="text-4xl text-destructive">!</div>
            <p className="text-sm font-medium text-destructive">Payment issue</p>
            <p className="text-xs text-muted-foreground text-center">{errorMsg}</p>
            <button onClick={onClose} className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity">Close</button>
          </div>
        )}
      </div>
    </div>
  );
};
