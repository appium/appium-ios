/**
 * Runs `promise` in the background so a rejection goes to `onError` instead of becoming an
 * unhandled rejection; `onSettled` runs afterwards either way.
 */
export function runInBackground(
  promise: PromiseLike<unknown>,
  onError?: (e: unknown) => void,
  onSettled?: () => void,
): void {
  void (async () => {
    try {
      await promise;
    } catch (e) {
      onError?.(e);
    } finally {
      onSettled?.();
    }
  })();
}
