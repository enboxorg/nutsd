import { useState, useCallback, useMemo } from 'react';

import { ThemeProvider, useTheme } from '@/components/theme-provider';
import { ErrorBoundary } from '@/components/error-boundary';
import { EnboxProvider } from '@/enbox/EnboxProvider';
import { useEnbox } from '@/enbox/use-enbox';
import { useWallet } from '@/hooks/use-wallet';

import { Welcome } from '@/components/wallet/welcome';
import { BalanceCard } from '@/components/wallet/balance-card';
import { ActionButtons } from '@/components/wallet/action-buttons';
import { MintListCard } from '@/components/wallet/mint-list-card';
import { TransactionListCard } from '@/components/wallet/transaction-list-card';
import { AddMintDialog } from '@/components/mint/add-mint-dialog';
import { MintDetail } from '@/components/mint/mint-detail';
import { DepositDialog } from '@/components/wallet/deposit-dialog';
import { WithdrawDialog } from '@/components/wallet/withdraw-dialog';
import { SendDialog } from '@/components/wallet/send-dialog';
import { SendToDIDDialog } from '@/components/wallet/send-to-did-dialog';
import { ReceiveDialog } from '@/components/wallet/receive-dialog';
import { TrustMintDialog } from '@/components/wallet/trust-mint-dialog';
import type { CrossMintSwapEstimate } from '@/cashu/cross-mint-swap';
import { RecoveryPhraseDialog } from '@/components/connect/recovery-phrase-dialog';
import { LnurlWithdrawDialog } from '@/components/wallet/lnurl-withdraw-dialog';
import { PayRequestDialog } from '@/components/wallet/pay-request-dialog';
import { CreateRequestDialog } from '@/components/wallet/create-request-dialog';
import { OnboardingBanner } from '@/components/wallet/onboarding-banner';
import { TransactionHistory } from '@/components/wallet/transaction-history';
import { SettingsPage } from '@/components/wallet/settings-page';
import { Toaster } from 'sonner';

import { QrScanner } from '@/components/wallet/qr-scanner';
import { PasteActionBar } from '@/components/wallet/paste-action-bar';
import { detectInput } from '@/lib/input-detect';
import { receiveToken, getMintInfo } from '@/cashu/wallet-ops';
import { extractMintUrl } from '@/cashu/token-utils';
import { acquireWalletLock } from '@/lib/wallet-mutex';

