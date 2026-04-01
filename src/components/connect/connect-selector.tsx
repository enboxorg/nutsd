import { Loader2Icon, User2Icon, Wallet2Icon, XIcon } from "lucide-react";
import { useEnbox } from "@/enbox";
import { useState } from "react";
import { toastError } from "@/lib/utils";

interface ConnectSelectorProps {
  close: () => void;
}

type ConnectState = 'init' | 'loading' | 'done';

export const ConnectSelector: React.FC<ConnectSelectorProps> = ({ close }) => {
  const { connect, connectLocal } = useEnbox();
  const [state, setState] = useState<ConnectState>('init');

  const handleWalletConnect = async () => {
    setState('loading');
    try {
      await connect();
      setState('done');
      setTimeout(close, 500);
    } catch (error) {
      toastError('Error connecting to wallet', error);
      setState('init');
    }
  };

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
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-lg font-semibold">Connect</h3>
          </div>
          <div className="flex flex-col space-y-3">
            <button
              onClick={handleWalletConnect}
              className="flex items-center px-4 py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity"
            >
              <Wallet2Icon className="mr-3 h-4 w-4" />
              Connect to a Wallet
            </button>
            <button
              onClick={handleCreateDid}
              className="flex items-center px-4 py-3 rounded-lg border border-border text-foreground font-medium text-sm hover:bg-muted transition-colors"
            >
              <User2Icon className="mr-3 h-4 w-4" />
              Create a New DID
            </button>
            <button
              onClick={() => close()}
              className="flex items-center px-4 py-3 rounded-lg text-muted-foreground text-sm hover:text-foreground transition-colors"
            >
              <XIcon className="mr-3 h-4 w-4" />
              Cancel
            </button>
          </div>
        </div>
      )}
      {state === 'done' && (
        <div className="flex items-center justify-center py-8 text-primary font-medium">
          Connected
        </div>
      )}
    </div>
  );
};
