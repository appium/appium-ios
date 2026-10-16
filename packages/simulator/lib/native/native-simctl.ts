import {NativeSimctl} from '@appium/coresim';

/**
 * Builds a `NativeSimctl` bound to the given device set path (or the default device set, when
 * `null`/`undefined`). `NativeSimctl` itself is stateless/cheap to construct — it never performs
 * I/O until a method is actually called — so a fresh instance per `devicesSetPath` change is
 * simpler than trying to mutate one in place.
 *
 * @param bulletinBoardVersions - the notifications store versions supported by the simulator class,
 * see `SimulatorXcode15.bulletinBoardVersions`; all the known ones by default.
 */
export function createNativeSimctl(
  deviceSetPath?: string | null,
  bulletinBoardVersions?: readonly number[],
): NativeSimctl {
  return new NativeSimctl(undefined, deviceSetPath ?? undefined, {bulletinBoardVersions});
}
