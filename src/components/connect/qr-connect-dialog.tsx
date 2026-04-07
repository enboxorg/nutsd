import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, Loader2Icon } from 'lucide-react';
import QRCode from 'qrcode';
import { normalizeProtocolRequests } from '@enbox/browser';
import { useEnbox } from '@/enbox';
import { CashuWalletDefinition } from '@/protocol/cashu-wallet-protocol';
import { CashuTransferDefinition } from '@/protocol/cashu-transfer-protocol';
import { brand } from '@/lib/brand';

// Connect relay servers — must include /connect path segment.
// WalletConnect.initClient appends /par, /authorize, /token to this base.
const RELAY_SERVERS = [
  'https://dev.aws.dwn.enbox.id/connect',
  'https://enbox-dwn.fly.dev/connect',
];

/** Minimal def for the DWN permissions protocol — needed for sync grants. */
const DWN_PERMISSIONS_PROTOCOL = {
  protocol  : 'https://identity.foundation/dwn/permissions',
  published : true,
  types     : {},
  structure : {},
};

/** All protocol definitions this dapp needs for QR connect. */
const DAPP_PROTOCOLS = [CashuWalletDefinition, CashuTransferDefinition, DWN_PERMISSIONS_PROTOCOL];

interface QRConnectDialogProps {
  onBack: () => void;
  onClose: () => void;
}

type QRPhase = 'generating' | 'waiting' | 'pin' | 'connecting' | 'error';

/**
 * QR code connect dialog for cross-device wallet connect.
 *
 * Uses the WalletConnect relay flow:
 * 1. Generates a connect URI -> renders as QR code
 * 2. Wallet scans QR -> creates delegate grants
 * 3. User enters PIN from wallet -> session established
 *
 * Designed for future extraction to @enbox/react.
 */
export const QRConnectDialog: React.FC<QRConnectDialogProps> = ({ onBack, onClose }) => {
  const { auth, applySession } = useEnbox();
  const [phase, setPhase] = useState<QRPhase>('generating');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [pin, setPin] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const pinResolveRef = useRef<((pin: string) => void) | null>(null);
  const abortRef = useRef(false);

  // Start the wallet connect flow
  const startConnect = useCallback(async () => {
    if (!auth) {
      setErrorMessage('Auth not ready. Please try again.');
      setPhase('error');
      return;
    }

    abortRef.current = false;
    setPhase('generating');

    try {
      // Build agent-level permission requests from the dapp protocol
      // definitions using normalizeProtocolRequests, which handles
      // the ProtocolDefinition -> ConnectPermissionRequest conversion
      // including default scopes (read, write, delete, query, subscribe, configure).
      const permissionRequests = normalizeProtocolRequests(DAPP_PROTOCOLS);

      const session = await auth.walletConnect({
        displayName        : brand.name,
        connectServerUrl   : RELAY_SERVERS[0],
        permissionRequests,
        onWalletUriReady   : async (uri: string) => {
          const dataUrl = await QRCode.toDataURL(uri, {
            width                : 280,
            margin               : 2,
            color                : { dark: '#ffffff', light: '#00000000' },
            errorCorrectionLevel : 'M',
          });
          setQrDataUrl(dataUrl);
          setPhase('waiting');
        },
        validatePin: () => new Promise<string>((resolve) => {
          pinResolveRef.current = resolve;
          setPhase('pin');
        }),
      });

      if (!abortRef.current) {
        applySession(session);
        onClose();
      }
    } catch (err) {
      if (!abortRef.current) {
        setErrorMessage((err as Error).message || 'Connection failed.');
        setPhase('error');
      }
    }
  }, [auth, applySession, onClose]);

  useEffect(() => {
    startConnect();
    return () => { abortRef.current = true; };
  }, [startConnect]);

  const handlePinSubmit = () => {
    if (pin.length === 4 && pinResolveRef.current) {
      pinResolveRef.current(pin);
      pinResolveRef.current = null;
      setPhase('connecting');
    }
  };

  return (
    <div className="p-6">
      {/* Header with back button */}
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={() => { abortRef.current = true; onBack(); }}
          className="text-muted-foreground hover:text-foreground p-1 rounded-lg hover:bg-muted transition-colors"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <h2 className="text-lg font-semibold">Scan with Wallet</h2>
      </div>

      {/* Generating QR */}
      {phase === 'generating' && (
        <div className="flex flex-col items-center py-12 gap-3">
          <Loader2Icon className="animate-spin h-8 w-8 text-primary" />
          <p className="text-sm text-muted-foreground">Generating QR code...</p>
        </div>
      )}

      {/* QR code display */}
      {phase === 'waiting' && qrDataUrl && (
        <div className="flex flex-col items-center gap-4">
          <div className="bg-card border border-border rounded-xl p-3">
            <img src={qrDataUrl} alt="Connect QR code" className="w-56 h-56" />
          </div>
          <p className="text-sm text-muted-foreground text-center">
            Scan this QR code with your Enbox wallet app
          </p>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2Icon className="animate-spin h-3 w-3" />
            Waiting for wallet...
          </div>
        </div>
      )}

      {/* PIN input */}
      {phase === 'pin' && (
        <div className="flex flex-col items-center gap-4">
          <p className="text-sm text-muted-foreground text-center">
            Enter the PIN shown in your wallet
          </p>
          <input
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onKeyDown={(e) => { if (e.key === 'Enter') { handlePinSubmit(); } }}
            className="w-40 text-center text-3xl font-bold tracking-[0.5em] bg-muted border border-border rounded-xl py-3 px-4 text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            autoFocus
            placeholder="----"
          />
          <button
            onClick={handlePinSubmit}
            disabled={pin.length !== 4}
            className="px-6 py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            Verify
          </button>
        </div>
      )}

      {/* Connecting */}
      {phase === 'connecting' && (
        <div className="flex flex-col items-center py-12 gap-3">
          <Loader2Icon className="animate-spin h-8 w-8 text-primary" />
          <p className="text-sm text-muted-foreground">Connecting...</p>
        </div>
      )}

      {/* Error */}
      {phase === 'error' && (
        <div className="flex flex-col items-center gap-4 py-8">
          <p className="text-sm text-red-400 text-center">{errorMessage}</p>
          <button
            onClick={() => { setPin(''); startConnect(); }}
            className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
};
