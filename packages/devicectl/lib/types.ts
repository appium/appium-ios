import type {SubProcess, TeenProcessExecResult} from 'teen_process';

/**
 * Information about a running process on the device
 */
export interface ProcessInfo {
  /** The process identifier */
  processIdentifier: number;
  /** The executable path */
  executable: string;
}

/**
 * Information about an installed app on the device
 */
export interface AppInfo {
  /** Whether this is an app clip */
  appClip: boolean;
  /** Whether this app was built by a developer */
  builtByDeveloper: boolean;
  /** The bundle identifier */
  bundleIdentifier: string;
  /** The bundle version */
  bundleVersion: string;
  /** Whether this is a default system app */
  defaultApp: boolean;
  /** Whether this app is hidden */
  hidden: boolean;
  /** Whether this is an internal system app */
  internalApp: boolean;
  /** The app name */
  name: string;
  /** Whether this app can be removed */
  removable: boolean;
  /** The app URL/path */
  url: string;
  /** The app version */
  version: string;
}

/**
 * Options for executing devicectl commands
 */
export interface ExecuteOptions {
  /**
   * Whether to drop the --device option from the actual devicectl command
   * @default false
   */
  noDevice?: boolean;
  /**
   * Whether to log stdout output
   * @default false
   */
  logStdout?: boolean;
  /**
   * Whether to return JSON output
   * @default true
   */
  asJson?: boolean;
  /**
   * Whether to run the command asynchronously
   * @default false
   */
  asynchronous?: boolean;
  /** Additional subcommand options */
  subcommandOptions?: string[] | string;
  /** Timeout in milliseconds */
  timeout?: number;
  /**
   * Whether to run as the original non-root user when current process is running via sudo
   *
   * If not set, this falls back to `DevicectlOptions.preferNonRootWhenSudo`.
   */
  runAsNonRootWhenSudo?: boolean;
}

/**
 * Options for creating a Devicectl instance
 */
export interface DevicectlOptions {
  /**
   * Whether to run `devicectl` as the original non-root user when parent process runs via sudo
   * @default true
   */
  preferNonRootWhenSudo?: boolean;
}

/**
 * Options for asynchronous execution
 */
export interface AsyncExecuteOptions extends ExecuteOptions {
  asynchronous: true;
}

/**
 * Options for listing files on the device
 */
export interface ListFilesOptions {
  /** The username of the user we should target. Only relevant for certain domains. */
  username?: string;
  /** A subdirectory within the domain. If not specified, defaults to the root. */
  subdirectory?: string;
}

/**
 * Options for pulling files from the device
 */
export interface PullFileOptions {
  /** The username of the user we should target. Only relevant for certain domains. */
  username?: string;
  /** The file service domain. Valid values are: temporary, rootStaging, appDataContainer, appGroupDataContainer, systemCrashLogs */
  domainType: string;
  /** A unique string used to provide additional context to the domain */
  domainIdentifier: string;
  /** The timeout for pulling a file in milliseconds */
  timeout?: number;
}

/**
 * Options for launching an app
 */
export interface LaunchAppOptions {
  /** Environment variables for the launching app process */
  env?: Record<string, string | number>;
  /** Whether to terminate the already running app */
  terminateExisting?: boolean;
}

/**
 * Options for terminating an app
 */
export interface TerminateAppOptions {
  /**
   * Send SIGKILL instead of SIGTERM so the process cannot catch the signal
   * @default false
   */
  force?: boolean;
}

/**
 * Result type for synchronous execution
 */
export type SyncExecuteResult = TeenProcessExecResult<string>;

/**
 * Result type for asynchronous execution
 */
export type AsyncExecuteResult = SubProcess;

/**
 * Union type for execute method return
 */
export type ExecuteResult<T extends ExecuteOptions> = T extends AsyncExecuteOptions
  ? AsyncExecuteResult
  : SyncExecuteResult;

/**
 * CPU type information
 */
export interface CPUType {
  /** The CPU type name
   * @example "arm64e" */
  name: string;
  /** The CPU subtype
   * @example 2 */
  subType: number;
  /** The CPU type identifier
   * @example 16777228 */
  type: number;
}

/**
 * Device capability information
 */
export interface Capability {
  /** The feature identifier
   * @example "com.apple.coredevice.feature.installapp" */
  featureIdentifier: string;
  /** The capability name
   * @example "Install Application" */
  name: string;
}

/**
 * Connection properties for the device
 */
