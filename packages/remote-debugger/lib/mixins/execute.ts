import {errors} from '@appium/base-driver';
import {util, timing} from '@appium/support';
import {retryInterval} from 'asyncbox';

import {getScriptForAtom} from '../atoms.js';
import type {AtomName} from '../atoms.js';
import type {RemoteDebugger} from '../remote-debugger.js';
import type {AppIdKey, PageIdKey, ScriptExecutionOptions, ExecuteAtomOptions} from '../types.js';
import {checkParams, simpleStringify, convertJavascriptEvaluationResult, RESPONSE_LOG_LENGTH} from '../utils/index.js';
import {
  getAppIdKey,
  getPageIdKey,
  getGarbageCollectOnExecute,
  getEmulateUserGestureForInteractionAtoms,
} from './property-accessors.js';

/* How many milliseconds to wait for webkit to return a response before timing out */
const RPC_RESPONSE_TIMEOUT_MS = 5000;

/* Runtime.awaitPromise gave no atom response: the page changed */
const PAGE_CHANGED_MESSAGE = 'The page changed before the promise returned by the script settled';

/**
 * Executes a Selenium atom in Safari by generating the atom script and
 * executing it in the page context.
 *
 * `execute_script` awaits a returned thenable (https://w3c.github.io/webdriver/#execute-script).
 *
 * @param atom - Name of the Selenium atom to execute (see atoms/ directory).
 * @param args - Arguments to pass to the atom function. Defaults to empty array.
 * @param frames - Frame context array for frame-specific execution. Defaults to empty array.
 * @param options - Options for this evaluation only. An explicit user-gesture value
 * overrides the opt-in interaction-atom policy. Without either opt-in, emulation
 * defaults to false.
 * @returns A promise that resolves to the result received from the atom execution.
 * @example
 * // Opt in for this call without enabling the interaction-atom policy.
 * await remoteDebugger.executeAtom('click', [element], frames, {emulateUserGesture: true});
 * @see ScriptExecutionOptions.emulateUserGesture for user-activation side effects.
 */
export async function executeAtom<R = any>(
  this: RemoteDebugger,
  atom: AtomName,
  args: any[] = [],
  frames: string[] = [],
  options: ExecuteAtomOptions = {},
): Promise<R> {
  this.log.debug(`Executing atom '${atom}' with 'args=${JSON.stringify(args)}; frames=${frames}'`);
  const emulateUserGesture =
    options.emulateUserGesture ?? (getEmulateUserGestureForInteractionAtoms(this) && isGestureInteraction(atom, args));
  const value =
    atom === 'execute_script'
      ? await executeScriptAtom.call(this, args, frames, {timeoutMs: options.timeoutMs, emulateUserGesture})
      : await this.execute<R>(await getScriptForAtom(atom, args, frames), undefined, {emulateUserGesture});
  this.log.debug(
    `Received result for atom '${atom}' execution: ${util.truncateString(simpleStringify(value), RESPONSE_LOG_LENGTH)}`,
  );
  return value;
}

/**
 * Executes a Selenium atom asynchronously by creating a Promise in the page context
 * and waiting for the atom to resolve it. Falls back to polling if Runtime.awaitPromise
 * is not available.
 *
 * @param atom - Name of the Selenium atom to execute (see atoms/ directory).
 * @param args - Arguments to pass to the atom function. Defaults to empty array.
 *               If args[2] is provided, it will be used as the timeout in milliseconds.
 * @param frames - Frame context array for frame-specific execution. Defaults to empty array.
 * @returns A promise that resolves to the result received from the atom execution.
 */
