/** Awaits `promise` in the background; a rejection is dropped instead of left unhandled. */
export function ignoreRejection(promise: PromiseLike<unknown> | undefined): void {
  void (async () => {
    try {
      await promise;
    } catch {
      // best-effort: failures are surfaced elsewhere or irrelevant
    }
  })();
}

/** Asks an async source to stop without waiting: an idle one may not settle until its next item. */
export function releaseQuietly(iterator: AsyncIterator<unknown>): void {
  ignoreRejection(iterator.return?.());
}
