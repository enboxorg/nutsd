/**
 * Detection-driven confirm card used inside the Unified Send dialog.
 *
 * Given a `DetectedInput` (from `input-detect.ts`), this component renders
 * the appropriate confirmation pane and drives the actual send operation.
 *
 * Each sub-card is self-contained:
 *   - Manages its own mini state machine (loading, error, intermediate steps)
 *   - Calls through to the shared SendContext to perform mint operations
 *   - Notifies the parent when the operation becomes blocking via `onBusyChange`
 *     (so the outer DialogWrapper can switch `preventClose` on)
 *   - Calls `onDone` once the operation succeeds
 *
 * Supported detected types:
 *   - lightning-invoice → InvoiceConfirm (auto-quote → confirm → melt)
 *   - payment-request   → PaymentRequestConfirm (decode → confirm → swap+encode)
 *   - lnurl / lightning-address → LnurlConfirm (resolve → amount → invoice → melt)
 *   - did               → DidConfirm (resolve pubkey → amount → P2PK send)
 *   - cashu-token       → MismatchCard (prompt: receive instead)
 *   - mint-url          → MismatchCard (prompt: add mint)
 *   - unknown           → MismatchCard (prompt: try again)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  CheckCircleIcon,
  DownloadIcon,
  FileTextIcon,
  GlobeIcon,
  Loader2Icon,
  UsersIcon,
  ZapIcon,
} from 'lucide-react';
import type { Proof } from '@cashu/cashu-ts';

import type { DetectedInput } from '@/lib/input-detect';
import type { Mint, StoredProof } from '@/hooks/use-wallet';
import type { TransactionData } from '@/protocol/cashu-wallet-protocol';
import {
  CashuTransferProtocol,
  assertP2PKLocked,
  type TransferData,
  type P2pkPublicKeyData,
} from '@/protocol/cashu-transfer-protocol';

import {
  createMeltQuote,
  meltTokens,
  checkMeltQuote,
  estimateInputFee,
  swapProofs,
  type MeltQuoteBolt11Response,
} from '@/cashu/wallet-ops';
import { encodeToken } from '@/cashu/token-utils';
import { decodeInvoice, formatInvoiceAmount } from '@/cashu/invoice-decode';
import { decodePaymentRequest, type PaymentRequest } from '@/cashu/payment-request';
import { sendP2pkLocked } from '@/cashu/p2pk';
import {
  resolveLightningAddress,
  resolveLnurl,
  requestLnurlInvoice,
  LnurlWithdrawDetectedError,
  msatToSats,
  satsToMsat,
  type LnurlPayResponse,
} from '@/lib/lnurl';
import { acquireWalletLock, isUnloading } from '@/lib/wallet-mutex';

import { toastError, formatAmount, truncateMintUrl, truncateMiddle } from '@/lib/utils';
import { AmountInput } from '@/components/wallet/amount-input';

// ---------------------------------------------------------------------------
// Shared context & types
// ---------------------------------------------------------------------------

/** Everything a confirm card needs from the parent. */
export interface SendContext {
  mints: Mint[];
  mintBalances: Map<string, number>;
  /** Balances keyed by mint contextId (needed for multi-unit payment requests). */
  mintBalancesByContext: Map<string, number>;
  keysetFeeMap: Map<string, number>;
  getUnspentProofs: (mintUrl: string) => StoredProof[];
  /** Used by payment-request matching which needs per-context proofs. */
  getUnspentProofsByContext: (contextId: string) => StoredProof[];
  onNewProofs: (mintContextId: string, proofs: Proof[]) => Promise<boolean>;
  onOldProofsSpent: (ids: string[]) => Promise<void>;
  onMarkPending: (ids: string[]) => Promise<void>;
  onRevertPending: (ids: string[]) => Promise<void>;
  onTransactionCreated: (
    data: Omit<TransactionData, 'createdAt'>,
  ) => Promise<string | undefined | void>;
  /** Mark a tx as claimed (confirmed SPENT via NUT-07). Only relevant for the P2PK send case. */
  onMarkClaimed: (txId: string) => Promise<void>;
  /** Sender's own DID — required for P2P (DID) sends. */
  senderDid: string | undefined;
  /** Enbox instance for DWN writes — required for P2P (DID) sends. */
  enbox: any;
}

/** Outcome a confirm card returns to the parent. */
export type SendOutcome =
  /** Payment completed instantly (Lightning melt, LNURL pay, P2P DID transfer). */
  | { kind: 'sent'; amount: number; unit: string; memo?: string }
  /**
   * A cashu token has been created and now needs to be manually shared with
   * the requester (NUT-18 payment request has no automated delivery transport).
   * The outer dialog should display the token as a shareable QR/copy view
   * and start claim-status polling.
   */
  | { kind: 'token-ready'; token: string; amount: number; unit: string; mintUrl: string; txId?: string; memo?: string }
  /** The detected input was actually a receive — pivot to the Receive dialog. */
  | { kind: 'switch-to-receive'; token: string }
  /** The detected input was a mint URL — pivot to the Add Mint dialog. */
  | { kind: 'switch-to-add-mint'; mintUrl: string }
  /** The LNURL resolved to a withdraw link — pivot to the Receive dialog. */
  | { kind: 'switch-to-lnurl-withdraw'; lnurl: string };

