import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';

import * as sinon from 'sinon';

import {
  TRANSPORT_ENV_VAR,
  TUNNEL_TRANSPORT,
  UnsupportedTransportError,
  UsbmuxServiceTransport,
  getDefaultTransportMode,
  resolveServiceTransport,
  resolveServiceTransportWithPort,
} from '../../../src/lib/service-transport/index.js';
import {TunnelAvailabilityError} from '../../../src/lib/tunnel/errors.js';

const UDID = 'test-udid';
const AFC = 'com.apple.afc.shim.remote';
const INSTPROXY = 'com.apple.mobile.installation_proxy.shim.remote';
const PASTEBOARD = 'com.apple.coredevice.pasteboardservice';

function makeResolvers(tunnelError?: Error) {
  const resolveTunnelService = sinon.stub();
  const resolveTunnelServicePorts = sinon.stub();
  if (tunnelError) {
    resolveTunnelService.rejects(tunnelError);
    resolveTunnelServicePorts.rejects(tunnelError);
  } else {
    resolveTunnelService.resolves({host: '::1', port: 1234, udid: UDID});
    resolveTunnelServicePorts.resolves({host: '::1', ports: {}, udid: UDID});
  }
  return {resolveTunnelService, resolveTunnelServicePorts};
}

describe('resolveServiceTransport', function () {
  const savedEnv = process.env[TRANSPORT_ENV_VAR];

  afterEach(function () {
    if (savedEnv === undefined) {
      delete process.env[TRANSPORT_ENV_VAR];
    } else {
      process.env[TRANSPORT_ENV_VAR] = savedEnv;
    }
  });

  describe('usbmux mode', function () {
    it('returns the usbmux transport without touching the tunnel registry', async function () {
      const resolvers = makeResolvers();
      const transport = await resolveServiceTransport(UDID, AFC, 'usbmux', resolvers);

      assert.ok(transport instanceof UsbmuxServiceTransport);
      assert.equal(resolvers.resolveTunnelService.callCount, 0);
      assert.equal(resolvers.resolveTunnelServicePorts.callCount, 0);
    });

    it('rejects tunnel-only services with UnsupportedTransportError', async function () {
      await assert.rejects(
        resolveServiceTransport(UDID, PASTEBOARD, 'usbmux', makeResolvers()),
        (err: Error) => err instanceof UnsupportedTransportError && err.message.includes(PASTEBOARD),
      );
    });
  });

  describe('tunnel mode', function () {
    it('returns the tunnel transport and the service port with the long registry wait', async function () {
      const resolvers = makeResolvers();
      const result = await resolveServiceTransportWithPort(UDID, AFC, 'tunnel', resolvers);

      assert.equal(result.transport, TUNNEL_TRANSPORT);
      assert.equal(result.tunnelPort, 1234);
      sinon.assert.calledOnceWithExactly(resolvers.resolveTunnelService, UDID, AFC, {waitMs: 15_000});
    });

    it('never falls back to usbmux', async function () {
      const err = new TunnelAvailabilityError('no tunnel');
      await assert.rejects(resolveServiceTransport(UDID, AFC, 'tunnel', makeResolvers(err)), (e) => e === err);
    });
  });

  describe('auto mode', function () {
    it('prefers the tunnel when it serves the service, with a short registry wait', async function () {
      const resolvers = makeResolvers();
      const transport = await resolveServiceTransport(UDID, AFC, 'auto', resolvers);

      assert.equal(transport, TUNNEL_TRANSPORT);
      sinon.assert.calledOnceWithExactly(resolvers.resolveTunnelService, UDID, AFC, {waitMs: 2000});
    });

    it('uses the batch lookup for several services', async function () {
      const resolvers = makeResolvers();
      await resolveServiceTransport(UDID, [AFC, INSTPROXY], 'auto', resolvers);

      sinon.assert.calledOnceWithExactly(resolvers.resolveTunnelServicePorts, UDID, [AFC, INSTPROXY], {
        waitMs: 2000,
      });
      assert.equal(resolvers.resolveTunnelService.callCount, 0);
    });

    it('falls back to usbmux when the tunnel is unavailable and the service supports it', async function () {
      const transport = await resolveServiceTransport(
        UDID,
        [AFC, INSTPROXY],
        'auto',
        makeResolvers(new TunnelAvailabilityError('no tunnel')),
      );

      assert.ok(transport instanceof UsbmuxServiceTransport);
      assert.equal(transport.udid, UDID);
    });

    it('rethrows the tunnel error when any service is tunnel-only', async function () {
      const err = new TunnelAvailabilityError('no tunnel');
      await assert.rejects(
        resolveServiceTransport(UDID, [AFC, PASTEBOARD], 'auto', makeResolvers(err)),
        (e) => e === err,
      );
    });

    it('does not mask unrelated errors with a usbmux fallback', async function () {
      const err = new Error('registry returned garbage');
      await assert.rejects(resolveServiceTransport(UDID, AFC, 'auto', makeResolvers(err)), (e) => e === err);
    });
  });

  describe('default mode', function () {
    it('is auto unless overridden by the environment', function () {
      delete process.env[TRANSPORT_ENV_VAR];
      assert.equal(getDefaultTransportMode(), 'auto');

      for (const mode of ['tunnel', 'usbmux', 'auto'] as const) {
        process.env[TRANSPORT_ENV_VAR] = ` ${mode.toUpperCase()} `;
        assert.equal(getDefaultTransportMode(), mode);
      }

      process.env[TRANSPORT_ENV_VAR] = 'bogus';
      assert.equal(getDefaultTransportMode(), 'auto');
    });

    it('is honoured by resolveServiceTransport', async function () {
      process.env[TRANSPORT_ENV_VAR] = 'usbmux';
      const resolvers = makeResolvers();

      assert.ok((await resolveServiceTransport(UDID, AFC, undefined, resolvers)) instanceof UsbmuxServiceTransport);
      assert.equal(resolvers.resolveTunnelService.callCount, 0);
    });
  });
});
