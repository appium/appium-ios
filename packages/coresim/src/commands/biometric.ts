import type {NativeSimctl} from '../native-simctl.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    isBiometricEnrolled(udid: string): Promise<boolean>;
    enrollBiometric(udid: string, isEnabled?: boolean): Promise<void>;
    sendBiometricMatch(udid: string, shouldMatch?: boolean, biometricName?: BiometricName): Promise<void>;
  }
}

/** A simulated biometric sensor — Face ID is only available since iOS 11. */
export type BiometricName = 'touchId' | 'faceId';

// Simulator.app's own Features > Face ID/Touch ID menu drives the same two Darwin notifications
// (see darwin-notification.ts) rather than any dedicated CoreSimulator API — no native call needed.
const ENROLLMENT_NOTIFICATION_NAME = 'com.apple.BiometricKit.enrollmentChanged';
const BIOMETRIC_DOMAIN_COMPONENTS: Record<BiometricName, string> = {
  touchId: 'fingerTouch',
  faceId: 'pearl',
};

/**
 * @param udid — UDID of the device to read from
 * @returns whether a biometric sensor is currently simulated as enrolled
 */
export async function isBiometricEnrolled(this: NativeSimctl, udid: string): Promise<boolean> {
  return (await this.getDarwinNotificationState(udid, ENROLLMENT_NOTIFICATION_NAME)) === 1n;
}

/**
 * Simulates enrolling (or un-enrolling) a biometric sensor — the prerequisite for
 * {@link sendBiometricMatch} to have any effect.
 *
 * @param udid — UDID of the target device
 * @param isEnabled — whether the device should report a biometric sensor as enrolled; defaults to `true`
 */
export async function enrollBiometric(this: NativeSimctl, udid: string, isEnabled = true): Promise<void> {
  await this.setDarwinNotificationState(udid, ENROLLMENT_NOTIFICATION_NAME, isEnabled ? 1n : 0n);
  await this.postDarwinNotification(udid, ENROLLMENT_NOTIFICATION_NAME);
  if ((await isBiometricEnrolled.call(this, udid)) !== isEnabled) {
    throw new Error(`Failed to set biometric enrolled state for '${udid}' to '${isEnabled}'`);
  }
}

/**
 * Simulates a successful or failed biometric match attempt — only takes effect once
 * {@link enrollBiometric} has enrolled the corresponding sensor.
 *
 * @param udid — UDID of the target device
 * @param shouldMatch — whether the simulated attempt should succeed; defaults to `true`
 * @param biometricName — which sensor to simulate; defaults to `'touchId'`
 */
export async function sendBiometricMatch(
  this: NativeSimctl,
  udid: string,
  shouldMatch = true,
  biometricName: BiometricName = 'touchId',
): Promise<void> {
  if (!Object.hasOwn(BIOMETRIC_DOMAIN_COMPONENTS, biometricName)) {
    throw new Error(
      `'${biometricName}' is not a valid biometric — use one of: ${Object.keys(BIOMETRIC_DOMAIN_COMPONENTS).join(', ')}`,
    );
  }
  const domainComponent = BIOMETRIC_DOMAIN_COMPONENTS[biometricName];
  await this.postDarwinNotification(
    udid,
    `com.apple.BiometricKit_Sim.${domainComponent}.${shouldMatch ? '' : 'no'}match`,
  );
}
