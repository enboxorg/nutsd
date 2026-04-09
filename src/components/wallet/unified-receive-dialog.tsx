/**
 * Unified Receive dialog.
 *
 * Replaces the legacy `ReceiveDialog`, `DepositDialog`, and `CreateRequestDialog`
 * with a single dialog that has three channels the user picks via a segmented
 * control, plus a hidden "claim token" mode used when the Send dialog
 * redirects here with a pasted/scanned cashu token.
 *
 * Channels:
 *
 *   1. ⚡ Lightning
 *      - Amount required
 *      - Creates a NUT-04 mint quote, shows the BOLT-11 as a QR
 *      - Subscribes to the mint (NUT-17 WS with polling fallback)
 *      - Auto-mints new proofs on onPaid → success screen
 *
 *   2. 🥜 Cashu (NUT-18 payment request)
 *      - Amount optional — empty = "any amount"
 *      - Encodes a `creqA…` payment request entirely client-side
 *      - Re-encodes live as the amount or mint changes
 *      - No waiting state — the sender fulfils the request out-of-band and
 *        nutsd-to-nutsd deliveries land in the home-screen incoming banner
 *
 *   3. 👤 Address (static DID)
 *      - No amount needed — QR is the user's DID
 *      - The sender's unified Send detects `did:` and routes to P2PK
 *      - Replaces the old P2PK-key display row on the home screen
 *
 * Claim mode (invoked via `claimToken` prop):
 *
 *   - Bypasses the 3-channel UI
 *   - Validates the token, checks spendability (NUT-07), detects P2PK
 *     locking, receives via the wallet, and shows a success screen
 *   - Delegates unknown mints to the parent via `onUnknownMint`
 *
 * Busy states propagate to DialogWrapper.preventClose so in-flight operations
 * can't be dismissed mid-flight.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FingerprintIcon,
  Loader2Icon,
  PackageIcon,
  ZapIcon,
  XIcon,
  AlertCircleIcon,
} from 'lucide-react';
import type { Proof } from '@cashu/cashu-ts';

import type { Mint } from '@/hooks/use-wallet';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';

import { DialogWrapper } from '@/components/ui/dialog-wrapper';
import { QRCodeDisplay } from '@/components/qr-code';
import { AmountInput } from '@/components/wallet/amount-input';
import { ChannelSegmented, type SegmentOption } from '@/components/wallet/channel-segmented';

import {
  createMintQuote,
  checkMintQuote,
  mintTokens,
  receiveToken,
  isTokenSpendable,
} from '@/cashu/wallet-ops';
import { isDleqValid } from '@/cashu/dleq-verify';
import { encodePaymentRequest } from '@/cashu/payment-request';
import { extractMintUrl, isCashuToken, isP2pkLockedToken, parseToken } from '@/cashu/token-utils';
import { receiveP2pkLocked } from '@/cashu/p2pk';
import { subscribeToQuote } from '@/lib/mint-ws';
import { fetchLnurlWithdrawInfo, submitLnurlWithdraw, msatToSats } from '@/lib/lnurl-withdraw';
import { decodeLnurl } from '@/lib/lnurl';
import { detectInput } from '@/lib/input-detect';
import { acquireWalletLock } from '@/lib/wallet-mutex';
import { formatAmount, toastError, toastSuccess, truncateMintUrl, truncateMiddle } from '@/lib/utils';

import { InlineQrScanner } from '@/components/wallet/inline-qr-scanner';
import { ClipboardButton } from '@/components/wallet/clipboard-button';

// ---------------------------------------------------------------------------
// Props & types
// ---------------------------------------------------------------------------

type Channel = 'lightning' | 'cashu' | 'address';

export interface UnifiedReceiveDialogProps {
  mints: Mint[];
  /** User's own DID, shown as the static receive address. */
  did?: string;
  /** P2PK private key for unlocking incoming P2PK-locked tokens in claim mode. */
  p2pkPrivateKey?: string;

  /**
   * When provided, the dialog opens in "claim token" mode — it bypasses the
   * 3-channel UI and immediately attempts to redeem the pasted/scanned token.
   * This is used by the Send dialog's mismatch path ("This is a token for you,
   * receive it instead").
   */
  claimToken?: string;

  /**
   * When provided, the dialog opens in "LNURL withdraw" mode — it resolves
   * the LNURL, creates a mint quote, submits the invoice, and waits for payment.
   * Set by the Send dialog when an LNURL resolves to a withdrawRequest.
   */
  lnurlWithdraw?: string;

  /**
   * Called when a token in claim mode is from an unknown mint. The parent
   * should close this dialog and open the trust-mint dialog.
   */
  onUnknownMint?: (mintUrl: string, amount: number, unit: string, token: string) => void;

  onClose: () => void;
  onProofsReceived: (mintContextId: string, proofs: Proof[], mintUrl: string) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export const UnifiedReceiveDialog: React.FC<UnifiedReceiveDialogProps> = ({
  mints,
  did,
  p2pkPrivateKey,
  claimToken,
  lnurlWithdraw,
  onUnknownMint,
  onClose,
  onProofsReceived,
  onTransactionCreated,
}) => {
  // Claim mode takes over the whole dialog when a claimToken is passed.
  if (claimToken) {
    return (
      <ClaimTokenPane
        mints={mints}
        token={claimToken}
        p2pkPrivateKey={p2pkPrivateKey}
        onUnknownMint={onUnknownMint}
        onClose={onClose}
        onProofsReceived={onProofsReceived}
        onTransactionCreated={onTransactionCreated}
      />
    );
  }

  // LNURL-withdraw mode: service pays you.
  if (lnurlWithdraw) {
    return (
      <LnurlWithdrawPane
        mints={mints}
        lnurl={lnurlWithdraw}
        onClose={onClose}
        onProofsReceived={onProofsReceived}
        onTransactionCreated={onTransactionCreated}
      />
    );
  }

  return (
    <ChannelsReceive
      mints={mints}
      did={did}
      onClose={onClose}
      onProofsReceived={onProofsReceived}
      onTransactionCreated={onTransactionCreated}
    />
  );
};

