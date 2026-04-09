/**
 * "Paste from clipboard" button used inside the unified Send modal.
 *
 * Two modes:
 *
 * 1. Button mode — a big pill that calls `navigator.clipboard.readText()`
 *    inside the click handler (which counts as user activation for
 *    Safari/Firefox). On success, the detected result is passed up via
 *    `onPaste`. On failure (denied, empty, unrecognized) we keep the
 *    button visible but reveal a hidden text input the user can paste into.
 *
 * 2. Fallback input — a bare text input with `onPaste` bound that activates
 *    when programmatic clipboard read fails. This is the one path that
 *    works everywhere (iOS Safari, Firefox, desktop Chrome with focus issues).
 *
 * The button also accepts a `highlightType` prop — when truthy, it shows a
 * friendly hint like "Lightning invoice detected" or "Cashu token detected"
 * next to the Paste label. This is powered by `useClipboardDetect` in the
 * parent, which silently probes the clipboard when possible.
 */
import { useRef, useState } from 'react';
import { ClipboardPasteIcon, Loader2Icon } from 'lucide-react';

import { detectInput, type DetectedInput } from '@/lib/input-detect';
import { toastError } from '@/lib/utils';

/**
 * Map detected input type → short human label for hint text.
 */
const TYPE_LABELS: Record<DetectedInput['type'], string> = {
  'payment-request'  : 'Payment request',
  'cashu-token'      : 'Cashu token',
  'lightning-invoice': 'Lightning invoice',
  'lnurl'            : 'LNURL',
  'lightning-address': 'Lightning address',
  'mint-url'         : 'Mint URL',
  'did'              : 'DID',
  'unknown'          : '',
};

interface ClipboardButtonProps {
  /** Called with the parsed detection result once the clipboard has been read. */
  onPaste: (detected: DetectedInput) => void;
  /** Optional function that does a best-effort silent read — used on mount / focus. */
  readClipboard?: () => Promise<DetectedInput | null>;
  /**
   * If the parent has detected a known type via silent probing, pass its
   * label here and the button will show a subtle "Lightning invoice ready
   * in clipboard" hint.
   */
  highlightType?: DetectedInput['type'] | null;
  disabled?: boolean;
}

export const ClipboardButton: React.FC<ClipboardButtonProps> = ({
  onPaste,
  readClipboard,
  highlightType,
  disabled,
}) => {
  const [busy, setBusy] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const fallbackRef = useRef<HTMLInputElement>(null);

  const handleClick = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      let detected: DetectedInput | null = null;

      // Prefer the parent's clipboard reader (which may use a shared permission
      // state), but fall through to readText() directly if not provided.
      if (readClipboard) {
        detected = await readClipboard();
      } else {
        try {
          const text = await navigator.clipboard.readText();
          if (text?.trim()) detected = detectInput(text);
        } catch {
          detected = null;
        }
      }

      if (!detected || detected.type === 'unknown') {
        // Silent read failed or returned something we don't recognize. Reveal
        // the fallback input and let the user Cmd/Ctrl+V into it.
        setShowFallback(true);
        // Focus the fallback after render
        setTimeout(() => fallbackRef.current?.focus(), 0);
        if (!detected) {
          toastError(
            'Couldn\u2019t read clipboard',
            new Error('Paste directly into the input below.'),
          );
        } else {
          toastError(
            'Unrecognized content',
            new Error('Expected a Cashu token, Lightning invoice, payment request, LNURL, or DID.'),
          );
        }
        return;
      }

      onPaste(detected);
    } finally {
      setBusy(false);
    }
  };

  const handleFallbackPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text?.trim()) return;
    e.preventDefault();
    const detected = detectInput(text);
    if (detected.type === 'unknown') {
      toastError(
        'Unrecognized content',
        new Error('Expected a Cashu token, Lightning invoice, payment request, LNURL, or DID.'),
      );
      return;
    }
    onPaste(detected);
    if (fallbackRef.current) fallbackRef.current.value = '';
    setShowFallback(false);
  };

  const hasHint = !!highlightType && TYPE_LABELS[highlightType];

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy || disabled}
        className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-full border text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
          hasHint
            ? 'border-primary/60 bg-primary/5 text-primary hover:bg-primary/10'
            : 'border-border bg-card hover:bg-muted text-foreground'
        }`}
      >
        {busy
          ? <Loader2Icon className="h-4 w-4 animate-spin" />
          : <ClipboardPasteIcon className="h-4 w-4" />}
        <span>
          {hasHint
            ? <>Paste <span className="opacity-70">· {TYPE_LABELS[highlightType]} detected</span></>
            : 'Paste from clipboard'}
        </span>
      </button>

      {showFallback && (
        <input
          ref={fallbackRef}
          type="text"
          onPaste={handleFallbackPaste}
          placeholder={'Paste here\u2026'}
          className="w-full px-3 py-2 rounded-lg bg-background border border-border text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      )}
    </div>
  );
};
