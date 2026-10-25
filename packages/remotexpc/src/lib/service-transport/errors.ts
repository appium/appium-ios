import {TunnelAvailabilityError} from '../tunnel/errors.js';

/**
 * The requested service cannot be reached over the requested transport (e.g. a DVT service over usbmux).
 * Extends {@link TunnelAvailabilityError} so callers that already report "start a tunnel" hints keep working.
 */
export class UnsupportedTransportError extends TunnelAvailabilityError {}