export interface ConnectionProperties {
  /** The authentication type
   * @example "manualPairing" */
  authenticationType: string;
  /** Whether this is a mobile device only
   * @example false */
  isMobileDeviceOnly: boolean;
  /** The last connection date in ISO format
   * @example "2025-01-01T12:00:00.000Z" */
  lastConnectionDate?: string;
  /** List of local hostnames
   * @example ["MyDevice.coredevice.local", "ABCD1234-5678-90EF-GHIJ-KLMNOPQRSTUV.coredevice.local"] */
  localHostnames?: string[];
  /** The pairing state
   * @example "paired" */
  pairingState: string;
  /** List of potential hostnames
   * @example ["MyDevice.coredevice.local", "ABCD1234-5678-90EF-GHIJ-KLMNOPQRSTUV.coredevice.local"] */
  potentialHostnames: string[];
  /** The transport type
   * @example "wired" */
  transportType?: string;
  /** The tunnel IP address
   * @example "fdda:f9b3:f5d9::1" */
  tunnelIPAddress?: string;
  /** The tunnel state
   * @example "connected" */
  tunnelState: string;
  /** The tunnel transport protocol
   * @example "tcp" */
  tunnelTransportProtocol?: string;
}

/**
 * Device properties
 */
export interface DeviceProperties {
  /** The boot state
   * @example "booted" */
  bootState?: string;
  /** Whether booted from snapshot
   * @example true */
  bootedFromSnapshot?: boolean;
  /** The booted snapshot name
   * @example "com.apple.os.update-ABCDEF1234567890" */
  bootedSnapshotName?: string;
  /** Whether DDI services are available
   * @example true */
  ddiServicesAvailable?: boolean;
  /** The developer mode status
   * @example "enabled" */
  developerModeStatus?: string;
  /** Whether has internal OS build
   * @example false */
  hasInternalOSBuild?: boolean;
  /** The device name
   * @example "My iPhone" */
  name: string;
  /** The OS build update
   * @example "22A100" */
  osBuildUpdate: string;
  /** The OS version number
   * @example "18.0.0" */
  osVersionNumber: string;
  /** Whether root file system is writable
   * @example false */
  rootFileSystemIsWritable?: boolean;
  /** The screen viewing URL
   * @example "devices://device/open?id=ABCD1234-5678-90EF-GHIJ-KLMNOPQRSTUV" */
  screenViewingURL?: string;
  /** Whether supports checked allocations
   * @example false */
  supportsCheckedAllocations?: boolean;
}

/**
 * Hardware properties for the device
 */
export interface HardwareProperties {
  /** The CPU type
   * @example { name: "arm64e", subType: 2, type: 16777228 } */
  cpuType: CPUType;
  /** The device type
   * @example "iPhone" */
  deviceType: string;
  /** The ECID
   * @example 1234567890123456 */
  ecid: number;
  /** The hardware model
   * @example "D63AP" */
  hardwareModel: string;
  /** The internal storage capacity in bytes
   * @example 128000000000 */
  internalStorageCapacity?: number;
  /** Whether is production fused
   * @example true */
  isProductionFused?: boolean;
  /** The marketing name
   * @example "iPhone 15" */
  marketingName?: string;
  /** The platform
   * @example "iOS", "tvOS" */
  platform: string;
  /** The product type
   * @example "iPhone16,1" */
  productType: string;
  /** The reality type (physical or simulator)
   * @example "physical" */
  reality?: string;
  /** The serial number
   * @example "ABC1234XYZ" */
  serialNumber?: string;
  /** List of supported CPU types
   * @example [{ name: "arm64e", subType: 2, type: 16777228 }, { name: "arm64", subType: 0, type: 16777228 }] */
  supportedCPUTypes?: CPUType[];
  /** List of supported device families
   * @example [1, 2], [3] */
  supportedDeviceFamilies: number[];
  /** The thinning product type
   * @example "iPhone16,1" */
  thinningProductType?: string;
  /** The UDID
   * @example "00000000-0000000000000000" */
  udid: string;
}

/**
 * Complete device information
 */
export interface DeviceInfo {
  /** List of device capabilities
   * @example [{ featureIdentifier: "com.apple.coredevice.feature.installapp", name: "Install Application" }] */
  capabilities: Capability[];
  /** Connection properties
   * @example { authenticationType: "manualPairing", pairingState: "paired", transportType: "wired" } */
  connectionProperties: ConnectionProperties;
  /** Device properties
   * @example { name: "My iPhone", bootState: "booted", osVersionNumber: "18.0.0" } */
  deviceProperties: DeviceProperties;
  /** Hardware properties
   * @example { deviceType: "iPhone", platform: "iOS", udid: "00000000-0000000000000000" } */
  hardwareProperties: HardwareProperties;
  /** The device identifier
   * @example "ABCD1234-5678-90EF-GHIJ-KLMNOPQRSTUV" */
  identifier: string;
  /** List of tags
   * @example [] */
  tags: string[];
  /** The visibility class
   * @example "default" */
  visibilityClass: string;
}
