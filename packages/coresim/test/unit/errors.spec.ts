import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  NativeSimDispatchError,
  NativeSimError,
  NativeSimOperationError,
  NativeSimDisplayResolutionError,
  NativeSimUnavailableError,
  wrapNativeError,
} from '../../src/errors.js';

describe('wrapNativeError', () => {
  it('passes an already-typed NativeSimError through unchanged', () => {
    const original = new NativeSimOperationError('boom', 'NSPOSIXErrorDomain', 1);
    assert.throws(
      () => wrapNativeError(original),
      (err: unknown) => err === original,
    );
  });

  it('maps a raw NativeSimUnavailableError-named error to the typed subclass', () => {
    const raw = Object.assign(new Error('missing selector'), {
      name: 'NativeSimUnavailableError',
      kind: 'selector',
      missing: 'bootWithOptions:error:',
      frameworkVersion: '1171.6',
    });
    assert.throws(
      () => wrapNativeError(raw),
      (err: unknown) =>
        err instanceof NativeSimUnavailableError &&
        err.kind === 'selector' &&
        err.missing === 'bootWithOptions:error:' &&
        err.frameworkVersion === '1171.6',
    );
  });

  it('maps a raw NativeSimDispatchError-named error to the typed subclass', () => {
    const raw = Object.assign(new Error('caught exception'), {
      name: 'NativeSimDispatchError',
      exceptionName: 'NSInvalidArgumentException',
      reason: 'bad arg',
    });
    assert.throws(
      () => wrapNativeError(raw),
      (err: unknown) => err instanceof NativeSimDispatchError && err.exceptionName === 'NSInvalidArgumentException',
    );
  });

  it('maps a raw NativeSimOperationError-named error to the typed subclass', () => {
    const raw = Object.assign(new Error('device busy'), {
      name: 'NativeSimOperationError',
      domain: 'com.apple.CoreSimulator.SimError',
      code: 405,
    });
    assert.throws(
      () => wrapNativeError(raw),
      (err: unknown) =>
        err instanceof NativeSimOperationError && err.domain === 'com.apple.CoreSimulator.SimError' && err.code === 405,
    );
  });

  it('falls back to the base NativeSimError for unrecognized error names', () => {
    assert.throws(() => wrapNativeError(new Error('plain failure')), NativeSimError);
  });

  it('falls back to the base NativeSimError for non-Error throwables', () => {
    assert.throws(() => wrapNativeError('a string was thrown'), NativeSimError);
  });
});

describe('display resolution errors', () => {
  it('maps the native error name while preserving its details', () => {
    const raw = Object.assign(new Error('missing display'), {
      name: 'NativeSimDisplayResolutionError',
      domain: 'io.appium.coresim.Screenshot',
      code: 2,
    });
    assert.throws(
      () => wrapNativeError(raw),
      (err: unknown) =>
        err instanceof NativeSimDisplayResolutionError &&
        err instanceof NativeSimOperationError &&
        err.domain === raw.domain &&
        err.code === raw.code &&
        err.message === raw.message,
    );
  });
  it('does not infer the error type from numeric codes', () => {
    const raw = Object.assign(new Error('operation failed'), {
      name: 'NativeSimOperationError',
      domain: 'io.appium.coresim.Screenshot',
      code: 2,
    });
    assert.throws(
      () => wrapNativeError(raw),
      (err: unknown) => err instanceof NativeSimOperationError && !(err instanceof NativeSimDisplayResolutionError),
    );
  });
});
