import {TunnelAvailabilityError} from '../tunnel/errors.js';

/**
 * The requested service cannot be reached over the requested transport (e.g. a DVT service over usbmux).
 * Extends {@link TunnelAvailabilityError} so callers that already report "start a tunnel" hints keep working.
 */
export class UnsupportedTransportError extends TunnelAvailabilityError {}

/** The device is not listed by usbmuxd or has no usable pair record, so lockdown services cannot be started. */
export class UsbmuxDeviceUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UsbmuxDeviceUnavailableError';
  }
}
