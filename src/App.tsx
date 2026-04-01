import { useState, useCallback } from 'react';

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

import { toastError } from '@/lib/utils';
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
    loading,
    addMint,
    removeMint,
    addProof,
    deleteProofs,
    addTransaction,
    getUnspentProofsForMint,
  } = useWallet();

  // Dialog state
  const [showAddMint, setShowAddMint] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [selectedMint, setSelectedMint] = useState<Mint | null>(null);

  const hasMints = mints.length > 0;

  // --- Proof persistence helpers ---

  /** Store Cashu proofs as DWN records. */
  const storeNewProofs = useCallback(async (mintContextId: string, cashuProofs: Proof[]) => {
    for (const proof of cashuProofs) {
      await addProof(mintContextId, {
        amount : proof.amount,
        id     : proof.id,
        secret : proof.secret,
        C      : proof.C,
      } as ProofData);
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

  const recordTransaction = useCallback(async (data: Omit<TransactionData, 'createdAt'>) => {
    await addTransaction({
      ...data,
      createdAt: new Date().toISOString(),
    });
  }, [addTransaction]);

  const handleAddMint = useCallback(async (data: MintData) => {
    await addMint(data);
  }, [addMint]);

  /** Check if a sent token has been claimed by the recipient (NUT-07). */
  const handleCheckTokenSpent = useCallback(async (tx: Transaction): Promise<boolean | null> => {
    if (!tx.cashuToken) return null;
    return checkTokenSpent(tx.cashuToken, tx.mintUrl, tx.unit);
  }, []);

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

            <MintListCard
              mints={mints}
              mintBalances={mintBalances}
              onAddMint={() => setShowAddMint(true)}
              onSelectMint={setSelectedMint}
            />

            <TransactionListCard
              transactions={transactions}
              onCheckTokenSpent={handleCheckTokenSpent}
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
          onClose={() => setShowWithdraw(false)}
          onNewProofs={storeNewProofs}
          onOldProofsSpent={removeProofsByIds}
          onTransactionCreated={recordTransaction}
        />
      )}
      {showSend && hasMints && (
        <SendDialog
          mints={mints}
          mintBalances={mintBalances}
          getUnspentProofs={getUnspentProofsForMint}
          onClose={() => setShowSend(false)}
          onNewProofs={storeNewProofs}
          onOldProofsSpent={removeProofsByIds}
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
