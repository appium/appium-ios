import type {NativeSimctl} from '../native-simctl.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    shake(udid: string): Promise<void>;
  }
}

const SHAKE_NOTIFICATION_NAME = 'com.apple.UIKit.SimulatorShake';

/**
 * Simulates a shake gesture (e.g. to trigger "Shake to Undo" or a shake-triggered debug menu) —
 * the same Darwin notification (see darwin-notification.ts) Simulator.app's own Device > Shake
 * menu item posts.
 *
 * @param udid — UDID of the target device
 */
export async function shake(this: NativeSimctl, udid: string): Promise<void> {
  await this.postDarwinNotification(udid, SHAKE_NOTIFICATION_NAME);
}
