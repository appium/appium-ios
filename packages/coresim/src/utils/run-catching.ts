import {wrapNativeError} from '../errors.js';

/** Shared by NativeSimctl and every `src/commands/*.ts` mixin — maps a raw error surfaced by the addon to a typed one. */
export async function runCatchingAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    wrapNativeError(err);
  }
}

/** `wrapNativeError` always throws — this just gets its thrown value back as a plain return, for
 * a live callback (e.g. a stream/recording's `onError`) that needs to emit or log a typed error
 * rather than raise it. */
export function toTypedError(err: unknown): Error {
  try {
    wrapNativeError(err);
  } catch (wrapped) {
    return wrapped as Error;
  }
}
