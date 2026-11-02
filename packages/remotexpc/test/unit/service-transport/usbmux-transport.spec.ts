import assert from 'node:assert/strict';
import net from 'node:net';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {UnsupportedTransportError, UsbmuxServiceTransport} from '../../../src/lib/service-transport/index.js';
import {getLockdownServiceName} from '../../../src/lib/service-transport/lockdown-service-names.js';
import {UsbmuxServiceConnection} from '../../../src/lib/service-transport/usbmux.js';
import {BaseService} from '../../../src/services/ios/base-service.js';

describe('UsbmuxServiceTransport', function () {
  it('maps supported RSD shim names to lockdown names and leaves others tunnel-only', function () {
    const transport = new UsbmuxServiceTransport('udid');

    assert.equal(getLockdownServiceName('com.apple.afc.shim.remote'), 'com.apple.afc');
    assert.equal(
      getLockdownServiceName('com.apple.mobile.installation_proxy.shim.remote'),
      'com.apple.mobile.installation_proxy',
    );
    assert.equal(getLockdownServiceName('com.apple.webinspector.shim.remote'), 'com.apple.webinspector');
    assert.equal(transport.supports('com.apple.syslog_relay.shim.remote'), true);

    for (const tunnelOnly of [
      'com.apple.coredevice.pasteboardservice',
      'com.apple.instruments.dtservicehub',
      'com.apple.dt.testmanagerd.remote',
      'com.apple.crashreportcopymobile.shim.remote',
      'com.apple.os_trace_relay.shim.remote',
      'com.apple.springboardservices.shim.remote',
      'com.apple.misagent.shim.remote',
      'com.apple.mobile.mobile_image_mounter.shim.remote',
      'com.apple.companion_proxy.shim.remote',
      'com.apple.mobile.assertion_agent.shim.remote',
    ]) {
      assert.equal(transport.supports(tunnelOnly), false, tunnelOnly);
    }
  });

  it('rejects tunnel-only services before any device I/O', async function () {
    await assert.rejects(
      new UsbmuxServiceTransport('udid').openSocket('com.apple.coredevice.pasteboardservice'),
      UnsupportedTransportError,
    );
  });
});

describe('BaseService with the usbmux transport', function () {
  it('refuses services that need the raw RSD address or a check-in-less socket', async function () {
    const service = new BaseService('udid', {transport: new UsbmuxServiceTransport('udid')});

    await assert.rejects(
      service.startLockdownWithoutCheckin('com.apple.instruments.dtservicehub'),
      (err: Error) => err instanceof UnsupportedTransportError && err.message.includes('RemoteXPC tunnel'),
    );
  });
});

describe('UsbmuxServiceConnection', function () {
  let server: net.Server;
  let client: net.Socket;
  let serverSide: net.Socket;

  beforeEach(async function () {
    server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
    client = net.createConnection({host: '127.0.0.1', port: (server.address() as net.AddressInfo).port});
    serverSide = await accepted;
  });

  afterEach(function () {
    client.destroy();
    serverSide.destroy();
    server.close();
  });

  it('replays the RSD StartService greeting to a caller that reads before sending', async function () {
    const conn = new UsbmuxServiceConnection(client, 'com.apple.afc');

    assert.deepEqual(await conn.receive(100), {Request: 'StartService', Service: 'com.apple.afc'});
    // only once: the next read is real wire data, and there is none
    await assert.rejects(conn.receive(50));
  });

  it('does not replay the greeting once the caller has sent a request', async function () {
    const conn = new UsbmuxServiceConnection(client, 'com.apple.afc');

    conn.sendPlist({Request: 'Anything'});
    await assert.rejects(conn.receive(50));
  });
});
