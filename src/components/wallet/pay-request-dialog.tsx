import { useState, useRef } from 'react';
import { Loader2Icon, XIcon, FileTextIcon, CopyIcon, CheckIcon } from 'lucide-react';
import { toastError, toastSuccess, formatAmount, truncateMintUrl } from '@/lib/utils';
import { swapProofs } from '@/cashu/wallet-ops';
import { encodeToken } from '@/cashu/token-utils';
import { decodePaymentRequest, type PaymentRequest } from '@/cashu/payment-request';
import { acquireWalletLock } from '@/lib/wallet-mutex';
import { DialogWrapper } from '@/components/ui/dialog-wrapper';
import type { Mint, StoredProof } from '@/hooks/use-wallet';
import type { Proof } from '@cashu/cashu-ts';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

interface PayRequestDialogProps {
  encodedRequest: string;
  mints: Mint[];
  /** Balances keyed by mint contextId (not URL) for multi-unit correctness. */
  mintBalancesByContext: Map<string, number>;
  /** Get unspent proofs by mint contextId (not URL) for multi-unit correctness. */
  getUnspentProofsByContext: (mintContextId: string) => StoredProof[];
  onClose: () => void;
  onNewProofs: (mintContextId: string, proofs: Proof[]) => Promise<void>;
  onOldProofsSpent: (ids: string[]) => Promise<void>;
  onMarkPending: (ids: string[]) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}

type Step = 'confirm' | 'sending' | 'done' | 'error';

