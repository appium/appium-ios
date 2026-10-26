import {SERVICE_NAMES} from './service-names.js';

/**
 * RSD shim service name -> classic lockdown service name, for the services that can also be
 * started through lockdownd over usbmux (no tunnel). Services missing here are tunnel-only.
 */
export const LOCKDOWN_SERVICE_NAMES: Readonly<Record<string, string>> = {
  [SERVICE_NAMES.afc]: 'com.apple.afc',
  [SERVICE_NAMES.houseArrest]: 'com.apple.mobile.house_arrest',
  [SERVICE_NAMES.installationProxy]: 'com.apple.mobile.installation_proxy',
  [SERVICE_NAMES.notificationProxy]: 'com.apple.mobile.notification_proxy',
  [SERVICE_NAMES.syslogText]: 'com.apple.syslog_relay',
  [SERVICE_NAMES.zipConduit]: 'com.apple.streaming_zip_conduit',
  [SERVICE_NAMES.mobileConfig]: 'com.apple.mobile.MCInstall',
  [SERVICE_NAMES.diagnostics]: 'com.apple.mobile.diagnostics_relay',
  [SERVICE_NAMES.webInspector]: 'com.apple.webinspector',
};

/** @returns The lockdown name for an RSD service name, or `undefined` if it is tunnel-only */
export function getLockdownServiceName(rsdServiceName: string): string | undefined {
  return LOCKDOWN_SERVICE_NAMES[rsdServiceName];
}
