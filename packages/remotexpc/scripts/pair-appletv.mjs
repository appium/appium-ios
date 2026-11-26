#!/usr/bin/env node
/**
 * Pair Apple TV / tvOS devices over WiFi for Remote XPC tunnels.
 *
 * Usage:
 *   npm run pair-appletv -- [options]
 */

import {logger, util} from '@appium/support';
import {AppleTVPairingService, UserInputService} from 'appium-ios-remotexpc';

import {parseCliArgs} from './lib/cli.mjs';
import {DEFAULT_APPLETV_PAIRING_DISCOVERY_TIMEOUT_MS} from './lib/constants.mjs';
import {parsePositiveIntegerOption} from './lib/options.mjs';
import {startTimeoutProgressLogger} from './lib/progress.mjs';

const log = logger.getLogger('AppleTVPairing');
const APPLETV_PAIRING_DISCOVERY_PROGRESS_INTERVAL_MS = 1000;
const APPLETV_PAIRING_DISCOVERY_PROGRESS_BAR_WIDTH = 24;

/**
 * @param {import('appium-ios-remotexpc').AppleTVPairingService} pairingService
 * @param {number} timeoutMs
 * @returns {{ startedAt: number, promise: Promise<AppleTVDevice[]> }}
 */
function discoverAppleTVPairingDevices(pairingService, timeoutMs) {
  const startedAt = performance.now();
  const promise = pairingService.discoverDevices({timeoutMs});
  return {startedAt, promise};
}

/**
 *
 * @param {{ startedAt: number, promise: Promise<AppleTVDevice[]> }} discovery
 * @param {number} timeoutMs
 * @returns {Promise<AppleTVDevice[]>}
 */
async function waitForAppleTVPairingDiscovery(discovery, timeoutMs) {
  const progress = startTimeoutProgressLogger({
    log,
    label: 'Waiting for Apple TV pairing discovery',
    startedAt: discovery.startedAt,
    timeoutMs,
    barWidth: APPLETV_PAIRING_DISCOVERY_PROGRESS_BAR_WIDTH,
    intervalMs: APPLETV_PAIRING_DISCOVERY_PROGRESS_INTERVAL_MS,
  });

  try {
    const devices = await discovery.promise;
    progress.succeed(`Apple TV pairing discovery completed: ${util.pluralize('device', devices.length, true)} found`);
    return devices;
  } catch (err) {
    progress.fail('Apple TV pairing discovery failed');
    throw err;
  }
}

/**
 * @param {import('appium-ios-remotexpc').AppleTVPairingService} pairingService
 * @param {string} deviceSelector
 * @param {number} discoveryTimeoutMs
 * @returns {Promise<{ success: boolean, deviceId: string, pairingFile?: string, error?: Error | null }>}
 */
async function discoverAndPairWithProgress(pairingService, deviceSelector, discoveryTimeoutMs) {
  const discovery = discoverAppleTVPairingDevices(pairingService, discoveryTimeoutMs);
  const devices = await waitForAppleTVPairingDiscovery(discovery, discoveryTimeoutMs);
  return await pairingService.discoverAndPair(deviceSelector, {
    devices,
    discoveryTimeoutMs,
  });
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isNoAppleTVPairingDevicesFoundError(err) {
  return (
    err instanceof Error &&
    (err.message === getNoAppleTVPairingDevicesMessage() || ('code' in err && err.code === 'NO_DEVICES'))
  );
}

/**
 * @returns {string}
 */
function getNoAppleTVPairingDevicesMessage() {
  return 'No Apple TV pairing devices found. Please ensure your Apple TV is on the same network and in pairing mode.';
}

const USAGE = `Usage: pair-appletv [options]

Pair Apple TV / tvOS devices over WiFi for Remote XPC tunnels

Options:
  -d, --device <selector>    Device selector: name, identifier (e.g. AA:BB:CC:DD:EE:FF), or index (0, 1, …)
  --discovery-timeout <ms>   Apple TV pairing discovery timeout in milliseconds
  -h, --help                 Show this help`;

async function main() {
  const {values: options} = parseCliArgs(
    USAGE,
    {
      device: {type: 'string', short: 'd'},
      'discovery-timeout': {type: 'string'},
    },
    {converters: {'discovery-timeout': (value) => parsePositiveIntegerOption(value, 'discovery timeout')}},
  );
  const discoveryTimeoutMs = options.discoveryTimeout ?? DEFAULT_APPLETV_PAIRING_DISCOVERY_TIMEOUT_MS;

  const userInput = new UserInputService();
  const pairingService = new AppleTVPairingService(userInput);
  const result = await discoverAndPairWithProgress(pairingService, options.device, discoveryTimeoutMs);

  if (result.success) {
    log.info(`Pairing successful! Record saved to: ${result.pairingFile}`);
  } else if (isNoAppleTVPairingDevicesFoundError(result.error)) {
    log.info(getNoAppleTVPairingDevicesMessage());
  } else {
    throw result.error ?? new Error('Pairing failed');
  }
}

await main();

/**
 * @typedef {import('appium-ios-remotexpc').AppleTVDevice} AppleTVDevice
 */
