/**
 * Global wallet operation mutex.
 *
 * Prevents concurrent wallet operations (mint, melt, send, swap) that could
 * lead to double-spending or inconsistent proof state. Only one operation
 * can hold the lock at a time; others wait or are rejected.
 *
 * Also handles `beforeunload` to warn the user if a wallet operation is
 * in-flight when they try to close the tab.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Mutex
// ---------------------------------------------------------------------------

let locked = false;
let lockHolder: string | null = null;
let waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

/**
 * Reset the mutex state (for testing only).
 * @internal
 */
export function _resetMutex(): void {
  locked = false;
  lockHolder = null;
  _isUnloading = false;
  for (const w of waitQueue) {
    w.reject(new Error('Mutex reset'));
  }
  waitQueue = [];
  removeBeforeUnload();
}

/**
 * Acquire the global wallet lock.
 *
 * @param operation - Name of the operation for debugging (e.g. 'melt', 'send')
 * @param timeout - Max milliseconds to wait for the lock (default: 30000)
 * @returns A release function that MUST be called when the operation completes
 * @throws if the lock cannot be acquired within the timeout
 */
export async function acquireWalletLock(
  operation: string,
  timeout = 30_000,
): Promise<() => void> {
  if (!locked) {
    locked = true;
    lockHolder = operation;
    installBeforeUnload();
    return createRelease(operation);
  }

  // Wait for the lock
  return new Promise<() => void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waitQueue.findIndex(w => w.reject === reject);
      if (idx !== -1) waitQueue.splice(idx, 1);
      reject(new Error(
        `Wallet lock timeout: '${operation}' waited ${timeout}ms while '${lockHolder}' holds the lock`,
      ));
    }, timeout);

    waitQueue.push({
      resolve: () => {
        clearTimeout(timer);
        locked = true;
        lockHolder = operation;
        resolve(createRelease(operation));
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

/**
 * Try to acquire the wallet lock without waiting.
 *
 * Returns a release function if the lock was free, or `null` if it's
 * currently held. Unlike `acquireWalletLock`, this never queues —
 * callers should skip or retry later.
 */
export function tryAcquireWalletLock(operation: string): (() => void) | null {
  if (locked) return null;
  locked = true;
  lockHolder = operation;
  installBeforeUnload();
  return createRelease(operation);
}

/**
 * Check if the wallet lock is currently held.
 */
export function isWalletLocked(): boolean {
  return locked;
}

/**
 * Get the name of the current lock holder (for UI display).
 */
export function getWalletLockHolder(): string | null {
  return lockHolder;
}

function createRelease(operation: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (lockHolder === operation) {
      lockHolder = null;
    }
    locked = false;
    removeBeforeUnload();

    // Wake up the next waiter
    const next = waitQueue.shift();
    if (next) {
      next.resolve();
    }
  };
}

// ---------------------------------------------------------------------------
// Unload detection (cashu.me pattern)
// ---------------------------------------------------------------------------

/**
 * True when the browser is in the process of unloading (tab close, refresh, navigate away).
 *
 * Catch blocks in melt/send operations should check this flag before
 * rolling back proof state. If the tab is closing, the network request
 * was killed by the browser — but the mint may have already processed it.
 * Skipping rollback ensures proofs stay in `pending` state, and
 * `reconcilePendingProofs()` on next startup resolves them correctly.
 *
 * This is the pattern used by cashu.me — more reliable than trying to
 * prevent the tab from closing (browsers mostly ignore custom messages).
 */
let _isUnloading = false;

export function isUnloading(): boolean {
  return _isUnloading;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    _isUnloading = true;
  });
}

// ---------------------------------------------------------------------------
// beforeunload prompt (best-effort — most browsers ignore the custom message)
// ---------------------------------------------------------------------------

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (locked) {
    e.preventDefault();
    e.returnValue = '';
  }
}

let unloadInstalled = false;

function installBeforeUnload(): void {
  if (!unloadInstalled && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload);
    unloadInstalled = true;
  }
}

function removeBeforeUnload(): void {
  if (unloadInstalled && !locked && typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', onBeforeUnload);
    unloadInstalled = false;
  }
}
