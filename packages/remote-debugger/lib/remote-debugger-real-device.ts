import {RemoteDebugger} from './remote-debugger.js';
import {RpcClientRealDevice} from './rpc/index.js';
import type {RemoteDebuggerRealDeviceOptions, RemoteDebuggerTransport} from './types.js';

export class RemoteDebuggerRealDevice extends RemoteDebugger {
  private readonly _udid!: string;
  private readonly _transport?: RemoteDebuggerTransport;

  constructor(opts: RemoteDebuggerRealDeviceOptions) {
    super(opts);
    this._udid = opts.udid;
    this._transport = opts.transport;
    this._skippedApps = ['lockdownd'];
  }

  override async initRpcClient(): Promise<void> {
    const rpcClient = new RpcClientRealDevice({
      bundleId: this._bundleId,
      platformVersion: this._platformVersion,
      isSafari: this._isSafari,
      logAllCommunication: this._logAllCommunication,
      logAllCommunicationHexDump: this._logAllCommunicationHexDump,
      webInspectorMaxFrameLength: this._webInspectorMaxFrameLength,
      udid: this._udid,
      transport: this._transport,
      pageLoadTimeoutMs: this._pageLoadMs,
      targetCreationTimeoutMs: this._targetCreationTimeoutMs,
    });
    // connecting is left to the connect mixin, after it has attached its listeners
    this._rpcClient = rpcClient;
    this.log.info(
      `Using the WebInspector service for iOS ${this._platformVersion ?? '(unknown version)'} ` +
        `via ${this._transport ?? 'tunnel'}`,
    );
  }
}

export default RemoteDebuggerRealDevice;
