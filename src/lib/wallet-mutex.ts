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
// beforeunload handler (prevents tab close during in-flight operations)
// ---------------------------------------------------------------------------

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (locked) {
    e.preventDefault();
    // Modern browsers ignore custom messages but still show a prompt
    e.returnValue = 'A wallet operation is in progress. Closing now may result in stuck funds.';
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