export async function executeAtomAsync<R = any>(
  this: RemoteDebugger,
  atom: AtomName,
  args: any[] = [],
  frames: string[] = [],
): Promise<R> {
  // helper to send directly to the web inspector
  const evaluate = async (method: string, opts: any) =>
    await this.requireRpcClient(true).send(
      method,
      Object.assign(
        {
          appIdKey: getAppIdKey(this),
          pageIdKey: getPageIdKey(this),
          returnByValue: false,
        },
        opts,
      ),
    );

  // first create a Promise on the page, saving the resolve/reject functions
  // as properties
  const promiseName = `appiumAsyncExecutePromise${util.uuidV4().replace(/-/g, '')}`;
  const script = `var res, rej;
    window.${promiseName} = new Promise(function (resolve, reject) {
      res = resolve;
      rej = reject;
    });
    window.${promiseName}.resolve = res;
    window.${promiseName}.reject = rej;
    window.${promiseName};`;
  const obj = await evaluate('Runtime.evaluate', {
    expression: script,
  });
  const promiseObjectId = obj.result.objectId;

  // execute the atom, calling back to the resolve function
  const asyncCallBack = `function (res) {
      window.${promiseName}.resolve(res);
      window.${promiseName}Value = res;
    }`;
  await this.execute(await getScriptForAtom(atom, args, frames, asyncCallBack));

  // wait for the promise to be resolved
  let res: any;
  const subcommandTimeout = 1000; // timeout on individual commands
  try {
    res = await evaluate('Runtime.awaitPromise', {
      promiseObjectId,
      returnByValue: true,
      generatePreview: true,
      saveResult: true,
    });
  } catch (err: any) {
    if (!err.message.includes(`'Runtime.awaitPromise' was not found`)) {
      throw err;
    }
    // awaitPromise is not always available, so simulate it with poll
    const retryWait = 100;
    const timeout = args.length >= 3 ? args[2] : RPC_RESPONSE_TIMEOUT_MS;
    // if the timeout math turns up 0 retries, make sure it happens once
    const retries = parseInt(`${timeout / retryWait}`, 10) || 1;
    const timer = new timing.Timer().start();
    this.log.debug(`Waiting up to ${timeout}ms for async execute to finish`);
    res = await retryInterval(retries, retryWait, async () => {
      // the atom _will_ return, either because it finished or an error
      // including a timeout error
      const hasValue = await evaluate('Runtime.evaluate', {
        expression: `window.hasOwnProperty('${promiseName}Value');`,
        returnByValue: true,
      });
      if (hasValue) {
        // we only put the property on `window` when the callback is called,
        // so if it is there, everything is done
        return await evaluate('Runtime.evaluate', {
          expression: `window.${promiseName}Value;`,
          returnByValue: true,
        });
      }
      // throw a TimeoutError, or else it needs to be caught and re-thrown
      throw new errors.TimeoutError(
        `Timed out waiting for asynchronous script ` +
          `result after ${timer.getDuration().asMilliSeconds.toFixed(0)}ms'));`,
      );
    });
  } finally {
    try {
      // try to get rid of the promise
      await this.executeAtom(
        'execute_script',
        [`delete window.${promiseName};`, [null, null], subcommandTimeout],
        frames,
      );
    } catch {}
  }
  return convertJavascriptEvaluationResult(res) as R;
}

/**
 * Executes a JavaScript command in the page context and returns the result.
 * Optionally performs garbage collection before execution if configured.
 *
 * @param command - The JavaScript command string to execute.
 * @param override - Deprecated and unused parameter; does not enable user-gesture emulation.
 * @param options - Options for this evaluation only; user-gesture emulation defaults to false.
 * @returns A promise that resolves to the result of the JavaScript evaluation,
 *          converted to a usable format.
 * @example
 * await remoteDebugger.execute(command, undefined, {emulateUserGesture: true});
 * @see ScriptExecutionOptions.emulateUserGesture for user-activation side effects.
 */
export async function execute<R = any>(
  this: RemoteDebugger,
  command: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for API compatibility
  override?: boolean,
  options: ScriptExecutionOptions = {},
): Promise<R> {
  const res = await evaluateInPage.call(
    this,
    command,
    {returnByValue: true, emulateUserGesture: options.emulateUserGesture ?? false},
    getPageKeys(this),
  );
  return convertJavascriptEvaluationResult(res) as R;
}

/**
 * Calls a JavaScript function on a remote object identified by objectId.
 * Optionally performs garbage collection before execution if configured.
 *
 * @param objectId - The object identifier of the remote object to call the function on.
 * @param fn - The function declaration string to execute on the object.
 * @param args - Optional array of arguments to pass to the function.
 * @returns A promise that resolves to the result of the function call,
 *          converted to a usable format.
 */
