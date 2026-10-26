import type {StringRecord, AppiumLogger} from '@appium/types';

export interface AppInfo {
  id: string;
  isProxy: boolean;
  name: string;
  bundleId: string;
  hostId?: string;
  isActive: boolean;
  isAutomationEnabled: boolean | string;
  pageArray?: Page[];
}

export interface AppPage {
  appIdKey: AppIdKey;
  pageDict: Page;
}

export interface App {
  id: string;
  bundleId: string;
}

export interface Page {
  url: string;
  title: string;
  id: PageIdKey;
  isKey: boolean;
  bundleId?: string;
}

export type AppDict = StringRecord<AppInfo>;

export type EventListener = (error?: Error, event?: StringRecord, method?: string) => any;

/** Options applied only to the current JavaScript evaluation. */
export interface ScriptExecutionOptions {
  /**
   * Evaluate in a WebKit user-gesture context. Overrides the interaction-atom
   * policy when specified; otherwise defaults to false unless that policy applies.
   * This can affect popup blocking and other user-activation checks; enable it
   * only for an intentional interaction, such as a click, rather than every script.
   * It does not make synthetic DOM events trusted. The option is not inherited
   * by subsequent commands or executeAtomAsync calls.
   *
   * This can preserve navigation entries that WebKit otherwise hides from native
   * back/forward APIs after a synthetic click. Callers such as XCUITest Driver
   * must explicitly pass the option; this is not a driver capability or setting.
   *
   * @see https://github.com/appium/appium-xcuitest-driver/issues/3042
   */
  emulateUserGesture?: boolean;
}

/**
 * Options for one executeAtom call. Evaluation options are inherited so atom-
 * specific options can be added without changing the call signature.
 */
export interface ExecuteAtomOptions extends ScriptExecutionOptions {
  /**
   * `execute_script` only: max wait in ms for a returned promise (`script timeout`), at most 1 hour.
   * Default: no timer, as a W3C `null` script timeout. Drivers pass the session script timeout.
   */
  timeoutMs?: number;
}

export interface RemoteDebuggerOptions {
  /** id of the app being connected to */
  bundleId?: string;
  /** array of possible bundle ids that the inspector could return */
  additionalBundleIds?: string[];
  /** array of bundle ids to exclude from webview context detection */
  ignoredBundleIds?: string[];
  /**
   * On iOS 27+, emulate user gestures for click, clear, submit, and type atoms
   * containing only ordinary text or Enter/Return. Defaults to false.
   *
   * Opt in to preserve native back/forward history for these interactions, as
   * observed on iOS 26 without emulation. This does not reproduce all iOS 26
   * behavior: it grants activation and can affect popup blocking. Escape,
   * modifier/special-key sequences, scripts, and asynchronous atoms are excluded.
   * An explicit per-call emulateUserGesture value takes precedence.
   * Unspecified platform versions and versions below 27 retain the default behavior.
   */
  emulateUserGestureForInteractionAtoms?: boolean;
  /** version of iOS */
  platformVersion?: string;
  isSafari?: boolean;
  includeSafari?: boolean;
  /** @deprecated - deprecated for removal, not used anywhere */
  useNewSafari?: boolean;
  /** the time, in ms, that should be waited for page loading */
  pageLoadMs?: number;
  /** the remote debugger's host address */
  host?: string;
  /** the remote debugger port through which to communicate */
  port?: number;
  socketPath?: string;
  pageReadyTimeout?: number;
  remoteDebugProxy?: string;
  garbageCollectOnExecute?: boolean;
  logFullResponse?: boolean;
  /** log plists sent and received from Web Inspector */
  logAllCommunication?: boolean;
  /** log communication from Web Inspector as hex dump */
  logAllCommunicationHexDump?: boolean;
  /** The maximum size in bytes of a single data frame in the device communication protocol */
  webInspectorMaxFrameLength?: number;
  fullPageInitialization?: boolean;
  /**
   * How long to wait until a new target is created for a page.
   * Usually, it happens almost instantly, but on slow CI environments this might take some minutes.
   */
  targetCreationTimeoutMs?: number;
  pageLoadStrategy?: string;
  log?: AppiumLogger;
}

