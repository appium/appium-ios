/** Base error for every failure raised by this package. */
export class MediaProxyError extends Error {
  public override name = 'MediaProxyError';
}

/** The native addon can't be used here (unsupported platform/arch or no matching prebuild). */
export class MediaProxyUnavailableError extends MediaProxyError {
  public override name = 'MediaProxyUnavailableError';

  constructor(
    message: string,
    public readonly platform: string,
    public readonly arch: string,
  ) {
    super(message);
  }
}

/** No encoder satisfying the request is available (e.g. H.264 with no HW encoder or OpenH264). */
export class MediaProxyEncoderUnavailableError extends MediaProxyError {
  public override name = 'MediaProxyEncoderUnavailableError';
}

/** An option failed validation. */
export class MediaProxyOptionError extends MediaProxyError {
  public override name = 'MediaProxyOptionError';
}

/** The OpenH264 runtime download was refused, failed, or didn't match its pinned checksum. */
export class OpenH264DownloadError extends MediaProxyError {
  public override name = 'OpenH264DownloadError';
}

/** The stream or a framed payload was malformed (e.g. APST desynchronization). */
export class MediaProxyProtocolError extends MediaProxyError {
  public override name = 'MediaProxyProtocolError';
}

/** Re-types an error thrown by the native addon by its `name`; others pass through. */
export function wrapNativeError(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  switch (e.name) {
    case 'MediaProxyEncoderUnavailableError':
      return new MediaProxyEncoderUnavailableError(e.message);
    case 'MediaProxyOptionError':
      return new MediaProxyOptionError(e.message);
    default:
      return e instanceof MediaProxyError ? e : new MediaProxyError(e.message, {cause: e});
  }
}
