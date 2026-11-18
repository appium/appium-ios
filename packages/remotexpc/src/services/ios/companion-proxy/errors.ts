/**
 * Raised when companion_proxy rejects a command; `code` carries the daemon's raw `Error` string.
 */
export class CompanionProxyError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CompanionProxyError';
    this.code = code;
  }
}
