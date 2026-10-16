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
  const finish = (ret: ResponseObject) => (stringify ? toJson(ret) : ret);
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

/**
 * JSON text of a wrapped value. Not the page's JSON.stringify: it calls an inherited toJSON and
 * the page can replace it. WebKit returnByValue (used before) ignores both.
 */
function toJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return String(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'string':
      return quote(value);
    case 'object':
      break;
    default:
      return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(toJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const members = Object.keys(obj)
    .filter((key) => obj[key] !== undefined && typeof obj[key] !== 'function')
    .map((key) => `${quote(key)}:${toJson(obj[key])}`);
  return `{${members.join(',')}}`;
}

/** A JSON string literal, as JSON.stringify writes it (lone surrogates escaped). */
function quote(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) {
      out += `\\${text[i]}`;
    } else if (code === 0x08) {
      out += '\\b';
    } else if (code === 0x0c) {
      out += '\\f';
    } else if (code === 0x0a) {
      out += '\\n';
    } else if (code === 0x0d) {
      out += '\\r';
    } else if (code === 0x09) {
      out += '\\t';
    } else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff && !isPairedSurrogate(text, i))) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += text[i];
    }
  }
  return `${out}"`;
}

function isPairedSurrogate(text: string, i: number): boolean {
  const code = text.charCodeAt(i);
  if (code <= 0xdbff) {
    const next = text.charCodeAt(i + 1);
    return next >= 0xdc00 && next <= 0xdfff;
  }
  const prev = text.charCodeAt(i - 1);
  return prev >= 0xd800 && prev <= 0xdbff;
}
