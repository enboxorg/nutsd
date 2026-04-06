import { useState, useRef } from 'react';
import { Loader2Icon, XIcon, UsersIcon, KeyIcon } from 'lucide-react';
import { toastError, toastSuccess, truncateMintUrl, formatAmount } from '@/lib/utils';
import { sendP2pkLocked, isValidP2pkPublicKey } from '@/cashu/p2pk';
import { encodeToken } from '@/cashu/token-utils';
import { acquireWalletLock } from '@/lib/wallet-mutex';
import { CashuTransferProtocol, assertP2PKLocked, type TransferData } from '@/protocol/cashu-transfer-protocol';
import type { Mint, StoredProof } from '@/hooks/use-wallet';
import type { Proof } from '@cashu/cashu-ts';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

interface SendToDIDDialogProps {
  mints: Mint[];
  mintBalances: Map<string, number>;
  getUnspentProofs: (mintUrl: string) => StoredProof[];
  senderDid: string;
  /** Enbox instance for DWN writes. */
  enbox: any;
  onClose: () => void;
  onNewProofs: (mintContextId: string, proofs: Proof[]) => Promise<void>;
  onOldProofsSpent: (ids: string[]) => Promise<void>;
  onMarkPending: (ids: string[]) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}

type Step = 'recipient' | 'amount' | 'sending' | 'done' | 'error';

