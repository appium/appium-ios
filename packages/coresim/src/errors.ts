/** Base error for every failure raised by the native CoreSimulator addon. */
export class NativeSimError extends Error {
  public override name = 'NativeSimError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * The class/selector a call needed doesn't exist on the currently loaded CoreSimulator.framework,
 * or a dynamic dispatch raised an NSException that got caught instead of crashing the process.
 * Distinct from {@link NativeSimOperationError}: this means "not supported on this simulator
 * runtime", not "the call ran and Apple's own code rejected it".
 */
export class NativeSimUnavailableError extends NativeSimError {
  public override name = 'NativeSimUnavailableError';

  /**
   * @param message — human-readable description
   * @param kind — `'class'` | `'selector'` | `'framework'`
   * @param missing — the missing class/selector/framework name
   * @param frameworkVersion — `CFBundleVersion` of the loaded CoreSimulator.framework
   */
  constructor(
    message: string,
    public readonly kind: string,
    public readonly missing: string,
    public readonly frameworkVersion: string,
  ) {
    super(message);
  }
}

/** A dynamic dispatch raised an NSException that was caught rather than crashing the process. */
export class NativeSimDispatchError extends NativeSimError {
  public override name = 'NativeSimDispatchError';

  /**
   * @param message — human-readable description
   * @param exceptionName — the caught `NSException`'s `name`
   * @param reason — the caught `NSException`'s `reason`
   */
  constructor(
    message: string,
    public readonly exceptionName: string,
    public readonly reason: string,
  ) {
    super(message);
  }
}

/** The call reached CoreSimulator and Apple's own code rejected it (a structured `NSError`). */
export class NativeSimOperationError extends NativeSimError {
  public override name = 'NativeSimOperationError';

  /**
   * @param message — `NSError.localizedDescription`
   * @param domain — `NSError.domain`
   * @param code — `NSError.code`
   */
  constructor(
    message: string,
    public readonly domain: string,
    public readonly code: number,
  ) {
    super(message);
  }
}

/** Re-throws a raw error surfaced by the native addon as the matching typed {@link NativeSimError}. */
export function wrapNativeError(err: unknown): never {
  if (err instanceof NativeSimError) {
    throw err;
  }
  const error = err as Error & Record<string, unknown>;
  const message = error?.message ?? String(err);
  switch (error?.name) {
    case 'NativeSimUnavailableError':
      throw new NativeSimUnavailableError(
        message,
        String(error.kind ?? ''),
        String(error.missing ?? ''),
        String(error.frameworkVersion ?? ''),
      );
    case 'NativeSimDispatchError':
      throw new NativeSimDispatchError(message, String(error.exceptionName ?? ''), String(error.reason ?? ''));
    case 'NativeSimOperationError':
      throw new NativeSimOperationError(message, String(error.domain ?? ''), Number(error.code ?? 0));
    default:
      throw new NativeSimError(message);
  }
}
