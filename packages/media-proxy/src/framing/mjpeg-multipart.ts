import type {JpegFrame} from '../types.js';

export const DEFAULT_MJPEG_BOUNDARY = 'appium-mjpeg-frame';

/** `Content-Type` header value for an MJPEG HTTP response using `boundary`. */
export function mjpegContentType(boundary: string = DEFAULT_MJPEG_BOUNDARY): string {
  return `multipart/x-mixed-replace; boundary=${boundary}`;
}

/** Header preceding one JPEG in the multipart body. */
export function mjpegPartHeader(frame: JpegFrame, boundary: string = DEFAULT_MJPEG_BOUNDARY): Buffer {
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
