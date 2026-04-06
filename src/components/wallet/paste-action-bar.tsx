import { useState, useRef } from 'react';
import { ClipboardPasteIcon, ScanLineIcon, Loader2Icon } from 'lucide-react';
import { detectInput } from '@/lib/input-detect';
import { toastError } from '@/lib/utils';

interface PasteActionBarProps {
  /** Route a detected cashu token to the receive flow. */
  onCashuToken: (token: string) => void;
  /** Route a detected Lightning invoice to the withdraw flow. */
  onLightningInvoice: (invoice: string) => void;
  /** Route a detected mint URL to the add-mint flow. */
  onMintUrl: (url: string) => void;
  /** Route a detected LNURL or Lightning address to the pay flow. */
  onLnurlOrAddress?: (value: string, type: 'lightning-address' | 'lnurl') => void;
  /** Route a detected NUT-18 payment request. */
  onPaymentRequest?: (encoded: string) => void;
  /** Open the QR scanner. */
  onScanQr: () => void;
  disabled?: boolean;
}

/**
 * Compact paste/scan bar for universal input detection.
 *
 * Users can paste anything — Cashu tokens, Lightning invoices, LNURL strings,
 * Lightning addresses, or mint URLs — and the bar auto-detects and routes
 * to the appropriate flow.
 */
export const PasteActionBar: React.FC<PasteActionBarProps> = ({
  onCashuToken,
  onLightningInvoice,
  onMintUrl,
  onLnurlOrAddress,
  onPaymentRequest,
  onScanQr,
  disabled,
}) => {
  const [processing, setProcessing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePaste = async () => {
    setProcessing(true);
    try {
      const text = await navigator.clipboard.readText();
      if (!text?.trim()) {
        toastError('Clipboard empty', new Error('Nothing to paste'));
        return;
      }
      routeInput(text);
    } catch {
      toastError('Paste failed', new Error('Clipboard access denied. Try pasting into the input field.'));
    } finally {
      setProcessing(false);
    }
  };

  const handleInputPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (text?.trim()) {
      e.preventDefault();
      routeInput(text);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const routeInput = (raw: string) => {
    const detected = detectInput(raw);
    switch (detected.type) {
      case 'cashu-token':
        onCashuToken(detected.value);
        break;
      case 'lightning-invoice':
        onLightningInvoice(detected.value);
        break;
      case 'lnurl':
      case 'lightning-address':
        if (onLnurlOrAddress) {
          onLnurlOrAddress(detected.value, detected.type);
        } else {
          toastError('Not yet supported', new Error(
            detected.type === 'lnurl'
              ? 'LNURL support is coming in a future update.'
              : `Lightning address (${detected.value}) support is coming in a future update.`,
          ));
        }
        break;
      case 'mint-url':
        onMintUrl(detected.value);
        break;
      case 'payment-request':
        if (onPaymentRequest) onPaymentRequest(detected.value);
        else toastError('Payment requests', new Error('Not supported yet'));
        break;
      case 'unknown':
        toastError('Unrecognized input', new Error(
          'Expected a Cashu token, Lightning invoice, or mint URL.',
        ));
        break;
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Hidden paste target for browsers that block clipboard.readText */}
      <div className="flex-1 relative">
        <input
          ref={inputRef}
          type="text"
          placeholder="Paste token, invoice, or URL..."
          onPaste={handleInputPaste}
          disabled={disabled}
          className="w-full px-3 py-2 pl-9 rounded-lg bg-background border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
        />
        <ClipboardPasteIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
      </div>

      {/* Paste button (reads from clipboard API) */}
      <button
        onClick={handlePaste}
        disabled={disabled || processing}
        className="px-3 py-2 rounded-lg border border-border text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50 flex items-center gap-1.5"
        title="Paste from clipboard"
      >
        {processing ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> : <ClipboardPasteIcon className="h-3.5 w-3.5" />}
        Paste
      </button>

      {/* QR scan button */}
      <button
        onClick={onScanQr}
        disabled={disabled}
        className="px-3 py-2 rounded-lg border border-border text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50 flex items-center gap-1.5"
        title="Scan QR code"
      >
        <ScanLineIcon className="h-3.5 w-3.5" />
        Scan
      </button>
    </div>
  );
};
