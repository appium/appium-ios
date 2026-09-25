/**
 * Numeric `Domain` values sent in `CreateSession`, keyed by the names `devicectl`
 * uses for `--domain-type`.
 */
export const FILE_SERVICE_DOMAIN = {
  appDataContainer: 1,
  appGroupDataContainer: 2,
  temporary: 3,
  systemCrashLogs: 5,
} as const;

/** Domains whose sessions need an identifier (a bundle id or an app group id). */
export const DOMAINS_REQUIRING_IDENTIFIER = ['appDataContainer', 'appGroupDataContainer'] as const;

/** `Cmd` values understood by `com.apple.coredevice.fileservice.control`. */
export const FILE_SERVICE_COMMAND = {
  CREATE_SESSION: 'CreateSession',
  END_SESSION: 'EndSession',
  LIST_DIRECTORY_FILE_NODES: 'ListDirectoryFileNodes',
  RETRIEVE_DIRECTORY_LIST: 'RetrieveDirectoryList',
  RETRIEVE_FILE: 'RetrieveFile',
  PROPOSE_FILE: 'ProposeFile',
  PROPOSE_EMPTY_FILE: 'ProposeEmptyFile',
  FILE_SYSTEM_OPERATION: 'FileSystemOperation',
} as const;

/**
 * `OperationType` values of a `FileSystemOperation` command. The device only
 * allows changes below `Library`, `Documents` and `tmp` of an app container.
 */
export const FILE_SYSTEM_OPERATION = {
  CREATE_DIRECTORY: 'CreateDirectory',
  REMOVE_DIRECTORY: 'RemoveDirectory',
  REMOVE_FILE: 'RemoveFile',
  RENAME: 'Rename',
} as const;

/**
 * Directories of an app data container that the device allows changes in. Its
 * `Rename` does not enforce this for the new path (seen on iOS 26), so the
 * client checks it.
 */
export const APP_CONTAINER_WRITABLE_DIRECTORIES = ['Library', 'Documents', 'tmp'] as const;

/** `Response` value of a control-channel reply that carries an error. */
export const FILE_SERVICE_ERROR_RESPONSE = 3;

export const DEFAULT_FILE_SERVICE_USERNAME = 'mobile';

/** How long closing the file service waits for the device to end the session. */
export const END_SESSION_TIMEOUT_MS = 5000;

/**
 * A transfer cut short makes the device hold up its next session, from any
 * client, for about 10 seconds. So when the destination of a pull fails, the
 * rest of the file is read and discarded if no more than this many bytes are left.
 */
export const MAX_DISCARDED_BYTES = 64 * 1024 * 1024;

/** POSIX permission bits of a file mode, without the file type bits. */
export const PERMISSION_BITS_MASK = 0o7777;

/** Permissions of a pushed file when neither the caller nor a local source file provides them. */
export const DEFAULT_PUSHED_FILE_PERMISSIONS = 0o644;

/** Bit of a file node's `resources` field that marks a directory. */
export const FILE_NODE_RESOURCE_DIRECTORY = 0x1;

/** Every data-channel message starts with this magic. */
export const DATA_CHANNEL_MAGIC = Buffer.from('rwb!FILE', 'ascii');

/**
 * Data-channel message header: the magic followed by four big-endian uint64
 * fields (message type, reserved, file id, payload size).
 */
export const DATA_CHANNEL_HEADER_SIZE = DATA_CHANNEL_MAGIC.length + 4 * 8;

/** Data-channel message types. */
export const DATA_CHANNEL_MESSAGE_TYPE = {
  /** Client header in front of the bytes of a file announced by `ProposeFile`. */
  FILE_UPLOAD: 0n,
  /** Client request for a file's bytes, and the device's header in front of them. */
  FILE_DATA: 1n,
  /** Confirmation that follows the last byte of a file, in either direction. */
  TRANSFER_COMPLETE: 0x63n,
} as const;
