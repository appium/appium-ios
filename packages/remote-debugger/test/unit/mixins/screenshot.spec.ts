import assert from 'node:assert/strict';
import {describe, it, beforeEach} from 'node:test';

import sinon from 'sinon';

import {RemoteDebugger} from '../../../lib/remote-debugger.js';

describe('screenshot', function () {
  let rd: RemoteDebugger;
  let send: sinon.SinonStub;

  beforeEach(function () {
    rd = new RemoteDebugger({bundleId: 'com.apple.mobilesafari'});
    send = sinon.stub().resolves({dataURL: 'data:image/png;base64,iVBOR'});
    sinon.stub(rd, 'requireRpcClient').returns({send} as any);
  });

  it('should pass the rect through with the Viewport coordinate system by default', async function () {
    const rect = {x: 1, y: 2, width: 3, height: 4};
    assert.strictEqual(await rd.captureScreenshot({rect}), 'iVBOR');
    const [command, opts] = send.firstCall.args;
    assert.strictEqual(command, 'Page.snapshotRect');
    assert.deepStrictEqual(
      {...rect, coordinateSystem: 'Viewport'},
      {x: opts.x, y: opts.y, width: opts.width, height: opts.height, coordinateSystem: opts.coordinateSystem},
    );
  });

  it('should convert a viewport rect to page coordinates with captureBeyondViewport', async function () {
    sinon.stub(rd, 'executeAtom').resolves({x: 10, y: 500});
    await rd.captureScreenshot({rect: {x: 5, y: -500, width: 402, height: 2000}, captureBeyondViewport: true});
    const opts = send.firstCall.args[1];
    assert.strictEqual(opts.coordinateSystem, 'Page');
    assert.strictEqual(opts.x, 15);
    assert.strictEqual(opts.y, 0);
    assert.strictEqual(opts.width, 402);
    assert.strictEqual(opts.height, 2000);
  });
});
