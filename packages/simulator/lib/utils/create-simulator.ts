import {createNativeSimctl} from '../native/native-simctl.js';
import type {CreateSimulatorOptions} from '../types.js';

/**
 * Creates a new Simulator device, resolving the given friendly `deviceTypeName`/`platformVersion`
 * strings (e.g. `'iPhone 17'`/`'18.0'`) to the exact `deviceTypeIdentifier`/`runtimeIdentifier`
 * `@appium/coresim`'s native `createDevice` requires.
 *
 * @param name Display name for the new device.
 * @param deviceTypeName Friendly device type name, e.g. `'iPhone 17'`.
 * @param platformVersion Platform version string, e.g. `'18.0'`.
 * @param opts.platform The name of the simulator platform. `'iOS'` by default.
 * @param opts.devicesSetPath Custom device set directory to create the device in, instead of the
 * default one.
 * @returns The new device's UDID.
 * @throws {Error} If no matching device type or platform runtime is available, or none of the
 * matching runtimes supports the device type.
 */
export async function createSimulator(
  name: string,
  deviceTypeName: string,
  platformVersion: string,
  opts: CreateSimulatorOptions = {},
): Promise<string> {
  const {platform = 'iOS', devicesSetPath} = opts;
  const nativeSimctl = createNativeSimctl(devicesSetPath);
  const [deviceTypes, runtimes] = await Promise.all([
    nativeSimctl.getSupportedDeviceTypes(),
    nativeSimctl.getSupportedRuntimes(),
  ]);
  const deviceType = deviceTypes.find((t) => t.name === deviceTypeName);
  if (!deviceType) {
    throw new Error(
      `No supported device type named '${deviceTypeName}'. Available: ${deviceTypes.map((t) => t.name).join(', ')}`,
    );
  }
  const platformRuntimes = runtimes.filter((r) => r.identifier.includes(`.SimRuntime.${platform}-`));
  // Exact matches first; some environments ship a patch bump (e.g. '18.4.1') for a runtime named
  // after its minor version ('18.4'), so also accept a dotted-prefix match for that case.
  const candidates = [
    ...platformRuntimes.filter((r) => r.versionString === platformVersion),
    ...platformRuntimes.filter((r) => r.versionString.startsWith(`${platformVersion}.`)),
  ];
  if (candidates.length === 0) {
    throw new Error(
      `No supported ${platform} runtime with version '${platformVersion}'. ` +
        `Available: ${platformRuntimes.map((r) => r.versionString).join(', ')}`,
    );
  }
  // A version may have several runtimes (e.g. iOS 27.2 also ships a Duo-only variant) and not
  // every one supports the device type, so use the first one that accepts it.
  let lastError: unknown;
  for (const runtime of candidates) {
    try {
      const device = await nativeSimctl.createDevice(name, deviceType.identifier, runtime.identifier);
      return device.udid;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
