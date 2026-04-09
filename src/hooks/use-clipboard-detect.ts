/**
 * Shared hook for clipboard-aware paste UX.
 *
 * Two jobs:
 *
 * 1. `probe()` — best-effort check whether the clipboard has something
 *    that looks like an actionable input (cashu token, Lightning invoice,
 *    payment request, LNURL, lightning address, DID, mint URL). Used by
 *    the Send modal to pre-highlight or hint at the Paste button.
 *
 *    This only works on Chrome/Edge where `navigator.permissions.query(
 *    { name: 'clipboard-read' })` returns 'granted' AND the tab has focus
 *    with a recent user gesture. On Safari/Firefox we gracefully return
 *    `{ known: false, preview: null }` — the Paste button still renders.
 *
 * 2. `readClipboard()` — explicit, gesture-backed read via
 *    `navigator.clipboard.readText()`. Called from the Paste button's
 *    onClick, so it benefits from the user-activation required by Safari.
 *
 * The hook does NOT auto-route — it just returns what it found. The
 * caller decides what to do (fill the confirm card, nudge the button,
 * show a toast).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { detectInput, type DetectedInput } from '@/lib/input-detect';

export interface ClipboardProbeResult {
  /** True if we successfully read the clipboard AND detected a known type. */
  known: boolean;
  /** A short type-label for the detected value, or null. */
  preview: DetectedInput['type'] | null;
  /** The raw detected value, or null. Never surfaced as a "paste content" leak. */
  value: string | null;
}

export interface UseClipboardDetectOptions {
  /** Whether to probe on mount. Default: true. */
  autoProbe?: boolean;
}

export interface UseClipboardDetectResult {
  /** Latest probe result. Starts as `{ known: false, preview: null, value: null }`. */
  probe: ClipboardProbeResult;
  /** Force a new probe attempt. Best-effort; may return unknown on strict browsers. */
  reprobe: () => Promise<ClipboardProbeResult>;
  /** Explicitly read the clipboard (use inside a click handler). */
  readClipboard: () => Promise<DetectedInput | null>;
  /** Whether clipboard.readText is accessible at all in this environment. */
  isClipboardAvailable: boolean;
}

const EMPTY: ClipboardProbeResult = { known: false, preview: null, value: null };

/**
 * Check if navigator.clipboard.readText is plausibly usable.
 * Does not guarantee success — Safari still blocks without user gesture.
 */
function hasClipboardRead(): boolean {
  return typeof navigator !== 'undefined'
      && typeof navigator.clipboard !== 'undefined'
      && typeof navigator.clipboard.readText === 'function';
}

/**
 * Probe whether clipboard-read permission is already granted so we can
 * do a silent readText() without prompting. Returns false on browsers
 * that don't support the Permissions API for clipboard-read.
 */
async function hasClipboardReadPermission(): Promise<boolean> {
  try {
    // Note: 'clipboard-read' is not in the standard PermissionName TS type
    // but is supported in Chromium browsers. Cast to any to bypass.
    const permissions = (navigator as any).permissions;
    if (!permissions?.query) return false;
    const status = await permissions.query({ name: 'clipboard-read' as PermissionName });
    return status.state === 'granted';
  } catch {
    // Expected: Safari/Firefox don't support 'clipboard-read' permission name
    return false;
  }
}

export function useClipboardDetect(
  options: UseClipboardDetectOptions = {},
): UseClipboardDetectResult {
  const { autoProbe = true } = options;

  const [probe, setProbe] = useState<ClipboardProbeResult>(EMPTY);
  const isClipboardAvailable = useRef(hasClipboardRead()).current;

  const doProbe = useCallback(async (): Promise<ClipboardProbeResult> => {
    if (!isClipboardAvailable) {
      setProbe(EMPTY);
      return EMPTY;
    }

    // Only attempt silent read when the user has already granted permission
    // AND the tab has focus. Without focus, Chrome will throw NotAllowedError.
    if (typeof document !== 'undefined' && !document.hasFocus()) {
      setProbe(EMPTY);
      return EMPTY;
    }

    const granted = await hasClipboardReadPermission();
    if (!granted) {
      setProbe(EMPTY);
      return EMPTY;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (!text?.trim()) {
        setProbe(EMPTY);
        return EMPTY;
      }
      const detected = detectInput(text);
      if (detected.type === 'unknown') {
        setProbe(EMPTY);
        return EMPTY;
      }
      const result: ClipboardProbeResult = {
        known   : true,
        preview : detected.type,
        value   : detected.value,
      };
      setProbe(result);
      return result;
    } catch {
      // Expected: permission was revoked, or tab lost focus between
      // the permission check and readText(). Silently fall through.
      setProbe(EMPTY);
      return EMPTY;
    }
  }, [isClipboardAvailable]);

  const readClipboard = useCallback(async (): Promise<DetectedInput | null> => {
    if (!isClipboardAvailable) return null;
    try {
      const text = await navigator.clipboard.readText();
      if (!text?.trim()) return null;
      return detectInput(text);
    } catch {
      // Expected: Safari/Firefox may reject even with an active user gesture
      return null;
    }
  }, [isClipboardAvailable]);

  // Initial probe on mount, plus re-probe when the window regains focus
  // (user may have copied something in another app).
  useEffect(() => {
    if (!autoProbe) return;
    doProbe();
    const handleFocus = () => { doProbe(); };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [autoProbe, doProbe]);

  return {
    probe,
    reprobe: doProbe,
    readClipboard,
    isClipboardAvailable,
  };
}
