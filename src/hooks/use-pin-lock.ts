import { useState, useCallback, useEffect } from 'react';

const PIN_HASH_KEY = 'enbox:pin-hash';

/**
 * Derive a SHA-256 hash of the PIN for safe localStorage storage.
 * We never store the PIN itself — only a hash for comparison on unlock.
 */
async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Optional PIN lock for the wallet.
 *
 * By default, the wallet is unlocked. The user can enable a PIN from
 * settings, after which a lock screen is shown on page load and when
 * the user manually locks.
 *
 * The PIN is a UI gate — it does NOT change the vault encryption key.
 * The vault password remains a random string in localStorage. The PIN
 * prevents casual access when someone else uses the same browser.
 */
export function usePinLock() {
  const [isPinEnabled, setIsPinEnabled] = useState(() => !!localStorage.getItem(PIN_HASH_KEY));
  const [isLocked, setIsLocked] = useState(() => !!localStorage.getItem(PIN_HASH_KEY));

  /** Enable PIN lock — user sets a new PIN. */
  const setPin = useCallback(async (pin: string) => {
    const hash = await hashPin(pin);
    localStorage.setItem(PIN_HASH_KEY, hash);
    setIsPinEnabled(true);
    setIsLocked(false);
  }, []);

  /** Disable PIN lock — removes the stored hash. */
  const removePin = useCallback(() => {
    localStorage.removeItem(PIN_HASH_KEY);
    setIsPinEnabled(false);
    setIsLocked(false);
  }, []);

  /** Verify an entered PIN against the stored hash. Returns true if correct. */
  const verifyPin = useCallback(async (pin: string): Promise<boolean> => {
    const storedHash = localStorage.getItem(PIN_HASH_KEY);
    if (!storedHash) { return true; } // No PIN set — always pass.
    const hash = await hashPin(pin);
    return hash === storedHash;
  }, []);

  /** Attempt to unlock with the given PIN. Returns true on success. */
  const unlock = useCallback(async (pin: string): Promise<boolean> => {
    const ok = await verifyPin(pin);
    if (ok) { setIsLocked(false); }
    return ok;
  }, [verifyPin]);

  /** Manually lock the wallet. */
  const lock = useCallback(() => {
    if (isPinEnabled) { setIsLocked(true); }
  }, [isPinEnabled]);

  // Auto-lock when the page is hidden for more than 5 minutes.
  useEffect(() => {
    if (!isPinEnabled) { return; }

    let hiddenAt: number | null = null;
    const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes

    const handleVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else if (hiddenAt && (Date.now() - hiddenAt) > AUTO_LOCK_MS) {
        setIsLocked(true);
        hiddenAt = null;
      } else {
        hiddenAt = null;
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [isPinEnabled]);

  return {
    /** Whether a PIN has been configured. */
    isPinEnabled,
    /** Whether the wallet is currently locked (PIN required to proceed). */
    isLocked,
    /** Set a new PIN (enables PIN lock). */
    setPin,
    /** Remove the PIN (disables PIN lock). */
    removePin,
    /** Attempt to unlock with the given PIN. Returns true on success. */
    unlock,
    /** Manually lock the wallet. */
    lock,
  };
}
