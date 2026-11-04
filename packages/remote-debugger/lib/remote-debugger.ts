import {EventEmitter} from 'node:events';

import {util} from '@appium/support';
import type {AppiumLogger, StringRecord} from '@appium/types';
import type {CancellablePromise} from 'asyncbox';

import {log as defaultLog} from './logger.js';
import * as automationMixins from './mixins/automation.js';
import * as connectMixins from './mixins/connect.js';
import * as cookieMixins from './mixins/cookies.js';
import * as eventMixins from './mixins/events.js';
import * as executeMixins from './mixins/execute.js';
import * as messageHandlerMixins from './mixins/message-handlers.js';
import * as miscellaneousMixins from './mixins/misc.js';
import * as navigationMixins from './mixins/navigate.js';
import * as screenshotMixins from './mixins/screenshot.js';
import type {
  PageSettingName,
  PageSettings,
  UserPreferenceName,
  PageUserPreferences,
  WebInspectorSettings,
} from './page-overrides.js';
import {RpcClientSimulator, type AutomationSession} from './rpc/index.js';
import type {RpcClient} from './rpc/rpc-client.js';
import type {RemoteDebuggerOptions, AppDict, EventListener, PageIdKey, AppIdKey} from './types.js';
import {getModuleProperties} from './utils/index.js';

export const REMOTE_DEBUGGER_PORT = 27753;
const PAGE_READY_TIMEOUT_MS = 5000;
const {version: MODULE_VERSION} = getModuleProperties();

export class RemoteDebugger extends EventEmitter {
  // events
  static readonly EVENT_PAGE_CHANGE: string;
  static readonly EVENT_DISCONNECT: string;
  static readonly EVENT_FRAMES_DETACHED: string;

  // methods
  setConnectionKey = connectMixins.setConnectionKey;
  disconnect = connectMixins.disconnect;
  startAutomationSession = automationMixins.startAutomationSession;
  stopAutomationSession = automationMixins.stopAutomationSession;
  checkPageIsReady = navigationMixins.checkPageIsReady;
  cancelPageLoad = navigationMixins.cancelPageLoad;
  waitForDom = navigationMixins.waitForDom;
  execute = executeMixins.execute;
  executeAtom = executeMixins.executeAtom;
  executeAtomAsync = executeMixins.executeAtomAsync;
  isPageLoadingCompleted = navigationMixins.isPageLoadingCompleted;
  selectApp = connectMixins.selectApp;
  connect = connectMixins.connect;
  selectPage = connectMixins.selectPage;
  navToUrl = navigationMixins.navToUrl;
  getCookies = cookieMixins.getCookies;
  setCookie = cookieMixins.setCookie;
  deleteCookie = cookieMixins.deleteCookie;
  captureScreenshot = screenshotMixins.captureScreenshot;
  addClientEventListener = eventMixins.addClientEventListener;
  removeClientEventListener = eventMixins.removeClientEventListener;
  startConsole = eventMixins.startConsole;
  stopConsole = eventMixins.stopConsole;
  startNetwork = eventMixins.startNetwork;
  stopNetwork = eventMixins.stopNetwork;
  launchSafari = miscellaneousMixins.launchSafari;
  startTimeline = miscellaneousMixins.startTimeline;
  stopTimeline = miscellaneousMixins.stopTimeline;
  overrideUserAgent = miscellaneousMixins.overrideUserAgent;
  garbageCollect = miscellaneousMixins.garbageCollect;
  isJavascriptExecutionBlocked = miscellaneousMixins.isJavascriptExecutionBlocked;

  // callbacks
  onPageChange = messageHandlerMixins.onPageChange;
  onConnectedApplicationList = messageHandlerMixins.onConnectedApplicationList;
  onAppConnect = messageHandlerMixins.onAppConnect;
  onAppDisconnect = messageHandlerMixins.onAppDisconnect;
  onAppUpdate = messageHandlerMixins.onAppUpdate;
  onConnectedDriverList = messageHandlerMixins.onConnectedDriverList;
  onCurrentState = messageHandlerMixins.onCurrentState;
  frameDetached = navigationMixins.frameDetached;

