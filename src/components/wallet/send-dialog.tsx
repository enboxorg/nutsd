import { useState, useRef } from 'react';
import { Loader2Icon, XIcon, SendIcon, CopyIcon, CheckIcon } from 'lucide-react';
import { toastError, toastSuccess, truncateMintUrl, formatAmount } from '@/lib/utils';
import { swapProofs } from '@/cashu/wallet-ops';
import { encodeToken } from '@/cashu/token-utils';
import type { Mint, StoredProof } from '@/hooks/use-wallet';
import type { Proof } from '@cashu/cashu-ts';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

interface SendDialogProps {
  mints: Mint[];
  mintBalances: Map<string, number>;
  getUnspentProofs: (mintUrl: string) => StoredProof[];
  onClose: () => void;
  onNewProofs: (mintContextId: string, proofs: Proof[]) => Promise<void>;
  /** Delete specific proof DWN records by their IDs. */
  onOldProofsSpent: (ids: string[]) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}

type Step = 'amount' | 'token';

export const SendDialog: React.FC<SendDialogProps> = ({
  mints,
  mintBalances,
  getUnspentProofs,
  onClose,
  onNewProofs,
  onOldProofsSpent,
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

  const handleSend = async () => {
    if (!selectedMint || !amount || busyRef.current) return;
    const amountNum = parseInt(amount, 10);
    if (isNaN(amountNum) || amountNum <= 0 || amountNum > balance) return;

    busyRef.current = true;
    setLoading(true);
    try {
      // Snapshot the proofs we'll use and their DWN record IDs
      const storedProofs = getUnspentProofs(selectedMint.url);
      const spentIds = storedProofs.map(p => p.id);
      const cashuProofs: Proof[] = storedProofs.map(p => ({
        amount: p.amount, id: p.keysetId, secret: p.secret, C: p.C,
        ...(p.dleq ? { dleq: p.dleq } : {}),
        ...(p.witness ? { witness: p.witness } : {}),
      }));

      // wallet.send() internally selects the optimal subset and returns:
      //   send: proofs totalling amountNum (to give to recipient)
      //   keep: change proofs (to store back)
      const { send, keep } = await swapProofs(
        selectedMint.url, cashuProofs, amountNum, selectedMint.unit,
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
      toastError('Failed to create token', err);
    } finally {
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
    } catch {
      toastError('Copy failed', new Error('Clipboard access denied'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border p-6 rounded-xl shadow-xl max-w-sm w-full space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SendIcon className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold">Send</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="h-4 w-4" />
          </button>
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
                placeholder="100"
                min="1"
                max={balance}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoFocus
              />
            </div>

            <button
              onClick={handleSend}
              disabled={!amount || loading || parseInt(amount) > balance}
              className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading && <Loader2Icon className="h-3 w-3 animate-spin" />}
              Create Token
            </button>
          </div>
        )}

        {step === 'token' && (
          <div className="space-y-4">
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
    </div>
  );
};
