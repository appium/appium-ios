/**
 * RSD shim service name -> classic lockdown service name, for the services that can also be
 * started through lockdownd over usbmux (no tunnel). Services missing here are tunnel-only.
 */
export const LOCKDOWN_SERVICE_NAMES: Readonly<Record<string, string>> = {
  'com.apple.afc.shim.remote': 'com.apple.afc',
  'com.apple.mobile.house_arrest.shim.remote': 'com.apple.mobile.house_arrest',
  'com.apple.mobile.installation_proxy.shim.remote': 'com.apple.mobile.installation_proxy',
  'com.apple.mobile.notification_proxy.shim.remote': 'com.apple.mobile.notification_proxy',
  'com.apple.syslog_relay.shim.remote': 'com.apple.syslog_relay',
  'com.apple.streaming_zip_conduit.shim.remote': 'com.apple.streaming_zip_conduit',
  'com.apple.mobile.MCInstall.shim.remote': 'com.apple.mobile.MCInstall',
  'com.apple.mobile.diagnostics_relay.shim.remote': 'com.apple.mobile.diagnostics_relay',
  'com.apple.webinspector.shim.remote': 'com.apple.webinspector',
};

/** @returns The lockdown name for an RSD service name, or `undefined` if it is tunnel-only */
export function getLockdownServiceName(rsdServiceName: string): string | undefined {
  return LOCKDOWN_SERVICE_NAMES[rsdServiceName];
}