  protected _skippedApps: string[];
  protected _clientEventListeners!: StringRecord<EventListener[]>;
  protected _appDict: AppDict = {};
  protected _appIdKey?: AppIdKey;
  protected _pageIdKey?: PageIdKey;
  protected _connectedDrivers?: StringRecord[];
  protected _currentState?: string;
  protected _pageLoadDelay?: CancellablePromise<void>;
  protected _rpcClient: RpcClient | null = null;
  protected _automationSession?: AutomationSession;
  protected _pageLoading: boolean = false;
  protected _navigatingToPage: boolean = false;
  protected _allowNavigationWithoutReload: boolean;
  protected _pageLoadMs?: number;
  protected readonly _pageLoadStrategy?: string;
  protected readonly _log: AppiumLogger;
  protected readonly _bundleId?: string;
  protected readonly _additionalBundleIds?: string[];
  protected readonly _ignoredBundleIds?: string[];
  protected readonly _platformVersion?: string;
  protected readonly _isSafari: boolean;
  protected readonly _includeSafari: boolean;
  protected readonly _garbageCollectOnExecute: boolean;
  protected readonly _emulateUserGestureForInteractionAtoms: boolean;
  protected readonly _host?: string;
  protected readonly _port?: number;
  protected readonly _socketPath?: string;
  protected readonly _remoteDebugProxy?: any;
  protected readonly _pageReadyTimeout: number;
  protected readonly _logAllCommunication: boolean;
  protected readonly _logAllCommunicationHexDump: boolean;
  protected readonly _webInspectorMaxFrameLength?: number;
  protected readonly _fullPageInitialization?: boolean;
  protected _pageSettings: PageSettings;
  protected _userPreferences: PageUserPreferences;
  protected _userAgent?: string;
  protected readonly _targetCreationTimeoutMs?: number;

  constructor(opts: RemoteDebuggerOptions = {}) {
    super();

    this._log = opts.log ?? defaultLog;
    this.log.info(`Remote Debugger version ${MODULE_VERSION}`);

    const {
      bundleId,
      additionalBundleIds = [],
      ignoredBundleIds = [],
      platformVersion,
      isSafari = true,
      includeSafari = false,
      pageLoadMs,
      host,
      port = REMOTE_DEBUGGER_PORT,
      socketPath,
      pageReadyTimeout = PAGE_READY_TIMEOUT_MS,
      remoteDebugProxy,
      garbageCollectOnExecute = false,
      emulateUserGestureForInteractionAtoms = false,
      logFullResponse = false,
      logAllCommunication = false,
      logAllCommunicationHexDump = false,
      webInspectorMaxFrameLength,
      fullPageInitialization,
      disableWebSecurity = false,
      pageLoadStrategy,
      targetCreationTimeoutMs,
    } = opts;

    this._bundleId = bundleId;
    this._additionalBundleIds = additionalBundleIds;
    this._ignoredBundleIds = ignoredBundleIds;
    this._platformVersion = platformVersion;
    this._isSafari = isSafari;
    this._includeSafari = includeSafari;
    this._pageLoadMs = pageLoadMs;
    this._allowNavigationWithoutReload = false;

    this._garbageCollectOnExecute = garbageCollectOnExecute;
    this._emulateUserGestureForInteractionAtoms =
      emulateUserGestureForInteractionAtoms && !!platformVersion && util.compareVersions(platformVersion, '>=', '27.0');

    this._host = host;
    this._port = port;
    this._socketPath = socketPath;
    this._remoteDebugProxy = remoteDebugProxy;
    this._pageReadyTimeout = pageReadyTimeout;

    this._logAllCommunication = logAllCommunication == null ? !!logFullResponse : !!logAllCommunication;
    this._logAllCommunicationHexDump = logAllCommunicationHexDump;

    if (Number.isInteger(webInspectorMaxFrameLength)) {
      this._webInspectorMaxFrameLength = webInspectorMaxFrameLength;
    }

    this._fullPageInitialization = fullPageInitialization;
    const initial = opts.webInspectorSettings ?? {
      pageSettings: {...opts.pageSettings, ...(disableWebSecurity ? {WebSecurityEnabled: false} : {})},
      userPreferences: opts.userPreferences,
    };
    this._pageSettings = {...initial.pageSettings};
    this._userPreferences = {...initial.userPreferences};
    this._userAgent = initial.userAgent;
    this._targetCreationTimeoutMs = targetCreationTimeoutMs;

    this._pageLoadStrategy = pageLoadStrategy;
    this._skippedApps = [];

    this.setup();
  }

  /**
   * Updates inspected pages and the policy used for future targets and connections.
   * false removes the WebKit override. Reload or navigate after changing this value;
   * existing document security origins are not changed retroactively.
   */
  async setDisableWebSecurity(value: boolean): Promise<void> {
    await this.setPageSetting('WebSecurityEnabled', value ? false : undefined);
  }

