/**
 * Unified Send dialog.
 *
 * This replaces the five legacy send flows (plain send, send-to-DID,
 * withdraw, lnurl-withdraw, pay-request) with a single scan-or-paste
 * entry point that auto-detects the payment target.
 *
 * Flow:
 *
 *  chooser ────── tap square ─────→ chooser (camera active)
 *    │                                     │
 *    ├── paste detected ──→ confirm ───────┤
 *    │                                     │
 *    ├── QR captured ─────→ confirm ───────┤
 *    │                                     │
 *    └── "send without scanning"
 *             │
 *             └──→ create-token ──→ creating ──→ token-ready
 *
 *  confirm ───→ DetectConfirmCard dispatches per detected type
 *             → on success:  sent  → Done
 *             → on redirect: parent handles (switch-to-receive / add-mint)
 *
 * Busy states propagate to DialogWrapper.preventClose so in-flight
 * financial operations cannot be dismissed mid-flight.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  Loader2Icon,
  SendIcon,
  XIcon,
} from 'lucide-react';
import type { Proof } from '@cashu/cashu-ts';

import { detectInput, type DetectedInput } from '@/lib/input-detect';
import type { Mint, StoredProof } from '@/hooks/use-wallet';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

import { DialogWrapper } from '@/components/ui/dialog-wrapper';
import { InlineQrScanner } from '@/components/wallet/inline-qr-scanner';
import { ClipboardButton } from '@/components/wallet/clipboard-button';
import { AmountInput } from '@/components/wallet/amount-input';
import { QRCodeDisplay } from '@/components/qr-code';
import { ClaimStatusIndicator } from '@/components/wallet/claim-status-indicator';
import { DetectConfirmCard, type SendContext, type SendOutcome } from '@/components/wallet/detect-confirm-card';

import { useClipboardDetect } from '@/hooks/use-clipboard-detect';
import { useTokenClaimStatus } from '@/hooks/use-token-claim-status';

import { swapProofs, estimateInputFee } from '@/cashu/wallet-ops';
import { encodeToken } from '@/cashu/token-utils';
import { acquireWalletLock } from '@/lib/wallet-mutex';
import { formatAmount, toastError, toastSuccess, truncateMintUrl } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface UnifiedSendDialogProps {
  mints: Mint[];
  mintBalances: Map<string, number>;
  mintBalancesByContext: Map<string, number>;
  mintFeePpk: Map<string, number>;
  keysetFeeMap: Map<string, number>;
  getUnspentProofs: (mintUrl: string) => StoredProof[];
  getUnspentProofsByContext: (contextId: string) => StoredProof[];
  senderDid?: string;
  enbox: any;
  onClose: () => void;
  onNewProofs: (mintContextId: string, proofs: Proof[]) => Promise<void>;
  onOldProofsSpent: (ids: string[]) => Promise<void>;
  onMarkPending: (ids: string[]) => Promise<void>;
  onRevertPending: (ids: string[]) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
  onMarkClaimed: (txId: string) => Promise<void>;

  /**
   * Called when the user pastes/scans a cashu token. The parent closes this
   * dialog and opens the Receive flow with the token pre-filled so the user
   * doesn't have to start over.
   */
  onSwitchToReceive: (token: string) => void;

  /**
   * Called when the user pastes/scans a mint URL. The parent closes this
   * dialog and opens Add Mint.
   */
  onSwitchToAddMint: (mintUrl: string) => void;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type Step =
  | 'chooser'       // default: idle scanner + paste + create-token link
  | 'confirm'       // DetectConfirmCard dispatcher for a detected input
  | 'create-token'  // offline cashu token creator: amount input
  | 'creating'      // spinner while the token is being minted/swapped
  | 'token-ready'   // final QR + copy + claim status
  | 'sent';         // generic "Sent!" state for non-offline sends

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export const UnifiedSendDialog: React.FC<UnifiedSendDialogProps> = (props) => {
  const {
    mints,
    mintBalances,
    mintBalancesByContext,
    mintFeePpk,
    keysetFeeMap,
    getUnspentProofs,
    getUnspentProofsByContext,
    senderDid,
    enbox,
    onClose,
    onNewProofs,
    onOldProofsSpent,
    onMarkPending,
    onRevertPending,
    onTransactionCreated,
    onMarkClaimed,
    onSwitchToReceive,
    onSwitchToAddMint,
  } = props;

  const [step, setStep] = useState<Step>('chooser');
  const [cameraActive, setCameraActive] = useState(false);
  const [detected, setDetected] = useState<DetectedInput | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [successAmount, setSuccessAmount] = useState<{ amount: number; unit: string; memo?: string } | null>(null);

  // ── Clipboard detection ──
  const { probe, readClipboard } = useClipboardDetect({ autoProbe: true });

  // ── Offline token creator state ──
  const [createMintState, setCreateMintState] = useState<Mint | null>(mints[0] ?? null);
  const [createAmount, setCreateAmount] = useState('');
  const [createdToken, setCreatedToken] = useState('');
  const [createdTxId, setCreatedTxId] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const busyRef = useRef(false);

  const createBalance = createMintState ? (mintBalances.get(createMintState.url) ?? 0) : 0;
  const createFeePpk = createMintState ? (mintFeePpk.get(createMintState.url) ?? 0) : 0;

  const createEstimatedFee = useMemo(() => {
    if (!createMintState || !createAmount || createFeePpk <= 0) return 0;
    const stored = getUnspentProofs(createMintState.url);
    const cashu: Proof[] = stored.map((p) => ({
      amount : p.amount,
      id     : p.keysetId,
      secret : p.secret,
      C      : p.C,
    }));
    return estimateInputFee(cashu, keysetFeeMap);
  }, [createMintState, createAmount, createFeePpk, getUnspentProofs, keysetFeeMap]);

  // ── SendContext for the DetectConfirmCard ──
  const sendContext: SendContext = useMemo(() => ({
    mints,
    mintBalances,
    mintBalancesByContext,
    keysetFeeMap,
    getUnspentProofs,
    getUnspentProofsByContext,
    onNewProofs,
    onOldProofsSpent,
    onMarkPending,
    onRevertPending,
    onTransactionCreated,
    onMarkClaimed,
    senderDid,
    enbox,
  }), [
    mints, mintBalances, mintBalancesByContext, keysetFeeMap,
    getUnspentProofs, getUnspentProofsByContext,
    onNewProofs, onOldProofsSpent, onMarkPending, onRevertPending,
    onTransactionCreated, onMarkClaimed, senderDid, enbox,
  ]);

  // ── Claim status tracking for the offline token flow ──
  const { status: claimStatus, checkNow } = useTokenClaimStatus({
    token    : createdToken,
    mintUrl  : createMintState?.url ?? '',
    unit     : createMintState?.unit ?? 'sat',
    enabled  : step === 'token-ready' && !!createdToken,
    onClaimed: async () => {
      if (createdTxId) await onMarkClaimed(createdTxId);
    },
  });
  const claimed = claimStatus === 'claimed';

  // ── Busy state for DialogWrapper.preventClose ──
  const preventClose =
       step === 'creating'
    || (step === 'confirm' && confirmBusy);

  // ── Chooser handlers ──
  const handleRequestCamera = useCallback(() => {
    setCameraActive(true);
  }, []);

  const handleScan = useCallback((raw: string) => {
    // InlineQrScanner delivers the raw value — run it through detection.
    const d = detectInput(raw);
    setDetected(d);
    setCameraActive(false);
    setStep('confirm');
  }, []);

  const handlePasteDetected = useCallback((d: DetectedInput) => {
    setDetected(d);
    setCameraActive(false);
    setStep('confirm');
  }, []);

  // ── Confirm card outcome ──
  const handleConfirmDone = useCallback((outcome: SendOutcome) => {
    if (outcome.kind === 'switch-to-receive') {
      onSwitchToReceive(outcome.token);
      return;
    }
    if (outcome.kind === 'switch-to-add-mint') {
      onSwitchToAddMint(outcome.mintUrl);
      return;
    }
    if (outcome.kind === 'token-ready') {
      // NUT-18 payment-request fulfilment: we minted a token that needs to be
      // manually shared with the requester. Reuse the offline-token success UI
      // (QR + copy + claim status) by shimming into createMintState/createAmount.
      const mint = mints.find((m) => m.url === outcome.mintUrl) ?? null;
      setCreateMintState(mint);
      setCreateAmount(String(outcome.amount));
      setCreatedToken(outcome.token);
      setCreatedTxId(outcome.txId);
      setStep('token-ready');
      return;
    }
    // kind === 'sent'
    setSuccessAmount({ amount: outcome.amount, unit: outcome.unit, memo: outcome.memo });
    setStep('sent');
  }, [onSwitchToReceive, onSwitchToAddMint, mints]);

  // ── Offline token creation ──
  const handleCreateToken = async () => {
    if (!createMintState || !createAmount || busyRef.current) return;
    const n = parseInt(createAmount, 10);
    if (isNaN(n) || n <= 0 || n + createEstimatedFee > createBalance) return;

    busyRef.current = true;
    setStep('creating');

    let releaseLock: (() => void) | undefined;
    try { releaseLock = await acquireWalletLock('send'); }
    catch {
      toastError('Wallet busy', new Error('Another wallet operation is in progress.'));
      setStep('create-token');
      busyRef.current = false;
      return;
    }

    try {
      const stored = getUnspentProofs(createMintState.url);
      const spentIds = stored.map((p) => p.id);
      const cashuProofs: Proof[] = stored.map((p) => ({
        amount : p.amount,
        id     : p.keysetId,
        secret : p.secret,
        C      : p.C,
        ...(p.dleq    ? { dleq    : p.dleq } : {}),
        ...(p.witness ? { witness : p.witness } : {}),
      }));

      await onMarkPending(spentIds);

      const { send, keep } = await swapProofs(
        createMintState.url, cashuProofs, n, createMintState.unit,
        { includeFees: true },
      );
      const encoded = encodeToken(createMintState.url, send, createMintState.unit);

      if (keep.length > 0) await onNewProofs(createMintState.contextId, keep);
      await onOldProofsSpent(spentIds);

      const txId = await onTransactionCreated({
        type        : 'send',
        amount      : n,
        unit        : createMintState.unit,
        mintUrl     : createMintState.url,
        status      : 'completed',
        claimStatus : 'pending',
        cashuToken  : encoded,
      });

      setCreatedToken(encoded);
      if (typeof txId === 'string') setCreatedTxId(txId);
      setStep('token-ready');
    } catch (err) {
      toastError('Failed to create token', err);
      setStep('create-token');
    } finally {
      releaseLock?.();
      busyRef.current = false;
    }
  };

  const handleCopyToken = async () => {
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
      toastSuccess('Token copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toastError('Copy failed', new Error('Clipboard access denied'));
    }
  };

  // ── Back navigation resets transient scanner/detect state ──
  const backToChooser = useCallback(() => {
    setDetected(null);
    setConfirmBusy(false);
    setCameraActive(false);
    setStep('chooser');
  }, []);

  const backToCreateEntry = useCallback(() => {
    setCreateMintState(mints[0] ?? null);
    setCreateAmount('');
    setCreatedToken('');
    setCreatedTxId(undefined);
    setStep('create-token');
  }, [mints]);

  // Auto-focus first mount → good for keyboard users.
  useEffect(() => {
    if (step === 'chooser') setCameraActive(false);
  }, [step]);

  // -----------------------------------------------------------------------
  // Header
  // -----------------------------------------------------------------------

  const headerTitle = (() => {
    switch (step) {
      case 'create-token':
      case 'creating':
        return 'Create token';
      case 'token-ready':
        return 'Token ready';
      case 'sent':
        return 'Sent';
      case 'confirm':
        return 'Confirm';
      default:
        return 'Send';
    }
  })();

  const canGoBack = step === 'confirm' || step === 'create-token' || step === 'token-ready';
  const backTarget = step === 'token-ready' ? backToCreateEntry : backToChooser;

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <DialogWrapper
      open={true}
      onClose={onClose}
      title="Send"
      maxWidth="max-w-md"
      preventClose={preventClose}
    >
      <div className="space-y-4">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {canGoBack && !preventClose ? (
              <button
                onClick={backTarget}
                className="p-1 -ml-1 rounded-md hover:bg-muted text-muted-foreground"
                aria-label="Back"
              >
                <ArrowLeftIcon className="h-4 w-4" />
              </button>
            ) : (
              <SendIcon className="h-5 w-5 text-primary" />
            )}
            <h3 className="text-lg font-semibold">{headerTitle}</h3>
          </div>
          {!preventClose && (
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* ----- chooser ----- */}
        {step === 'chooser' && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <InlineQrScanner
              active={cameraActive}
              onRequestStart={handleRequestCamera}
              onScan={handleScan}
            />

            <ClipboardButton
              onPaste={handlePasteDetected}
              readClipboard={readClipboard}
              highlightType={probe.known ? probe.preview : null}
            />

            <button
              onClick={() => setStep('create-token')}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              Or create a token without scanning →
            </button>
          </div>
        )}

        {/* ----- confirm (detection-driven) ----- */}
        {step === 'confirm' && detected && (
          <div className="animate-in fade-in duration-200">
            <DetectConfirmCard
              detected={detected}
              ctx={sendContext}
              onBack={backToChooser}
              onDone={handleConfirmDone}
              onBusyChange={setConfirmBusy}
            />
          </div>
        )}

        {/* ----- create-token: amount input ----- */}
        {step === 'create-token' && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <p className="text-xs text-muted-foreground text-center px-2">
              Create an offline cashu token you can share via text, email, or any
              other channel. The recipient can claim it in any cashu wallet.
            </p>

            {mints.length > 1 && (
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground px-1">
                  From
                </label>
                <select
                  value={createMintState?.url ?? ''}
                  onChange={(e) => setCreateMintState(mints.find((m) => m.url === e.target.value) ?? null)}
                  className="w-full px-3 py-2.5 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  {mints.map((m) => (
                    <option key={m.url} value={m.url}>
                      {m.name || truncateMintUrl(m.url)} ({formatAmount(mintBalances.get(m.url) ?? 0, m.unit)})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <AmountInput
              value={createAmount}
              onChange={setCreateAmount}
              unit={createMintState?.unit ?? 'sat'}
              max={Math.max(0, createBalance - createEstimatedFee)}
              helper={`Balance: ${formatAmount(createBalance, createMintState?.unit)}`}
              error={
                createAmount && (parseInt(createAmount, 10) || 0) + createEstimatedFee > createBalance
                  ? 'Insufficient balance'
                  : null
              }
            />

            {createAmount && createEstimatedFee > 0 && (
              <div className="p-3 rounded-xl bg-background border border-border space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Amount</span>
                  <span className="amount-display font-medium">
                    {formatAmount(parseInt(createAmount, 10) || 0, createMintState?.unit)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Mint fee</span>
                  <span className="amount-display font-medium">{formatAmount(createEstimatedFee)}</span>
                </div>
                <div className="border-t border-border pt-1.5 flex justify-between text-sm font-semibold">
                  <span>Total</span>
                  <span className="amount-display">
                    {formatAmount((parseInt(createAmount, 10) || 0) + createEstimatedFee, createMintState?.unit)}
                  </span>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={backToChooser}
                className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleCreateToken}
                disabled={
                  !createAmount
                  || (parseInt(createAmount, 10) || 0) + createEstimatedFee > createBalance
                  || (parseInt(createAmount, 10) || 0) <= 0
                }
                className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create token
              </button>
            </div>
          </div>
        )}

        {/* ----- creating: spinner ----- */}
        {step === 'creating' && (
          <div className="flex flex-col items-center py-10 gap-3">
            <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
            <div className="text-sm text-muted-foreground">Minting your token…</div>
          </div>
        )}

        {/* ----- token-ready: QR + copy + claim status ----- */}
        {step === 'token-ready' && createdToken && (
          <div className="space-y-4 animate-in fade-in duration-200">
            {claimed ? (
              <div className="flex flex-col items-center py-6 gap-3">
                <CheckCircleIcon className="h-12 w-12 text-[var(--color-success)]" />
                <div className="text-base font-semibold text-[var(--color-success)]">Token claimed!</div>
                <div className="text-xs text-muted-foreground text-center">
                  {formatAmount(parseInt(createAmount, 10) || 0, createMintState?.unit)}
                  {' received by the recipient.'}
                </div>
                <button
                  onClick={onClose}
                  className="mt-2 px-6 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                <div className="flex justify-center">
                  <QRCodeDisplay value={createdToken} size={200} />
                </div>
                <div className="text-center space-y-0.5">
                  <div className="amount-display text-2xl font-bold text-foreground">
                    {formatAmount(parseInt(createAmount, 10) || 0, createMintState?.unit)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">Share this token with the recipient</div>
                </div>

                <div className="p-3 rounded-lg bg-background border border-border max-h-24 overflow-y-auto">
                  <div className="token-string text-muted-foreground">{createdToken}</div>
                </div>

                <ClaimStatusIndicator status={claimStatus} onCheckNow={() => checkNow().catch(() => {})} />

                <button
                  onClick={handleCopyToken}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
                >
                  {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
                  {copied ? 'Copied' : 'Copy token'}
                </button>
                <button
                  onClick={onClose}
                  className="w-full px-4 py-2.5 rounded-full text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  Close
                </button>
              </>
            )}
          </div>
        )}

        {/* ----- sent: simple success screen ----- */}
        {step === 'sent' && successAmount && (
          <div className="flex flex-col items-center py-10 gap-3 animate-in fade-in duration-200">
            <CheckCircleIcon className="h-14 w-14 text-[var(--color-success)]" />
            <div className="text-center space-y-1">
              <div className="text-lg font-semibold">Sent</div>
              <div className="amount-display text-3xl font-bold text-foreground">
                {formatAmount(successAmount.amount, successAmount.unit)}
              </div>
              {successAmount.memo && (
                <div className="text-xs text-muted-foreground">{successAmount.memo}</div>
              )}
            </div>
            <button
              onClick={onClose}
              className="mt-4 px-8 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </DialogWrapper>
  );
};
