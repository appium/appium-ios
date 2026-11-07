/**
 * RSD service names of the services that can be reached over either the tunnel or usbmux.
 * Pass them to `getAvailableTransports()` to check what can serve a service.
 */
export const SERVICE_NAMES = Object.freeze({
  afc: 'com.apple.afc.shim.remote',
  houseArrest: 'com.apple.mobile.house_arrest.shim.remote',
  installationProxy: 'com.apple.mobile.installation_proxy.shim.remote',
  notificationProxy: 'com.apple.mobile.notification_proxy.shim.remote',
  syslogText: 'com.apple.syslog_relay.shim.remote',
  zipConduit: 'com.apple.streaming_zip_conduit.shim.remote',
  mobileConfig: 'com.apple.mobile.MCInstall.shim.remote',
  diagnostics: 'com.apple.mobile.diagnostics_relay.shim.remote',
  webInspector: 'com.apple.webinspector.shim.remote',
} as const);
