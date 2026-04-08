import { useState, useRef, useCallback, useEffect } from 'react';
import { Loader2Icon, XIcon, UsersIcon, CheckCircleIcon, AlertCircleIcon } from 'lucide-react';
import { toastError, toastSuccess, truncateMintUrl, formatAmount } from '@/lib/utils';
import { sendP2pkLocked } from '@/cashu/p2pk';
import { encodeToken } from '@/cashu/token-utils';
import { acquireWalletLock } from '@/lib/wallet-mutex';
import { CashuTransferProtocol, assertP2PKLocked, type TransferData, type P2pkPublicKeyData } from '@/protocol/cashu-transfer-protocol';
import { DialogWrapper } from '@/components/ui/dialog-wrapper';
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
  onRevertPending: (ids: string[]) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}

type Step = 'recipient' | 'amount' | 'sending' | 'done' | 'error';
type ResolveState = 'idle' | 'resolving' | 'resolved' | 'not-found' | 'error';

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
  onRevertPending,
  onTransactionCreated,
}) => {
  const [step, setStep] = useState<Step>('recipient');
  const [recipientDid, setRecipientDid] = useState('');
  const [recipientPubkey, setRecipientPubkey] = useState('');
  const [resolveState, setResolveState] = useState<ResolveState>('idle');
  const [selectedMint, setSelectedMint] = useState<Mint | null>(mints[0] ?? null);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [sentToken, setSentToken] = useState('');
  const [claimed, setClaimed] = useState(false);
  const busyRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const balance = selectedMint ? (mintBalances.get(selectedMint.url) ?? 0) : 0;

  // --- Token claim status polling (NUT-07) ---
  useEffect(() => {
    if (step !== 'done' || !sentToken || !selectedMint || claimed) return;
    const check = async (): Promise<void> => {
      try {
        const { checkTokenSpent } = await import('@/cashu/wallet-ops');
        const spent = await checkTokenSpent(sentToken, selectedMint.url, selectedMint.unit);
        if (spent === true) {
          setClaimed(true);
          if (pollRef.current) { clearInterval(pollRef.current); }
        }
      } catch { /* best-effort */ }
    };
    check();
    pollRef.current = setInterval(check, 5_000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); } };
  }, [step, sentToken, selectedMint, claimed]);

  // ── Resolve recipient's P2PK public key from their DID ──────────

  const resolveRecipientPubkey = useCallback(async (did: string) => {
    if (!did.startsWith('did:')) return;
    setResolveState('resolving');
    setRecipientPubkey('');
    try {
      // Query the recipient's DWN for their published P2PK public key.
      // The cashu-transfer protocol's publicKey type has $actions: anyone can read.
      const transferTyped = enbox.using(CashuTransferProtocol);
      const { records } = await transferTyped.records.query('publicKey', {
        from: did,
      });

      if (records && records.length > 0) {
        const data: P2pkPublicKeyData = await records[0].data.json();
        if (data.publicKey) {
          setRecipientPubkey(data.publicKey);
          setResolveState('resolved');
          return;
        }
      }
      setResolveState('not-found');
    } catch (err) {
      console.warn('[nutsd] Failed to resolve P2PK key from DID:', err);
      setResolveState('error');
    }
  }, [enbox]);

  const handleDidBlur = () => {
    const did = recipientDid.trim();
    if (did.startsWith('did:') && resolveState === 'idle') {
      resolveRecipientPubkey(did);
    }
  };

  const handleDidChange = (value: string) => {
    setRecipientDid(value);
    setResolveState('idle');
    setRecipientPubkey('');
  };

  const handleNext = () => {
    if (resolveState === 'idle' && recipientDid.trim().startsWith('did:')) {
      resolveRecipientPubkey(recipientDid.trim());
      return;
    }
    if (!recipientPubkey) {
      toastError('Cannot resolve recipient', new Error('Could not find recipient\'s P2PK public key'));
      return;
    }
    setStep('amount');
  };

  const handleSend = async () => {
    if (!selectedMint || !amount || busyRef.current) return;
    const amountNum = parseInt(amount, 10);
    if (isNaN(amountNum) || amountNum <= 0 || amountNum > balance) return;

    busyRef.current = true;
    setStep('sending');
    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = await acquireWalletLock('p2p-send');
    } catch (err) {
      console.warn('[nutsd] Wallet lock acquisition failed for p2p-send:', err);
      toastError('Wallet busy', new Error('Another wallet operation is in progress. Please wait.'));
      setStep('amount');
      busyRef.current = false;
      return;
    }
    let spentIds: string[] = [];
    let swapCompleted = false;
    try {
      const storedProofs = getUnspentProofs(selectedMint.url);
      spentIds = storedProofs.map(p => p.id);
      const cashuProofs: Proof[] = storedProofs.map(p => ({
        amount: p.amount, id: p.keysetId, secret: p.secret, C: p.C,
        ...(p.dleq ? { dleq: p.dleq } : {}),
        ...(p.witness ? { witness: p.witness } : {}),
      }));

      // Mark pending before the irreversible swap
      await onMarkPending(spentIds);

      // Create P2PK-locked proofs (irreversible — mint consumes originals)
      const { send, keep } = await sendP2pkLocked(
        selectedMint.url, cashuProofs, amountNum, recipientPubkey.trim(), selectedMint.unit,
      );
      swapCompleted = true;

      const encodedToken = encodeToken(selectedMint.url, send, selectedMint.unit);

      // Validate P2PK enforcement before writing.
      const transferData: TransferData = {
        token: encodedToken,
        amount: amountNum,
        unit: selectedMint.unit,
        mintUrl: selectedMint.url,
        memo: memo.trim() || undefined,
        senderDid,
        recipientPubkey: recipientPubkey.trim(),
        proofs: send,
      };
      assertP2PKLocked(transferData);

      // CRITICAL: Persist change proofs and transaction record BEFORE
      // deleting old proofs. This ensures that if we crash between here
      // and the old-proofs cleanup, the change proofs and token are safe.
      // The token is embedded in the transaction's cashuToken field.
      if (keep.length > 0) await onNewProofs(selectedMint.contextId, keep);

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

      // Now safe to delete old proofs — change + token are persisted.
      await onOldProofsSpent(spentIds);

      // Write transfer record to recipient's DWN (non-fatal if it fails —
      // the token is in our tx history and can be reclaimed).
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
          console.warn('[nutsd] Failed to write transfer to recipient DWN:', err);
        }
      }

      setSentToken(encodedToken);
      setStep('done');
      toastSuccess(
        dwnWriteSucceeded ? 'Token sent to recipient\'s DWN' : 'P2PK-locked token created',
        `${formatAmount(amountNum, selectedMint.unit)}`,
      );
    } catch (err) {
      // If the swap hasn't completed, the proofs are still at the mint —
      // revert them from pending back to unspent immediately.
      if (!swapCompleted && spentIds.length > 0) {
        onRevertPending(spentIds).catch(() => {});
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    } finally {
      releaseLock?.();
      busyRef.current = false;
    }
  };

  return (
    <DialogWrapper open={true} onClose={onClose} title="Send to DID" preventClose={step === 'sending'}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UsersIcon className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold">Send to DID</h3>
          </div>
          {step !== 'sending' && (
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        {step === 'recipient' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Recipient DID</label>
              <input
                type="text"
                value={recipientDid}
                onChange={(e) => handleDidChange(e.target.value)}
                onBlur={handleDidBlur}
                placeholder="did:dht:..."
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoFocus
              />
            </div>

            {/* Resolve status */}
            {resolveState === 'resolving' && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2Icon className="h-3 w-3 animate-spin" />
                Resolving P2PK key...
              </div>
            )}
            {resolveState === 'resolved' && (
              <div className="flex items-center gap-2 text-xs text-green-400">
                <CheckCircleIcon className="h-3 w-3" />
                P2PK key resolved: {recipientPubkey.slice(0, 8)}...{recipientPubkey.slice(-4)}
              </div>
            )}
            {resolveState === 'not-found' && (
              <div className="flex items-center gap-2 text-xs text-amber-400">
                <AlertCircleIcon className="h-3 w-3" />
                Recipient has no published P2PK key. They may need to open nutsd first.
              </div>
            )}
            {resolveState === 'error' && (
              <div className="flex items-center gap-2 text-xs text-red-400">
                <AlertCircleIcon className="h-3 w-3" />
                Failed to resolve recipient. Check the DID and try again.
              </div>
            )}

            <button
              onClick={handleNext}
              disabled={!recipientDid.trim().startsWith('did:') || resolveState === 'resolving' || resolveState === 'not-found'}
              className="w-full px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {resolveState === 'resolving' ? 'Resolving...' : 'Next'}
            </button>
          </div>
        )}

        {step === 'amount' && (
          <div className="space-y-4">
            {/* Mint selector */}
            {mints.length > 1 && (
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">From Mint</label>
                <select
                  value={selectedMint?.url ?? ''}
                  onChange={(e) => setSelectedMint(mints.find(m => m.url === e.target.value) ?? null)}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  {mints.map(m => (
                    <option key={m.url} value={m.url}>
                      {truncateMintUrl(m.url)} ({formatAmount(mintBalances.get(m.url) ?? 0, m.unit)})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Amount */}
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Amount ({selectedMint?.unit ?? 'sat'})</label>
              <input
                type="number"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                min={1}
                max={balance}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoFocus
              />
              <p className="text-[10px] text-muted-foreground">
                Available: {formatAmount(balance, selectedMint?.unit ?? 'sat')}
              </p>
            </div>

            {/* Memo */}
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Memo (optional)</label>
              <input
                type="text"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="What's this for?"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setStep('recipient')}
                className="flex-1 px-4 py-2 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleSend}
                disabled={!amount || parseInt(amount, 10) <= 0 || parseInt(amount, 10) > balance}
                className="flex-1 px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Send
              </button>
            </div>
          </div>
        )}

        {step === 'sending' && (
          <div className="flex flex-col items-center py-8 gap-3">
            <Loader2Icon className="h-8 w-8 text-primary animate-spin" />
            <p className="text-sm text-muted-foreground">Locking and sending tokens...</p>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <CheckCircleIcon className={`h-8 w-8 ${claimed ? 'text-green-400' : 'text-primary'}`} />
            <p className="text-sm font-medium">
              {claimed ? 'Token claimed!' : 'Transfer sent!'}
            </p>
            <p className="text-xs text-muted-foreground text-center">
              {formatAmount(parseInt(amount, 10), selectedMint?.unit ?? 'sat')}
              {claimed
                ? ' has been received by the recipient.'
                : ` locked to ${recipientDid.slice(0, 20)}...`}
            </p>
            {!claimed && (
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Loader2Icon className="h-3 w-3 animate-spin" />
                Waiting for recipient to claim...
              </div>
            )}
            <button
              onClick={onClose}
              className="mt-2 px-6 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
            >
              Done
            </button>
          </div>
        )}

        {step === 'error' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <AlertCircleIcon className="h-8 w-8 text-red-400" />
            <p className="text-sm text-red-400 text-center">{errorMsg}</p>
            <div className="flex gap-2">
              <button
                onClick={() => setStep('amount')}
                className="px-4 py-2 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-full text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </DialogWrapper>
  );
};
