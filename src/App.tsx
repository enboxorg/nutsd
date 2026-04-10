import { useState, useCallback, useEffect, useMemo } from 'react';

import { ThemeProvider, useTheme } from '@/components/theme-provider';
import { ErrorBoundary } from '@/components/error-boundary';
import { EnboxProvider } from '@/enbox/EnboxProvider';
import { useEnbox } from '@/enbox/use-enbox';
import { useWallet } from '@/hooks/use-wallet';

import { Welcome } from '@/components/wallet/welcome';
import { BalanceCard } from '@/components/wallet/balance-card';
import { PrimaryActions } from '@/components/wallet/primary-actions';
import { MintListCard } from '@/components/wallet/mint-list-card';
import { TransactionListCard } from '@/components/wallet/transaction-list-card';
import { AddMintDialog } from '@/components/mint/add-mint-dialog';
import { MintDetail } from '@/components/mint/mint-detail';
import { UnifiedSendDialog } from '@/components/wallet/unified-send-dialog';
import { UnifiedReceiveDialog } from '@/components/wallet/unified-receive-dialog';
import { TrustMintDialog } from '@/components/wallet/trust-mint-dialog';
import type { CrossMintSwapEstimate } from '@/cashu/cross-mint-swap';
import { RecoveryPhraseDialog } from '@/components/connect/recovery-phrase-dialog';
import { OnboardingBanner } from '@/components/wallet/onboarding-banner';
import { TransactionHistory } from '@/components/wallet/transaction-history';
import { SettingsPage } from '@/components/wallet/settings-page';
import { Toaster } from 'sonner';

import { receiveToken, getMintInfo, checkTokenSpent } from '@/cashu/wallet-ops';
import { executeCrossMintSwap } from '@/cashu/cross-mint-swap';
import { acquireWalletLock } from '@/lib/wallet-mutex';
import { QRCodeDisplay } from '@/components/qr-code';
import { DialogWrapper } from '@/components/ui/dialog-wrapper';

import { toastError, toastSuccess, formatAmount, truncateMintUrl, truncateMiddle } from '@/lib/utils';
import { brand } from '@/lib/brand';
import { usePinLock } from '@/hooks/use-pin-lock';
import { PinScreen } from '@/components/connect/pin-screen';
import type { Proof } from '@cashu/cashu-ts';
import type { ProofData, MintData, TransactionData } from '@/protocol/cashu-wallet-protocol';
import type { Mint, Transaction } from '@/hooks/use-wallet';
import {
  LogOutIcon,
  LockIcon,
  MoonIcon,
  SunIcon,
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  XIcon,
  DownloadIcon,
  SettingsIcon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Invoice QR dialog — for re-displaying a pending invoice from activity
// ---------------------------------------------------------------------------

function InvoiceQrDialog({ invoice, amount, unit, expiresAt, onClose }: {
  invoice: string;
  amount: number;
  unit: string;
  expiresAt?: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [expired, setExpired] = useState(
    () => !!expiresAt && new Date(expiresAt).getTime() < Date.now(),
  );

  // Auto-close when the invoice expires while the dialog is open.
  useEffect(() => {
    if (!expiresAt || expired) return;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setExpired(true), ms);
    return () => clearTimeout(timer);
  }, [expiresAt, expired]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(invoice);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toastError('Copy failed', new Error('Clipboard access denied'));
    }
  };

  return (
    <DialogWrapper open={true} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">{expired ? 'Invoice Expired' : 'Pending Invoice'}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        {expired ? (
          <div className="flex flex-col items-center py-6 gap-3">
            <AlertTriangleIcon className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground text-center">
              This invoice has expired and can no longer be paid.
            </p>
            <button
              onClick={onClose}
              className="px-6 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground text-center">
              Waiting for <span className="font-medium text-foreground">{formatAmount(amount, unit)}</span> payment
            </p>
            <div className="flex justify-center">
              <div className="p-4 rounded-2xl bg-white">
                <QRCodeDisplay value={invoice} size={200} />
              </div>
            </div>
            <button
              onClick={handleCopy}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border border-border text-sm font-medium hover:bg-muted transition-colors"
            >
              {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy Invoice'}
            </button>
          </>
        )}
      </div>
    </DialogWrapper>
  );
}

