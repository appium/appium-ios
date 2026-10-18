import * as net from 'node:net';

import {util} from '@appium/support';

import {createDiscoveryBackend} from '../../discovery/discovery-backend-factory.js';
import {getLogger} from '../../logger.js';
import {
  DEFAULT_PAIRING_CONFIG,
  REMOTE_PAIRING_DISCOVERY_DOMAIN,
  REMOTE_PAIRING_VERIFIED_DISCOVERY_SERVICE_TYPE,
} from '../constants.js';
import {enrichDiscoveredDevicesWithDevicectl} from '../devicectl-enrichment.js';
import {toAppleTVDevices} from '../discovered-device-mapper.js';
import {decryptChaCha20Poly1305, encryptChaCha20Poly1305} from '../encryption/index.js';
import {PairingError} from '../errors.js';
import {NetworkClient} from '../network/index.js';
import type {NetworkClientInterface} from '../network/types.js';
import {PairVerificationProtocol} from '../pairing-protocol/index.js';
import type {VerificationKeys} from '../pairing-protocol/pair-verification-protocol.js';
import {PairingStorage} from '../storage/pairing-storage.js';
import type {PairRecord} from '../storage/types.js';
import type {AppleTVDevice} from '../types.js';
import {type MatchedPairRecord, type PairRecordCandidate, matchDevicesToPairRecords} from './pair-record-matcher.js';
import {RemotedController} from './remoted-controller.js';
import type {TcpListenerInfo} from './types.js';

const log = getLogger('TunnelService');
const appleTVLog = getLogger('AppleTVTunnelService');

export interface AppleTVTunnelOptions {
  discoveryTimeoutMs?: number;
  devices?: AppleTVDevice[];
}

export interface AppleTVDiscoveryOptions {
  timeoutMs?: number;
}

export class TunnelService {
  private encryptedSequenceNumber = 0;

  constructor(
    private readonly networkClient: NetworkClientInterface,
    private readonly keys: VerificationKeys,
    private sequenceNumber: number,
  ) {}

  async createTcpListener(): Promise<TcpListenerInfo> {
    log.debug('Creating TCP listener (Encrypted Request)');

    const request = {
      request: {
        _0: {
          createListener: {
            key: this.keys.encryptionKey.toString('base64'),
            peerConnectionsInfo: [
              {
                owningPID: process.pid,
                owningProcessName: 'CoreDeviceService',
              },
            ],
            transportProtocolType: 'tcp',
          },
        },
      },
    };

    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(BigInt(this.encryptedSequenceNumber), 0);

    const requestJson = JSON.stringify(request);

    const encrypted = encryptChaCha20Poly1305({
      plaintext: Buffer.from(requestJson, 'utf8'),
      key: this.keys.clientEncryptionKey,
      nonce,
    });

    const encryptedPayload = {
      message: {
        streamEncrypted: {
          _0: encrypted.toString('base64'),
        },
      },
      originatedBy: 'host',
      sequenceNumber: this.sequenceNumber++,
    };

    await this.networkClient.sendPacket(encryptedPayload);
    this.encryptedSequenceNumber++;

    const response = await this.networkClient.receiveResponse();

    const encryptedData = response.message?.streamEncrypted?._0;

    if (!encryptedData) {
      throw new PairingError('Failed to receive encrypted response from device', 'ENCRYPTED_RESPONSE_MISSING', {
        response,
      });
    }

    const responseNonce = Buffer.alloc(12);
    responseNonce.writeBigUInt64LE(BigInt(this.encryptedSequenceNumber - 1), 0);

    const decrypted = decryptChaCha20Poly1305({
      ciphertext: Buffer.from(encryptedData, 'base64'),
      key: this.keys.serverEncryptionKey,
      nonce: responseNonce,
    });

    const responseJson = JSON.parse(decrypted.toString('utf8'));
    const createListenerResponse = responseJson?.response?._1?.createListener;

    if (!createListenerResponse?.port) {
      log.error(`Invalid createListener response: ${JSON.stringify(responseJson, null, 2)}`);
      throw new PairingError('TCP listener creation failed: missing port in response', 'LISTENER_PORT_MISSING', {
        response: responseJson,
      });
    }

    log.debug(`TCP Listener created on port: ${createListenerResponse.port}`);

    return createListenerResponse;
  }

  getSequenceNumber(): number {
    return this.sequenceNumber;
  }
}

/**
 * High-level service for establishing Apple TV tunnels.
 * Orchestrates device discovery, pairing verification, and tunnel creation.
 */