interface DetectConfirmCardProps {
  detected: DetectedInput;
  ctx: SendContext;
  /** Called when the pane wants to return to the scan/paste chooser. */
  onBack: () => void;
  /** Called once the operation completes or should hand off. */
  onDone: (outcome: SendOutcome) => void;
  /** Fired whenever the pane enters/leaves a state that must block dismissal. */
  onBusyChange: (busy: boolean) => void;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const DetectConfirmCard: React.FC<DetectConfirmCardProps> = ({
  detected,
  ctx,
  onBack,
  onDone,
  onBusyChange,
}) => {
  switch (detected.type) {
    case 'lightning-invoice':
      return (
        <InvoiceConfirm
          invoice={detected.value}
          ctx={ctx}
          onBack={onBack}
          onDone={onDone}
          onBusyChange={onBusyChange}
        />
      );
    case 'payment-request':
      return (
        <PaymentRequestConfirm
          encoded={detected.value}
          ctx={ctx}
          onBack={onBack}
          onDone={onDone}
          onBusyChange={onBusyChange}
        />
      );
    case 'lnurl':
    case 'lightning-address':
      return (
        <LnurlConfirm
          target={detected.value}
          kind={detected.type}
          ctx={ctx}
          onBack={onBack}
          onDone={onDone}
          onBusyChange={onBusyChange}
        />
      );
    case 'did':
      return (
        <DidConfirm
          recipientDid={detected.value}
          ctx={ctx}
          onBack={onBack}
          onDone={onDone}
          onBusyChange={onBusyChange}
        />
      );
    case 'cashu-token':
      return (
        <MismatchCard
          kind="cashu-token"
          onBack={onBack}
          onSwitch={() => onDone({ kind: 'switch-to-receive', token: detected.value })}
        />
      );
    case 'mint-url':
      return (
        <MismatchCard
          kind="mint-url"
          onBack={onBack}
          onSwitch={() => onDone({ kind: 'switch-to-add-mint', mintUrl: detected.value })}
        />
      );
    default:
      return (
        <MismatchCard
          kind="unknown"
          onBack={onBack}
        />
      );
  }
};

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * The small "To: Lightning invoice" header shown at the top of every confirm
 * card. Gives context for what the user is about to send.
 */
const CardHeader: React.FC<{
  icon: React.ReactNode;
  label: string;
  subtitle?: React.ReactNode;
}> = ({ icon, label, subtitle }) => (
  <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/50 border border-border">
    <div className="p-2 rounded-full bg-background">{icon}</div>
    <div className="min-w-0 flex-1">
      <div className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground">
        {label}
      </div>
      {subtitle && (
        <div className="text-xs text-foreground truncate">{subtitle}</div>
      )}
    </div>
  </div>
);

/**
 * Convert StoredProof[] → Proof[] including optional dleq/witness metadata.
 * Extracted because every confirm card needs this.
 */
function toCashuProofs(stored: StoredProof[]): Proof[] {
  return stored.map((p) => ({
    amount : p.amount,
    id     : p.keysetId,
    secret : p.secret,
    C      : p.C,
    ...(p.dleq    ? { dleq    : p.dleq } : {}),
    ...(p.witness ? { witness : p.witness } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Lightning invoice confirm
// ---------------------------------------------------------------------------

type InvoiceStep = 'quoting' | 'confirm' | 'paying' | 'done' | 'error';

const InvoiceConfirm: React.FC<{
  invoice: string;
  ctx: SendContext;
  onBack: () => void;
  onDone: (outcome: SendOutcome) => void;
  onBusyChange: (busy: boolean) => void;
}> = ({ invoice, ctx, onBack, onDone, onBusyChange }) => {
  // Decode once — this is cheap and never changes.
  const decoded = useMemo(() => {
    try { return decodeInvoice(invoice); }
    catch { return null; }
  }, [invoice]);

  const [selectedMint, setSelectedMint] = useState<Mint | null>(ctx.mints[0] ?? null);
  const [step, setStep] = useState<InvoiceStep>('quoting');
  const [quoteAmount, setQuoteAmount] = useState(0);
  const [quoteFee, setQuoteFee] = useState(0);
  const [inputFee, setInputFee] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const quoteRef = useRef<MeltQuoteBolt11Response | null>(null);
  const pendingIdsRef = useRef<string[]>([]);

  // Propagate "busy" state up while paying.
  useEffect(() => { onBusyChange(step === 'paying' || step === 'quoting'); }, [step, onBusyChange]);

  // Get a fresh quote whenever the selected mint changes (or on mount).
  const fetchQuote = useCallback(async (mint: Mint) => {
    setStep('quoting');
    setErrorMsg('');
    try {
      const quote = await createMeltQuote(mint.url, invoice.trim(), mint.unit);
      quoteRef.current = quote;
      setQuoteAmount(quote.amount);
      setQuoteFee(quote.fee_reserve);

      const stored = ctx.getUnspentProofs(mint.url);
      setInputFee(estimateInputFee(toCashuProofs(stored), ctx.keysetFeeMap));
      setStep('confirm');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  }, [invoice, ctx]);

  // Mount: quote with default mint. Changing mint re-quotes.
  useEffect(() => {
    if (selectedMint) fetchQuote(selectedMint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMint]);

  const handleMintChange = (url: string) => {
    const m = ctx.mints.find((x) => x.url === url);
    if (m) setSelectedMint(m);
  };

  const balance = selectedMint ? (ctx.mintBalances.get(selectedMint.url) ?? 0) : 0;
  const total = quoteAmount + quoteFee + inputFee;
  const insufficient = total > balance;

  const handlePay = async () => {
    if (!selectedMint || !quoteRef.current || insufficient) return;
    setStep('paying');

    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = await acquireWalletLock('melt');
    } catch (err) {
      toastError('Wallet busy', new Error('Another wallet operation is in progress.'));
      setStep('confirm');
      return;
    }

    try {
      const stored = ctx.getUnspentProofs(selectedMint.url);
      const spentIds = stored.map((p) => p.id);
      const cashuProofs = toCashuProofs(stored);

      await ctx.onMarkPending(spentIds);
      pendingIdsRef.current = spentIds;

      const { paid, change } = await meltTokens(
        selectedMint.url, quoteRef.current, cashuProofs, selectedMint.unit,
      );

      if (paid) {
        if (change.length > 0) await ctx.onNewProofs(selectedMint.contextId, change);
        await ctx.onOldProofsSpent(spentIds);
        pendingIdsRef.current = [];

        await ctx.onTransactionCreated({
          type    : 'melt',
          amount  : quoteAmount,
          unit    : selectedMint.unit,
          mintUrl : selectedMint.url,
          status  : 'completed',
          memo    : 'Lightning withdrawal',
        });

        setStep('done');
        onDone({ kind: 'sent', amount: quoteAmount, unit: selectedMint.unit });
      } else {
        setErrorMsg(
          'Payment was not completed. Your proofs may be temporarily locked by the mint. '
          + 'They will be reconciled on next startup.',
        );
        setStep('error');
      }
    } catch (err) {
      if (isUnloading()) return;

      // Re-check the quote before reverting — see withdraw-dialog for full context.
      if (quoteRef.current && pendingIdsRef.current.length > 0) {
        try {
          const state = await checkMeltQuote(
            selectedMint.url, quoteRef.current.quote, selectedMint.unit,
          );
          if (state.state === 'UNPAID') {
            await ctx.onRevertPending(pendingIdsRef.current);
            pendingIdsRef.current = [];
          }
        } catch {
          // Best-effort — reconciliation will handle it on next startup.
        }
      }

      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    } finally {
      releaseLock?.();
    }
  };

  if (step === 'quoting') {
    return (
      <div className="space-y-4">
        <CardHeader
          icon={<ZapIcon className="h-4 w-4 text-[var(--color-warning)]" />}
          label="Lightning invoice"
          subtitle={decoded?.amountSats != null ? formatInvoiceAmount(decoded) : 'Decoding…'}
        />
        <div className="flex flex-col items-center py-6 gap-3">
          <Loader2Icon className="h-6 w-6 animate-spin text-primary" />
          <div className="text-xs text-muted-foreground">Getting a quote from the mint…</div>
        </div>
      </div>
    );
  }

  if (step === 'paying') {
    return (
      <div className="space-y-4">
        <CardHeader
          icon={<ZapIcon className="h-4 w-4 text-[var(--color-warning)]" />}
          label="Paying…"
        />
        <div className="flex flex-col items-center py-8 gap-3">
          <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
          <div className="text-sm text-muted-foreground">Paying the Lightning invoice…</div>
        </div>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="space-y-4">
        <CardHeader
          icon={<AlertCircleIcon className="h-4 w-4 text-destructive" />}
          label="Couldn't pay"
        />
        <p className="text-xs text-muted-foreground text-center">{errorMsg}</p>
        <div className="flex gap-2">
          <button
            onClick={onBack}
            className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
          >
            Back
          </button>
          <button
            onClick={() => selectedMint && fetchQuote(selectedMint)}
            className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // step === 'confirm'
  return (
    <div className="space-y-4">
      <CardHeader
        icon={<ZapIcon className="h-4 w-4 text-[var(--color-warning)]" />}
        label="Lightning invoice"
        subtitle={
          decoded
            ? <>
                {decoded.amountSats != null ? formatInvoiceAmount(decoded) : 'Open amount'}
                {decoded.description && (
                  <span className="text-muted-foreground"> · {decoded.description}</span>
                )}
              </>
            : truncateMiddle(invoice, 10, 10)
        }
      />

      {/* Mint selector — only if multiple */}
      {ctx.mints.length > 1 && (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground px-1">
            Pay from
          </label>
          <select
            value={selectedMint?.url ?? ''}
            onChange={(e) => handleMintChange(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {ctx.mints.map((m) => (
              <option key={m.url} value={m.url}>
                {m.name || truncateMintUrl(m.url)} ({formatAmount(ctx.mintBalances.get(m.url) ?? 0, m.unit)})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Fee breakdown */}
      <div className="p-3 rounded-xl bg-background border border-border space-y-1.5 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Amount</span>
          <span className="amount-display font-medium">{formatAmount(quoteAmount, selectedMint?.unit)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Lightning fee</span>
          <span className="amount-display font-medium">{formatAmount(quoteFee, selectedMint?.unit)}</span>
        </div>
        {inputFee > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Mint fee</span>
            <span className="amount-display font-medium">{formatAmount(inputFee, selectedMint?.unit)}</span>
          </div>
        )}
        <div className="border-t border-border pt-1.5 flex justify-between text-sm font-semibold">
          <span>Total</span>
          <span className="amount-display">{formatAmount(total, selectedMint?.unit)}</span>
        </div>
      </div>

      {insufficient && (
        <p className="text-[11px] text-destructive text-center">
          Insufficient balance. You need {formatAmount(total, selectedMint?.unit)} but only have {formatAmount(balance, selectedMint?.unit)}.
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
        >
          Back
        </button>
        <button
          onClick={handlePay}
          disabled={insufficient}
          className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Pay {formatAmount(total, selectedMint?.unit)}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// NUT-18 Payment request confirm
// ---------------------------------------------------------------------------

type PayRequestStep = 'confirm' | 'sending' | 'error';

const PaymentRequestConfirm: React.FC<{
  encoded: string;
  ctx: SendContext;
  onBack: () => void;
  onDone: (outcome: SendOutcome) => void;
  onBusyChange: (busy: boolean) => void;
}> = ({ encoded, ctx, onBack, onDone, onBusyChange }) => {
  const request = useMemo<PaymentRequest | null>(() => {
    try { return decodePaymentRequest(encoded); }
    catch { return null; }
  }, [encoded]);

  const [step, setStep] = useState<PayRequestStep>('confirm');
  const [customAmount, setCustomAmount] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const pendingIdsRef = useRef<string[]>([]);

  useEffect(() => { onBusyChange(step === 'sending'); }, [step, onBusyChange]);

  if (!request) {
    return (
      <div className="space-y-4">
        <CardHeader icon={<AlertCircleIcon className="h-4 w-4 text-destructive" />} label="Invalid request" />
        <p className="text-xs text-muted-foreground text-center">Could not decode this payment request.</p>
        <button
          onClick={onBack}
          className="w-full px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium"
        >
          Back
        </button>
      </div>
    );
  }

  const requestUnit = request.unit ?? 'sat';
  // Match a mint that supports the request's accepted mints AND unit.
  const matchingMint = request.mints?.length
    ? ctx.mints.find((m) => request.mints!.includes(m.url) && m.unit === requestUnit)
    : ctx.mints.find((m) => m.unit === requestUnit);

  const isOpenAmount = !request.amount || request.amount <= 0;
  const amount = isOpenAmount ? (parseInt(customAmount, 10) || 0) : (request.amount ?? 0);
  const balance = matchingMint ? (ctx.mintBalancesByContext.get(matchingMint.contextId) ?? 0) : 0;
  const canPay = matchingMint != null && amount > 0 && amount <= balance;

  const handlePay = async () => {
    if (!matchingMint || !canPay) return;
    setStep('sending');

    let releaseLock: (() => void) | undefined;
    try { releaseLock = await acquireWalletLock('pay-request'); }
    catch {
      toastError('Wallet busy', new Error('Another wallet operation is in progress.'));
      setStep('confirm');
      return;
    }

    let swapCompleted = false;
    try {
      const stored = ctx.getUnspentProofsByContext(matchingMint.contextId);
      const spentIds = stored.map((p) => p.id);
      const cashuProofs = toCashuProofs(stored);

      await ctx.onMarkPending(spentIds);
      pendingIdsRef.current = spentIds;

      const { send, keep } = await swapProofs(
        matchingMint.url, cashuProofs, amount, matchingMint.unit, { includeFees: true },
      );
      swapCompleted = true;
      const encodedToken = encodeToken(matchingMint.url, send, matchingMint.unit);

      if (keep.length > 0) await ctx.onNewProofs(matchingMint.contextId, keep);
      await ctx.onOldProofsSpent(spentIds);
      pendingIdsRef.current = [];

      const txId = await ctx.onTransactionCreated({
        type        : 'send',
        amount,
        unit        : matchingMint.unit,
        mintUrl     : matchingMint.url,
        status      : 'completed',
        claimStatus : 'pending',
        cashuToken  : encodedToken,
        memo        : request.description || (request.id ? `Request ${request.id}` : undefined),
      });

      // NUT-18 has no automatic delivery transport — hand the token back to
      // the outer dialog so the user can share it with the requester.
      onDone({
        kind    : 'token-ready',
        token   : encodedToken,
        amount,
        unit    : matchingMint.unit,
        mintUrl : matchingMint.url,
        txId    : typeof txId === 'string' ? txId : undefined,
        memo    : request.description,
      });
    } catch (err) {
      // Revert pending proofs if the swap never completed — the mint
      // hasn't consumed them so they're safe to unlock.
      if (!swapCompleted && pendingIdsRef.current.length > 0) {
        ctx.onRevertPending(pendingIdsRef.current).catch(() => {});
        pendingIdsRef.current = [];
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    } finally {
      releaseLock?.();
    }
  };

  if (step === 'sending') {
    return (
      <div className="space-y-4">
        <CardHeader icon={<FileTextIcon className="h-4 w-4 text-primary" />} label="Creating payment…" />
        <div className="flex flex-col items-center py-8 gap-3">
          <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
          <div className="text-sm text-muted-foreground">Crafting your payment token…</div>
        </div>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="space-y-4">
        <CardHeader icon={<AlertCircleIcon className="h-4 w-4 text-destructive" />} label="Payment failed" />
        <p className="text-xs text-muted-foreground text-center">{errorMsg}</p>
        <div className="flex gap-2">
          <button onClick={onBack} className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted">Back</button>
          <button onClick={() => setStep('confirm')} className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium">Try again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <CardHeader
        icon={<FileTextIcon className="h-4 w-4 text-primary" />}
        label="Payment request"
        subtitle={request.description || (isOpenAmount ? 'Any amount' : formatAmount(request.amount ?? 0, requestUnit))}
      />

      {request.mints && request.mints.length > 0 && (
        <p className="text-[11px] text-muted-foreground text-center">
          Accepted: {request.mints.map((u) => truncateMintUrl(u)).join(', ')}
        </p>
      )}

      {/* Amount input (only for open-amount requests) */}
      {isOpenAmount && matchingMint && (
        <AmountInput
          value={customAmount}
          onChange={setCustomAmount}
          unit={matchingMint.unit}
          max={balance}
          helper={`Balance: ${formatAmount(balance, matchingMint.unit)}`}
        />
      )}

      {!matchingMint && (
        <p className="text-[11px] text-destructive text-center">
          You don&apos;t have a mint that matches this request
          {requestUnit !== 'sat' ? ` (unit: ${requestUnit})` : ''}.
        </p>
      )}

      {matchingMint && amount > balance && (
        <p className="text-[11px] text-destructive text-center">
          Insufficient balance at {truncateMintUrl(matchingMint.url)} ({formatAmount(balance, matchingMint.unit)}).
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
        >
          Back
        </button>
        <button
          onClick={handlePay}
          disabled={!canPay}
          className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Pay {amount > 0 ? formatAmount(amount, requestUnit) : ''}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// LNURL / Lightning address confirm
// ---------------------------------------------------------------------------

type LnurlStep = 'resolving' | 'amount' | 'fetching-invoice' | 'confirm' | 'paying' | 'error';

const LnurlConfirm: React.FC<{
  target: string;
  kind: 'lnurl' | 'lightning-address';
  ctx: SendContext;
  onBack: () => void;
  onDone: (outcome: SendOutcome) => void;
  onBusyChange: (busy: boolean) => void;
}> = ({ target, kind, ctx, onBack, onDone, onBusyChange }) => {
  const [step, setStep] = useState<LnurlStep>('resolving');
  const [payInfo, setPayInfo] = useState<LnurlPayResponse | null>(null);
  const [selectedMint, setSelectedMint] = useState<Mint | null>(ctx.mints[0] ?? null);
  const [amount, setAmount] = useState('');
  const [quoteAmount, setQuoteAmount] = useState(0);
  const [quoteFee, setQuoteFee] = useState(0);
  const [inputFee, setInputFee] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const quoteRef = useRef<MeltQuoteBolt11Response | null>(null);
  const pendingIdsRef = useRef<string[]>([]);

  useEffect(() => {
    onBusyChange(step === 'paying' || step === 'fetching-invoice');
  }, [step, onBusyChange]);

  // Resolve the LNURL/address once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = kind === 'lightning-address'
          ? await resolveLightningAddress(target)
          : await resolveLnurl(target);
        if (cancelled) return;
        setPayInfo(info);
        setStep('amount');
      } catch (err) {
        if (cancelled) return;
        // LNURL-withdraw is a receive operation — redirect to the Receive flow.
        if (err instanceof LnurlWithdrawDetectedError) {
          onDone({ kind: 'switch-to-lnurl-withdraw', lnurl: target });
          return;
        }
        setErrorMsg(err instanceof Error ? err.message : 'Failed to resolve address');
        setStep('error');
      }
    })();
    return () => { cancelled = true; };
  }, [target, kind, onDone]);

  const balance = selectedMint ? (ctx.mintBalances.get(selectedMint.url) ?? 0) : 0;
  const minSats = payInfo ? msatToSats(payInfo.minSendable) : 1;
  const maxSats = payInfo ? Math.min(msatToSats(payInfo.maxSendable), balance) : balance;
  const amtNum = parseInt(amount, 10) || 0;
  const amtInRange = amtNum >= minSats && amtNum <= maxSats;

  const handleFetchInvoice = async () => {
    if (!selectedMint || !payInfo || !amtInRange) return;
    setStep('fetching-invoice');
    try {
      const invoice = await requestLnurlInvoice(payInfo.callback, satsToMsat(amtNum));

      const quote = await createMeltQuote(selectedMint.url, invoice, selectedMint.unit);
      quoteRef.current = quote;
      setQuoteAmount(quote.amount);
      setQuoteFee(quote.fee_reserve);

      const stored = ctx.getUnspentProofs(selectedMint.url);
      setInputFee(estimateInputFee(toCashuProofs(stored), ctx.keysetFeeMap));

      setStep('confirm');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  const handlePay = async () => {
    if (!selectedMint || !quoteRef.current) return;
    setStep('paying');

    let releaseLock: (() => void) | undefined;
    try { releaseLock = await acquireWalletLock('lnurl-melt'); }
    catch {
      toastError('Wallet busy', new Error('Another wallet operation is in progress.'));
      setStep('confirm');
      return;
    }

    try {
      const stored = ctx.getUnspentProofs(selectedMint.url);
      const spentIds = stored.map((p) => p.id);
      const cashuProofs = toCashuProofs(stored);

      await ctx.onMarkPending(spentIds);
      pendingIdsRef.current = spentIds;

      const { paid, change } = await meltTokens(
        selectedMint.url, quoteRef.current, cashuProofs, selectedMint.unit,
      );

      if (paid) {
        if (change.length > 0) await ctx.onNewProofs(selectedMint.contextId, change);
        await ctx.onOldProofsSpent(spentIds);
        pendingIdsRef.current = [];

        await ctx.onTransactionCreated({
          type    : 'melt',
          amount  : quoteAmount,
          unit    : selectedMint.unit,
          mintUrl : selectedMint.url,
          status  : 'completed',
          memo    : `Paid ${target}`,
        });

        onDone({ kind: 'sent', amount: quoteAmount, unit: selectedMint.unit, memo: target });
      } else {
        setErrorMsg('Payment was not completed. Proofs will be checked on next startup.');
        setStep('error');
      }
    } catch (err) {
      if (isUnloading()) return;

      // Re-check quote to decide whether to revert pending.
      if (quoteRef.current && pendingIdsRef.current.length > 0) {
        try {
          const state = await checkMeltQuote(selectedMint.url, quoteRef.current.quote, selectedMint.unit);
          if (state.state === 'UNPAID') {
            await ctx.onRevertPending(pendingIdsRef.current);
            pendingIdsRef.current = [];
          }
        } catch {
          // Expected: leave pending for reconciliation
        }
      }

      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    } finally {
      releaseLock?.();
    }
  };

  const displayTarget = payInfo?.displayName || target;

  if (step === 'resolving') {
    return (
      <div className="space-y-4">
        <CardHeader
          icon={<ZapIcon className="h-4 w-4 text-[var(--color-warning)]" />}
          label="Resolving…"
          subtitle={target}
        />
        <div className="flex flex-col items-center py-6 gap-3">
          <Loader2Icon className="h-6 w-6 animate-spin text-primary" />
          <div className="text-xs text-muted-foreground">Looking up {target}…</div>
        </div>
      </div>
    );
  }

  if (step === 'fetching-invoice' || step === 'paying') {
    return (
      <div className="space-y-4">
        <CardHeader
          icon={<ZapIcon className="h-4 w-4 text-[var(--color-warning)]" />}
          label={step === 'paying' ? 'Paying…' : 'Getting invoice…'}
          subtitle={displayTarget}
        />
        <div className="flex flex-col items-center py-8 gap-3">
          <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
          <div className="text-sm text-muted-foreground">
            {step === 'paying' ? `Paying ${displayTarget}…` : 'Requesting invoice from service…'}
          </div>
        </div>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="space-y-4">
        <CardHeader icon={<AlertCircleIcon className="h-4 w-4 text-destructive" />} label="Couldn't pay" />
        <p className="text-xs text-muted-foreground text-center">{errorMsg}</p>
        <div className="flex gap-2">
          <button onClick={onBack} className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted">Back</button>
          {payInfo && (
            <button onClick={() => setStep('amount')} className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium">Try again</button>
          )}
        </div>
      </div>
    );
  }

  if (step === 'confirm' && payInfo) {
    const total = quoteAmount + quoteFee + inputFee;
    const insufficient = total > balance;
    return (
      <div className="space-y-4">
        <CardHeader
          icon={<ZapIcon className="h-4 w-4 text-[var(--color-warning)]" />}
          label="Paying"
          subtitle={<span className="truncate">{displayTarget}</span>}
        />

        <div className="p-3 rounded-xl bg-background border border-border space-y-1.5 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount</span>
            <span className="amount-display font-medium">{formatAmount(quoteAmount, selectedMint?.unit)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Lightning fee</span>
            <span className="amount-display font-medium">{formatAmount(quoteFee, selectedMint?.unit)}</span>
          </div>
          {inputFee > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Mint fee</span>
              <span className="amount-display font-medium">{formatAmount(inputFee, selectedMint?.unit)}</span>
            </div>
          )}
          <div className="border-t border-border pt-1.5 flex justify-between text-sm font-semibold">
            <span>Total</span>
            <span className="amount-display">{formatAmount(total, selectedMint?.unit)}</span>
          </div>
        </div>

        {insufficient && (
          <p className="text-[11px] text-destructive text-center">Insufficient balance.</p>
        )}

        <div className="flex gap-2">
          <button onClick={() => setStep('amount')} className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors">Back</button>
          <button
            onClick={handlePay}
            disabled={insufficient}
            className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Pay {formatAmount(total, selectedMint?.unit)}
          </button>
        </div>
      </div>
    );
  }

  // step === 'amount'
  return (
    <div className="space-y-4">
      <CardHeader
        icon={<ZapIcon className="h-4 w-4 text-[var(--color-warning)]" />}
        label={kind === 'lightning-address' ? 'Lightning address' : 'LNURL'}
        subtitle={
          <>
            <span className="truncate">{displayTarget}</span>
            {payInfo?.description && (
              <span className="text-muted-foreground"> · {payInfo.description}</span>
            )}
          </>
        }
      />

      {ctx.mints.length > 1 && (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground px-1">Pay from</label>
          <select
            value={selectedMint?.url ?? ''}
            onChange={(e) => setSelectedMint(ctx.mints.find((m) => m.url === e.target.value) ?? null)}
            className="w-full px-3 py-2.5 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {ctx.mints.map((m) => (
              <option key={m.url} value={m.url}>
                {m.name || truncateMintUrl(m.url)} ({formatAmount(ctx.mintBalances.get(m.url) ?? 0, m.unit)})
              </option>
            ))}
          </select>
        </div>
      )}

      <AmountInput
        value={amount}
        onChange={setAmount}
        unit={selectedMint?.unit ?? 'sat'}
        max={maxSats}
        helper={
          payInfo
            ? `Range: ${formatAmount(minSats)} – ${formatAmount(Math.min(msatToSats(payInfo.maxSendable), balance))}`
            : undefined
        }
        error={amtNum > 0 && !amtInRange
          ? (amtNum < minSats
              ? `Minimum is ${formatAmount(minSats)}`
              : `Maximum is ${formatAmount(maxSats)}`)
          : null}
      />

      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
        >
          Back
        </button>
        <button
          onClick={handleFetchInvoice}
          disabled={!amtInRange}
          className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Continue
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// DID (P2PK) confirm
// ---------------------------------------------------------------------------

type DidStep = 'resolving' | 'amount' | 'sending' | 'error';

const DidConfirm: React.FC<{
  recipientDid: string;
  ctx: SendContext;
  onBack: () => void;
  onDone: (outcome: SendOutcome) => void;
  onBusyChange: (busy: boolean) => void;
}> = ({ recipientDid, ctx, onBack, onDone, onBusyChange }) => {
  const [step, setStep] = useState<DidStep>('resolving');
  const [recipientPubkey, setRecipientPubkey] = useState('');
  const [selectedMint, setSelectedMint] = useState<Mint | null>(ctx.mints[0] ?? null);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => { onBusyChange(step === 'sending'); }, [step, onBusyChange]);

  // Resolve the recipient's published P2PK public key.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!ctx.enbox) {
        setErrorMsg('No enbox instance available.');
        setStep('error');
        return;
      }
      try {
        const transferTyped = ctx.enbox.using(CashuTransferProtocol);
        const { records } = await transferTyped.records.query('publicKey', {
          from: recipientDid,
        });
        if (cancelled) return;
        if (records && records.length > 0) {
          const data: P2pkPublicKeyData = await records[0].data.json();
          if (data.publicKey) {
            setRecipientPubkey(data.publicKey);
            setStep('amount');
            return;
          }
        }
        setErrorMsg('Recipient has no published P2PK key. They may need to open nutsd first.');
        setStep('error');
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : 'Failed to resolve recipient');
        setStep('error');
      }
    })();
    return () => { cancelled = true; };
  }, [recipientDid, ctx.enbox]);

  const balance = selectedMint ? (ctx.mintBalances.get(selectedMint.url) ?? 0) : 0;
  const amtNum = parseInt(amount, 10) || 0;
  const inputFee = useMemo(() => {
    if (!selectedMint) return 0;
    const stored = ctx.getUnspentProofs(selectedMint.url);
    return estimateInputFee(toCashuProofs(stored), ctx.keysetFeeMap);
  }, [selectedMint, ctx]);
  const total = amtNum + inputFee;
  const canSend = amtNum > 0 && total <= balance && !!recipientPubkey && !!selectedMint;

  const handleSend = async () => {
    if (!canSend || !selectedMint || !ctx.senderDid) return;
    setStep('sending');

    let releaseLock: (() => void) | undefined;
    try { releaseLock = await acquireWalletLock('p2p-send'); }
    catch {
      toastError('Wallet busy', new Error('Another wallet operation is in progress.'));
      setStep('amount');
      return;
    }

    let spentIds: string[] = [];
    let swapCompleted = false;
    try {
      const stored = ctx.getUnspentProofs(selectedMint.url);
      spentIds = stored.map((p) => p.id);
      const cashuProofs = toCashuProofs(stored);

      await ctx.onMarkPending(spentIds);

      const { send, keep } = await sendP2pkLocked(
        selectedMint.url, cashuProofs, amtNum, recipientPubkey.trim(), selectedMint.unit,
      );
      swapCompleted = true;

      const encodedToken = encodeToken(selectedMint.url, send, selectedMint.unit);

      const transferData: TransferData = {
        token           : encodedToken,
        amount          : amtNum,
        unit            : selectedMint.unit,
        mintUrl         : selectedMint.url,
        memo            : memo.trim() || undefined,
        senderDid       : ctx.senderDid,
        recipientPubkey : recipientPubkey.trim(),
      };
      // Pass raw proofs separately so V4 tokens validate without decoding.
      // The proofs are NOT serialized into the DWN record.
      assertP2PKLocked(transferData, send);

      // Persist change + tx BEFORE deleting old — crash-safety pattern.
      if (keep.length > 0) await ctx.onNewProofs(selectedMint.contextId, keep);

      await ctx.onTransactionCreated({
        type         : 'p2p-send',
        amount       : amtNum,
        unit         : selectedMint.unit,
        mintUrl      : selectedMint.url,
        status       : 'completed',
        claimStatus  : 'pending',
        cashuToken   : encodedToken,
        recipientDid : recipientDid,
        memo         : memo.trim() || undefined,
      });

      await ctx.onOldProofsSpent(spentIds);

      // Write to recipient's DWN (non-fatal if it fails — token is in our history)
      try {
        const transferTyped = ctx.enbox.using(CashuTransferProtocol);
        const { record } = await transferTyped.records.create('transfer', {
          data  : transferData,
          store : false,
        });
        if (record) {
          await record.send(recipientDid);
        }
      } catch (err) {
        console.warn('[nutsd] Failed to write transfer to recipient DWN:', err);
      }

      onDone({
        kind   : 'sent',
        amount : amtNum,
        unit   : selectedMint.unit,
        memo   : memo.trim() || undefined,
      });
    } catch (err) {
      if (!swapCompleted && spentIds.length > 0) {
        ctx.onRevertPending(spentIds).catch(() => {});
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep('error');
    } finally {
      releaseLock?.();
    }
  };

  const pubkeyPreview = recipientPubkey
    ? `${recipientPubkey.slice(0, 8)}…${recipientPubkey.slice(-4)}`
    : null;

  if (step === 'resolving') {
    return (
      <div className="space-y-4">
        <CardHeader
          icon={<UsersIcon className="h-4 w-4 text-primary" />}
          label="Recipient"
          subtitle={<span className="font-mono text-[10px]">{truncateMiddle(recipientDid, 12, 8)}</span>}
        />
        <div className="flex flex-col items-center py-6 gap-3">
          <Loader2Icon className="h-6 w-6 animate-spin text-primary" />
          <div className="text-xs text-muted-foreground">Resolving recipient's P2PK key…</div>
        </div>
      </div>
    );
  }

  if (step === 'sending') {
    return (
      <div className="space-y-4">
        <CardHeader
          icon={<UsersIcon className="h-4 w-4 text-primary" />}
          label="Sending…"
          subtitle={<span className="font-mono text-[10px]">{truncateMiddle(recipientDid, 12, 8)}</span>}
        />
        <div className="flex flex-col items-center py-8 gap-3">
          <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
          <div className="text-sm text-muted-foreground">Locking and sending…</div>
        </div>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="space-y-4">
        <CardHeader icon={<AlertCircleIcon className="h-4 w-4 text-destructive" />} label="Couldn't send" />
        <p className="text-xs text-muted-foreground text-center">{errorMsg}</p>
        <div className="flex gap-2">
          <button onClick={onBack} className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted">Back</button>
          {recipientPubkey && (
            <button onClick={() => setStep('amount')} className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium">Try again</button>
          )}
        </div>
      </div>
    );
  }

  // step === 'amount'
  return (
    <div className="space-y-4">
      <CardHeader
        icon={<UsersIcon className="h-4 w-4 text-primary" />}
        label="Sending to"
        subtitle={
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px]">{truncateMiddle(recipientDid, 12, 8)}</span>
            {pubkeyPreview && (
              <span className="flex items-center gap-1 text-[10px] text-[var(--color-success)]">
                <CheckCircleIcon className="h-3 w-3" />
                {pubkeyPreview}
              </span>
            )}
          </div>
        }
      />

      {ctx.mints.length > 1 && (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground px-1">From</label>
          <select
            value={selectedMint?.url ?? ''}
            onChange={(e) => setSelectedMint(ctx.mints.find((m) => m.url === e.target.value) ?? null)}
            className="w-full px-3 py-2.5 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {ctx.mints.map((m) => (
              <option key={m.url} value={m.url}>
                {m.name || truncateMintUrl(m.url)} ({formatAmount(ctx.mintBalances.get(m.url) ?? 0, m.unit)})
              </option>
            ))}
          </select>
        </div>
      )}

      <AmountInput
        value={amount}
        onChange={setAmount}
        unit={selectedMint?.unit ?? 'sat'}
        max={Math.max(0, balance - inputFee)}
        helper={`Balance: ${formatAmount(balance, selectedMint?.unit ?? 'sat')}`}
        error={amtNum > 0 && total > balance ? 'Insufficient balance' : null}
      />

      {amtNum > 0 && inputFee > 0 && (
        <div className="p-3 rounded-xl bg-background border border-border space-y-1.5 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount</span>
            <span className="amount-display font-medium">{formatAmount(amtNum, selectedMint?.unit)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Mint fee</span>
            <span className="amount-display font-medium">{formatAmount(inputFee, selectedMint?.unit)}</span>
          </div>
          <div className="border-t border-border pt-1.5 flex justify-between text-sm font-semibold">
            <span>Total</span>
            <span className="amount-display">{formatAmount(total, selectedMint?.unit)}</span>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground px-1">
          Memo (optional)
        </label>
        <input
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder={'What\u2019s this for?'}
          className="w-full px-3 py-2.5 rounded-lg bg-background border border-border text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
        >
          Back
        </button>
        <button
          onClick={handleSend}
          disabled={!canSend}
          className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Send {amtNum > 0 ? formatAmount(total, selectedMint?.unit) : ''}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Mismatch card (cashu-token, mint-url, unknown)
// ---------------------------------------------------------------------------

type MismatchKind = 'cashu-token' | 'mint-url' | 'unknown';

const MISMATCH_COPY: Record<MismatchKind, {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: string;
}> = {
  'cashu-token': {
    icon   : <DownloadIcon className="h-4 w-4 text-[var(--color-info)]" />,
    title  : 'This looks like a receive',
    body   : 'That\u2019s a cashu token \u2014 someone wants to send money to you. Switch to Receive to claim it.',
    action : 'Receive it instead',
  },
  'mint-url': {
    icon   : <GlobeIcon className="h-4 w-4 text-[var(--color-info)]" />,
    title  : 'That\u2019s a mint URL',
    body   : 'This is a Cashu mint you could add to your wallet, not a payment destination.',
    action : 'Add mint',
  },
  'unknown': {
    icon   : <AlertCircleIcon className="h-4 w-4 text-muted-foreground" />,
    title  : 'Nothing to send to',
    body   : 'We couldn\u2019t recognize that as a Lightning invoice, payment request, LNURL, address, or DID.',
  },
};

const MismatchCard: React.FC<{
  kind: MismatchKind;
  onBack: () => void;
  onSwitch?: () => void;
}> = ({ kind, onBack, onSwitch }) => {
  const copy = MISMATCH_COPY[kind];
  return (
    <div className="space-y-4">
      <CardHeader icon={copy.icon} label={copy.title} />
      <p className="text-xs text-muted-foreground text-center leading-relaxed">{copy.body}</p>
      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="flex-1 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
        >
          Back
        </button>
        {onSwitch && copy.action && (
          <button
            onClick={onSwitch}
            className="flex-1 px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            {copy.action}
          </button>
        )}
      </div>
    </div>
  );
};
