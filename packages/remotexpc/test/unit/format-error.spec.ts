import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {formatJson} from '../../src/lib/format-error.js';

describe('formatJson', () => {
  it('should keep JSON output for nested objects', () => {
    assert.strictEqual(formatJson({a: {b: {c: {d: 1}}}}), '{"a":{"b":{"c":{"d":1}}}}');
  });

  it('should render nested bigint values as strings', () => {
    assert.strictEqual(formatJson({pid: 5n}), '{"pid":"5"}');
  });

  it('should render a top-level bigint without quotes', () => {
    assert.strictEqual(formatJson(5n), '5');
  });

  it('should fall back to formatValue for undefined', () => {
    assert.strictEqual(formatJson(undefined), 'undefined');
  });
});
