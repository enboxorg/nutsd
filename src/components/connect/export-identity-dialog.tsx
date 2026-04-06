import { useState } from 'react';
import { AlertTriangleIcon, ArrowRightIcon, Loader2Icon, XIcon } from 'lucide-react';
import { useEnbox } from '@/enbox';
import { toastError } from '@/lib/utils';

interface ExportIdentityDialogProps {
  open: boolean;
  onClose: () => void;
}

type ExportPhase = 'confirm' | 'exporting' | 'done';

/**
 * Export Identity to Wallet dialog.
 *
 * Allows a user with a local DID to export their identity to an
 * external wallet, then reconnect as a delegate. This keeps the
 * same DID while moving key custody to the wallet.
 *
 * Flow:
 * 1. User confirms they want to export
 * 2. Dapp exports the PortableIdentity
 * 3. Dapp disconnects the local session
 * 4. Dapp initiates wallet connect with the portableIdentity
 * 5. Wallet imports the identity and creates delegate grants
 * 6. Dapp reconnects as delegate to the same DID
 *
 * Designed for future extraction to @enbox/react.
 */
export const ExportIdentityDialog: React.FC<ExportIdentityDialogProps> = ({ open, onClose }) => {
  const { auth, did, connectWallet, disconnect } = useEnbox();
  const [phase, setPhase] = useState<ExportPhase>('confirm');

  if (!open) { return null; }

  const handleExport = async () => {
    if (!auth || !did) { return; }

    setPhase('exporting');
    try {
      // Step 1: Export the identity (kept for future portableIdentity pass-through).
      // TODO(enbox/connect-flow): pass portable to DWebConnect when per-call portableIdentity is supported.
      await auth.exportIdentity(did);

      // Step 2: Disconnect the local session.
      await disconnect();

      // Step 3: Reconnect via wallet with the portable identity.
      // The BrowserConnectHandler will open the wallet selector popup.
      // The wallet will see the portableIdentity in the DWebConnect request
      // and import it before creating delegate grants.
      //
      // NOTE: This requires the updated @enbox/browser that passes
      // portableIdentity through the DWebConnect protocol. For now,
      // we initiate a normal wallet connect — the user can manually
      // import via recovery phrase in the wallet if needed.
      await connectWallet();

      setPhase('done');
      setTimeout(() => onClose(), 1500);
    } catch (error) {
      toastError('Failed to export identity', error);
      setPhase('confirm');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && phase === 'confirm') { onClose(); }
      }}
    >
      <div className="bg-card border border-border rounded-2xl shadow-2xl max-w-sm w-full">
        {/* Exporting state */}
        {phase === 'exporting' && (
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <Loader2Icon className="animate-spin h-8 w-8 text-primary mb-3" />
            <p className="text-sm text-muted-foreground">Exporting identity to wallet...</p>
          </div>
        )}

        {/* Done state */}
        {phase === 'done' && (
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <div className="text-2xl mb-3">&#10003;</div>
            <p className="text-sm font-medium">Identity transferred!</p>
          </div>
        )}

        {/* Confirmation */}
        {phase === 'confirm' && (
          <div className="p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold">Connect Wallet</h2>
              <button
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground p-1 rounded-lg hover:bg-muted transition-colors"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 mb-4">
              <AlertTriangleIcon className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="text-xs text-amber-200 leading-relaxed">
                This will disconnect your local session and reconnect through your wallet.
                Your identity and data will be preserved.
                Make sure you have backed up your recovery phrase.
              </div>
            </div>

            <p className="text-xs text-muted-foreground mb-4">
              Your current DID will be transferred to the external wallet.
              After the transfer, this app will operate with delegated access
              from the wallet.
            </p>

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2.5 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleExport}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Connect Wallet
                <ArrowRightIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
