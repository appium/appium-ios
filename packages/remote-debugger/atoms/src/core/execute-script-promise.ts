import {BotError, ErrorCode} from './error.js';
import {
  getErrorMessage,
  isAutomationError,
  type ResponseObject,
  unwrapValue,
  wrapError,
  wrapResponse,
} from './inject.js';

/** Longest wait for a returned promise; a longer timeout is reduced to it. */
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

const SYNC_ERROR_FALLBACK = 'The script threw an error';
const REJECTION_FALLBACK = 'The promise returned by the script was rejected';

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
    return finish(wrapScriptError(ex, SYNC_ERROR_FALLBACK));
  }
  try {
    if (!isThenable(result)) {
      return finish(wrapResponse(result));
    }
  } catch (ex) {
    return finish(wrapScriptError(ex, SYNC_ERROR_FALLBACK));
  }
  const thenable = result;
  // Runtime.awaitPromise accepts only a native promise: an async function returns one, even when
  // zone.js replaced window.Promise and the native then().
  return (async () => finish(await awaitScriptResult(thenable, win, timeout)))();
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as {then?: unknown}).then === 'function'
  );
}

/** Never rejects: settles with the response for the value, rejection, timeout or unload. */
function awaitScriptResult(thenable: PromiseLike<unknown>, win: Window, timeout?: number): Promise<ResponseObject> {
  return new Promise((resolve) => {
    let timeoutId: ReturnType<Window['setTimeout']> | undefined;
    const settle = (ret: ResponseObject) => {
      for (const event of PAGE_LEAVE_EVENTS) {
        win.removeEventListener(event, onunload, true);
      }
      win.clearTimeout(timeoutId);
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
    for (const event of PAGE_LEAVE_EVENTS) {
      win.addEventListener(event, onunload, true);
    }

    if (typeof timeout === 'number') {
      const startTime = Date.now();
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
    }

    // Handled at once: no unhandled rejection in the page.
    Promise.resolve(thenable).then(
      (value) => {
        let ret: ResponseObject;
        try {
          ret = wrapResponse(value);
        } catch (ex) {
          ret = wrapScriptError(ex, SYNC_ERROR_FALLBACK);
        }
        settle(ret);
      },
      (reason) =>
        settle(wrapError(new BotError(ErrorCode.JAVASCRIPT_ERROR, getErrorMessage(reason, REJECTION_FALLBACK)))),
    );
  });
}

/**
 * An error of the atoms keeps its code; any other thrown value is a script error (W3C `javascript error`).
 * Not the `code` of the value: a DOMException has one that is no WebDriver code.
 */
function wrapScriptError(ex: unknown, fallback: string): ResponseObject {
  return isAutomationError(ex)
    ? wrapError(ex)
    : wrapError(new BotError(ErrorCode.JAVASCRIPT_ERROR, getErrorMessage(ex, fallback)));
}
