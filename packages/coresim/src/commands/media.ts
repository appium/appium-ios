import type {NativeSimctl} from '../native-simctl.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    addMedia(udid: string, filePaths: string[]): Promise<void>;
    addPhoto(udid: string, filePath: string): Promise<void>;
    addVideo(udid: string, filePath: string): Promise<void>;
  }
}

/**
 * Adds one or more photo/video files to the device's Photos library — the native equivalent of
 * `simctl addmedia`. Each file's type is auto-detected; use {@link addPhoto}/{@link addVideo}
 * instead when the file's kind is already known.
 *
 * @param udid — UDID of the target device
 * @param filePaths — paths to the media files on the local filesystem
 */
export async function addMedia(this: NativeSimctl, udid: string, filePaths: string[]): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).addMedia(filePaths));
}

/**
 * @param udid — UDID of the target device
 * @param filePath — path to a photo file on the local filesystem
 */
export async function addPhoto(this: NativeSimctl, udid: string, filePath: string): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).addPhoto(filePath));
}

/**
 * @param udid — UDID of the target device
 * @param filePath — path to a video file on the local filesystem
 */
export async function addVideo(this: NativeSimctl, udid: string, filePath: string): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).addVideo(filePath));
}