  /** Updates current and future targets. undefined removes the override. Reload for document-dependent settings. */
  async setPageSetting(name: PageSettingName, value: boolean | undefined): Promise<void> {
    await this._rpcClient?.setPageSetting(name, value);
    if (value === undefined) {
      delete this._pageSettings[name];
    } else {
      this._pageSettings[name] = value;
    }
  }

  /** Updates current and future targets. undefined restores the system preference. */
  async setUserPreference<Name extends UserPreferenceName>(
    name: Name,
    value: PageUserPreferences[Name],
  ): Promise<void> {
    await this._rpcClient?.setUserPreference(name, value);
    if (value === undefined) {
      delete this._userPreferences[name];
    } else {
      this._userPreferences[name] = value;
    }
  }

  /** Replaces the complete policy. Omitted entries are reset; {} clears all overrides. */
  async setWebInspectorSettings(settings: WebInspectorSettings): Promise<void> {
    const next = {
      pageSettings: {...settings.pageSettings},
      userPreferences: {...settings.userPreferences},
      userAgent: settings.userAgent,
    };
    await this._rpcClient?.setWebInspectorSettings(next);
    this._pageSettings = next.pageSettings;
    this._userPreferences = next.userPreferences;
    this._userAgent = next.userAgent;
  }

  get log(): AppiumLogger {
    return this._log;
  }

  get isConnected(): boolean {
    return !!this._rpcClient?.isConnected;
  }

  // Only use this getter to read the appDict value.
  // Any changes to it don't mutate the original property
  // because the getter always returns the copy of it
  get appDict(): AppDict {
    return structuredClone(this._appDict);
  }

  get allowNavigationWithoutReload(): boolean {
    return !!this._allowNavigationWithoutReload;
  }

  get currentState(): string | undefined {
    return this._currentState;
  }

  get connectedDrivers(): StringRecord[] | undefined {
    return this._connectedDrivers;
  }

  /** The active Automation session, if `startAutomationSession()` has been called. */
  get automationSession(): AutomationSession | undefined {
    return this._automationSession;
  }

  get pageLoadMs(): number {
    return this._pageLoadMs ?? navigationMixins.DEFAULT_PAGE_READINESS_TIMEOUT_MS;
  }

  set allowNavigationWithoutReload(allow: boolean) {
    this._allowNavigationWithoutReload = allow;
  }

  set pageLoadMs(value: number) {
    this._pageLoadMs = value;
  }

  requireRpcClient(checkConnected: boolean = false): RpcClient {
    if (!this._rpcClient) {
      throw new Error(`rpcClient is undefined. Has 'initRpcClient' been called before?`);
    }
    if (checkConnected && !this._rpcClient.isConnected) {
      throw new Error('Remote debugger is not connected');
    }
    return this._rpcClient;
  }

  setup(): void {
    // app handling configuration
    this._appDict = {};
    this._appIdKey = undefined;
    this._pageIdKey = undefined;
    this._pageLoading = false;
    this._navigatingToPage = false;
    this._currentState = undefined;
    this._connectedDrivers = undefined;
    this._pageLoadDelay = undefined;

    this._rpcClient = null;
    this._automationSession = undefined;
    this._clientEventListeners = {};
  }

  teardown(): void {
    this.log.debug('Cleaning up listeners');

    this._appDict = {};
    this._appIdKey = undefined;
    this._pageIdKey = undefined;
    this._pageLoading = false;

    this._rpcClient = null;
    this._automationSession = undefined;

    for (const evt of [
      RemoteDebugger.EVENT_DISCONNECT,
      RemoteDebugger.EVENT_PAGE_CHANGE,
      RemoteDebugger.EVENT_FRAMES_DETACHED,
    ]) {
      this.removeAllListeners(evt);
    }
  }

  async initRpcClient(): Promise<void> {
    this._rpcClient = new RpcClientSimulator({
      bundleId: this._bundleId,
      platformVersion: this._platformVersion,
      isSafari: this._isSafari,
      host: this._host,
      port: this._port,
      socketPath: this._socketPath,
      messageProxy: this._remoteDebugProxy,
      logAllCommunication: this._logAllCommunication,
      logAllCommunicationHexDump: this._logAllCommunicationHexDump,
      fullPageInitialization: this._fullPageInitialization,
      webInspectorSettings: {
        pageSettings: this._pageSettings,
        userPreferences: this._userPreferences,
        userAgent: this._userAgent,
      },
      webInspectorMaxFrameLength: this._webInspectorMaxFrameLength,
      pageLoadTimeoutMs: this._pageLoadMs,
      targetCreationTimeoutMs: this._targetCreationTimeoutMs,
    });
  }
}

Object.assign(RemoteDebugger, eventMixins.events);

export default RemoteDebugger;
