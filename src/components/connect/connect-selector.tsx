import { Loader2Icon, KeyRoundIcon, LinkIcon, XIcon } from "lucide-react";
import { useEnbox } from "@/enbox";
import { useState } from "react";
import { toastError } from "@/lib/utils";

interface ConnectSelectorProps {
  close: () => void;
}

type ConnectState = 'init' | 'loading';

/**
 * Connect selector for nutsd.
 */
export const ConnectSelector: React.FC<ConnectSelectorProps> = ({ close }) => {
  const { connectLocal, connectWallet } = useEnbox();
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

  const handleConnectWallet = async () => {
    setState('loading');
    try {
      await connectWallet();
      close();
    } catch (error) {
      toastError('Error connecting wallet', error);
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
            Connect an Enbox wallet or create a local decentralized identity (DID).
            Sensitive wallet records stay encrypted in your personal DWN.
          </p>

          <div className="flex flex-col space-y-3">
            <button
              onClick={handleConnectWallet}
              className="flex items-center px-4 py-3 rounded-lg border border-border bg-card text-foreground font-medium text-sm hover:bg-muted transition-colors"
            >
              <LinkIcon className="mr-3 h-4 w-4" />
              Connect Enbox Wallet
            </button>
            <button
              onClick={handleCreateDid}
              className="flex items-center px-4 py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity"
            >
              <KeyRoundIcon className="mr-3 h-4 w-4" />
              Create Identity
            </button>
          </div>

          <p className="mt-4 text-[10px] text-muted-foreground leading-relaxed">
            Use a local identity for full self-custody on this device, or connect an
            external Enbox wallet to use delegated encrypted access from another wallet.
          </p>
        </div>
      )}
    </div>
  );
};