import { toastError, toastSuccess, formatAmount, truncateMintUrl } from '@/lib/utils';
import { truncateMiddle } from '@/lib/utils';
import { checkTokenSpent } from '@/cashu/wallet-ops';
import { brand } from '@/lib/brand';
import type { Proof } from '@cashu/cashu-ts';
import type { ProofData, MintData, TransactionData } from '@/protocol/cashu-wallet-protocol';
import type { Mint, Transaction } from '@/hooks/use-wallet';
import {
  LogOutIcon,
  MoonIcon,
  SunIcon,
  AlertTriangleIcon,
  KeyIcon,
  CopyIcon,
  UsersIcon,
  DownloadIcon,
  SettingsIcon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Wallet app (connected)
// ---------------------------------------------------------------------------

function WalletHome() {
  const { did, disconnect, enbox } = useEnbox();
  const { theme, setTheme } = useTheme();
  const {
    mints,
    transactions,
    totalBalance,
    mintBalances,
    unitBalances,
    proofCountByMint,
    mintFeePpk,
    keysetFeeMap,
    pendingProofCount,
    p2pkKey,
    loading,
    reconciling,
    dwnError,
    addMint,
    updateMint,
    removeMint,
    deleteProofs,
    addTransaction,
    clearTransactionToken,
    getUnspentProofsForMint,
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

  // Dialog state
  const [showAddMint, setShowAddMint] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [selectedMint, setSelectedMint] = useState<Mint | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [showLnurlPay, setShowLnurlPay] = useState<{ target: string; type: 'lightning-address' | 'lnurl' } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showSendToDid, setShowSendToDid] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPayRequest, setShowPayRequest] = useState<string | null>(null);
  const [showCreateRequest, setShowCreateRequest] = useState(false);
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
  const storeNewProofs = useCallback(async (mintContextId: string, cashuProofs: Proof[]) => {
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
    await safeStoreReceivedProofs(
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
  ) => {
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
    await storeNewProofs(ctx, cashuProofs);
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
    } catch {
      toastError('Wallet busy', new Error('Another wallet operation is in progress.'));
      return;
    }
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
    } catch {
      toastError('Wallet busy', new Error('Another wallet operation is in progress.'));
      return;
    }
    try {
      // Receive the token at the foreign mint using a TRANSIENT wallet.
      // We do NOT add the foreign mint to the DWN — that's the whole point of
      // the trust dialog. The cashu-ts Wallet is created directly via getWallet()
      // which only needs the mint URL, not a DWN record.
      const { receiveToken: receiveTokenOp } = await import('@/cashu/wallet-ops');
      const foreignProofs = await receiveTokenOp(trustMintState.mintUrl, trustMintState.token, trustMintState.unit);

      // Execute cross-mint swap
      const { executeCrossMintSwap } = await import('@/cashu/cross-mint-swap');
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
      clearTransactionToken(tx.id);
    }
    return isSpent;
  }, [clearTransactionToken]);

  /** Route a QR scan or paste result to the appropriate dialog/flow. */
  const handleScanResult = useCallback((raw: string) => {
    const detected = detectInput(raw);
    switch (detected.type) {
      case 'cashu-token':
        // Process the scanned token with mint-safe ordering
        (async () => {
          const releaseLock = await acquireWalletLock('scan-receive').catch(() => null);
          if (!releaseLock) {
            toastError('Wallet busy', new Error('Another operation is in progress.'));
            return;
          }
          try {
            const mintUrl = extractMintUrl(detected.value);
            if (!mintUrl) throw new Error('Could not determine mint URL from token');

            // Check if the mint is known. If not, show the trust dialog.
            const knownMint = mints.find(m => m.url === mintUrl);
            if (!knownMint) {
              const { parseToken } = await import('@/cashu/token-utils');
              try {
                const parsed = parseToken(detected.value);
                handleUnknownMint(mintUrl, parsed.amount, parsed.unit ?? 'sat', detected.value);
              } catch {
                handleUnknownMint(mintUrl, 0, 'sat', detected.value);
              }
              return; // Trust dialog handles the rest
            }

            const newProofs = await receiveToken(mintUrl, detected.value);
            const totalReceived = newProofs.reduce((s, p) => s + p.amount, 0);
            const contextId = knownMint.contextId;
            await storeNewProofsForMintUrl(contextId, newProofs, mintUrl);
            await recordTransaction({
              type   : 'receive',
              amount : totalReceived,
              unit   : knownMint.unit ?? 'sat',
              mintUrl,
              status : 'completed',
            });
            toastSuccess('Token received', `+${totalReceived} ${knownMint.unit ?? 'sat'}`);
          } catch (err) {
            toastError('Failed to receive token', err);
          } finally {
            releaseLock();
          }
        })();
        break;
      case 'lightning-invoice':
        setShowWithdraw(true);
        break;
      case 'lnurl':
        setShowLnurlPay({ target: detected.value, type: 'lnurl' });
        break;
      case 'lightning-address':
        setShowLnurlPay({ target: detected.value, type: 'lightning-address' });
        break;
      case 'mint-url':
        setShowAddMint(true);
        break;
      case 'payment-request':
        setShowPayRequest(detected.value);
        break;
      default:
        toastError('Unrecognized QR code', new Error(
          'Expected a Cashu token, Lightning invoice, or mint URL.',
        ));
        break;
    }
  }, [mints, handleUnknownMint, storeNewProofsForMintUrl, recordTransaction]);

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

      clearTransactionToken(tx.id);
      toastSuccess('Token reclaimed', `+${totalReclaimed} ${tx.unit}`);
    } finally {
      releaseLock();
    }
  }, [mints, storeNewProofsForMintUrl, recordTransaction, clearTransactionToken]);

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
                      onClick={() => redeemIncomingTransfer(transfer, i).catch(err => toastError('Redeem failed', err))}
                      className="px-2 py-1 rounded-full bg-primary text-primary-foreground text-[10px] font-medium"
                    >
                      Claim
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* P2PK public key display */}
            {p2pkKey && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-card border border-border text-xs">
                <KeyIcon className="h-3.5 w-3.5 text-primary shrink-0" />
                <div className="min-w-0">
                  <span className="text-muted-foreground">Your P2PK key: </span>
                  <code className="font-mono text-foreground truncate">{p2pkKey.publicKey.slice(0, 8)}...{p2pkKey.publicKey.slice(-6)}</code>
                </div>
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(p2pkKey.publicKey);
                    toastSuccess('P2PK key copied');
                  }}
                  className="p-1 rounded hover:bg-muted text-muted-foreground shrink-0"
                  title="Copy P2PK public key"
                >
                  <CopyIcon className="h-3 w-3" />
                </button>
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
              <>
                <ActionButtons
                  onDeposit={() => setShowDeposit(true)}
                  onWithdraw={() => setShowWithdraw(true)}
                  onSend={() => setShowSend(true)}
                  onReceive={() => setShowReceive(true)}
                  onRequest={() => setShowCreateRequest(true)}
                />

                <PasteActionBar
                  onCashuToken={(token) => handleScanResult(token)}
                  onLightningInvoice={() => setShowWithdraw(true)}
                  onMintUrl={() => setShowAddMint(true)}
                  onLnurlOrAddress={(value, type) => setShowLnurlPay({ target: value, type })}
                  onPaymentRequest={(v) => setShowPayRequest(v)}
                  onScanQr={() => setShowScanner(true)}
                />

                {p2pkKey && (
                  <button
                    onClick={() => setShowSendToDid(true)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-primary/30 text-xs font-medium text-primary hover:bg-primary/5 transition-colors"
                  >
                    <UsersIcon className="h-3.5 w-3.5" />
                    Send to DID (P2PK)
                  </button>
                )}
              </>
            )}

            <MintListCard
              mints={mints}
              mintBalances={mintBalances}
              onAddMint={() => setShowAddMint(true)}
              onSelectMint={setSelectedMint}
            />

            <TransactionListCard
              transactions={transactions}
              onViewAll={() => setShowHistory(true)}
              onCheckTokenSpent={handleCheckTokenSpent}
              onReclaimToken={handleReclaimToken}
            />
          </>
        )}
      </main>

      {/* Dialogs */}
      {showAddMint && (
        <AddMintDialog
          onAdd={handleAddMint}
          onClose={() => setShowAddMint(false)}
        />
      )}
      {showDeposit && hasMints && (
        <DepositDialog
          mints={orderedMints}
          onClose={() => setShowDeposit(false)}
          onProofsReceived={storeNewProofs}
          onTransactionCreated={recordTransaction}
        />
      )}
      {showWithdraw && hasMints && (
        <WithdrawDialog
          mints={orderedMints}
          mintBalances={mintBalances}
          getUnspentProofs={getUnspentProofsForMint}
          keysetFeeMap={keysetFeeMap}
          onClose={() => setShowWithdraw(false)}
          onNewProofs={storeNewProofs}
          onOldProofsSpent={removeProofsByIds}
          onMarkPending={markProofsPending}
          onRevertToUnspent={revertProofsToUnspent}
          onTransactionCreated={recordTransaction}
        />
      )}
      {showSend && hasMints && (
        <SendDialog
          mints={orderedMints}
          mintBalances={mintBalances}
          getUnspentProofs={getUnspentProofsForMint}
          keysetFeeMap={keysetFeeMap}
          mintFeePpk={mintFeePpk}
          onClose={() => setShowSend(false)}
          onNewProofs={storeNewProofs}
          onOldProofsSpent={removeProofsByIds}
          onMarkPending={markProofsPending}
          onTransactionCreated={recordTransaction}
        />
      )}
      {showSendToDid && hasMints && p2pkKey && did && (
        <SendToDIDDialog
          mints={orderedMints}
          mintBalances={mintBalances}
          getUnspentProofs={getUnspentProofsForMint}
          senderDid={did}
          enbox={enbox}
          onClose={() => setShowSendToDid(false)}
          onNewProofs={storeNewProofs}
          onOldProofsSpent={removeProofsByIds}
          onMarkPending={markProofsPending}
          onTransactionCreated={recordTransaction}
        />
      )}
      {showReceive && (
        <ReceiveDialog
          mints={mints}
          p2pkPrivateKey={p2pkKey?.privateKey}
          onUnknownMint={handleUnknownMint}
          onClose={() => setShowReceive(false)}
          onProofsReceived={storeNewProofsForMintUrl}
          onTransactionCreated={recordTransaction}
        />
      )}
      {showScanner && (
        <QrScanner
          onScan={(value) => { setShowScanner(false); handleScanResult(value); }}
          onClose={() => setShowScanner(false)}
        />
      )}
      {showLnurlPay && hasMints && (
        <LnurlWithdrawDialog
          target={showLnurlPay.target}
          targetType={showLnurlPay.type}
          mints={orderedMints}
          mintBalances={mintBalances}
          getUnspentProofs={getUnspentProofsForMint}
          keysetFeeMap={keysetFeeMap}
          onClose={() => setShowLnurlPay(null)}
          onNewProofs={storeNewProofs}
          onOldProofsSpent={removeProofsByIds}
          onMarkPending={markProofsPending}
          onTransactionCreated={recordTransaction}
        />
      )}
      {showHistory && (
        <TransactionHistory
          transactions={transactions}
          mints={mints}
          onClose={() => setShowHistory(false)}
        />
      )}
      {showSettings && (
        <SettingsPage
          did={did}
          mints={mints}
          preferences={preferences}
          p2pkKey={p2pkKey}
          onUpdatePreferences={updatePreferences}
          onClose={() => setShowSettings(false)}
        />
      )}
      {trustMintState && (
        <TrustMintDialog
          mintUrl={trustMintState.mintUrl}
          amount={trustMintState.amount}
          unit={trustMintState.unit}
          defaultMint={orderedMints[0]}
          mints={orderedMints}
          onTrustAndClaim={handleTrustAndClaim}
          onSwapToMint={handleSwapToMint}
          onCancel={() => setTrustMintState(null)}
        />
      )}
      {showPayRequest && (
        <PayRequestDialog
          encodedRequest={showPayRequest}
          mints={orderedMints}
          mintBalances={mintBalances}
          getUnspentProofs={getUnspentProofsForMint}
          onClose={() => setShowPayRequest(null)}
          onNewProofs={storeNewProofs}
          onOldProofsSpent={removeProofsByIds}
          onMarkPending={markProofsPending}
          onTransactionCreated={recordTransaction}
        />
      )}
      {showCreateRequest && hasMints && (
        <CreateRequestDialog mints={orderedMints} onClose={() => setShowCreateRequest(false)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root app
// ---------------------------------------------------------------------------

function AppContent() {
  const { isConnected, recoveryPhrase, clearRecoveryPhrase } = useEnbox();

  if (!isConnected) {
    return <Welcome />;
  }

  return (
    <>
      <WalletHome />
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
