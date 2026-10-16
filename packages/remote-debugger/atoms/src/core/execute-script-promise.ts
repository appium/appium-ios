import {BotError, ErrorCode} from './error.js';
import {type ResponseObject, unwrapValue, wrapError, wrapResponse} from './inject.js';

/** Longest wait for a returned promise; a longer timeout is reduced to it. */
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

/** iOS Safari can fire pagehide without unload, e.g. for the back/forward cache. */
const PAGE_LEAVE_EVENTS = ['unload', 'pagehide'];

/**
 * `executeScript` from inject.ts for a script string, plus a returned thenable is awaited
 * (https://w3c.github.io/webdriver/#execute-script). Kept apart so inject.ts, bundled in most
 * atoms, does not change.
 */
export function executeScriptAwaitingPromise(
  script: string,
  args: unknown[],
  stringify?: boolean,
  win: Window = window,
  timeout?: number,
): string | ResponseObject | Promise<string | ResponseObject> {
  const finish = (ret: ResponseObject) => (stringify ? JSON.stringify(ret) : ret);
  let result: unknown;
  try {
    // as recompileFunction in inject.ts does for a string
    const compiled = new (win as unknown as {Function: FunctionConstructor}).Function(script);
    const unwrappedArgs = unwrapValue(args, win.document) as unknown[];
    result = compiled.apply(null, unwrappedArgs);
  } catch (ex) {
    return finish(wrapError(ex as Error));
  }
  let then: AnyThen | undefined;
  try {
    then = readThen(result);
  } catch (ex) {
    return finish(rejectionResponse(ex));
  }
  if (!then) {
    try {
      return finish(wrapResponse(result));
    } catch (ex) {
      return finish(wrapError(ex as Error));
    }
  }
  const firstThen = then;
  // Runtime.awaitPromise accepts only a native promise: an async function returns one, even when
  // zone.js replaced window.Promise and the native then().
  return (async () => finish(await awaitScriptResult(result, firstThen, win, timeout)))();
}

type AnyThen = (onValue: (value: unknown) => void, onReason: (reason: unknown) => void) => unknown;

/** `then` of a thenable, read once (W3C); undefined for any other value. */
function readThen(value: unknown): AnyThen | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  const then = (value as {then?: unknown}).then;
  return typeof then === 'function' ? (then as AnyThen) : undefined;
}

function rejectionResponse(reason: unknown): ResponseObject {
  return wrapError(new BotError(ErrorCode.JAVASCRIPT_ERROR, getRejectionMessage(reason)));
}

/**
 * Never rejects: settles with the response for the value, rejection, timeout or unload. Page
 * globals that the page replaced (Promise, setTimeout, addEventListener) do not break it.
 */
function awaitScriptResult(
  thenable: unknown,
  firstThen: AnyThen,
  win: Window,
  timeout?: number,
): Promise<ResponseObject> {
  // native, also when the page replaced window.Promise
  const NativePromise = (async () => {})().constructor as PromiseConstructor;
  return new NativePromise((resolve) => {
    let timeoutId: ReturnType<Window['setTimeout']> | undefined;
    const settle = (ret: ResponseObject) => {
      try {
        for (const event of PAGE_LEAVE_EVENTS) {
          win.removeEventListener(event, onunload, true);
        }
        win.clearTimeout(timeoutId);
      } catch {
        // replaced by the page
      }
      resolve(ret);
    };
    // Runtime.awaitPromise never answers after the page goes.
    function onunload(): void {
      settle(
        wrapError(
          new BotError(
            ErrorCode.UNKNOWN_ERROR,
            'Detected a page unload or pagehide event; the promise returned by the script does not work across page loads.',
          ),
        ),
      );
    }
    try {
      for (const event of PAGE_LEAVE_EVENTS) {
        win.addEventListener(event, onunload, true);
      }
    } catch {
      // replaced by the page: no unload answer
    }

    if (typeof timeout === 'number') {
      const startTime = Date.now();
      try {
        timeoutId = win.setTimeout(
          () => {
            settle(
              wrapError(
                new BotError(
                  ErrorCode.SCRIPT_TIMEOUT,
                  `Timed out waiting for the promise returned by the script after ${Date.now() - startTime} ms`,
                ),
              ),
            );
          },
          Math.min(Math.max(0, timeout), MAX_TIMEOUT_MS),
        );
      } catch {
        // replaced by the page: the Node timer ends the wait
      }
    }

    const onReason = (reason: unknown) => settle(rejectionResponse(reason));
    // As PromiseResolve: `then` read once, a thenable value adopted again. Handled at once: no
    // unhandled rejection in the page.
    const adopt = (value: unknown, then?: AnyThen) => {
      try {
        const next = then ?? readThen(value);
        if (next) {
          next.call(value, (v: unknown) => adopt(v), onReason);
          return;
        }
      } catch (ex) {
        onReason(ex);
        return;
      }
      let ret: ResponseObject;
      try {
        ret = wrapResponse(value);
      } catch (ex) {
        ret = wrapError(ex as Error);
      }
      settle(ret);
    };
    adopt(thenable, firstThen);
  });
}

function getRejectionMessage(reason: unknown): string {
  let message = '';
  try {
    if (reason !== null && reason !== undefined) {
      const reasonMessage = (reason as {message?: unknown}).message;
      message = String(reasonMessage === undefined ? reason : reasonMessage);
    }
  } catch {
    // e.g. Object.create(null)
  }
  return message || 'The promise returned by the script was rejected';
}
