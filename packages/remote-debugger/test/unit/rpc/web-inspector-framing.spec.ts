import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';

import {plist} from '@appium/support';

import {
  WebInspectorFrameDecoder,
  WebInspectorFrameError,
  cleanupRpcObject,
  encodeWebInspectorFrame,
  getMaxFrameLength,
} from '../../../lib/rpc/web-inspector-framing.js';

const MSG = {__selector: '_rpc_reportIdentifier:', __argument: {WIRConnectionIdentifierKey: 'abc'}};

describe('web-inspector-framing', function () {
  describe('WebInspectorFrameDecoder', function () {
    it('decodes a frame split across chunks', function () {
      const frame = encodeWebInspectorFrame(MSG);
      const decoder = new WebInspectorFrameDecoder();
      assert.deepStrictEqual(decoder.push(frame.subarray(0, 2)), []);
      assert.deepStrictEqual(decoder.push(frame.subarray(2, 10)), []);
      assert.deepStrictEqual(decoder.push(frame.subarray(10)), [MSG]);
    });

    it('decodes multiple frames in one chunk', function () {
      const other = {__selector: 'other', __argument: {a: 1}};
      const chunk = Buffer.concat([encodeWebInspectorFrame(MSG), encodeWebInspectorFrame(other)]);
      assert.deepStrictEqual(new WebInspectorFrameDecoder().push(chunk), [MSG, other]);
    });

    it('keeps the remainder of a following partial frame', function () {
      const frame = encodeWebInspectorFrame(MSG);
      const decoder = new WebInspectorFrameDecoder();
      assert.deepStrictEqual(decoder.push(Buffer.concat([frame, frame.subarray(0, 5)])), [MSG]);
      assert.deepStrictEqual(decoder.push(frame.subarray(5)), [MSG]);
    });

    it('rejects oversize frames', function () {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(101, 0);
      assert.throws(() => new WebInspectorFrameDecoder(100).push(header), /bigger than expected/);
    });

    it('ignores empty payloads', function () {
      const decoder = new WebInspectorFrameDecoder();
      assert.deepStrictEqual(decoder.push(Buffer.concat([Buffer.alloc(4), encodeWebInspectorFrame(MSG)])), [MSG]);
    });

    it('decodes a large frame delivered in many small chunks', function () {
      const msg = {__selector: 'x', __argument: {WIRMessageDataKey: Buffer.alloc(300_000, 7)}};
      const frame = encodeWebInspectorFrame(msg);
      const decoder = new WebInspectorFrameDecoder();
      const out: any[] = [];
      for (let i = 0; i < frame.length; i += 1000) {
        out.push(...decoder.push(frame.subarray(i, i + 1000)));
      }
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].__argument.WIRMessageDataKey.length, 300_000);
    });

    it('refuses further input after a failure instead of parsing garbage', function () {
      const decoder = new WebInspectorFrameDecoder(100);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(1000, 0);
      assert.throws(() => decoder.push(header), /bigger than expected/);
      assert.throws(() => decoder.push(Buffer.from('more bytes')), /bigger than expected/);
    });

    it('reports messages decoded before an oversize frame', function () {
      const bad = Buffer.alloc(4);
      bad.writeUInt32BE(5000, 0);
      const decoder = new WebInspectorFrameDecoder(1000);
      assert.throws(
        () => decoder.push(Buffer.concat([encodeWebInspectorFrame(MSG), bad])),
        (e: any) => e instanceof WebInspectorFrameError && e.decoded.length === 1,
      );
    });

    it('reports messages decoded before an invalid plist', function () {
      const garbage = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('abc')]);
      assert.throws(
        () => new WebInspectorFrameDecoder().push(Buffer.concat([encodeWebInspectorFrame(MSG), garbage])),
        (e: any) => e instanceof WebInspectorFrameError && e.decoded.length === 1,
      );
    });

    it('round-trips Buffer fields', function () {
      const msg = {__selector: 'x', __argument: {WIRMessageDataKey: Buffer.from('{"id":1}')}};
      const [decoded] = new WebInspectorFrameDecoder().push(encodeWebInspectorFrame(msg));
      assert.ok(Buffer.isBuffer(decoded.__argument.WIRMessageDataKey));
      assert.strictEqual(decoded.__argument.WIRMessageDataKey.toString('utf8'), '{"id":1}');
    });
  });

  describe('encodeWebInspectorFrame', function () {
    it('prefixes the binary plist with its big-endian length', function () {
      const frame = encodeWebInspectorFrame(MSG);
      assert.strictEqual(frame.readUInt32BE(0), frame.length - 4);
      assert.deepStrictEqual(plist.parsePlist(frame.subarray(4)), MSG);
    });

    it('strips nullish values when the plist encoder fails on them', function () {
      const msg = {__selector: 'x', __argument: {a: 1, b: undefined, c: {d: null, e: 2}}};
      const [decoded] = new WebInspectorFrameDecoder().push(encodeWebInspectorFrame(msg));
      assert.deepStrictEqual(decoded, {__selector: 'x', __argument: {a: 1, c: {e: 2}}});
    });

    it('rejects nullish messages', function () {
      assert.throws(() => encodeWebInspectorFrame(null), /Cannot send a null object/);
    });
  });

  describe('cleanupRpcObject', function () {
    it('removes nullish values recursively and keeps Buffers', function () {
      const buf = Buffer.from('a');
      assert.deepStrictEqual(cleanupRpcObject({a: null, b: [1, null, {c: undefined, d: buf}]}), {b: [1, {d: buf}]});
    });
  });

  describe('getMaxFrameLength', function () {
    const original = process.env.APPIUM_IOS_MAX_FRAME_SIZE;

    afterEach(function () {
      if (original === undefined) {
        delete process.env.APPIUM_IOS_MAX_FRAME_SIZE;
      } else {
        process.env.APPIUM_IOS_MAX_FRAME_SIZE = original;
      }
    });

    it('prefers the explicit value, then the env var, then 20 MB', function () {
      process.env.APPIUM_IOS_MAX_FRAME_SIZE = '1234';
      assert.strictEqual(getMaxFrameLength(99), 99);
      assert.strictEqual(getMaxFrameLength(), 1234);
      delete process.env.APPIUM_IOS_MAX_FRAME_SIZE;
      assert.strictEqual(getMaxFrameLength(), 20 * 1024 * 1024);
    });
  });
});
