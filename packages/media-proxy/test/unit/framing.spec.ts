import assert from 'node:assert';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {describe, it} from 'node:test';

import {MediaProxyProtocolError} from '../../src/errors.js';
import {
  ApstParser,
  ApstTrack,
  encodeApstEndOfStream,
  encodeApstFrame,
  encodeApstFrameBuffer,
} from '../../src/framing/apst.js';
import {serveMjpeg} from '../../src/framing/mjpeg-http.js';
import {formatMjpegPart, mjpegContentType} from '../../src/framing/mjpeg-multipart.js';
import type {JpegFrame, VideoAccessUnit} from '../../src/types.js';

const video: VideoAccessUnit = {
  track: 'video',
  data: Buffer.from([0, 0, 0, 1, 0x67, 1, 2]),
  isKeyFrame: true,
  sequence: 5,
  timestampMicros: 123_456_789,
};
const jpeg: JpegFrame = {data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), sequence: 2, timestampMicros: 40};

describe('APST framing', () => {
  it('matches the Android wire layout', () => {
    const buf = encodeApstFrameBuffer(video);
    assert.strictEqual(buf.subarray(0, 4).toString('ascii'), 'APST');
    assert.strictEqual(buf.readUInt8(4), 1); // version
    assert.strictEqual(buf.readUInt8(5), 1); // track = video
    assert.strictEqual(buf.readUInt8(6), 0x02); // keyframe flag
    assert.strictEqual(buf.readBigUInt64BE(8), 5n);
    assert.strictEqual(buf.readBigUInt64BE(16), 123_456_789n);
    assert.strictEqual(buf.readUInt32BE(24), video.data.length);
    assert.deepStrictEqual(buf.subarray(28), video.data);
  });

  it('round-trips video, android config and jpeg frames across arbitrary chunk boundaries', () => {
    // We never emit CONFIG frames, but the parser must read them from Android's stream.
    const config = encodeApstFrameBuffer({...video, isKeyFrame: false, sequence: 0});
    config.writeUInt8(config.readUInt8(6) | 0x01, 6);
    const wire = Buffer.concat([config, encodeApstFrameBuffer(video), encodeApstFrameBuffer(jpeg)]);
    const parser = new ApstParser();
    const out = [];
    for (let i = 0; i < wire.length; i += 3) {
      out.push(...parser.push(wire.subarray(i, i + 3)));
    }
    assert.deepStrictEqual(
      out.map((f) => [f.track, f.sequence, f.isConfig, f.isKeyFrame, f.data.length]),
      [
        [ApstTrack.Video, 0, true, false, video.data.length],
        [ApstTrack.Video, 5, false, true, video.data.length],
        [ApstTrack.Jpeg, 2, false, false, jpeg.data.length],
      ],
    );
    assert.deepStrictEqual(out[1].data, video.data);
    assert.strictEqual(out[1].timestampMicros, 123_456_789);
  });

  it('encodes header and payload separately without copying the payload', () => {
    const [header, payload] = encodeApstFrame(jpeg);
    assert.strictEqual(header.length, 28);
    assert.strictEqual(payload, jpeg.data);
  });

  it('flags end of stream', () => {
    const [frame] = [...new ApstParser().push(encodeApstEndOfStream(ApstTrack.Video, 9, 1))];
    assert.strictEqual(frame.isEndOfStream, true);
    assert.strictEqual(frame.data.length, 0);
  });

  it('reassembles a large frame delivered in small chunks', () => {
    const big: JpegFrame = {data: Buffer.alloc(1_000_000, 0xab), sequence: 1, timestampMicros: 1};
    const wire = encodeApstFrameBuffer(big);
    const parser = new ApstParser();
    const out = [];
    for (let i = 0; i < wire.length; i += 4096) {
      out.push(...parser.push(wire.subarray(i, i + 4096)));
    }
    assert.strictEqual(out.length, 1);
    assert.ok(out[0].data.equals(big.data));
  });

  it('throws on desynchronization', () => {
    const parser = new ApstParser();
    assert.throws(() => [...parser.push(Buffer.alloc(40, 1))], MediaProxyProtocolError);
  });

  it('rejects an implausible payload length', () => {
    const buf = encodeApstFrameBuffer(jpeg);
    buf.writeUInt32BE(0xffff_ffff, 24);
    assert.throws(() => [...new ApstParser().push(buf)], MediaProxyProtocolError);
  });
});

