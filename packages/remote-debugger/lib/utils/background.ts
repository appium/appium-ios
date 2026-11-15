/**
 * Awaits `promise` in the background so its rejection is passed to `onError` (or dropped)
 * instead of surfacing as an unhandled rejection.
 */
export function runInBackground(promise: PromiseLike<unknown>, onError?: (err: any) => void): void {
  void (async () => {
    try {
      await promise;
    } catch (err) {
      onError?.(err);
    }
  })();
}