// ---------------------------------------------------------------------------
// Channels mode — Lightning / Cashu / Address
// ---------------------------------------------------------------------------

const CHANNEL_OPTIONS: ReadonlyArray<SegmentOption<Channel>> = [
  { value: 'lightning', label: 'Lightning', icon: ZapIcon,       description: 'Receive via Lightning invoice' },
  { value: 'cashu',     label: 'Cashu',     icon: PackageIcon,   description: 'Receive via Cashu payment request' },
  { value: 'address',   label: 'Address',   icon: FingerprintIcon, description: 'Show your static receive address' },
];

type LnStep = 'amount' | 'invoice' | 'waiting' | 'done' | 'error';

const ChannelsReceive: React.FC<{
  mints: Mint[];
  did?: string;
  onClose: () => void;
  onProofsReceived: (mintContextId: string, proofs: Proof[], mintUrl: string) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}> = ({ mints, did, onClose, onProofsReceived, onTransactionCreated }) => {
  // ── Scan/paste can switch the dialog into claim-token or lnurl-withdraw mode ──
  const [scannedToken, setScannedToken] = useState<string | null>(null);
  const [scannedLnurlWithdraw, setScannedLnurlWithdraw] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [resolving, setResolving] = useState(false);

  const handleScanOrPaste = useCallback(async (raw: string) => {
    setCameraActive(false);
    const detected = detectInput(raw);
    switch (detected.type) {
      case 'cashu-token':
        setScannedToken(detected.value);
        return;
      case 'lnurl': {
        // Resolve the LNURL first to determine if it's pay or withdraw.
        setResolving(true);
        try {
          const url = detected.value.toLowerCase().startsWith('lnurl1')
            ? decodeLnurl(detected.value)
            : detected.value;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`LNURL endpoint failed: ${res.status}`);
          const data = await res.json();
          if (data.tag === 'withdrawRequest') {
            setScannedLnurlWithdraw(detected.value);
          } else if (data.tag === 'payRequest') {
            toastError('LNURL-pay detected', new Error('This is a payment link. Use Send to pay it.'));
          } else {
            toastError('Unsupported LNURL', new Error(`Unsupported LNURL type: ${data.tag || 'unknown'}`));
          }
        } catch (err) {
          toastError('LNURL failed', err instanceof Error ? err : new Error('Could not resolve LNURL'));
        } finally {
          setResolving(false);
        }
        return;
      }
      default:
        toastError('Not recognized', new Error('Expected a Cashu token or LNURL-withdraw link.'));
    }
  }, []);

  // If scanned a token, switch to claim mode
  if (scannedToken) {
    return (
      <ClaimTokenPane
        mints={mints}
        token={scannedToken}
        onClose={() => setScannedToken(null)}
        onProofsReceived={onProofsReceived}
        onTransactionCreated={onTransactionCreated}
      />
    );
  }

  // If scanned an LNURL-withdraw, switch to withdraw mode
  if (scannedLnurlWithdraw) {
    return (
      <LnurlWithdrawPane
        mints={mints}
        lnurl={scannedLnurlWithdraw}
        onClose={() => setScannedLnurlWithdraw(null)}
        onProofsReceived={onProofsReceived}
        onTransactionCreated={onTransactionCreated}
      />
    );
  }

  return (
    <ChannelsReceiveInner
      mints={mints}
      did={did}
      cameraActive={cameraActive}
      resolving={resolving}
      onCameraToggle={setCameraActive}
      onScanOrPaste={handleScanOrPaste}
      onClose={onClose}
      onProofsReceived={onProofsReceived}
      onTransactionCreated={onTransactionCreated}
    />
  );
};

