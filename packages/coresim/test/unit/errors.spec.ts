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
  for (const domain of ['io.appium.coresim.Screenshot', 'io.appium.coresim.Video']) {
    for (const code of [1, 2, 3]) {
      it(`maps an explicitly named display resolution error from ${domain} with code ${code}`, () => {
        const raw = Object.assign(new Error('display not found'), {
          name: 'NativeSimDisplayResolutionError',
          domain,
          code,
        });
        assert.throws(
          () => wrapNativeError(raw),
          (err: unknown) =>
            err instanceof NativeSimDisplayResolutionError &&
            err instanceof NativeSimOperationError &&
            err.name === 'NativeSimDisplayResolutionError' &&
            err.message === 'display not found' &&
            err.domain === domain &&
            err.code === code,
        );
      });
    }
  }

  it('passes an already-typed display resolution error through unchanged', () => {
    const original = new NativeSimDisplayResolutionError('display not found', 'io.appium.coresim.Screenshot', 2);
    assert.throws(
      () => wrapNativeError(original),
      (err: unknown) => err === original,
    );
  });

  it('converts display resolution error metadata to string and number values', () => {
    const raw = Object.assign(new Error('display not found'), {
      name: 'NativeSimDisplayResolutionError',
      domain: 123,
      code: '2',
    });
    assert.throws(
      () => wrapNativeError(raw),
      (err: unknown) => err instanceof NativeSimDisplayResolutionError && err.domain === '123' && err.code === 2,
    );
  });

  for (const metadata of [{}, {domain: null, code: null}]) {
    it(`defaults ${'domain' in metadata ? 'null' : 'missing'} display resolution error metadata`, () => {
      const raw = Object.assign(new Error('display not found'), {
        name: 'NativeSimDisplayResolutionError',
        ...metadata,
      });
      assert.throws(
        () => wrapNativeError(raw),
        (err: unknown) => err instanceof NativeSimDisplayResolutionError && err.domain === '' && err.code === 0,
      );
    });
  }

  for (const code of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`keeps screenshot operation error code ${code} as an operation error`, () => {
      const raw = Object.assign(new Error('native failure'), {
        name: 'NativeSimOperationError',
        domain: 'io.appium.coresim.Screenshot',
        code,
      });
      assert.throws(
        () => wrapNativeError(raw),
        (err: unknown) =>
          err instanceof NativeSimOperationError &&
          err.name === 'NativeSimOperationError' &&
          err.domain === 'io.appium.coresim.Screenshot' &&
          err.code === code &&
          !(err instanceof NativeSimDisplayResolutionError),
      );
    });
  }
  it('does not classify the same code from another domain as display resolution', () => {
    const raw = Object.assign(new Error('connection failure'), {
      name: 'NativeSimOperationError',
      domain: 'NSPOSIXErrorDomain',
      code: 2,
    });
    assert.throws(
      () => wrapNativeError(raw),
      (err: unknown) => err instanceof NativeSimOperationError && !(err instanceof NativeSimDisplayResolutionError),
    );
  });
});
