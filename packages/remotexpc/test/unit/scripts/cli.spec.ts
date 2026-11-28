import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {parseCliArgs} from '../../../scripts/lib/cli.mjs';

const USAGE = 'Usage: test';
const OPTIONS = {'retry-count': {type: 'string'}, 'keep-open': {type: 'boolean', short: 'k'}} as const;

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const exit = (code: number): never => {
  throw new ExitSignal(code);
};

/** Runs fn with stdout/stderr captured; returns the exit code (if any) and output. */
function run(fn: () => unknown) {
  let out = '';
  let err = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  let result: unknown;
  let code: number | undefined;
  try {
    result = fn();
  } catch (e) {
    if (!(e instanceof ExitSignal)) {
      throw e;
    }
    code = e.code;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return {result, code, out, err};
}

describe('scripts/lib/cli parseCliArgs', function () {
  it('camelCases keys, applies converters and returns positionals', function () {
    const {result} = run(() =>
      parseCliArgs(USAGE, OPTIONS, {
        args: ['--retry-count', '3', '-k', 'udid-1'],
        maxPositionals: 1,
        converters: {'retry-count': (v) => Number(v)},
        exit,
      }),
    );
    assert.deepEqual(result, {values: {retryCount: 3, keepOpen: true}, positionals: ['udid-1']});
  });

  it('prints usage and exits 0 on --help', function () {
    const {code, out} = run(() => parseCliArgs(USAGE, OPTIONS, {args: ['--help'], exit}));
    assert.equal(code, 0);
    assert.equal(out, `${USAGE}\n`);
  });

  it('exits 1 with error and usage on an unknown option', function () {
    const {code, err} = run(() => parseCliArgs(USAGE, OPTIONS, {args: ['--bogus'], exit}));
    assert.equal(code, 1);
    assert.match(err, /^error: .*--bogus/);
    assert.ok(err.includes(USAGE));
  });

  it('exits 1 on too many positionals', function () {
    const {code, err} = run(() => parseCliArgs(USAGE, OPTIONS, {args: ['a', 'b'], maxPositionals: 1, exit}));
    assert.equal(code, 1);
    assert.match(err, /Too many arguments: a b/);
  });

  it('exits 1 when a converter throws', function () {
    const {code, err} = run(() =>
      parseCliArgs(USAGE, OPTIONS, {
        args: ['--retry-count', 'x'],
        converters: {
          'retry-count': () => {
            throw new Error('bad count');
          },
        },
        exit,
      }),
    );
    assert.equal(code, 1);
    assert.match(err, /bad count/);
  });

  it('throws on a converter keyed by an unknown option', function () {
    assert.throws(
      () => parseCliArgs(USAGE, OPTIONS, {args: [], converters: {'retry-cnt': (v) => v}, exit}),
      /unknown option 'retry-cnt'/,
    );
  });
});