export type RemoteDebuggerRealDeviceOptions = RemoteDebuggerRealDeviceSpecificOptions & RemoteDebuggerOptions;

/**
 * Options for configuring an RpcClient instance.
 */
export interface RpcClientOptions {
  bundleId?: string;
  platformVersion?: string;
  isSafari?: boolean;
  logAllCommunication?: boolean;
  logAllCommunicationHexDump?: boolean;
  webInspectorMaxFrameLength?: number;
  fullPageInitialization?: boolean;
  pageLoadTimeoutMs?: number;
  udid?: string;
  targetCreationTimeoutMs?: number;
}

/**
 * Options specific to RpcClientSimulator.
 */
export interface RpcClientSimulatorOptions {
  socketPath?: string;
  host?: string;
  port?: number;
  messageProxy?: any;
}

export type AppIdKey = string | number;

export type PageIdKey = string | number;
export type TargetId = string;
export interface RemoteCommandId {
  id: string;
}

export interface RemoteCommandOpts {
  appIdKey?: AppIdKey;
  pageIdKey?: PageIdKey;
  id?: string;
  connId?: string;
  senderId?: string;
  /** Automation session identifier, required for Automation.* domain commands */
  sessionId?: string;
  targetId?: TargetId;
  bundleId?: string;
  enabled?: boolean;
  [key: string]: any;
}

export interface ProtocolCommandOpts {
  id: string;
  method: string;
  params: StringRecord;
}

export type RawRemoteCommand = RemoteCommandTemplated<StringRecord>;

export type RemoteCommand = RemoteCommandTemplated<Buffer>;

/**
 * Target types.
 * 'frame' was added since iOS 26.2 beta.
 * https://github.com/WebKit/WebKit/blob/06f8ad1a5a66f9ffaa33696a5b9fba4f4c65070b/Source/JavaScriptCore/inspector/protocol/Target.json#L12
 */
export type TargetType = 'page' | 'service-worker' | 'worker' | 'frame';

export interface TargetInfo {
  targetId: string;
  type: TargetType;
  isProvisional: boolean;
  isPaused: boolean;
}

export interface ProvisionalTargetInfo {
  oldTargetId: string;
  newTargetId: string;
}
/**
 * How a real device's Web Inspector service is reached: through the RemoteXPC tunnel (preferred)
 * or, as a temporary fallback when no tunnel is running, through lockdown over usbmux.
 */
export type RemoteDebuggerTransport = 'tunnel' | 'usbmux';

interface RemoteDebuggerRealDeviceSpecificOptions {
  udid: string;
  /**
   * The caller decides the transport (e.g. by checking whether a tunnel is running).
   * Defaults to `tunnel`. Ignored for simulators.
   */
  transport?: RemoteDebuggerTransport;
}

type SocketDataKey = Buffer | StringRecord;

interface RemoteCommandArgument<T extends SocketDataKey> {
  WIRSocketDataKey?: T;
  WIRConnectionIdentifierKey?: string;
  WIRSenderKey?: string;
  WIRApplicationIdentifierKey?: AppIdKey;
  WIRPageIdentifierKey?: PageIdKey;
  WIRMessageDataTypeKey?: string;
  WIRDestinationKey?: string;
  WIRMessageDataKey?: string;
  /** Automation session identifier, present on Automation domain socket data */
  WIRSessionIdentifierKey?: string;
  /** Capabilities dict sent when requesting an Automation session */
  WIRSessionCapabilitiesKey?: StringRecord;
  [key: string]: any;
}

interface RemoteCommandTemplated<T extends SocketDataKey> {
  __argument: RemoteCommandArgument<T>;
  __selector: string;
}
