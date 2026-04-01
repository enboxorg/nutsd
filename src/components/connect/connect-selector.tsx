import { Loader2Icon, KeyRoundIcon, XIcon, ShieldAlertIcon } from "lucide-react";
import { useEnbox } from "@/enbox";
import { useState } from "react";
import { toastError } from "@/lib/utils";

interface ConnectSelectorProps {
  close: () => void;
}

type ConnectState = 'init' | 'loading';

/**
 * Connect selector for nutsd.
 *
 * Only local DID creation is offered. Wallet-connect (delegate mode)
 * is intentionally blocked because delegate DIDs lack X25519 encryption
 * keys — writes to `encryptionRequired: true` protocol types would fail,
 * leaving bearer material (proofs, tokens) unencrypted or rejected.
 */
export const ConnectSelector: React.FC<ConnectSelectorProps> = ({ close }) => {
  const { connectLocal } = useEnbox();
  const [state, setState] = useState<ConnectState>('init');

  const handleCreateDid = async () => {
    setState('loading');
    try {
      await connectLocal();
      close();
    } catch (error) {
      toastError('Error creating new DID', error);
      setState('init');
    }
  };

  return (
    <div className="bg-card border border-border p-6 rounded-xl shadow-xl max-w-sm w-full mx-4">
      {state === 'loading' && (
        <div className="flex items-center justify-center py-8">
          <Loader2Icon className="animate-spin h-8 w-8 text-primary" />
        </div>
      )}
      {state === 'init' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold">Get Started</h3>
            <button onClick={close} className="text-muted-foreground hover:text-foreground">
              <XIcon className="h-4 w-4" />
            </button>
          </div>

          <p className="text-xs text-muted-foreground mb-4">
            Create a local decentralized identity (DID) with full encryption support.
            Your wallet data is encrypted and stored in your personal DWN.
          </p>

          <div className="flex flex-col space-y-3">
            <button
              onClick={handleCreateDid}
              className="flex items-center px-4 py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity"
            >
              <KeyRoundIcon className="mr-3 h-4 w-4" />
              Create Identity
            </button>
          </div>

          <div className="mt-4 flex items-start gap-2 p-2.5 rounded-lg bg-muted/50">
            <ShieldAlertIcon className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Wallet-connect (delegate mode) is disabled because delegate DIDs
              cannot encrypt records. All wallet data requires end-to-end encryption.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
