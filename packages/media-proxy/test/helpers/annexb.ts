import {readFileSync} from 'node:fs';

import type {NalAccessUnit} from '../../src/types.js';

const RTP_TICKS_PER_FRAME = 1500; // 60 fps at 90 kHz

function splitNals(stream: Buffer): Buffer[] {
  const starts: {at: number; length: number}[] = [];
  for (let i = 0; i + 3 <= stream.length;) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) {
      const four = i > 0 && stream[i - 1] === 0;
      starts.push({at: four ? i - 1 : i, length: four ? 4 : 3});
      i += 3;
    } else {
      i++;
    }
  }
  return starts.map((s, n) => stream.subarray(s.at + s.length, starts[n + 1]?.at ?? stream.length));
}

const nalType = (nal: Buffer) => (nal[0] >> 1) & 0x3f;
// End of sequence/bitstream, filler data and suffix SEI follow their picture; every other non-VCL NAL starts the next unit.
const TRAILING_TYPES = new Set([36, 37, 38, 40]);
const isVcl = (type: number) => type < 32;
const startsPicture = (nal: Buffer) => isVcl(nalType(nal)) && (nal[2] & 0x80) !== 0;

/** Groups a bare-NAL Annex-B HEVC stream into access units the way remotexpc delivers them. */
export function readHevcFixture(
  path: string,
  startTimestamp = 0,
  ticksPerFrame = RTP_TICKS_PER_FRAME,
): NalAccessUnit[] {
  const units: NalAccessUnit[] = [];
  let nals: Buffer[] = [];
  let hasVcl = false;
  let key = false;
  const flush = () => {
    if (nals.length > 0) {
      units.push({nals, isKeyFrame: key, timestamp: (startTimestamp + units.length * ticksPerFrame) >>> 0});
    }
    nals = [];
    hasVcl = false;
    key = false;
  };
  for (const nal of splitNals(readFileSync(path))) {
    const type = nalType(nal);
    if (hasVcl && (isVcl(type) ? startsPicture(nal) : !TRAILING_TYPES.has(type))) {
      flush();
    }
    nals.push(nal);
    if (isVcl(type)) {
      hasVcl = true;
      key ||= type >= 16 && type <= 21;
    }
  }
  flush();
  return units;
}

/** Width/height from the first SOF marker of a JPEG. */
export function jpegSize(jpeg: Buffer): {width: number; height: number} {
  for (let i = 2; i + 9 < jpeg.length;) {
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = jpeg[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7)};
    }
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  throw new Error('no SOF marker');
}