export class AppleTVTunnelService {
  private readonly networkClient: NetworkClient;
  private readonly storage: PairingStorage;
  private readonly remoted: RemotedController;
  private sequenceNumber = 0;

  constructor() {
    this.networkClient = new NetworkClient(DEFAULT_PAIRING_CONFIG);
    this.storage = new PairingStorage(DEFAULT_PAIRING_CONFIG);
    this.remoted = new RemotedController();
  }

  disconnect(): void {
    this.networkClient.disconnect();
    // Safety net: startTunnel() already resumes remoted in its own finally
    // block, this guards against callers that abandon a partially-started
    // tunnel without that path executing.
    this.remoted.resume();
  }

  /**
   * Discovers Apple TV devices advertising Remote Pairing on the local network.
   */
  async discoverDevices(options: AppleTVDiscoveryOptions = {}): Promise<AppleTVDevice[]> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PAIRING_CONFIG.discoveryTimeout;

    // The tunnel flow must use the trusted `_remotepairing._tcp` service.
    // The PIN-setup `_remotepairing-manual-pairing._tcp` service does not
    // expose a tunnel listener creator and rejects createListener with
    // `errorExtended: { code: 3, NSLocalizedDescription: 'Unsupported
    // operation: Tunnel listener creator not set' }`.
    const backend = createDiscoveryBackend(process.platform, {
      serviceType: REMOTE_PAIRING_VERIFIED_DISCOVERY_SERVICE_TYPE,
      domain: REMOTE_PAIRING_DISCOVERY_DOMAIN,
    });
    const discoveredDevices = await backend.discoverDevices(timeoutMs);
    const enrichedDevices = await enrichDiscoveredDevicesWithDevicectl(discoveredDevices);
    const devices = toAppleTVDevices(enrichedDevices);
    if (devices.length === 0) {
      throw new Error('No devices found via discovery backend');
    }

