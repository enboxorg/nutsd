import { useState, useRef } from 'react';
import { Loader2Icon, XIcon, SendIcon, CopyIcon, CheckIcon } from 'lucide-react';
import { QRCodeDisplay } from '@/components/qr-code';
import { toastError, toastSuccess, truncateMintUrl, formatAmount } from '@/lib/utils';
import { swapProofs, estimateInputFee } from '@/cashu/wallet-ops';
import { encodeToken } from '@/cashu/token-utils';
import { acquireWalletLock } from '@/lib/wallet-mutex';
import { DialogWrapper } from '@/components/ui/dialog-wrapper';
import type { Mint, StoredProof } from '@/hooks/use-wallet';
import type { Proof } from '@cashu/cashu-ts';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

interface SendDialogProps {
  mints: Mint[];
  mintBalances: Map<string, number>;
  getUnspentProofs: (mintUrl: string) => StoredProof[];
  /** Map of keyset ID -> inputFeePpk for fee estimates. */
  keysetFeeMap: Map<string, number>;
  /** Max fee rate (ppk) per mint URL. */
  mintFeePpk: Map<string, number>;
  onClose: () => void;
  onNewProofs: (mintContextId: string, proofs: Proof[]) => Promise<void>;
  /** Delete specific proof DWN records by their IDs. */
  onOldProofsSpent: (ids: string[]) => Promise<void>;
  /** Mark proofs as pending in DWN before sending to mint. */
  onMarkPending: (ids: string[]) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}

type Step = 'amount' | 'token';

export const SendDialog: React.FC<SendDialogProps> = ({
  mints,
  mintBalances,
  getUnspentProofs,
  keysetFeeMap,
  mintFeePpk,
  onClose,
  onNewProofs,
  onOldProofsSpent,
  onMarkPending,
  onTransactionCreated,
}) => {
  const [selectedMint, setSelectedMint] = useState<Mint | null>(mints[0] ?? null);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>('amount');
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const busyRef = useRef(false);

  const balance = selectedMint ? (mintBalances.get(selectedMint.url) ?? 0) : 0;
  const feePpk = selectedMint ? (mintFeePpk.get(selectedMint.url) ?? 0) : 0;

  /** Estimate input fee for the current amount. */
  const estimatedFee = (() => {
    if (!selectedMint || !amount || feePpk <= 0) return 0;
    const storedProofs = getUnspentProofs(selectedMint.url);
    const cashuProofs: Proof[] = storedProofs.map(p => ({
      amount: p.amount, id: p.keysetId, secret: p.secret, C: p.C,
    }));
    return estimateInputFee(cashuProofs, keysetFeeMap);
  })();

  const handleSend = async () => {
    if (!selectedMint || !amount || busyRef.current) return;
    const amountNum = parseInt(amount, 10);
    if (isNaN(amountNum) || amountNum <= 0 || amountNum + estimatedFee > balance) return;

    busyRef.current = true;
    setLoading(true);
    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = await acquireWalletLock('send');
    } catch (err) {
      console.warn('[nutsd] Wallet lock acquisition failed for send:', err);
      toastError('Wallet busy', new Error('Another wallet operation is in progress. Please wait.'));
      setLoading(false);
      busyRef.current = false;
      return;
    }
    try {
      // Snapshot the proofs we'll use and their DWN record IDs
      const storedProofs = getUnspentProofs(selectedMint.url);
      const spentIds = storedProofs.map(p => p.id);
      const cashuProofs: Proof[] = storedProofs.map(p => ({
        amount: p.amount, id: p.keysetId, secret: p.secret, C: p.C,
        ...(p.dleq ? { dleq: p.dleq } : {}),
        ...(p.witness ? { witness: p.witness } : {}),
      }));

      // CRASH SAFETY: Mark proofs as pending in the DWN BEFORE sending to the mint.
      await onMarkPending(spentIds);

      // wallet.send() internally selects the optimal subset and returns:
      //   send: proofs totalling amountNum (to give to recipient)
      //   keep: change proofs (to store back)
      // includeFees: true ensures input fees are accounted for
      const { send, keep } = await swapProofs(
        selectedMint.url, cashuProofs, amountNum, selectedMint.unit,
        { includeFees: true },
      );

      const encodedToken = encodeToken(selectedMint.url, send, selectedMint.unit);
      setToken(encodedToken);

      // STORE-BEFORE-DELETE: persist change proofs first, then remove old ones.
      // If this crashes after step 1 but before step 2, we have duplicates
      // (harmless, detectable via NUT-07) rather than lost funds.
      if (keep.length > 0) {
        await onNewProofs(selectedMint.contextId, keep);
      }
      await onOldProofsSpent(spentIds);

      // Record transaction in DWN -- cashuToken is encrypted at the DWN layer
      // (encryptionRequired: true on the transaction type). Cleared once spent.
      await onTransactionCreated({
        type: 'send',
        amount: amountNum,
        unit: selectedMint.unit,
        mintUrl: selectedMint.url,
        status: 'completed',
        cashuToken: encodedToken,
      });

      setStep('token');
    } catch (err) {
      // On error, proofs are pending. reconcilePendingProofs() handles recovery.
      toastError('Failed to create token', err);
    } finally {
      releaseLock?.();
      setLoading(false);
      busyRef.current = false;
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      toastSuccess('Token copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('[nutsd] Clipboard write failed:', err);
      toastError('Copy failed', new Error('Clipboard access denied'));
    }
  };

  return (
    <DialogWrapper open={true} onClose={onClose} preventClose={loading}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SendIcon className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold">Send</h3>
          </div>
          {!loading && (
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        {step === 'amount' && (
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
              <div className="flex justify-between items-center">
                <label className="text-xs text-muted-foreground">Amount (sats)</label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Balance: {formatAmount(balance, selectedMint?.unit)}</span>
                  <button
                    onClick={() => setAmount(String(Math.max(0, balance - estimatedFee)))}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground"
                  >
                    Max
                  </button>
                </div>
              </div>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="100"
                min="1"
                max={balance}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoFocus
              />
            </div>

            {/* Fee estimate */}
            {amount && estimatedFee > 0 && (
              <div className="p-2 rounded-lg bg-background border border-border space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Send amount</span>
                  <span className="font-mono">{formatAmount(parseInt(amount) || 0)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Input fee (NUT-02)</span>
                  <span className="font-mono">{formatAmount(estimatedFee)}</span>
                </div>
                <div className="border-t border-border pt-1 flex justify-between text-xs font-medium">
                  <span>Total cost</span>
                  <span className="font-mono">{formatAmount((parseInt(amount) || 0) + estimatedFee)}</span>
                </div>
              </div>
            )}

            <button
              onClick={handleSend}
              disabled={!amount || loading || (parseInt(amount) || 0) + estimatedFee > balance}
              className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading && <Loader2Icon className="h-3 w-3 animate-spin" />}
              Create Token
            </button>
          </div>
        )}

        {step === 'token' && (
          <div className="space-y-4">
            <div className="flex justify-center">
              <QRCodeDisplay value={token} size={180} />
            </div>
            <p className="text-sm font-semibold text-center">{formatAmount(parseInt(amount), selectedMint?.unit)}</p>
            <p className="text-xs text-muted-foreground">
              Share this Cashu token with the recipient:
            </p>
            <div className="p-3 rounded-lg bg-background border border-border max-h-32 overflow-y-auto">
              <div className="token-string text-muted-foreground">
                {token}
              </div>
            </div>
            <button
              onClick={handleCopy}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
            >
              {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy Token'}
            </button>
            <button
              onClick={onClose}
              className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </DialogWrapper>
  );
};
