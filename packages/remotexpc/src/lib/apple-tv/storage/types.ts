export interface PairRecord {
  publicKey: Buffer;
  privateKey: Buffer;
  remoteUnlockHostKey: string;
  remotePairingUdid?: string;
  altIRK?: Buffer;
}

export interface PairingStorageInterface {
  save(deviceId: string, record: PairRecord): Promise<string>;
  load(deviceId: string): Promise<PairRecord | null>;
  getAvailableDeviceIds(): Promise<string[]>;
}
