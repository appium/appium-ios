export interface DiscoveredDeviceMetadata {
  identifier?: string;
  identifierSource?: 'bonjour' | 'devicectl';
  model?: string;
  version?: string;
  deviceType?: string;
  /** Raw TXT `identifier`; survives devicectl enrichment, which replaces `identifier`. */
  serviceIdentifier?: string;
  /** Base64 TXT `authTag`: SipHash-2-4(altIRK, serviceIdentifier). */
  authTag?: string;
}

export interface DiscoveredDevice {
  id: string;
  name: string;
  hostname?: string;
  ip?: string;
  port?: number;
  metadata: DiscoveredDeviceMetadata;
}

export interface DiscoveryOptions {
  serviceType: string;
  domain?: string;
}

export interface IDeviceDiscoveryBackend {
  discoverDevices(timeoutMs: number): Promise<DiscoveredDevice[]>;
}