/** Inner channels view (separated so scan/paste can swap the whole component). */
const ChannelsReceiveInner: React.FC<{
  mints: Mint[];
  did?: string;
  cameraActive: boolean;
  /** True while an LNURL is being resolved after scan/paste. */
  resolving: boolean;
  onCameraToggle: (active: boolean) => void;
  onScanOrPaste: (raw: string) => void;
  onClose: () => void;
  onProofsReceived: (mintContextId: string, proofs: Proof[], mintUrl: string) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}> = ({ mints, did, cameraActive, resolving, onCameraToggle, onScanOrPaste, onClose, onProofsReceived, onTransactionCreated }) => {
  // Default channel: Cashu (most universal — works for any cashu wallet).
  // If the user has no DID, hide Address. If they have no mints, hide Lightning.
  const availableChannels = useMemo<ReadonlyArray<SegmentOption<Channel>>>(
    () => CHANNEL_OPTIONS.filter((opt) => {
      if (opt.value === 'address'   && !did) return false;
      if (opt.value === 'lightning' && mints.length === 0) return false;
      if (opt.value === 'cashu'     && mints.length === 0) return false;
      return true;
    }),
    [did, mints.length],
  );
  const [channel, setChannel] = useState<Channel>(() => availableChannels[0]?.value ?? 'cashu');

  // Shared amount state — survives channel switches (except for Lightning if the
  // channel has already generated an invoice for a different amount).
  const [selectedMint, setSelectedMint] = useState<Mint | null>(mints[0] ?? null);
  const [amount, setAmount] = useState('');

  // Lightning-specific state
  const [lnStep, setLnStep] = useState<LnStep>('amount');
  const [lnInvoice, setLnInvoice] = useState('');
  const [lnReceivedAmount, setLnReceivedAmount] = useState(0);
  const [lnError, setLnError] = useState('');
  const [lnLoading, setLnLoading] = useState(false);
  const stopPollingRef = useRef<(() => void) | undefined>();
  const mountedRef = useRef(true);

  // Copy feedback
  const [copied, setCopied] = useState(false);

  // ── Lifecycle: cleanup the WS subscription if we unmount ──
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPollingRef.current?.();
    };
  }, []);

  // ── Busy-state propagation to DialogWrapper.preventClose ──
  // Lightning invoice is generated but not yet paid → allow close (user can
  // dismiss). Only block during the brief "waiting" (minting) step so we
  // don't lose the mint-tokens result.
  const preventClose = channel === 'lightning' && lnStep === 'waiting';

  // ── Channel change: tear down any in-flight Lightning state ──
  const handleChannelChange = useCallback((next: Channel) => {
    if (channel === next) return;
    // Cancel any active Lightning subscription.
    stopPollingRef.current?.();
    stopPollingRef.current = undefined;
    setLnInvoice('');
    setLnStep('amount');
    setLnError('');
    setChannel(next);
    setCopied(false);
  }, [channel]);

  // ── Amount change in Lightning mode invalidates the invoice ──
  const handleAmountChange = useCallback((next: string) => {
    setAmount(next);
    if (channel === 'lightning' && lnStep !== 'amount') {
      stopPollingRef.current?.();
      stopPollingRef.current = undefined;
      setLnInvoice('');
      setLnStep('amount');
      setLnError('');
    }
  }, [channel, lnStep]);

  // ── Live-encoded Cashu payment request ──
  const cashuRequest = useMemo(() => {
    if (channel !== 'cashu') return '';
    if (!selectedMint) return '';
    const n = parseInt(amount, 10);
    return encodePaymentRequest({
      amount      : isNaN(n) || n <= 0 ? undefined : n,
      unit        : selectedMint.unit,
      mints       : [selectedMint.url],
      description : undefined,
    });
  }, [channel, selectedMint, amount]);

  // ── Current QR value depending on channel ──
  const qrValue = (() => {
    if (channel === 'address') return did ?? '';
    if (channel === 'cashu')   return cashuRequest;
    // Lightning: only valid in the invoice/waiting/done steps
    return lnStep === 'invoice' || lnStep === 'waiting' ? lnInvoice : '';
  })();

  // ── Copy handler ──
  const handleCopy = async () => {
    if (!qrValue) return;
    try {
      await navigator.clipboard.writeText(qrValue);
      setCopied(true);
      toastSuccess('Copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toastError('Copy failed', new Error('Clipboard access denied'));
    }
  };

  // ── Lightning invoice generation ──
  const handleGenerateInvoice = async () => {
    if (!selectedMint || lnLoading) return;
    const n = parseInt(amount, 10);
    if (isNaN(n) || n <= 0) return;

    setLnLoading(true);
    setLnError('');
    try {
      const quote = await createMintQuote(selectedMint.url, n, selectedMint.unit);
      if (!mountedRef.current) return;
      setLnInvoice(quote.request);
      setLnStep('invoice');

      // Capture values in closure; the state object may change by the time callbacks fire.
      const mintUrl = selectedMint.url;
      const mintUnit = selectedMint.unit;
      const mintCtx = selectedMint.contextId;
      const quoteId = quote.quote;
      const quoteExpiry = quote.expiry ?? null;
      const amt = n;

      stopPollingRef.current = subscribeToQuote({
        mintUrl,
        quoteId,
        quoteType : 'bolt11_mint_quote',
        callbacks : {
          onPaid: async () => {
            if (!mountedRef.current) return;
            setLnStep('waiting');
            let releaseLock: (() => void) | undefined;
            try {
              releaseLock = await acquireWalletLock('mint');
              const proofs = await mintTokens(mintUrl, amt, quoteId, mintUnit);
              if (!mountedRef.current) return;

              if (!(await isDleqValid(mintUrl, proofs))) {
                console.warn('[nutsd:financial] DLEQ verification failed on minted proofs');
              }

              await onProofsReceived(mintCtx, proofs, mintUrl);
              await onTransactionCreated({
                type   : 'mint',
                amount : amt,
                unit   : mintUnit,
                mintUrl,
                status : 'completed',
                memo   : 'Lightning receive',
              });

              if (mountedRef.current) {
                setLnReceivedAmount(amt);
                setLnStep('done');
                toastSuccess('Received!', `+${formatAmount(amt, mintUnit)}`);
              }
            } catch (err) {
              if (mountedRef.current) {
                setLnError(err instanceof Error ? err.message : 'Failed to mint tokens');
                setLnStep('error');
              }
            } finally {
              releaseLock?.();
            }
          },
          onExpired: () => {
            if (mountedRef.current) {
              setLnError('The invoice has expired. Generate a new one.');
              setLnStep('error');
            }
          },
          onIssued: () => {
            if (mountedRef.current) {
              setLnError('These tokens were already minted (possibly in another session).');
              setLnStep('error');
            }
          },
          isActive: () => mountedRef.current,
        },
        checkFn: () => checkMintQuote(mintUrl, quoteId, mintUnit).then((s) => ({
          state  : s.state as 'UNPAID' | 'PAID' | 'ISSUED',
          expiry : s.expiry ?? null,
        })),
        expiry: quoteExpiry,
      });
    } catch (err) {
      toastError('Failed to create invoice', err);
      setLnError(err instanceof Error ? err.message : String(err));
      setLnStep('error');
    } finally {
      setLnLoading(false);
    }
  };

  const handleLightningDone = () => {
    setLnStep('amount');
    setLnInvoice('');
    setLnReceivedAmount(0);
    setAmount('');
    onClose();
  };

  // ── Rendering helpers ──

  const isSuccessView = channel === 'lightning' && lnStep === 'done';
  const isErrorView   = channel === 'lightning' && lnStep === 'error';

  // Sub-title for the amount region (shown under the QR)
  const amountSubtitle = (() => {
    if (channel === 'address') return did ? truncateMiddle(did, 14, 8) : 'No DID';
    if (channel === 'cashu') {
      const n = parseInt(amount, 10);
      return !isNaN(n) && n > 0
        ? formatAmount(n, selectedMint?.unit ?? 'sat')
        : 'Any amount';
    }
    // Lightning
    const n = parseInt(amount, 10);
    return !isNaN(n) && n > 0
      ? formatAmount(n, selectedMint?.unit ?? 'sat')
      : 'Enter amount';
  })();

  // Tip text shown at the bottom of the card
  const tip = (() => {
    if (channel === 'address') return 'Other nutsd users can send directly to this address.';
    if (channel === 'cashu')   return 'Any Cashu wallet can fulfil this request.';
    if (channel === 'lightning') {
      switch (lnStep) {
        case 'amount':  return 'Tap Generate to create a Lightning invoice.';
        case 'invoice': return 'Waiting for payment…';
        case 'waiting': return 'Minting your tokens…';
        default:        return '';
      }
    }
    return '';
  })();

  return (
    <DialogWrapper
      open={true}
      onClose={onClose}
      title="Receive"
      maxWidth="max-w-md"
      preventClose={preventClose}
    >
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DownloadIcon className="h-5 w-5 text-[var(--color-info)]" />
            <h3 className="text-lg font-semibold">
              {isSuccessView ? 'Received!' : 'Receive'}
            </h3>
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

        {/* Success screen (Lightning done) */}
        {isSuccessView && (
          <div className="flex flex-col items-center py-10 gap-3 animate-in fade-in duration-200">
            <CheckCircleIcon className="h-14 w-14 text-[var(--color-success)]" />
            <div className="text-center space-y-1">
              <div className="text-lg font-semibold">Received</div>
              <div className="amount-display text-3xl font-bold text-foreground">
                {formatAmount(lnReceivedAmount, selectedMint?.unit ?? 'sat')}
              </div>
            </div>
            <button
              onClick={handleLightningDone}
              className="mt-4 px-8 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          </div>
        )}

        {/* Error screen (Lightning error) */}
        {isErrorView && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-destructive/10 border border-destructive/30">
              <AlertCircleIcon className="h-4 w-4 text-destructive" />
              <div className="text-xs text-muted-foreground">{lnError}</div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setLnStep('amount'); setLnError(''); setLnInvoice(''); }}
                className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted"
              >
                Try again
              </button>
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* Main channel UI */}
        {!isSuccessView && !isErrorView && (
          <div className="space-y-4 animate-in fade-in duration-200">
            {/* QR code */}
            <div className="flex justify-center">
              <div className="p-4 rounded-2xl bg-white">
                {qrValue ? (
                  <QRCodeDisplay value={qrValue} size={200} />
                ) : (
                  <div className="w-[200px] h-[200px] flex items-center justify-center text-[11px] text-muted-foreground bg-white rounded">
                    {channel === 'lightning' ? 'Enter an amount to generate' : ''}
                  </div>
                )}
              </div>
            </div>

            {/* Amount display under the QR */}
            <div className="text-center">
              <div className="amount-display text-2xl font-bold text-foreground">
                {amountSubtitle}
              </div>
            </div>

            {/* Segmented channel control */}
            <ChannelSegmented
              options={availableChannels}
              value={channel}
              onChange={handleChannelChange}
              disabled={channel === 'lightning' && (lnStep === 'invoice' || lnStep === 'waiting')}
              aria-label="Receive channel"
            />

            {/* Scan/paste bar — detect cashu tokens, LNURL-withdraw links */}
            <div className="space-y-2">
              {resolving ? (
                <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
                  <Loader2Icon className="h-3 w-3 animate-spin" />
                  Resolving LNURL…
                </div>
              ) : (
                <>
                  <InlineQrScanner
                    active={cameraActive}
                    onRequestStart={() => onCameraToggle(true)}
                    onScan={onScanOrPaste}
                    onError={(msg) => toastError('Scanner error', new Error(msg))}
                  />
                  {!cameraActive && (
                    <ClipboardButton
                      onPaste={(detected) => onScanOrPaste(detected.value)}
                      highlightType={null}
                    />
                  )}
                </>
              )}
            </div>

            {/* Mint picker — shown only for Lightning & Cashu, and only if multiple mints */}
            {(channel === 'lightning' || channel === 'cashu') && mints.length > 1 && (
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground px-1">
                  Mint
                </label>
                <select
                  value={selectedMint?.contextId ?? ''}
                  onChange={(e) => {
                    setSelectedMint(mints.find((m) => m.contextId === e.target.value) ?? null);
                    // Lightning: invalidate any pending invoice since mint changed.
                    if (channel === 'lightning' && lnStep !== 'amount') {
                      stopPollingRef.current?.();
                      stopPollingRef.current = undefined;
                      setLnInvoice('');
                      setLnStep('amount');
                    }
                  }}
                  disabled={channel === 'lightning' && (lnStep === 'invoice' || lnStep === 'waiting')}
                  className="w-full px-3 py-2.5 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
                >
                  {mints.map((m) => (
                    <option key={m.contextId} value={m.contextId}>
                      {m.name || truncateMintUrl(m.url)} ({m.unit})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Amount input — hidden for Address */}
            {channel !== 'address' && (
              <AmountInput
                value={amount}
                onChange={handleAmountChange}
                unit={selectedMint?.unit ?? 'sat'}
                optional={channel === 'cashu'}
                disabled={channel === 'lightning' && (lnStep === 'invoice' || lnStep === 'waiting')}
                autoFocus
              />
            )}

            {/* Action: Copy / Generate / Waiting */}
            {channel === 'lightning' && lnStep === 'amount' && (
              <button
                onClick={handleGenerateInvoice}
                disabled={!amount || parseInt(amount, 10) <= 0 || lnLoading || !selectedMint}
                className="w-full px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {lnLoading && <Loader2Icon className="h-4 w-4 animate-spin" />}
                Generate invoice
              </button>
            )}

            {channel === 'lightning' && lnStep === 'invoice' && (
              <>
                <button
                  onClick={handleCopy}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
                >
                  {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
                  {copied ? 'Copied' : 'Copy invoice'}
                </button>
                <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
                  <Loader2Icon className="h-3 w-3 animate-spin" />
                  Waiting for payment…
                </div>
              </>
            )}

            {channel === 'lightning' && lnStep === 'waiting' && (
              <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground py-2">
                <Loader2Icon className="h-3 w-3 animate-spin" />
                Minting your tokens…
              </div>
            )}

            {(channel === 'cashu' || channel === 'address') && qrValue && (
              <button
                onClick={handleCopy}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}

            {/* Tip text */}
            {tip && (
              <p className="text-[11px] text-muted-foreground text-center">{tip}</p>
            )}
          </div>
        )}
      </div>
    </DialogWrapper>
  );
};

// ---------------------------------------------------------------------------
// Claim-token mode (invoked via the claimToken prop)
// ---------------------------------------------------------------------------

type ClaimStep = 'checking' | 'ready' | 'claiming' | 'done' | 'error';

const ClaimTokenPane: React.FC<{
  mints: Mint[];
  token: string;
  p2pkPrivateKey?: string;
  onUnknownMint?: (mintUrl: string, amount: number, unit: string, token: string) => void;
  onClose: () => void;
  onProofsReceived: (mintContextId: string, proofs: Proof[], mintUrl: string) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}> = ({
  mints,
  token,
  p2pkPrivateKey,
  onUnknownMint,
  onClose,
  onProofsReceived,
  onTransactionCreated,
}) => {
  const [step, setStep] = useState<ClaimStep>('checking');
  const [tokenAmount, setTokenAmount] = useState<number>(0);
  const [tokenUnit, setTokenUnit] = useState<string>('sat');
  const [mintUrl, setMintUrl] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState('');
  const [receivedAmount, setReceivedAmount] = useState<number>(0);
  const preventClose = step === 'claiming';

  // ── Initial parse & spendability pre-check ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isCashuToken(token)) {
        setErrorMsg('Not a valid cashu token.');
        setStep('error');
        return;
      }
      const mu = extractMintUrl(token);
      if (!mu) {
        setErrorMsg('Could not determine the mint URL from this token.');
        setStep('error');
        return;
      }
      setMintUrl(mu);

      // Best-effort amount/unit parse (may fail for V4 with unknown keysets)
      let parsedAmount = 0;
      let parsedUnit = 'sat';
      try {
        const parsed = parseToken(token);
        parsedAmount = parsed.amount;
        parsedUnit = parsed.unit ?? 'sat';
        if (!cancelled) {
          setTokenAmount(parsedAmount);
          setTokenUnit(parsedUnit);
        }
      } catch {
        // Expected: V4 token or unparseable — leave amount at 0
      }

      // If the mint is unknown, hand off to the trust-mint flow.
      const known = mints.find((m) => m.url === mu);
      if (!known) {
        if (onUnknownMint) {
          onUnknownMint(mu, parsedAmount, parsedUnit, token);
          return;
        }
        setErrorMsg(`Token is from an unknown mint (${truncateMintUrl(mu)}).`);
        setStep('error');
        return;
      }

      if (cancelled) return;
      // Pre-check spendability (NUT-07)
      const spendable = await isTokenSpendable(token, mu);
      if (cancelled) return;
      if (spendable === false) {
        setErrorMsg('This token has already been claimed and cannot be received again.');
        setStep('error');
        return;
      }

      setStep('ready');
    })();
    return () => { cancelled = true; };
  }, [token, mints, onUnknownMint]);

  const handleClaim = async () => {
    if (step !== 'ready' || !mintUrl) return;
    setStep('claiming');

    let releaseLock: (() => void) | undefined;
    try { releaseLock = await acquireWalletLock('receive'); }
    catch {
      toastError('Wallet busy', new Error('Another wallet operation is in progress.'));
      setStep('ready');
      return;
    }

    try {
      const known = mints.find((m) => m.url === mintUrl);
      if (!known) throw new Error('Mint no longer exists.');

      let newProofs: Proof[];
      if (isP2pkLockedToken(token) && p2pkPrivateKey) {
        newProofs = await receiveP2pkLocked(mintUrl, token, p2pkPrivateKey);
      } else if (isP2pkLockedToken(token)) {
        throw new Error('This token is locked with P2PK. Your wallet does not have the private key.');
      } else {
        newProofs = await receiveToken(mintUrl, token);
      }

      if (!(await isDleqValid(mintUrl, newProofs))) {
        console.warn('[nutsd:financial] DLEQ verification failed on received proofs');
        toastError('Warning', new Error('Some proofs failed DLEQ verification. The mint may be misbehaving.'));
      }

      const total = newProofs.reduce((s, p) => s + p.amount, 0);
      await onProofsReceived(known.contextId, newProofs, mintUrl);
      await onTransactionCreated({
        type   : 'receive',
        amount : total,
        unit   : known.unit ?? 'sat',
        mintUrl,
        status : 'completed',
      });

      setReceivedAmount(total);
      setStep('done');
      toastSuccess('Token received', `+${formatAmount(total, known.unit ?? 'sat')}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    } finally {
      releaseLock?.();
    }
  };

  return (
    <DialogWrapper
      open={true}
      onClose={onClose}
      title="Claim token"
      maxWidth="max-w-md"
      preventClose={preventClose}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {step === 'ready' ? (
              <button
                onClick={onClose}
                className="p-1 -ml-1 rounded-md hover:bg-muted text-muted-foreground"
                aria-label="Back"
              >
                <ArrowLeftIcon className="h-4 w-4" />
              </button>
            ) : (
              <DownloadIcon className="h-5 w-5 text-[var(--color-info)]" />
            )}
            <h3 className="text-lg font-semibold">
              {step === 'done' ? 'Received!' : 'Claim token'}
            </h3>
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

        {step === 'checking' && (
          <div className="flex flex-col items-center py-10 gap-3">
            <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
            <div className="text-sm text-muted-foreground">Checking token…</div>
          </div>
        )}

        {step === 'ready' && (
          <div className="space-y-4">
            <div className="flex flex-col items-center py-4 gap-2">
              <div className="p-3 rounded-full bg-[var(--color-info)]/10">
                <DownloadIcon className="h-6 w-6 text-[var(--color-info)]" />
              </div>
              <div className="text-center space-y-0.5">
                {tokenAmount > 0 ? (
                  <div className="amount-display text-3xl font-bold text-foreground">
                    {formatAmount(tokenAmount, tokenUnit)}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">Ready to claim</div>
                )}
                <div className="text-[11px] text-muted-foreground">
                  from {truncateMintUrl(mintUrl)}
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleClaim}
                className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
              >
                Claim
              </button>
            </div>
          </div>
        )}

        {step === 'claiming' && (
          <div className="flex flex-col items-center py-10 gap-3">
            <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
            <div className="text-sm text-muted-foreground">Claiming…</div>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center py-10 gap-3 animate-in fade-in duration-200">
            <CheckCircleIcon className="h-14 w-14 text-[var(--color-success)]" />
            <div className="text-center space-y-1">
              <div className="text-lg font-semibold">Received</div>
              <div className="amount-display text-3xl font-bold text-foreground">
                {formatAmount(receivedAmount, tokenUnit)}
              </div>
            </div>
            <button
              onClick={onClose}
              className="mt-4 px-8 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          </div>
        )}

        {step === 'error' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-destructive/10 border border-destructive/30">
              <AlertCircleIcon className="h-4 w-4 text-destructive shrink-0" />
              <div className="text-xs text-muted-foreground">{errorMsg}</div>
            </div>
            <button
              onClick={onClose}
              className="w-full px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </DialogWrapper>
  );
};

// ---------------------------------------------------------------------------
// LNURL-withdraw mode
// ---------------------------------------------------------------------------

type WithdrawStep = 'resolving' | 'ready' | 'withdrawing' | 'waiting' | 'done' | 'error';

const LnurlWithdrawPane: React.FC<{
  mints: Mint[];
  lnurl: string;
  onClose: () => void;
  onProofsReceived: (mintContextId: string, proofs: Proof[], mintUrl: string) => Promise<void>;
  onTransactionCreated: (data: Omit<TransactionData, 'createdAt'>) => Promise<string | undefined | void>;
}> = ({ mints, lnurl, onClose, onProofsReceived, onTransactionCreated }) => {
  // LNURL-withdraw amounts are defined in millisats/sats by the LN service.
  // Only sat-unit mints are semantically valid here — a usd-unit mint would
  // create a quote in cents while the amount is in sats.
  const satMints = useMemo(() => mints.filter((m) => m.unit === 'sat'), [mints]);

  const [step, setStep] = useState<WithdrawStep>('resolving');
  const [withdrawInfo, setWithdrawInfo] = useState<{
    callback: string; k1: string;
    minSats: number; maxSats: number; description: string;
  } | null>(null);
  const [selectedMint, setSelectedMint] = useState<Mint | null>(satMints[0] ?? null);
  const [amount, setAmount] = useState('');
  const [receivedAmount, setReceivedAmount] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const stopPollingRef = useRef<(() => void) | undefined>();
  const mountedRef = useRef(true);

  const preventClose = step === 'withdrawing' || step === 'waiting';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPollingRef.current?.();
    };
  }, []);

  // ── Resolve the LNURL to get withdraw info ──
  useEffect(() => {
    if (satMints.length === 0) {
      setErrorMsg('LNURL-withdraw requires a sat-unit mint. Add a sat mint first.');
      setStep('error');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Decode if it's a bech32 LNURL, otherwise use as-is (plain URL)
        const url = lnurl.toLowerCase().startsWith('lnurl1')
          ? decodeLnurl(lnurl)
          : lnurl;
        const info = await fetchLnurlWithdrawInfo(url);
        if (cancelled) return;

        const minSats = msatToSats(info.minWithdrawable);
        const maxSats = msatToSats(info.maxWithdrawable);
        setWithdrawInfo({
          callback: info.callback,
          k1: info.k1,
          minSats,
          maxSats,
          description: info.defaultDescription,
        });
        // Pre-fill with max amount (most common for faucets/rewards)
        setAmount(String(maxSats));
        setStep('ready');
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : 'Failed to resolve LNURL');
        setStep('error');
      }
    })();
    return () => { cancelled = true; };
  }, [lnurl, satMints.length]);

  const handleWithdraw = async () => {
    if (!withdrawInfo || !selectedMint) return;
    const amt = parseInt(amount, 10);
    if (isNaN(amt) || amt < withdrawInfo.minSats || amt > withdrawInfo.maxSats) return;

    setStep('withdrawing');
    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = await acquireWalletLock('lnurl-withdraw');
    } catch {
      toastError('Wallet busy', new Error('Another wallet operation is in progress.'));
      setStep('ready');
      return;
    }

    try {
      // LNURL-withdraw is always in sats (Lightning denomination).
      const unit = 'sat';

      // Step 1: Create a mint quote (Lightning invoice) at our mint
      const quote = await createMintQuote(selectedMint.url, amt, unit);
      if (!mountedRef.current) return;

      // Step 2: Submit the invoice to the LNURL-withdraw service
      await submitLnurlWithdraw(withdrawInfo.callback, withdrawInfo.k1, quote.request);
      if (!mountedRef.current) return;
      setStep('waiting');

      // Step 3: Wait for the service to pay the invoice (poll/WS)
      const mintUrl = selectedMint.url;
      const mintUnit = unit;
      const mintCtx = selectedMint.contextId;
      const quoteId = quote.quote;
      const quoteExpiry = quote.expiry ?? null;

      stopPollingRef.current = subscribeToQuote({
        mintUrl,
        quoteId,
        quoteType: 'bolt11_mint_quote',
        callbacks: {
          onPaid: async () => {
            if (!mountedRef.current) return;
            try {
              const proofs = await mintTokens(mintUrl, amt, quoteId, mintUnit);
              if (!mountedRef.current) return;

              if (!(await isDleqValid(mintUrl, proofs))) {
                console.warn('[nutsd:financial] DLEQ verification failed on LNURL-withdraw proofs');
              }

              await onProofsReceived(mintCtx, proofs, mintUrl);
              await onTransactionCreated({
                type   : 'mint',
                amount : amt,
                unit   : mintUnit,
                mintUrl,
                status : 'completed',
                memo   : `LNURL withdraw${withdrawInfo.description ? `: ${withdrawInfo.description}` : ''}`,
              });

              if (mountedRef.current) {
                setReceivedAmount(amt);
                setStep('done');
                toastSuccess('Received!', `+${formatAmount(amt, mintUnit)}`);
              }
            } catch (err) {
              if (mountedRef.current) {
                setErrorMsg(err instanceof Error ? err.message : 'Failed to mint tokens');
                setStep('error');
              }
            } finally {
              releaseLock?.();
              releaseLock = undefined;
            }
          },
          onExpired: () => {
            releaseLock?.();
            if (mountedRef.current) {
              setErrorMsg('The invoice expired before the service paid it.');
              setStep('error');
            }
          },
          onIssued: () => {
            releaseLock?.();
            if (mountedRef.current) {
              setErrorMsg('These tokens were already minted (possibly in another session).');
              setStep('error');
            }
          },
          isActive: () => mountedRef.current,
        },
        checkFn: () => checkMintQuote(mintUrl, quoteId, mintUnit).then((s) => ({
          state  : s.state as 'UNPAID' | 'PAID' | 'ISSUED',
          expiry : s.expiry ?? null,
        })),
        expiry: quoteExpiry,
      });
    } catch (err) {
      releaseLock?.();
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  const amtNum = parseInt(amount, 10) || 0;
  const inRange = withdrawInfo
    ? amtNum >= withdrawInfo.minSats && amtNum <= withdrawInfo.maxSats
    : false;

  return (
    <DialogWrapper
      open={true}
      onClose={onClose}
      title="LNURL Withdraw"
      maxWidth="max-w-md"
      preventClose={preventClose}
    >
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DownloadIcon className="h-5 w-5 text-[var(--color-info)]" />
            <h3 className="text-lg font-semibold">
              {step === 'done' ? 'Received!' : 'LNURL Withdraw'}
            </h3>
          </div>
          {!preventClose && (
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        {step === 'resolving' && (
          <div className="flex flex-col items-center py-10 gap-3">
            <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
            <div className="text-sm text-muted-foreground">Resolving LNURL...</div>
          </div>
        )}

        {step === 'ready' && withdrawInfo && (
          <div className="space-y-4">
            {withdrawInfo.description && (
              <p className="text-xs text-muted-foreground text-center">{withdrawInfo.description}</p>
            )}

            {satMints.length > 1 && (
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground px-1">
                  Mint
                </label>
                <select
                  value={selectedMint?.contextId ?? ''}
                  onChange={(e) => setSelectedMint(satMints.find((m) => m.contextId === e.target.value) ?? null)}
                  className="w-full px-3 py-2.5 rounded-lg bg-background border border-border text-sm"
                >
                  {satMints.map((m) => (
                    <option key={m.contextId} value={m.contextId}>{m.name || truncateMintUrl(m.url)}</option>
                  ))}
                </select>
              </div>
            )}

            <AmountInput
              value={amount}
              onChange={setAmount}
              unit="sat"
              max={withdrawInfo.maxSats}
              autoFocus
            />

            {withdrawInfo.minSats !== withdrawInfo.maxSats && (
              <p className="text-[10px] text-muted-foreground text-center">
                {formatAmount(withdrawInfo.minSats)} – {formatAmount(withdrawInfo.maxSats)} sats available
              </p>
            )}

            <button
              onClick={handleWithdraw}
              disabled={!inRange || !selectedMint}
              className="w-full px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Withdraw
            </button>
          </div>
        )}

        {step === 'withdrawing' && (
          <div className="flex flex-col items-center py-10 gap-3">
            <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
            <div className="text-sm text-muted-foreground">Submitting withdrawal request...</div>
          </div>
        )}

        {step === 'waiting' && (
          <div className="flex flex-col items-center py-10 gap-3">
            <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
            <div className="text-sm text-muted-foreground">Waiting for service to pay...</div>
          </div>
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center py-10 gap-3 animate-in fade-in duration-200">
            <CheckCircleIcon className="h-14 w-14 text-[var(--color-success)]" />
            <div className="text-center space-y-1">
              <div className="text-lg font-semibold">Received</div>
              <div className="amount-display text-3xl font-bold text-foreground">
                {formatAmount(receivedAmount, 'sat')}
              </div>
            </div>
            <button
              onClick={onClose}
              className="mt-4 px-8 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          </div>
        )}

        {step === 'error' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-destructive/10 border border-destructive/30">
              <AlertCircleIcon className="h-4 w-4 text-destructive shrink-0" />
              <div className="text-xs text-muted-foreground">{errorMsg}</div>
            </div>
            <button
              onClick={onClose}
              className="w-full px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </DialogWrapper>
  );
};
