import type {FILE_SERVICE_DOMAIN} from './constants.js';

/** File service domain, named as `devicectl --domain-type` names it. */
export type FileServiceDomain = keyof typeof FILE_SERVICE_DOMAIN;

/** Identifies the device-side location that a file service session is rooted at. */
export interface FileServiceSessionOptions {
  /** Domain type of the session. */
  domain: FileServiceDomain;
  /**
   * Domain identifier: the bundle id for `appDataContainer`, the group id for
   * `appGroupDataContainer`. Leave unset for domains that take none.
   */
  identifier?: string;
  /** Device user that owns the domain. Defaults to `mobile`. */
  username?: string;
}

export interface FileServiceRequestOptions {
  /**
   * Maximum time without a message from the device on the control channel, and
   * the timeout for connecting the data channel.
   */
  timeoutMs?: number;
}

export interface FileServiceTransferOptions extends FileServiceRequestOptions {
  /**
   * Maximum time the data channel may stall while a file is transferred.
   * Defaults to 30 seconds.
   */
  idleTimeoutMs?: number;
}

export interface FileServiceListOptions extends FileServiceRequestOptions {
  /**
   * Whether to include everything below the listed directory instead of only
   * its direct children. Defaults to `false`. The device always walks the whole
   * tree, so a non-recursive listing is filtered on the host.
   */
  recursive?: boolean;
}

export interface FileServiceRemoveOptions extends FileServiceRequestOptions {
  /**
   * Whether to remove a directory together with everything below it. Without
   * it, only a file or an empty directory can be removed. Defaults to `false`.
   */
  recursive?: boolean;
}

export interface FileServicePushOptions extends FileServiceTransferOptions {
  /**
   * Size of the data in bytes. Required when the source is a stream, because
   * the device needs it before the transfer starts.
   */
  size?: number;
  /** POSIX permission bits of the new file. Defaults to those of a local source file, else `0o644`. */
  permissions?: number;
  /** Modification time of the new file. Defaults to that of a local source file, else the current time. */
  modifiedAt?: Date;
}

export interface FileServiceFileMetadata {
  /** Size in bytes. */
  size: number;
  /** POSIX permission bits (without the file type bits). */
  permissions: number;
  ownerUid: number;
  ownerGid: number;
  modifiedAt: Date;
}

export interface FileServiceEntry {
  /** Path relative to the listed directory, without a trailing slash. */
  path: string;
  isDirectory: boolean;
  /** Present for every entry of a directory listing. */
  metadata?: FileServiceFileMetadata;
}