export const SendToDIDDialog: React.FC<SendToDIDDialogProps> = ({
  mints,
  mintBalances,
  getUnspentProofs,
  senderDid,
  enbox,
  onClose,
  onNewProofs,
  onOldProofsSpent,
  onMarkPending,
  onTransactionCreated,
}) => {
  const [step, setStep] = useState<Step>('recipient');
  const [recipientDid, setRecipientDid] = useState('');
  const [recipientPubkey, setRecipientPubkey] = useState('');
  const [selectedMint, setSelectedMint] = useState<Mint | null>(mints[0] ?? null);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const busyRef = useRef(false);

  const balance = selectedMint ? (mintBalances.get(selectedMint.url) ?? 0) : 0;

  const handleNext = () => {
    if (!recipientPubkey.trim()) {
      toastError('Missing public key', new Error('Enter the recipient\'s P2PK public key'));
      return;
    }
    if (!isValidP2pkPublicKey(recipientPubkey.trim())) {
      toastError('Invalid public key', new Error('Expected a compressed secp256k1 key (02... or 03...)'));
      return;
    }
    setStep('amount');
  };

  const handleSend = async () => {
    if (!selectedMint || !amount || busyRef.current) return;
    const amountNum = parseInt(amount, 10);
    if (isNaN(amountNum) || amountNum <= 0 || amountNum > balance) return;

    busyRef.current = true;
    setLoading(true);
    setStep('sending');
    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = await acquireWalletLock('p2p-send');
    } catch {
      toastError('Wallet busy', new Error('Another wallet operation is in progress. Please wait.'));
      setStep('amount');
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

      // Mark pending
      await onMarkPending(spentIds);

      // Create P2PK-locked proofs
      const { send, keep } = await sendP2pkLocked(
        selectedMint.url, cashuProofs, amountNum, recipientPubkey.trim(), selectedMint.unit,
      );

      const encodedToken = encodeToken(selectedMint.url, send, selectedMint.unit);

      // Validate P2PK enforcement before writing
      const transferData: TransferData = {
        token: encodedToken,
        amount: amountNum,
        unit: selectedMint.unit,
        mintUrl: selectedMint.url,
        memo: memo.trim() || undefined,
        senderDid,
        recipientPubkey: recipientPubkey.trim(),
      };
      assertP2PKLocked(transferData);

      // Store change proofs, delete old
      if (keep.length > 0) await onNewProofs(selectedMint.contextId, keep);
      await onOldProofsSpent(spentIds);

      // Record transaction
      await onTransactionCreated({
        type: 'p2p-send',
        amount: amountNum,
        unit: selectedMint.unit,
        mintUrl: selectedMint.url,
        status: 'completed',
        cashuToken: encodedToken,
        recipientDid: recipientDid.trim() || undefined,
        memo: memo.trim() || undefined,
      });

      // Write transfer record to recipient's DWN
      let dwnWriteSucceeded = false;
      if (recipientDid.trim()) {
        try {
          const transferTyped = enbox.using(CashuTransferProtocol);
          const { record } = await transferTyped.records.create('transfer', {
            data  : transferData,
            store : false, // don't persist locally — sender doesn't need it
          });
          if (record) {
            const { status: sendStatus } = await record.send(recipientDid.trim());
            if (sendStatus.code >= 200 && sendStatus.code < 300) {
              console.log(`[nutsd] Transfer record sent to ${recipientDid.trim()}'s DWN`);
              dwnWriteSucceeded = true;
            } else {
              console.warn(`[nutsd] Transfer send returned status ${sendStatus.code}: ${sendStatus.detail}`);
            }
          }
        } catch (err) {
          // DWN write failure is non-fatal — token is still available in tx history
          console.warn('[nutsd] Failed to write transfer to recipient DWN:', err);
        }
      }

      setStep('done');
      toastSuccess(
        dwnWriteSucceeded ? 'Token sent to recipient\'s DWN' : 'P2PK-locked token created',
        `${formatAmount(amountNum, selectedMint.unit)}`,
      );
    } catch (err) {
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
            <UsersIcon className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold">Send to DID</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {step === 'recipient' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Recipient DID (optional)</label>
              <input
                type="text"
                value={recipientDid}
                onChange={(e) => setRecipientDid(e.target.value)}
                placeholder="did:dht:..."
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs text-muted-foreground flex items-center gap-1">
                <KeyIcon className="h-3 w-3" />
                Recipient P2PK Public Key
              </label>
              <input
                type="text"
                value={recipientPubkey}
                onChange={(e) => setRecipientPubkey(e.target.value)}
                placeholder="02..."
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoFocus
              />
              <p className="text-[10px] text-muted-foreground">
                The token will be locked to this key. Only the holder of the corresponding
                private key can redeem it.
              </p>
            </div>

            <button
              onClick={handleNext}
              disabled={!recipientPubkey.trim()}
              className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        )}

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
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Balance: {formatAmount(balance)}</span>
                  <button
                    onClick={() => {
                      // Conservative max: leave room for input fees (NUT-02).
                      // The exact fee depends on proof count and keyset fee rate,
                      // which we don't have here. Deduct ~1% as a safe margin.
                      const maxAfterFees = Math.max(1, Math.floor(balance * 0.99));
                      setAmount(String(maxAfterFees));
                    }}
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
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Memo (optional)</label>
              <input
                type="text"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="Payment for..."
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div className="flex gap-2">
              <button onClick={() => setStep('recipient')} className="flex-1 px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted transition-colors">Back</button>
              <button
                onClick={handleSend}
                disabled={!amount || loading || parseInt(amount) > balance}
                className="flex-1 px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading && <Loader2Icon className="h-3 w-3 animate-spin" />}
                Lock & Send
              </button>
            </div>
          </div>
        )}

        {step === 'sending' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Creating P2PK-locked token...</p>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <div className="text-4xl text-[var(--color-success)]">&#x2713;</div>
            <p className="text-sm font-medium text-[var(--color-success)]">Token locked & sent!</p>
            <p className="text-xs text-muted-foreground text-center">
              The token is locked to the recipient's public key. Only they can redeem it.
            </p>
            <button onClick={onClose} className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity">Done</button>
          </div>
        )}

        {step === 'error' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <div className="text-4xl text-destructive">!</div>
            <p className="text-sm font-medium text-destructive">Send failed</p>
            <p className="text-xs text-muted-foreground text-center">{errorMsg}</p>
            <button onClick={onClose} className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity">Close</button>
          </div>
        )}
      </div>
    </div>
  );
};