export async function callFunction<R = any>(
  this: RemoteDebugger,
  objectId: string,
  fn: string,
  args?: any[],
): Promise<R> {
  const {appIdKey, pageIdKey} = checkParams({
    appIdKey: getAppIdKey(this),
    pageIdKey: getPageIdKey(this),
  });

  if (getGarbageCollectOnExecute(this)) {
    await this.garbageCollect();
  }

  this.log.debug('Calling javascript function');
  const res = await this.requireRpcClient(true).send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn,
    arguments: args,
    returnByValue: true,
    appIdKey,
    pageIdKey,
  });

  return convertJavascriptEvaluationResult(res) as R;
}

/** Keep the compatibility policy narrower than arbitrary JavaScript or special-key input. */
function isGestureInteraction(atom: AtomName, args: any[]): boolean {
  if (atom === 'click' || atom === 'clear' || atom === 'submit') {
    return true;
  }
  if (atom !== 'type') {
    return false;
  }
  const values = Array.isArray(args[1]) ? args[1] : [args[1]];
  if (!values.every((value) => typeof value === 'string' || typeof value === 'number')) {
    return false;
  }
  const text = values.join('');
  // WebDriver's private-use keys include Escape and modifier shortcuts. Permit
  // only Enter/Return; callers can still opt in explicitly for other keys.
  const hasOnlyTextOrNewlines = [...text].every(
    (char) => char === '\n' || (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
  );
  return text.length > 0 && hasOnlyTextOrNewlines && !/[\uE000-\uE005\uE008-\uF8FF]/u.test(text);
}

/** Sync result: one call. Thenable: the atom returns a promise, awaited by `Runtime.awaitPromise`. */
async function executeScriptAtom(
  this: RemoteDebugger,
  args: any[],
  frames: string[],
  {timeoutMs, emulateUserGesture}: {timeoutMs?: number; emulateUserGesture: boolean},
): Promise<any> {
  const [script, scriptArgs = []] = args;
  // stringify, default window, timeout
  const atomScript = await getScriptForAtom('execute_script', [script, scriptArgs, true, undefined, timeoutMs], frames);
  // the promise exists only on the page that created it
  const keys = getPageKeys(this);
  // gesture for the script only
  const res = await evaluateInPage.call(this, atomScript, {returnByValue: false, emulateUserGesture}, keys);
  const promiseObjectId = typeof res === 'string' ? undefined : res?.result?.objectId;
  if (!promiseObjectId) {
    return convertJavascriptEvaluationResult(res);
  }

  this.log.debug('Waiting for the promise returned by the script');
  const settled = await this.requireRpcClient(true).send('Runtime.awaitPromise', {
    promiseObjectId,
    returnByValue: true,
    ...keys,
  });
  // success: the atom's JSON string; WebKit error: an object (e.g. page gone before the wait)
  if (settled?.error) {
    throw new errors.UnknownError(settled.error.message ?? PAGE_CHANGED_MESSAGE);
  }
  if (typeof settled !== 'string') {
    throw new errors.UnknownError(PAGE_CHANGED_MESSAGE);
  }
  return convertJavascriptEvaluationResult(settled);
}

/** `Runtime.evaluate` in the page; returns the raw result. */
async function evaluateInPage(
  this: RemoteDebugger,
  command: string,
  {returnByValue, emulateUserGesture = false}: {returnByValue: boolean; emulateUserGesture?: boolean},
  keys: {appIdKey: AppIdKey; pageIdKey: PageIdKey},
): Promise<any> {
  const {appIdKey, pageIdKey} = keys;
  if (getGarbageCollectOnExecute(this)) {
    await this.garbageCollect();
  }

  const rpcClient = this.requireRpcClient(true);
  await rpcClient.waitForPage(appIdKey, pageIdKey);
  this.log.debug(`Sending javascript command: '${util.truncateString(command, 50)}'`);
  return await rpcClient.send('Runtime.evaluate', {
    expression: command,
    emulateUserGesture,
    returnByValue,
    appIdKey,
    pageIdKey,
  });
}

/** The selected app and page keys; throws when one is missing. */
function getPageKeys(rd: RemoteDebugger): {appIdKey: AppIdKey; pageIdKey: PageIdKey} {
  return checkParams({appIdKey: getAppIdKey(rd), pageIdKey: getPageIdKey(rd)}) as {
    appIdKey: AppIdKey;
    pageIdKey: PageIdKey;
  };
}
