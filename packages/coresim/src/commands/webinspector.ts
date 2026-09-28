import type {NativeSimctl} from '../native-simctl.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    getWebInspectorSocket(udid: string): Promise<string>;
  }
}

/**
 * Locates the Unix-domain socket a booted device's WebInspector service listens on, for WebKit
 * remote-debugging tools to connect to directly.
 *
 * @example
 * const socketPath = await sim.getWebInspectorSocket(udid);
 * const socket = net.connect(socketPath); // speak the WebInspector wire protocol from here
 *
 * @param udid — UDID of the device to inspect; must be booted
 * @returns the socket's filesystem path
 */
export async function getWebInspectorSocket(this: NativeSimctl, udid: string): Promise<string> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).getWebInspectorSocket());
}
