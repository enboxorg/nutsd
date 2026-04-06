import { useState } from 'react';
import { Loader2Icon, KeyRoundIcon, LinkIcon, SmartphoneIcon, XIcon } from 'lucide-react';
import { useEnbox } from '@/enbox';
import { toastError } from '@/lib/utils';
import { QRConnectDialog } from './qr-connect-dialog';

interface ConnectModalProps {
  open: boolean;
  onClose: () => void;
}

type ConnectState = 'init' | 'loading' | 'qr';

/**
 * Redesigned connect modal for nutsd.
 *
 * Presents three clear paths:
 * 1. Quick Start — create a local DID (primary CTA)
 * 2. Same Browser — open wallet selector / DWebConnect popup
 * 3. Scan QR — cross-device relay connect flow
 *
 * Designed for future extraction to @enbox/react.
 */
export const ConnectModal: React.FC<ConnectModalProps> = ({ open, onClose }) => {
  const { connectLocal, connectWallet } = useEnbox();
  const [state, setState] = useState<ConnectState>('init');

  if (!open) { return null; }

  const handleQuickStart = async () => {
    setState('loading');
    try {
      await connectLocal();
      onClose();
    } catch (error) {
      toastError('Failed to create identity', error);
      setState('init');
    }
  };

  const handleConnectWallet = async () => {
    setState('loading');
    try {
      await connectWallet();
      onClose();
    } catch (error) {
      toastError('Failed to connect wallet', error);
      setState('init');
    }
  };

  const handleQRConnect = () => {
    setState('qr');
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget && state === 'init') { onClose(); }
        }}
      >
        <div className="bg-card border border-border rounded-2xl shadow-2xl max-w-sm w-full animate-in fade-in slide-in-from-bottom-4 duration-200">
          {/* Loading state */}
          {state === 'loading' && (
            <div className="flex flex-col items-center justify-center py-16 px-6">
              <Loader2Icon className="animate-spin h-8 w-8 text-primary mb-3" />
              <p className="text-sm text-muted-foreground">Setting up...</p>
            </div>
          )}

          {/* QR connect */}
          {state === 'qr' && (
            <QRConnectDialog onBack={() => setState('init')} onClose={onClose} />
          )}

          {/* Main selection */}
          {state === 'init' && (
            <div className="p-6">
              {/* Header */}
              <div className="flex justify-between items-center mb-5">
                <h2 className="text-lg font-semibold">Get Started</h2>
                <button
                  onClick={onClose}
                  className="text-muted-foreground hover:text-foreground p-1 rounded-lg hover:bg-muted transition-colors"
                >
                  <XIcon className="h-4 w-4" />
                </button>
              </div>

              {/* Quick Start — primary CTA */}
              <button
                onClick={handleQuickStart}
                className="w-full flex items-start gap-3 p-4 rounded-xl bg-primary text-primary-foreground hover:opacity-90 transition-opacity text-left mb-4"
              >
                <KeyRoundIcon className="h-5 w-5 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium text-sm">Quick Start</div>
                  <div className="text-xs opacity-80 mt-0.5">
                    Create a local identity with full self-custody on this device.
                  </div>
                </div>
              </button>

              {/* Separator */}
              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground">or connect your wallet</span>
                <div className="flex-1 h-px bg-border" />
              </div>

              {/* Secondary options */}
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={handleConnectWallet}
                  className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border bg-card hover:bg-muted transition-colors text-center"
                >
                  <LinkIcon className="h-5 w-5 text-primary" />
                  <div>
                    <div className="font-medium text-xs">Same Browser</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">Popup connect</div>
                  </div>
                </button>

                <button
                  onClick={handleQRConnect}
                  className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border bg-card hover:bg-muted transition-colors text-center"
                >
                  <SmartphoneIcon className="h-5 w-5 text-primary" />
                  <div>
                    <div className="font-medium text-xs">Phone Wallet</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">Scan QR code</div>
                  </div>
                </button>
              </div>

              {/* Footer hint */}
              <p className="mt-5 text-[10px] text-muted-foreground leading-relaxed text-center">
                Quick Start creates a decentralized identity on this device.
                You can connect a wallet later to sync across devices.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
