import {MediaProxyOptionError} from '../errors.js';
import type {JpegFrame} from '../types.js';

export const DEFAULT_MJPEG_BOUNDARY = 'appium-mjpeg-frame';

// Safe in an unquoted `boundary=` parameter (a MIME token) and a valid RFC 2046 delimiter.
const BOUNDARY_PATTERN = /^[0-9A-Za-z'+_.-]{1,70}$/;

/** Throws `MediaProxyOptionError` unless `boundary` is 1-70 chars of `[0-9A-Za-z'+_.-]`. */
export function assertValidMjpegBoundary(boundary: string): void {
  if (typeof boundary !== 'string' || !BOUNDARY_PATTERN.test(boundary)) {
    throw new MediaProxyOptionError(
      `boundary must be 1-70 characters of [0-9A-Za-z'+_.-], got ${JSON.stringify(boundary)}`,
    );
  }
}

/** `Content-Type` header value for an MJPEG HTTP response using `boundary`. */
export function mjpegContentType(boundary: string = DEFAULT_MJPEG_BOUNDARY): string {
  assertValidMjpegBoundary(boundary);
  return `multipart/x-mixed-replace; boundary=${boundary}`;
}

/** Header preceding one JPEG in the multipart body. */
export function mjpegPartHeader(frame: JpegFrame, boundary: string = DEFAULT_MJPEG_BOUNDARY): Buffer {
  assertValidMjpegBoundary(boundary);
  return Buffer.from(
    `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.data.length}\r\n\r\n`,
    'ascii',
  );
}

const PART_TRAILER = Buffer.from('\r\n', 'ascii');

/** `[header, jpeg, trailer]` for one multipart part; write them in order without concatenating. */
export function formatMjpegPart(frame: JpegFrame, boundary: string = DEFAULT_MJPEG_BOUNDARY): [Buffer, Buffer, Buffer] {
  return [mjpegPartHeader(frame, boundary), frame.data, PART_TRAILER];
}
