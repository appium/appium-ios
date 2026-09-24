import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DATA_CHANNEL_HEADER_SIZE, DATA_CHANNEL_MESSAGE_TYPE} from '../../../src/services/ios/file-service/constants.js';
import {
  FileDataDecoder,
  buildFileDataRequest,
  decodeDataChannelHeader,
  encodeDataChannelHeader,
} from '../../../src/services/ios/file-service/data-channel.js';

function deviceReply(fileId: bigint, payload: Buffer): Buffer {
  return Buffer.concat([
    encodeDataChannelHeader({type: DATA_CHANNEL_MESSAGE_TYPE.FILE_DATA, fileId, size: BigInt(payload.length)}),
    payload,
    encodeDataChannelHeader({type: DATA_CHANNEL_MESSAGE_TYPE.TRANSFER_COMPLETE, fileId, size: 0n}),
  ]);
}

describe('file service data channel', function () {
  it('builds the file data request that devicectl sends', function () {
    // Captured from a live transfer: magic, type 1, reserved 0, file id 1, size 0.
    const expected = Buffer.from(
      '7277622146494c45' + '0000000000000001' + '0000000000000000' + '0000000000000001' + '0000000000000000',
      'hex',
    );
    assert.deepStrictEqual(buildFileDataRequest(1n), expected);
  });

  it('decodes a header captured from the device', function () {
    const header = Buffer.from(
      '7277622146494c45' + '0000000000000001' + '0000000000000000' + '0000000000000002' + '000000000034c018',
      'hex',
    );
    assert.deepStrictEqual(decodeDataChannelHeader(header), {
      type: DATA_CHANNEL_MESSAGE_TYPE.FILE_DATA,
      fileId: 2n,
      size: 3457048n,
    });
  });

  it('round-trips a header', function () {
    const header = {type: DATA_CHANNEL_MESSAGE_TYPE.TRANSFER_COMPLETE, fileId: 7n, size: 0n};
    const encoded = encodeDataChannelHeader(header);
    assert.strictEqual(encoded.length, DATA_CHANNEL_HEADER_SIZE);
    assert.deepStrictEqual(decodeDataChannelHeader(encoded), header);
  });

  it('rejects a short header or a bad magic', function () {
    assert.throws(() => decodeDataChannelHeader(Buffer.alloc(10)), /must be 40 bytes/);
    const header = encodeDataChannelHeader({type: 1n, fileId: 1n, size: 0n});
    header[0] = 0;
    assert.throws(() => decodeDataChannelHeader(header), /invalid magic/);
  });

  describe('FileDataDecoder', function () {
    it('extracts the file bytes from a single chunk', function () {
      const payload = Buffer.from('hello world');
      const decoder = new FileDataDecoder(1n);

      const parts = decoder.push(deviceReply(1n, payload));

      assert.deepStrictEqual(Buffer.concat(parts), payload);
      assert.strictEqual(decoder.isDone, true);
      assert.strictEqual(decoder.size, BigInt(payload.length));
    });

    it('extracts the file bytes when every chunk is a single byte', function () {
      const payload = Buffer.from('split across many chunks');
      const wire = deviceReply(3n, payload);
      const decoder = new FileDataDecoder(3n);

      const parts: Buffer[] = [];
      for (let i = 0; i < wire.length; i++) {
        assert.strictEqual(decoder.isDone, false);
        parts.push(...decoder.push(wire.subarray(i, i + 1)));
      }

      assert.deepStrictEqual(Buffer.concat(parts), payload);
      assert.strictEqual(decoder.isDone, true);
    });

    it('handles an empty file', function () {
      const decoder = new FileDataDecoder(1n);

      assert.deepStrictEqual(decoder.push(deviceReply(1n, Buffer.alloc(0))), []);
      assert.strictEqual(decoder.isDone, true);
      assert.strictEqual(decoder.size, 0n);
    });

    it('rejects data for another file', function () {
      const decoder = new FileDataDecoder(1n);
      assert.throws(() => decoder.push(deviceReply(2n, Buffer.from('x'))), /file ID 1, got data for file ID 2/);
    });

    it('rejects an unexpected message type', function () {
      const decoder = new FileDataDecoder(1n);
      const header = encodeDataChannelHeader({
        type: DATA_CHANNEL_MESSAGE_TYPE.TRANSFER_COMPLETE,
        fileId: 1n,
        size: 0n,
      });
      assert.throws(() => decoder.push(header), /of type 1, got type 99/);
    });

    it('rejects bytes after the confirmation', function () {
      const decoder = new FileDataDecoder(1n);
      assert.throws(
        () => decoder.push(Buffer.concat([deviceReply(1n, Buffer.from('x')), Buffer.from('extra')])),
        /unexpected bytes/,
      );
    });
  });
});