// ---------------------------------------------------------------------------
// Wallet app (connected)
// ---------------------------------------------------------------------------

interface WalletHomeProps {
  isPinEnabled: boolean;
  onSetPin: (pin: string) => Promise<void>;
  onRemovePin: () => void;
  onLock: () => void;
}

function WalletHome({ isPinEnabled, onSetPin, onRemovePin, onLock }: WalletHomeProps) {
  const { did, disconnect, enbox, isDelegateSession } = useEnbox();
  const { theme, setTheme } = useTheme();
  const {
    mints,
    transactions,
    totalBalance,
    mintBalances,
    mintBalancesByContext,
    unitBalances,
    proofCountByMint,
    mintFeePpk,
    keysetFeeMap,
    pendingProofCount,
    mintHealth,
    p2pkKey,
    loading,
    reconciling,
    dwnError,
    addMint,
    updateMint,
    removeMint,
    deleteProofs,
    addTransaction,
    completeTransaction,
    deleteTransaction,
    markTransactionClaimed,
    getUnspentProofsForMint,
    getUnspentProofsByContext,
    markProofsPending,
    revertProofsToUnspent,
    safeStoreReceivedProofs,
    preferences,
    updatePreferences,
    incomingTransfers,
    checkIncomingTransfers,
    redeemIncomingTransfer,
  } = useWallet();

  // Ordered mints: default mint first (for dialog selectors)
  const orderedMints = useMemo(() => {
    if (!preferences.defaultMintUrl) return mints;
    const idx = mints.findIndex(m => m.url === preferences.defaultMintUrl);
    if (idx <= 0) return mints;
    return [mints[idx], ...mints.slice(0, idx), ...mints.slice(idx + 1)];
  }, [mints, preferences.defaultMintUrl]);

  // Dialog state — unified send/receive model.
  const [showAddMint, setShowAddMint] = useState(false);
  /** Pre-filled URL for AddMintDialog (set when Send scanner detects a mint URL). */
  const [addMintInitialUrl, setAddMintInitialUrl] = useState<string | null>(null);
  const [showSend, setShowSend] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  /** When set, the Receive dialog opens in claim-token mode instead of channels. */
  const [receiveClaimToken, setReceiveClaimToken] = useState<string | null>(null);
  /** When set, the Receive dialog opens in LNURL-withdraw mode. */
  const [receiveLnurlWithdraw, setReceiveLnurlWithdraw] = useState<string | null>(null);
  const [selectedMint, setSelectedMint] = useState<Mint | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [trustBusy, setTrustBusy] = useState(false);
  const [trustMintState, setTrustMintState] = useState<{
    mintUrl: string;
    amount: number;
    unit: string;
    token: string;
  } | null>(null);

  const hasMints = mints.length > 0;

  // --- Proof persistence helpers ---
  // Startup recovery (stash + pending reconciliation) is handled inside
  // useWallet() hook, sequenced AFTER proofs are loaded.

  /**
   * Store Cashu proofs as DWN records using the crash-safe stash pattern.
   *
   * Writes a single stash record FIRST (crash checkpoint), then individual
   * proof records, then deletes the stash. If the app crashes between the
   * stash write and cleanup, `recoverProofStashes()` on next startup fills
   * in any missing proofs from the stash.
   */
  const storeNewProofs = useCallback(async (mintContextId: string, cashuProofs: Proof[]): Promise<boolean> => {
    const mint = mints.find(m => m.contextId === mintContextId);
    const proofDataList: ProofData[] = cashuProofs.map(proof => {
      const data: ProofData = {
        amount  : proof.amount,
        id      : proof.id,
        secret  : proof.secret,
        C       : proof.C,
        state   : 'unspent',
      };
      if (proof.dleq) {
        data.dleq = {
          e: String(proof.dleq.e),
          s: String(proof.dleq.s),
          r: String(proof.dleq.r),
        };
      }
      if (proof.witness) {
        data.witness = typeof proof.witness === 'string'
          ? proof.witness
          : JSON.stringify(proof.witness);
      }
      return data;
    });
    return safeStoreReceivedProofs(
      mintContextId,
      mint?.url ?? '',
      mint?.unit ?? 'sat',
      proofDataList,
    );
  }, [mints, safeStoreReceivedProofs]);

  /** Store proofs, auto-adding the mint if unknown. */
  const storeNewProofsForMintUrl = useCallback(async (
    mintContextId: string,
    cashuProofs: Proof[],
    mintUrl: string,
  ): Promise<boolean> => {
    let ctx = mintContextId;
    if (!ctx) {
      const knownMint = mints.find(m => m.url === mintUrl);
      if (knownMint) {
        ctx = knownMint.contextId;
      } else {
        const newMint = await addMint({ url: mintUrl, unit: 'sat', active: true });
        if (newMint) ctx = newMint.contextId;
      }
    }
    if (!ctx) throw new Error(`Could not resolve mint context for ${mintUrl}`);
    return storeNewProofs(ctx, cashuProofs);
  }, [mints, addMint, storeNewProofs]);

  /**
   * Delete specific proof DWN records by ID.
   * Called AFTER new proofs are safely stored (store-before-delete).
   */
  const removeProofsByIds = useCallback(async (ids: string[]) => {
    if (ids.length > 0) {
      await deleteProofs(ids);
    }
  }, [deleteProofs]);

  /** Record a transaction in DWN. Returns the record ID. */
  const recordTransaction = useCallback(async (data: Omit<TransactionData, 'createdAt'>): Promise<string | undefined> => {
    const tx = await addTransaction({
      ...data,
      createdAt: new Date().toISOString(),
    });
    return tx?.id;
  }, [addTransaction]);

  const handleAddMint = useCallback(async (data: MintData) => {
    await addMint(data);
  }, [addMint]);

  /** Called when the receive flow encounters a token from an unknown mint. */
  const handleUnknownMint = useCallback((mintUrl: string, amount: number, unit: string, token: string) => {
    setShowReceive(false); // Close receive dialog
    setTrustMintState({ mintUrl, amount, unit, token });
  }, []);

  /** Trust the unknown mint, add it, and claim the token. */
  const handleTrustAndClaim = useCallback(async () => {
    if (!trustMintState) return;
    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = await acquireWalletLock('trust-claim');
    } catch (err) {
      console.warn('[nutsd] Wallet lock acquisition failed for trust-claim:', err);
      toastError('Wallet busy', new Error('Another wallet operation is in progress.'));
      return;
    }
    setTrustBusy(true);
    try {
      // Add the mint
      const newMint = await addMint({ url: trustMintState.mintUrl, unit: trustMintState.unit, active: true });
      if (!newMint) throw new Error('Failed to add mint');

      // Now receive the token
      const newProofs = await receiveToken(trustMintState.mintUrl, trustMintState.token, trustMintState.unit);
      const total = newProofs.reduce((s, p) => s + p.amount, 0);
      await storeNewProofs(newMint.contextId, newProofs);
      await recordTransaction({
        type    : 'receive',
        amount  : total,
        unit    : trustMintState.unit,
        mintUrl : trustMintState.mintUrl,
        status  : 'completed',
      });
      toastSuccess('Token received', `+${total} ${trustMintState.unit}`);
    } catch (err) {
      toastError('Failed to receive', err);
    } finally {
      setTrustBusy(false);
      releaseLock?.();
      setTrustMintState(null);
    }
  }, [trustMintState, addMint, storeNewProofs, recordTransaction]);

  /** Swap the token from the unknown mint to a trusted mint via Lightning. */
  const handleSwapToMint = useCallback(async (estimate: CrossMintSwapEstimate, targetMint: Mint) => {
    if (!trustMintState) return;
    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = await acquireWalletLock('cross-mint-swap');
    } catch (err) {
      console.warn('[nutsd] Wallet lock acquisition failed for cross-mint-swap:', err);
      toastError('Wallet busy', new Error('Another wallet operation is in progress.'));
      return;
    }
    setTrustBusy(true);
    try {
      // Receive the token at the foreign mint using a TRANSIENT wallet.
      // We do NOT add the foreign mint to the DWN — that's the whole point of
      // the trust dialog. The cashu-ts Wallet is created directly via getWallet()
      // which only needs the mint URL, not a DWN record.
      const foreignProofs = await receiveToken(trustMintState.mintUrl, trustMintState.token, trustMintState.unit);

      // Execute cross-mint swap
      let result;
      try {
        result = await executeCrossMintSwap(
          trustMintState.mintUrl, targetMint.url, foreignProofs, estimate, trustMintState.unit,
        );
      } catch (err: any) {
        // If the melt succeeded but minting timed out, persist recovery state
        if (err.pendingSwapState) {
          // Persist change proofs from foreign mint if any
          if (err.change?.length > 0) {
            // We need a temporary mint record to store change proofs.
            // This is the ONE case where we add the foreign mint — because we
            // have change proofs that belong to it. Mark it as inactive.
            const tempMint = await addMint({ url: trustMintState.mintUrl, unit: trustMintState.unit, active: false });
            if (tempMint) await storeNewProofs(tempMint.contextId, err.change);
          }
          // Record the pending swap as a transaction for later resume
          await recordTransaction({
            type    : 'swap',
            amount  : estimate.receiveAmount,
            unit    : trustMintState.unit,
            mintUrl : targetMint.url,
            status  : 'pending',
            memo    : JSON.stringify(err.pendingSwapState),
          });
          toastError('Swap partially complete', new Error(
            'Lightning payment sent. Waiting for trusted mint to detect payment. ' +
            'The swap will resume automatically on next startup.'
          ));
          setTrustBusy(false);
          setTrustMintState(null);
          return;
        }
        throw err;
      }

      // Store new proofs at trusted mint (stash-safe)
      await storeNewProofs(targetMint.contextId, result.proofs);

      // Store foreign change proofs if any
      if (result.change.length > 0) {
        const tempMint = await addMint({ url: trustMintState.mintUrl, unit: trustMintState.unit, active: false });
        if (tempMint) await storeNewProofs(tempMint.contextId, result.change);
      }

      await recordTransaction({
        type    : 'receive',
        amount  : result.amount,
        unit    : trustMintState.unit,
        mintUrl : targetMint.url,
        status  : 'completed',
        memo    : `Cross-mint swap from ${truncateMintUrl(trustMintState.mintUrl)}`,
      });
      toastSuccess('Token swapped', `+${formatAmount(result.amount, trustMintState.unit)} at ${truncateMintUrl(targetMint.url)}`);
    } catch (err) {
      toastError('Swap failed', err);
    } finally {
      setTrustBusy(false);
      releaseLock?.();
      setTrustMintState(null);
    }
  }, [trustMintState, addMint, storeNewProofs, recordTransaction]);

  /** Check if a sent token has been claimed by the recipient (NUT-07). */
  const handleCheckTokenSpent = useCallback(async (tx: Transaction): Promise<boolean | null> => {
    if (!tx.cashuToken) return null;
    const isSpent = await checkTokenSpent(tx.cashuToken, tx.mintUrl, tx.unit);
    // If confirmed spent, clear the bearer token from the DWN record
    if (isSpent === true) {
      markTransactionClaimed(tx.id);
    }
    return isSpent;
  }, [markTransactionClaimed]);

  /** Delete a transaction (only allowed for expired pending/failed invoices). */
  const handleDeleteTransaction = useCallback(async (tx: Transaction) => {
    const isExpiredPending = tx.status === 'pending' && tx.expiresAt && new Date(tx.expiresAt).getTime() < Date.now();
    const isFailedInvoice = tx.status === 'failed' && tx.type === 'mint' && !!tx.invoice;
    if (!isExpiredPending && !isFailedInvoice) return;
    await deleteTransaction(tx.id);
    toastSuccess('Invoice removed');
  }, [deleteTransaction]);

  /** Show the QR code for a pending invoice. */
  const [invoiceQrTx, setInvoiceQrTx] = useState<{ invoice: string; amount: number; unit: string; expiresAt?: string } | null>(null);
  const handleShowInvoiceQr = useCallback((tx: Transaction) => {
    if (!tx.invoice) return;
    // Allow opening even if expired — the dialog itself shows the expired state.
    setInvoiceQrTx({ invoice: tx.invoice, amount: tx.amount, unit: tx.unit, expiresAt: tx.expiresAt });
  }, []);

  // ── Unified dialog switchers ──

  /** The Send dialog detected a cashu token → hand off to Receive in claim mode. */
  const handleSwitchToReceive = useCallback((token: string) => {
    setShowSend(false);
    setReceiveClaimToken(token);
    setShowReceive(true);
  }, []);

  /** The Send dialog detected a mint URL → hand off to Add Mint with the URL pre-filled. */
  const handleSwitchToAddMint = useCallback((mintUrl: string) => {
    setShowSend(false);
    setAddMintInitialUrl(mintUrl);
    setShowAddMint(true);
  }, []);

  /** The Send dialog detected an LNURL-withdraw → hand off to Receive in withdraw mode. */
  const handleSwitchToLnurlWithdraw = useCallback((lnurl: string) => {
    setShowSend(false);
    setReceiveLnurlWithdraw(lnurl);
    setShowReceive(true);
  }, []);

  /** Reclaim an unclaimed sent token (NUT-07 reports all proofs UNSPENT). */
  const handleReclaimToken = useCallback(async (tx: Transaction) => {
    if (!tx.cashuToken) throw new Error('No token to reclaim');
    const releaseLock = await acquireWalletLock('reclaim');
    try {
      const mintUrl = tx.mintUrl;

      // Ensure mint exists before redeeming (user may have removed mint since sending)
      let knownMint = mints.find(m => m.url === mintUrl);
      if (!knownMint) {
        await getMintInfo(mintUrl); // throws if unreachable
        await storeNewProofsForMintUrl('', [], mintUrl); // auto-add
        knownMint = mints.find(m => m.url === mintUrl);
      }

      const newProofs = await receiveToken(mintUrl, tx.cashuToken, tx.unit);
      const totalReclaimed = newProofs.reduce((s, p) => s + p.amount, 0);
      const contextId = knownMint?.contextId ?? '';
      await storeNewProofsForMintUrl(contextId, newProofs, mintUrl);

      await recordTransaction({
        type   : 'receive',
        amount : totalReclaimed,
        unit   : tx.unit,
        mintUrl,
        status : 'completed',
        memo   : 'Reclaimed unclaimed token',
      });

      markTransactionClaimed(tx.id);
      toastSuccess('Token reclaimed', `+${totalReclaimed} ${tx.unit}`);
    } finally {
      releaseLock();
    }
  }, [mints, storeNewProofsForMintUrl, recordTransaction, markTransactionClaimed]);

  const handleDisconnect = async () => {
    try {
      await disconnect({ clearStorage: true });
    } catch (err) {
      toastError('Failed to disconnect', err);
    }
  };

  // -- Mint detail view --
  if (selectedMint) {
    return (
      <>
        <MintDetail
          mint={selectedMint}
          balance={mintBalances.get(selectedMint.url) ?? 0}
          proofCount={proofCountByMint.get(selectedMint.url) ?? 0}
          onBack={() => setSelectedMint(null)}
          onDelete={(id) => { removeMint(id); setSelectedMint(null); }}
          onUpdateMint={updateMint}
          getUnspentProofs={getUnspentProofsForMint}
          onNewProofs={storeNewProofs}
          onOldProofsSpent={removeProofsByIds}
          onMarkPending={markProofsPending}
          onTransactionCreated={recordTransaction}
        />
        {showAddMint && (
          <AddMintDialog onAdd={handleAddMint} onClose={() => setShowAddMint(false)} />
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div className="text-lg font-bold tracking-tighter">
            {brand.baseName}<span className="text-primary">{brand.accentLetter}</span>
          </div>
          <div className="flex items-center gap-2">
            {did && (
              <div className="text-xs text-muted-foreground font-mono hidden sm:block">
                {truncateMiddle(did, 12, 6)}
              </div>
            )}
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
              title="Toggle theme"
            >
              {theme === 'dark' ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
              title="Settings"
            >
              <SettingsIcon className="h-4 w-4" />
            </button>
            {isPinEnabled && (
              <button
                onClick={onLock}
                className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
                title="Lock wallet"
              >
                <LockIcon className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={handleDisconnect}
              className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
              title="Disconnect"
            >
              <LogOutIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-lg mx-auto px-4 py-6 space-y-4">
        {loading ? (
          <div className="text-center text-muted-foreground py-12 text-sm">Loading wallet...</div>
        ) : (
          <>
            {/* DWN error banner */}
            {dwnError && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive">
                <AlertTriangleIcon className="h-4 w-4 shrink-0" />
                {dwnError}
              </div>
            )}

            {/* Pending proofs banner */}
            {pendingProofCount > 0 && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/30 text-sm">
                <AlertTriangleIcon className="h-4 w-4 text-[var(--color-warning)] shrink-0" />
                <span className="text-muted-foreground">
                  {reconciling
                    ? `Checking ${pendingProofCount} pending proof(s) with mint...`
                    : `${pendingProofCount} proof(s) in pending state — will be checked on next startup.`}
                </span>
              </div>
            )}

            {/* Incoming P2P transfers banner */}
            {incomingTransfers.length > 0 && (
              <div className="rounded-lg bg-[var(--color-info)]/10 border border-[var(--color-info)]/30 p-3 space-y-2">
                <div className="flex items-center justify-between text-sm font-medium">
                  <div className="flex items-center gap-2">
                    <DownloadIcon className="h-4 w-4 text-[var(--color-info)]" />
                    {incomingTransfers.length} incoming P2P transfer{incomingTransfers.length !== 1 ? 's' : ''}
                  </div>
                  <button
                    onClick={() => checkIncomingTransfers()}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Refresh
                  </button>
                </div>
                {incomingTransfers.map((transfer, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {formatAmount(transfer.amount, transfer.unit)} from {transfer.senderDid?.slice(0, 20)}...
                    </span>
                    <button
                       onClick={() => redeemIncomingTransfer(transfer).catch(err => toastError('Redeem failed', err))}
                      className="px-2 py-1 rounded-full bg-primary text-primary-foreground text-[10px] font-medium"
                    >
                      Claim
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* unit is the actual denomination of the proofs, NOT a display preference.
                displayCurrency requires an exchange rate layer to convert — without it,
                showing sat balances as "$1,000.00" would be actively misleading.
                The per-unit breakdown in unitBalances handles multi-unit mints correctly. */}
            <BalanceCard
              totalBalance={totalBalance}
              unit="sat"
              mintCount={mints.length}
              unitBalances={unitBalances}
            />

            {!hasMints ? (
              <OnboardingBanner onAddMint={() => setShowAddMint(true)} />
            ) : (
              <PrimaryActions
                onSend={() => setShowSend(true)}
                onReceive={() => { setReceiveClaimToken(null); setReceiveLnurlWithdraw(null); setShowReceive(true); }}
              />
            )}

            <MintListCard
              mints={mints}
              mintBalances={mintBalances}
              mintHealth={mintHealth}
              onAddMint={() => setShowAddMint(true)}
              onSelectMint={setSelectedMint}
            />

            <TransactionListCard
              transactions={transactions}
              onViewAll={() => setShowHistory(true)}
              onCheckTokenSpent={handleCheckTokenSpent}
              onReclaimToken={handleReclaimToken}
              onShowInvoiceQr={handleShowInvoiceQr}
              onDeleteTransaction={handleDeleteTransaction}
            />
          </>
        )}
      </main>

      {/* Dialogs */}
      {showAddMint && (
        <AddMintDialog
          onAdd={handleAddMint}
          onClose={() => { setShowAddMint(false); setAddMintInitialUrl(null); }}
          initialUrl={addMintInitialUrl ?? undefined}
        />
      )}

      {showSend && hasMints && (
        <UnifiedSendDialog
          mints={orderedMints}
          mintBalances={mintBalances}
          mintBalancesByContext={mintBalancesByContext}
          mintFeePpk={mintFeePpk}
          keysetFeeMap={keysetFeeMap}
          getUnspentProofs={getUnspentProofsForMint}
          getUnspentProofsByContext={getUnspentProofsByContext}
          senderDid={did}
          enbox={enbox}
          onClose={() => setShowSend(false)}
          onNewProofs={storeNewProofs}
          onOldProofsSpent={removeProofsByIds}
          onMarkPending={markProofsPending}
          onRevertPending={revertProofsToUnspent}
          onTransactionCreated={recordTransaction}
          onMarkClaimed={markTransactionClaimed}
          onSwitchToReceive={handleSwitchToReceive}
          onSwitchToAddMint={handleSwitchToAddMint}
          onSwitchToLnurlWithdraw={handleSwitchToLnurlWithdraw}
        />
      )}

      {showReceive && (
        <UnifiedReceiveDialog
          mints={mints}
          mintHealth={mintHealth}
          did={did ?? undefined}
          p2pkPrivateKey={p2pkKey?.privateKey}
          claimToken={receiveClaimToken ?? undefined}
          lnurlWithdraw={receiveLnurlWithdraw ?? undefined}
          onUnknownMint={handleUnknownMint}
          onClose={() => {
            setShowReceive(false);
            setReceiveClaimToken(null);
            setReceiveLnurlWithdraw(null);
          }}
          onProofsReceived={storeNewProofsForMintUrl}
          onTransactionCreated={recordTransaction}
          onTransactionCompleted={completeTransaction}
        />
      )}

      {showHistory && (
        <TransactionHistory
          transactions={transactions}
          mints={mints}
          onClose={() => setShowHistory(false)}
          onCheckTokenSpent={handleCheckTokenSpent}
          onReclaimToken={handleReclaimToken}
          onShowInvoiceQr={handleShowInvoiceQr}
          onDeleteTransaction={handleDeleteTransaction}
        />
      )}
      {showSettings && (
        <SettingsPage
          did={did}
          isDelegateSession={isDelegateSession}
          mints={mints}
          preferences={preferences}
          p2pkKey={p2pkKey}
          isPinEnabled={isPinEnabled}
          onSetPin={onSetPin}
          onRemovePin={onRemovePin}
          onUpdatePreferences={updatePreferences}
          onClose={() => setShowSettings(false)}
        />
      )}
      {invoiceQrTx && (
        <InvoiceQrDialog
          invoice={invoiceQrTx.invoice}
          amount={invoiceQrTx.amount}
          unit={invoiceQrTx.unit}
          expiresAt={invoiceQrTx.expiresAt}
          onClose={() => setInvoiceQrTx(null)}
        />
      )}
      {trustMintState && (
        <TrustMintDialog
          mintUrl={trustMintState.mintUrl}
          amount={trustMintState.amount}
          unit={trustMintState.unit}
          defaultMint={orderedMints[0]}
          mints={orderedMints}
          busy={trustBusy}
          onTrustAndClaim={handleTrustAndClaim}
          onSwapToMint={handleSwapToMint}
          onCancel={() => { if (!trustBusy) setTrustMintState(null); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root app
// ---------------------------------------------------------------------------

function AppContent() {
  const { isConnected, recoveryPhrase, clearRecoveryPhrase } = useEnbox();
  const { isPinEnabled, isLocked, setPin, removePin, unlock, lock } = usePinLock();

  // Not connected — show welcome/connect flow.
  if (!isConnected) {
    return <Welcome />;
  }

  // Connected but locked — show PIN unlock screen.
  if (isLocked) {
    return (
      <PinScreen
        mode="unlock"
        onSubmit={async (pin) => unlock(pin)}
      />
    );
  }

  return (
    <>
      <WalletHome
        isPinEnabled={isPinEnabled}
        onSetPin={setPin}
        onRemovePin={removePin}
        onLock={lock}
      />
      {recoveryPhrase && (
        <RecoveryPhraseDialog
          phrase={recoveryPhrase}
          onDone={clearRecoveryPhrase}
        />
      )}
    </>
  );
}

export const App = () => {
  return (
    <ThemeProvider defaultTheme="dark" storageKey={`${brand.storagePrefix}-ui-theme`}>
      <ErrorBoundary>
        <EnboxProvider>
          <AppContent />
          <Toaster
            position="bottom-center"
            toastOptions={{
              className: 'bg-card border border-border text-foreground text-sm',
            }}
          />
        </EnboxProvider>
      </ErrorBoundary>
    </ThemeProvider>
  );
};
