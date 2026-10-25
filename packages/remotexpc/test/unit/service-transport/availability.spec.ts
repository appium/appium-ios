import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import * as sinon from 'sinon';

import {type AvailabilityProbes, getAvailableTransports} from '../../../src/lib/service-transport/availability.js';
import {TunnelAvailabilityError} from '../../../src/lib/tunnel/errors.js';

const UDID = 'test-udid';
const AFC = 'com.apple.afc.shim.remote';
const INSTPROXY = 'com.apple.mobile.installation_proxy.shim.remote';
const PASTEBOARD = 'com.apple.coredevice.pasteboardservice';

function makeProbes({tunnel = true, usbmux = true}: {tunnel?: boolean; usbmux?: boolean | Error} = {}) {
  const tunnelResult = async () => {
    if (!tunnel) {
      throw new TunnelAvailabilityError('no tunnel');
    }
    return {} as never;
  };
  return {
    getTunnelForDevice: sinon.stub().callsFake(tunnelResult),
    resolveTunnelService: sinon.stub().callsFake(tunnelResult),
    resolveTunnelServicePorts: sinon.stub().callsFake(tunnelResult),
    isDeviceReadyOverUsbmux: sinon.stub().callsFake(async () => {
      if (usbmux instanceof Error) {
        throw usbmux;
      }
      return usbmux;
    }),
  } satisfies Record<keyof AvailabilityProbes, sinon.SinonStub>;
}

describe('getAvailableTransports', function () {
  it('reports both transports when the tunnel is up and the device is paired', async function () {
    const probes = makeProbes();

    assert.deepEqual(await getAvailableTransports(UDID, AFC, {}, probes), {tunnel: true, usbmux: true});
    sinon.assert.calledOnceWithExactly(probes.resolveTunnelService, UDID, AFC, {waitMs: 2000});
  });

  it('checks only the device when no services are given', async function () {
    const probes = makeProbes();

    assert.deepEqual(await getAvailableTransports(UDID, [], {tunnelWaitMs: 500}, probes), {
      tunnel: true,
      usbmux: true,
    });
    sinon.assert.calledOnceWithExactly(probes.getTunnelForDevice, UDID, {waitMs: 500});
    assert.equal(probes.resolveTunnelService.callCount, 0);
  });

  it('uses the batch lookup for several services', async function () {
    const probes = makeProbes();
    await getAvailableTransports(UDID, [AFC, INSTPROXY], {}, probes);

    sinon.assert.calledOnceWithExactly(probes.resolveTunnelServicePorts, UDID, [AFC, INSTPROXY], {waitMs: 2000});
  });

  it('reports usbmux only when the tunnel is down', async function () {
    assert.deepEqual(await getAvailableTransports(UDID, AFC, {}, makeProbes({tunnel: false})), {
      tunnel: false,
      usbmux: true,
    });
  });

  it('reports the tunnel only for services that cannot be started over usbmux', async function () {
    const probes = makeProbes();

    assert.deepEqual(await getAvailableTransports(UDID, [AFC, PASTEBOARD], {}, probes), {
      tunnel: true,
      usbmux: false,
    });
    assert.equal(probes.isDeviceReadyOverUsbmux.callCount, 0);
  });

  it('reports usbmux as unavailable when the device is not connected or paired', async function () {
    assert.deepEqual(await getAvailableTransports(UDID, AFC, {}, makeProbes({usbmux: false})), {
      tunnel: true,
      usbmux: false,
    });
  });

  it('never throws, even if both probes fail', async function () {
    const result = await getAvailableTransports(
      UDID,
      AFC,
      {},
      makeProbes({tunnel: false, usbmux: new Error('usbmuxd is not running')}),
    );

    assert.deepEqual(result, {tunnel: false, usbmux: false});
  });
});