describe('MJPEG multipart', () => {
  it('formats a part with content type and exact length', () => {
    const [head, body, tail] = formatMjpegPart(jpeg, 'b');
    assert.strictEqual(head.toString(), '--b\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n');
    assert.strictEqual(body, jpeg.data);
    assert.strictEqual(tail.toString(), '\r\n');
    assert.strictEqual(mjpegContentType('b'), 'multipart/x-mixed-replace; boundary=b');
  });
});

describe('serveMjpeg', () => {
  it('streams frames to a client and ends the response when the source ends', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* frames(): AsyncGenerator<JpegFrame> {
      await gate;
      for (let i = 0; i < 3; i++) {
        yield {...jpeg, sequence: i};
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    const server = await serveMjpeg(frames(), {boundary: 'xyz'});
    try {
      const body = await new Promise<Buffer>((resolve, reject) => {
        http
          .get(server.url, (res) => {
            assert.strictEqual(res.headers['content-type'], 'multipart/x-mixed-replace; boundary=xyz');
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            // Client is registered once headers are delivered.
            release();
          })
          .on('error', reject);
      });
      const parts = body
        .toString('latin1')
        .split('--xyz')
        .filter((p) => p.includes('image/jpeg'));
      assert.ok(parts.length >= 1, 'at least one frame delivered');
      assert.ok(parts.every((p) => p.includes('Content-Length: 4')));
    } finally {
      await server.close();
    }
  });
});

describe('serveMjpeg lifecycle', () => {
  const get = (url: string) =>
    new Promise<{status: number; ended: Promise<void>}>((resolve, reject) => {
      http
        .get(url, (res) => {
          res.resume();
          resolve({status: res.statusCode ?? 0, ended: new Promise<void>((r) => res.on('end', () => r()))});
        })
        .on('error', reject);
    });
  const settlesWithin = (promise: Promise<unknown>, ms = 1000) =>
    Promise.race([promise.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

  it('answers 410 to clients that connect after the source has ended', async () => {
    async function* frames(): AsyncGenerator<JpegFrame> {
      yield jpeg;
    }
    const server = await serveMjpeg(frames());
    try {
      await server.done;
      const res = await get(server.url);
      assert.strictEqual(res.status, 410);
    } finally {
      await server.close();
    }
  });

  it('exposes a source failure through done and ends connected clients', async () => {
    let fail!: () => void;
    const gate = new Promise<void>((r) => (fail = r));
    const frames: AsyncIterable<JpegFrame> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await gate;
          throw new Error('no encoder');
        },
      }),
    };
    const server = await serveMjpeg(frames);
    try {
      const res = await get(server.url);
      assert.strictEqual(res.status, 200);
      fail();
      await assert.rejects(server.done, /no encoder/);
      assert.ok(await settlesWithin(res.ended), 'client response ended');
      assert.strictEqual((await get(server.url)).status, 410);
    } finally {
      await server.close();
    }
  });

  it('close() asks an idle source to stop and settles done', async () => {
    let returned = false;
    const iterator: AsyncIterableIterator<JpegFrame> = {
      [Symbol.asyncIterator]: () => iterator,
      next: () => new Promise(() => {}),
      return: async () => {
        returned = true;
        return {value: undefined, done: true};
      },
    };
    const server = await serveMjpeg({[Symbol.asyncIterator]: () => iterator});
    await server.close();
    assert.ok(returned, 'source return() was called');
    assert.ok(await settlesWithin(server.done), 'done settled');
  });

  it('does not listen when opening the source throws', async () => {
    const frames: AsyncIterable<JpegFrame> = {
      [Symbol.asyncIterator]: () => {
        throw new Error('open failed');
      },
    };
    await assert.rejects(serveMjpeg(frames), /open failed/);
  });

  it('releases the source when listening fails', async () => {
    const blocker = http.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    const {port} = blocker.address() as AddressInfo;
    let returned = false;
    const iterator: AsyncIterableIterator<JpegFrame> = {
      [Symbol.asyncIterator]: () => iterator,
      next: () => new Promise(() => {}),
      return: async () => {
        returned = true;
        return {value: undefined, done: true};
      },
    };
    try {
      await assert.rejects(serveMjpeg({[Symbol.asyncIterator]: () => iterator}, {port}), /EADDRINUSE/);
      assert.ok(returned, 'source return() was called');
    } finally {
      blocker.close();
    }
  });
});