    return devices;
  }

  async startTunnel(
    deviceId?: string,
    specificDeviceIdentifier?: string,
    options: AppleTVTunnelOptions = {},
  ): Promise<{
    tcpSocket: net.Socket;
    psk: Buffer;
    device: AppleTVDevice;
  }> {
    let devices = options.devices;
    if (!devices) {
      devices = await this.discoverDevices({
        timeoutMs: options.discoveryTimeoutMs,
      });
      this.logDiscoveredDevices(devices);
    }

    const identifiersToTry = await this.validateAndGetPairRecords(deviceId);
    const failedAttempts: {identifier: string; error: string}[] = [];
    const candidates = await this.loadPairRecordCandidates(identifiersToTry, failedAttempts);
    const attempts = this.selectConnectionAttempts(devices, candidates, specificDeviceIdentifier);

    // Suspend macOS' remoted daemon for the duration of the tunnel handshake.
    // While remoted holds the trusted tunnel for a paired device, the device
    // refuses a second createListener request from another client. Resumed in
    // finally so the daemon never stays suspended after this method returns.
    await this.remoted.suspend();
    try {
      for (const {device, identifier, record} of attempts) {
        appleTVLog.debug(`\n--- Attempting connection with pair record: ${identifier} ---`);
        appleTVLog.debug(`Device: ${device.ip}:${device.port}`);

        const result = await this.attemptDeviceConnection(device, identifier, record, failedAttempts);

        if (result) {
          return result;
        }
      }
    } finally {
      this.remoted.resume();
    }

    this.logFailureSummary(failedAttempts);

    throw new Error('Failed to establish tunnel with any pair record. All authentication attempts failed.');
  }

  /**
   * Logs information about discovered devices
   */
  private logDiscoveredDevices(devices: AppleTVDevice[]): void {
    appleTVLog.debug('Step 1: Device Discovery success');
    appleTVLog.debug(`Found ${util.pluralize('device', devices.length, true)} via discovery backend`);

    if (devices.length > 0) {
      appleTVLog.info('\nDiscovered Apple TV devices:');
      devices.forEach((device, index) => {
        appleTVLog.info(`  ${index + 1}. Identifier: ${device.identifier}`);
        appleTVLog.info(`     Name: ${device.name}`);
        appleTVLog.info(`     IP: ${device.ip}:${device.port}`);
        appleTVLog.info(`     Model: ${device.model}`);
        appleTVLog.info(`     Version: ${device.version}`);
      });
    }
  }

  /**
   * Loads each pair record once; records that fail to load are recorded as failed attempts and skipped.
   */
  private async loadPairRecordCandidates(
    identifiers: string[],
    failedAttempts: {identifier: string; error: string}[],
  ): Promise<PairRecordCandidate[]> {
    const candidates: PairRecordCandidate[] = [];
    for (const identifier of identifiers) {
      const record = await this.storage.load(identifier);
      if (record) {
        candidates.push({identifier, record});
        continue;
      }
      appleTVLog.debug(`Failed to load pair record for ${identifier}`);
      failedAttempts.push({identifier, error: 'Failed to load pair record'});
    }
    return candidates;
  }

  /**
   * Builds the ordered connection attempts: devices matched to a record by authTag first, then
   * records without an altIRK (saved before it was stored) against every device no record matched.
   * `specificDeviceIdentifier` may be a discovered device identifier or a pair record id.
   */
  private selectConnectionAttempts(
    devices: AppleTVDevice[],
    candidates: PairRecordCandidate[],
    specificDeviceIdentifier?: string,
  ): MatchedPairRecord[] {
    const {matches, recordsWithoutAltIRK, devicesWithoutAuthTag} = matchDevicesToPairRecords(devices, candidates);
    if (devicesWithoutAuthTag.length > 0) {
      appleTVLog.debug(`Discovered devices without an authTag: ${devicesWithoutAuthTag.join(', ')}`);
    }

    const matchedDevices = new Set(matches.map(({device}) => device));
    const unmatchedDevices = devices.filter((device) => !matchedDevices.has(device));
    // A record without an altIRK only costs extra attempts when more than one device is left to try it on
    if (unmatchedDevices.length > 1) {
      for (const identifier of recordsWithoutAltIRK) {
        appleTVLog.warn(
          `Pair record ${identifier} has no altIRK, so it will be tried against ${unmatchedDevices.length} unmatched devices; pair that Apple TV again to avoid this.`,
        );
      }
    }
    const legacyCandidates = candidates.filter(({identifier}) => recordsWithoutAltIRK.includes(identifier));
    const legacyAttempts = unmatchedDevices.flatMap((device) =>
      legacyCandidates.map(({identifier, record}) => ({identifier, record, device})),
    );
    const attempts = [...matches, ...legacyAttempts];
    if (attempts.length === 0) {
      throw new Error(
        `No discovered device matched a pair record by authTag (${util.pluralize('device', devices.length, true)} discovered, ${devicesWithoutAuthTag.length} without authTag; ${util.pluralize('pair record', candidates.length, true)}).`,
      );
    }

    if (!specificDeviceIdentifier) {
      return attempts;
    }

    const filteredAttempts = attempts.filter(
      ({device, identifier}) =>
        device.identifier === specificDeviceIdentifier || identifier === specificDeviceIdentifier,
    );
    if (filteredAttempts.length === 0) {
      appleTVLog.error(`\nDevice with identifier ${specificDeviceIdentifier} not found among connection attempts.`);
      appleTVLog.error('Connection attempts:');
      attempts.forEach(({device, identifier}) => {
        appleTVLog.error(`  - ${device.identifier} (${device.name}) with pair record ${identifier}`);
      });
      throw new Error(
        `Device with identifier ${specificDeviceIdentifier} not found. Please check available devices above.`,
      );
    }

    appleTVLog.info(`\nFiltered to specific device: ${specificDeviceIdentifier}`);

    return filteredAttempts;
  }

  /**
   * Validates pair records and returns the list of identifiers to try
   */
  private async validateAndGetPairRecords(deviceId?: string): Promise<string[]> {
    const availableDeviceIds = await this.storage.getAvailableDeviceIds();

    if (availableDeviceIds.length === 0) {
      throw new Error('No pair records found');
    }

    if (deviceId && !availableDeviceIds.includes(deviceId)) {
      throw new Error(`No pair record found for specified device ${deviceId}`);
    }

    return deviceId ? [deviceId] : availableDeviceIds;
  }

  /**
   * Attempts to establish a connection with a device using a specific pair record
   */
  private async attemptDeviceConnection(
    device: AppleTVDevice,
    identifier: string,
    pairRecord: PairRecord,
    failedAttempts: {identifier: string; error: string}[],
  ): Promise<{
    tcpSocket: net.Socket;
    psk: Buffer;
    device: AppleTVDevice;
  } | null> {
    const connectionTarget = device.ip ?? device.hostname;
    if (!connectionTarget) {
      failedAttempts.push({
        identifier,
        error: 'Connection failed: no IP or hostname available',
      });
      return null;
    }

    try {
      this.sequenceNumber = 0;
      await this.networkClient.connect(connectionTarget, device.port);

      try {
        await this.performHandshake();

        const keys = await this.performPairVerification(pairRecord, identifier);
        appleTVLog.info(`✅ Successfully verified with pair record: ${identifier}`);

        const listenerInfo = await this.createTcpListener(keys);
        this.networkClient.disconnect();

        const tcpSocket = await connectToListenerPort(connectionTarget, listenerInfo.port);
        const tunnelDevice = this.withTunnelIdentifier(device, pairRecord);

        appleTVLog.debug('Step 6: Tunnel Establishment success');
        appleTVLog.info(`🔑 Using pair record: ${identifier}`);
        appleTVLog.info(`📱 Connected to device: ${tunnelDevice.identifier} (${tunnelDevice.name})`);
        appleTVLog.info(`   Target: ${connectionTarget}:${device.port}`);

        return {
          tcpSocket,
          psk: keys.encryptionKey,
          device: tunnelDevice,
        };
      } catch (error: any) {
        const errorMessage = error.message || String(error);
        appleTVLog.debug(`❌ Failed with pair record ${identifier}: ${errorMessage}`);
        failedAttempts.push({identifier, error: errorMessage});
        this.networkClient.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (connectionError: any) {
      const errorMessage = connectionError.message || String(connectionError);
      appleTVLog.debug(`Failed to connect to ${connectionTarget}:${device.port}: ${errorMessage}`);
      failedAttempts.push({
        identifier,
        error: `Connection failed: ${errorMessage}`,
      });
      this.networkClient.disconnect();
    }

    return null;
  }

  /**
   * Logs a summary of all failed connection attempts
   */
  private logFailureSummary(failedAttempts: {identifier: string; error: string}[]): void {
    appleTVLog.error('\n=== Pair Record Verification Summary ===');
    appleTVLog.error(`Total pair records tried: ${failedAttempts.length}`);
    failedAttempts.forEach(({identifier, error}) => {
      appleTVLog.error(`  - ${identifier}: ${error}`);
    });
    appleTVLog.error('=======================================\n');
  }

  private resolveTunnelIdentifier(pairRecord: PairRecord, device: AppleTVDevice): string {
    if (pairRecord.remotePairingUdid) {
      return pairRecord.remotePairingUdid.toUpperCase();
    }

    if (process.platform === 'darwin' && device.identifierSource === 'devicectl' && device.identifier) {
      appleTVLog.warn('Pair record does not include remote_pairing_udid; falling back to devicectl identifier');
      return device.identifier.toUpperCase();
    }

    throw new Error('Pair record does not include remote_pairing_udid and no macOS devicectl fallback is available');
  }

  private withTunnelIdentifier(device: AppleTVDevice, pairRecord: PairRecord): AppleTVDevice {
    return {
      ...device,
      identifier: this.resolveTunnelIdentifier(pairRecord, device),
    };
  }

  private async performHandshake(): Promise<void> {
    const handshakePayload = {
      message: {
        plain: {
          _0: {
            request: {
              _0: {
                handshake: {
                  _0: {
                    hostOptions: {attemptPairVerify: true},
                    wireProtocolVersion: 19,
                  },
                },
              },
            },
          },
        },
      },
      originatedBy: 'host',
      sequenceNumber: this.sequenceNumber++,
    };

    await this.networkClient.sendPacket(handshakePayload);
    await this.networkClient.receiveResponse();

    appleTVLog.debug('Step 2: Initial Connection & Handshake success');
  }

  private async performPairVerification(pairRecord: PairRecord, deviceId: string): Promise<VerificationKeys> {
    appleTVLog.debug('Step 3: Pair Verification (4-step process)');

    const verificationProtocol = new PairVerificationProtocol(this.networkClient);
    verificationProtocol.setSequenceNumber(this.sequenceNumber);
    const keys = await verificationProtocol.verify(pairRecord, deviceId);

    this.sequenceNumber = verificationProtocol.getSequenceNumber();

    appleTVLog.debug('Step 4: Main Encryption Key Derivation success');

    return keys;
  }

  private async createTcpListener(
    keys: VerificationKeys,
  ): Promise<{port: number; serviceName: string; devicePublicKey: string}> {
    appleTVLog.debug('Step 5: TCP Listener Creation (Encrypted Request)');

    const tunnelService = new TunnelService(this.networkClient, keys, this.sequenceNumber);
    const listenerInfo = await tunnelService.createTcpListener();

    this.sequenceNumber = tunnelService.getSequenceNumber();

    return listenerInfo;
  }
}

function connectToListenerPort(hostname: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({host: hostname, port}, () => {
      resolve(socket);
    });
    socket.once('error', reject);
  });
}
