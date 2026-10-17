import {asDictionary, asNumber, asString} from '../../../lib/remote-xpc/xpc-value.js';
import type {XPCDictionary, XPCValue} from '../../../lib/types.js';
import {CoreDeviceError} from '../core-device/core-device-service.js';
import {FILE_NODE_RESOURCE_DIRECTORY, FILE_SERVICE_ERROR_RESPONSE, PERMISSION_BITS_MASK} from './constants.js';
import type {FileServiceEntry, FileServiceFileMetadata} from './types.js';

/**
 * Returns the reply unchanged, or throws the error it carries.
 *
 * A failed command replies with `Response: 3`, a human-readable `Error` and an
 * `EncodedError` dictionary holding the error domain and code.
 */
export function assertSuccessfulReply(command: string, reply: XPCDictionary): XPCDictionary {
  const encodedError = asDictionary(reply.EncodedError);
  if (!encodedError && reply.Error === undefined && reply.Response !== FILE_SERVICE_ERROR_RESPONSE) {
    return reply;
  }

  const description = asString(encodedError?.NSLocalizedDescription) ?? asString(reply.Error) ?? 'unknown error';
  const domain = asString(encodedError?.ErrorDomain) ?? 'unknown';
  const code = asNumber(encodedError?.ErrorCode);
  const codeSuffix = code === undefined ? '' : ` ${code}`;
  throw new CoreDeviceError(`File service '${command}' failed: ${description} [${domain}${codeSuffix}]`, reply);
}

/**
 * Converts a `ListDirectoryFileNodes` reply's `FileList` into entries.
 *
 * Each node carries its path relative to the listed directory in `url.relative`
 * (percent-encoded, with a trailing slash for directories), its `metadata`, and a
 * `resources` bit field. Listing a regular file yields the plain path string
 * instead of a node.
 */
export function parseFileNodes(fileList: XPCValue | undefined): FileServiceEntry[] {
  if (!Array.isArray(fileList)) {
    return [];
  }
  const entries: FileServiceEntry[] = [];
  for (const node of fileList) {
    if (typeof node === 'string') {
      entries.push({path: node, isDirectory: false});
      continue;
    }
    const entry = parseFileNode(asDictionary(node));
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Extracts the metadata of a file announced by a `RetrieveFile` reply.
 */
export function parseRetrievedFileMetadata(reply: XPCDictionary, size: number): FileServiceFileMetadata {
  return {
    size,
    permissions: (asNumber(reply.FilePermissions) ?? 0) & PERMISSION_BITS_MASK,
    ownerUid: asNumber(reply.FileOwnerUserID) ?? 0,
    ownerGid: asNumber(reply.FileOwnerGroupID) ?? 0,
    modifiedAt: new Date((asNumber(reply.FileLastModificationTime) ?? 0) * 1000),
  };
}

function parseFileNode(node: XPCDictionary | undefined): FileServiceEntry | undefined {
  const relativeUrl = asString(asDictionary(node?.url)?.relative);
  if (!node || !relativeUrl) {
    return undefined;
  }
  const resources = asNumber(node.resources) ?? 0;
  const isDirectory = relativeUrl.endsWith('/') || (resources & FILE_NODE_RESOURCE_DIRECTORY) !== 0;
  const entry: FileServiceEntry = {
    path: decodeRelativeUrl(relativeUrl.replace(/\/+$/, '')),
    isDirectory,
  };
  const metadata = asDictionary(node.metadata);
  if (metadata) {
    entry.metadata = {
      size: asNumber(metadata.size) ?? 0,
      permissions: (asNumber(metadata.permissions) ?? 0) & PERMISSION_BITS_MASK,
      ownerUid: asNumber(metadata.ownerUid) ?? 0,
      ownerGid: asNumber(metadata.ownerGid) ?? 0,
      modifiedAt: new Date((asNumber(metadata.lastModTime) ?? 0) * 1000),
    };
  }
  return entry;
}

function decodeRelativeUrl(value: string): string {
  // Keep a name that is not valid percent-encoding as the device sent it
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