export const PayRequestDialog: React.FC<PayRequestDialogProps> = ({
  encodedRequest, mints, mintBalancesByContext, getUnspentProofsByContext,
  onClose, onNewProofs, onOldProofsSpent, onMarkPending, onTransactionCreated,
}) => {
  const [step, setStep] = useState<Step>('confirm');
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const busyRef = useRef(false);

  let request: PaymentRequest;
  try {
    request = decodePaymentRequest(encodedRequest);
  } catch (err) {
    console.warn('[nutsd] Payment request decode failed:', err);
    return (
      <DialogWrapper open={true} onClose={onClose}>
        <div className="space-y-4">
          <p className="text-sm text-destructive">Invalid payment request</p>
          <button onClick={onClose} className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm">Close</button>
        </div>
      </DialogWrapper>
    );
  }

  // Find a mint that matches the request's accepted mints AND unit.
  // A single mint URL can appear multiple times with different units.
  // Do NOT fall back to a mint with the wrong unit — that would create
  // a token in the wrong denomination.
  const requestUnit = request.unit ?? 'sat';
  const matchingMint = request.mints?.length
    // Request specifies accepted mints: match by URL + unit. No fallback.
    ? mints.find(m => request.mints!.includes(m.url) && m.unit === requestUnit)
    // No mint restriction: match by unit only.
    : mints.find(m => m.unit === requestUnit);

  const [customAmount, setCustomAmount] = useState('');
  const isOpenAmount = !request.amount || request.amount <= 0;
  const amount = isOpenAmount ? (parseInt(customAmount) || 0) : (request.amount ?? 0);
  const balance = matchingMint ? (mintBalancesByContext.get(matchingMint.contextId) ?? 0) : 0;

  const handlePay = async () => {
    if (!matchingMint || busyRef.current || amount <= 0) return;
    busyRef.current = true;
    setLoading(true);

    let releaseLock: (() => void) | undefined;
    try { releaseLock = await acquireWalletLock('pay-request'); } catch (err) {
      console.warn('[nutsd] Wallet lock acquisition failed for pay-request:', err);
      toastError('Wallet busy', new Error('Another operation is in progress.'));
      setLoading(false); busyRef.current = false; return;
    }

    try {
      setStep('sending');
      const storedProofs = getUnspentProofsByContext(matchingMint.contextId);
      const spentIds = storedProofs.map(p => p.id);
      const cashuProofs: Proof[] = storedProofs.map(p => ({
        amount: p.amount, id: p.keysetId, secret: p.secret, C: p.C,
        ...(p.dleq ? { dleq: p.dleq } : {}),
        ...(p.witness ? { witness: p.witness } : {}),
      }));

      await onMarkPending(spentIds);
      const { send, keep } = await swapProofs(matchingMint.url, cashuProofs, amount, matchingMint.unit, { includeFees: true });
      const encodedToken = encodeToken(matchingMint.url, send, matchingMint.unit);
      setToken(encodedToken);

      if (keep.length > 0) await onNewProofs(matchingMint.contextId, keep);
      await onOldProofsSpent(spentIds);
      await onTransactionCreated({
        type: 'send', amount, unit: matchingMint.unit, mintUrl: matchingMint.url,
        status: 'completed', cashuToken: encodedToken,
        memo: request.description || `Payment request${request.id ? ` ${request.id}` : ''}`,
      });
      setStep('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    } finally {
      releaseLock?.(); setLoading(false); busyRef.current = false;
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(token);
    setCopied(true);
    toastSuccess('Token copied');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <DialogWrapper open={true} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileTextIcon className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold">Payment Request</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><XIcon className="h-4 w-4" /></button>
        </div>

        {step === 'confirm' && (
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-background border border-border space-y-2">
              {request.description && <p className="text-sm">{request.description}</p>}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-medium">{amount > 0 ? formatAmount(amount, request.unit) : 'Any amount'}</span>
              </div>
              {request.mints && request.mints.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  Accepted mint{request.mints.length > 1 ? 's' : ''}: {request.mints.map(u => truncateMintUrl(u)).join(', ')}
                </div>
              )}
            </div>

            {/* Amount input for open-ended ("any amount") requests */}
            {isOpenAmount && matchingMint && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs text-muted-foreground">Amount ({requestUnit})</label>
                  <span className="text-xs text-muted-foreground">
                    Balance: {formatAmount(balance, matchingMint.unit)}
                  </span>
                </div>
                <input
                  type="number"
                  value={customAmount}
                  onChange={(e) => setCustomAmount(e.target.value)}
                  placeholder="Enter amount"
                  min="1"
                  max={balance}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
                  autoFocus
                />
              </div>
            )}

            {!matchingMint && (
              <p className="text-xs text-destructive">You don&apos;t have a mint that matches this request{requestUnit !== 'sat' ? ` (unit: ${requestUnit})` : ''}.</p>
            )}
            {matchingMint && amount > 0 && amount > balance && (
              <p className="text-xs text-destructive">Insufficient balance at {truncateMintUrl(matchingMint.url)} ({formatAmount(balance, matchingMint.unit)})</p>
            )}

            <button
              onClick={handlePay}
              disabled={!matchingMint || amount <= 0 || amount > balance || loading}
              className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading && <Loader2Icon className="h-3 w-3 animate-spin" />}
              Pay {amount > 0 ? formatAmount(amount, requestUnit) : ''}
            </button>
          </div>
        )}

        {step === 'sending' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Creating payment...</p>
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-4">
            <div className="text-center"><div className="text-4xl text-[var(--color-success)]">&#x2713;</div><p className="text-sm font-medium text-[var(--color-success)]">Payment ready</p></div>
            <p className="text-xs text-muted-foreground text-center">Share this token with the requester:</p>
            <div className="p-3 rounded-lg bg-background border border-border max-h-24 overflow-y-auto"><div className="token-string text-muted-foreground text-[10px]">{token}</div></div>
            <button onClick={handleCopy} className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted">
              {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy Token'}
            </button>
            <button onClick={onClose} className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium">Done</button>
          </div>
        )}

        {step === 'error' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <div className="text-4xl text-destructive">!</div>
            <p className="text-xs text-muted-foreground text-center">{errorMsg}</p>
            <div className="flex gap-2">
              <button
                onClick={() => setStep('confirm')}
                className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted"
              >
                Try Again
              </button>
              <button onClick={onClose} className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm">Close</button>
            </div>
          </div>
        )}
      </div>
    </DialogWrapper>
  );
};
