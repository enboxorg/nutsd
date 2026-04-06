import { useState, useCallback, useEffect, useRef } from 'react';

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
import { ReceiveDialog } from '@/components/wallet/receive-dialog';
import { RecoveryPhraseDialog } from '@/components/connect/recovery-phrase-dialog';
import { Toaster } from 'sonner';

import { QrScanner } from '@/components/wallet/qr-scanner';
import { PasteActionBar } from '@/components/wallet/paste-action-bar';
import { detectInput } from '@/lib/input-detect';
import { receiveToken } from '@/cashu/wallet-ops';
import { extractMintUrl } from '@/cashu/token-utils';

import { toastError, toastSuccess } from '@/lib/utils';
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
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Wallet app (connected)
// ---------------------------------------------------------------------------

function WalletHome() {
  const { did, disconnect } = useEnbox();
  const { theme, setTheme } = useTheme();
  const {
    mints,
    transactions,
    totalBalance,
    mintBalances,
    mintFeePpk,
    keysetFeeMap,
    pendingProofCount,
    loading,
    reconciling,
    addMint,
    removeMint,
    addProof,
    deleteProofs,
    addTransaction,
    clearTransactionToken,
    getUnspentProofsForMint,
    markProofsPending,
    revertProofsToUnspent,
    reconcilePendingProofs,
    proofs,
  } = useWallet();

  // Dialog state
  const [showAddMint, setShowAddMint] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [selectedMint, setSelectedMint] = useState<Mint | null>(null);
  const [showScanner, setShowScanner] = useState(false);

  const hasMints = mints.length > 0;

  // --- Startup reconciliation ---
  // Run once after initial proofs load. Checks all pending proofs with mints.
  const reconciliationDone = useRef(false);
  useEffect(() => {
    if (!loading && proofs.length > 0 && !reconciliationDone.current) {
      reconciliationDone.current = true;
      reconcilePendingProofs().catch((err: unknown) =>
        console.error('[nutsd] Startup reconciliation failed:', err),
      );
    }
  }, [loading, proofs, reconcilePendingProofs]);

  // --- Proof persistence helpers ---

  /** Store Cashu proofs as DWN records. Preserves all fields (dleq, witness). */
  const storeNewProofs = useCallback(async (mintContextId: string, cashuProofs: Proof[]) => {
    for (const proof of cashuProofs) {
      const data: ProofData = {
        amount  : proof.amount,
        id      : proof.id,
        secret  : proof.secret,
        C       : proof.C,
        state   : 'unspent',
      };
      // Preserve optional NUT-12 DLEQ proof and NUT-10/11 witness
      if (proof.dleq) {
        data.dleq = {
          e: String(proof.dleq.e),
          s: String(proof.dleq.s),
          r: String(proof.dleq.r),
        };
      }
      if (proof.witness) {
        // witness can be string | P2PKWitness | HTLCWitness — serialize to string
        data.witness = typeof proof.witness === 'string'
          ? proof.witness
          : JSON.stringify(proof.witness);
      }
      await addProof(mintContextId, data);
    }
  }, [addProof]);

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
        setShowReceive(true);
        // Process the token directly
        (async () => {
          try {
            const mintUrl = extractMintUrl(detected.value);
            if (!mintUrl) throw new Error('Could not determine mint URL from token');
            const knownMint = mints.find(m => m.url === mintUrl);
            const newProofs = await receiveToken(mintUrl, detected.value);
            const totalReceived = newProofs.reduce((s, p) => s + p.amount, 0);
            const contextId = knownMint?.contextId ?? '';
            await storeNewProofsForMintUrl(contextId, newProofs, mintUrl);
            await recordTransaction({
              type   : 'receive',
              amount : totalReceived,
              unit   : 'sat',
              mintUrl,
              status : 'completed',
            });
            toastSuccess('Token received', `+${totalReceived} sat`);
            setShowReceive(false);
          } catch (err) {
            toastError('Failed to receive token', err);
          }
        })();
        break;
      case 'lightning-invoice':
        setShowWithdraw(true);
        break;
      case 'mint-url':
        setShowAddMint(true);
        break;
      default:
        toastError('Unrecognized QR code', new Error(
          'Expected a Cashu token, Lightning invoice, or mint URL.',
        ));
        break;
    }
  }, [mints, storeNewProofsForMintUrl, recordTransaction]);

  /** Reclaim an unclaimed sent token (NUT-07 reports all proofs UNSPENT). */
  const handleReclaimToken = useCallback(async (tx: Transaction) => {
    if (!tx.cashuToken) throw new Error('No token to reclaim');
    const mintUrl = tx.mintUrl;
    const newProofs = await receiveToken(mintUrl, tx.cashuToken, tx.unit);
    const totalReclaimed = newProofs.reduce((s, p) => s + p.amount, 0);

    const knownMint = mints.find(m => m.url === mintUrl);
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

    // Clear the bearer token from the original send transaction
    clearTransactionToken(tx.id);
    toastSuccess('Token reclaimed', `+${totalReclaimed} ${tx.unit}`);
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
          onBack={() => setSelectedMint(null)}
          onDelete={(id) => { removeMint(id); setSelectedMint(null); }}
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

            <BalanceCard
              totalBalance={totalBalance}
              unit="sat"
              mintCount={mints.length}
            />

            <ActionButtons
              onDeposit={() => setShowDeposit(true)}
              onWithdraw={() => setShowWithdraw(true)}
              onSend={() => setShowSend(true)}
              onReceive={() => setShowReceive(true)}
              disabled={!hasMints}
            />

            <PasteActionBar
              onCashuToken={(token) => handleScanResult(token)}
              onLightningInvoice={() => setShowWithdraw(true)}
              onMintUrl={() => setShowAddMint(true)}
              onScanQr={() => setShowScanner(true)}
              disabled={!hasMints}
            />

            <MintListCard
              mints={mints}
              mintBalances={mintBalances}
              onAddMint={() => setShowAddMint(true)}
              onSelectMint={setSelectedMint}
            />

            <TransactionListCard
              transactions={transactions}
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
          mints={mints}
          onClose={() => setShowDeposit(false)}
          onProofsReceived={storeNewProofs}
          onTransactionCreated={recordTransaction}
        />
      )}
      {showWithdraw && hasMints && (
        <WithdrawDialog
          mints={mints}
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
          mints={mints}
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
      {showReceive && (
        <ReceiveDialog
          mints={mints}
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
