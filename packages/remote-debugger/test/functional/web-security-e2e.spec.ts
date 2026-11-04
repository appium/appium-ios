import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {useRemoteDebuggerFixture} from './rd-fixture.js';

for (const disableWebSecurity of [false, true]) {
  describe(`Safari cross-origin frames (disableWebSecurity=${disableWebSecurity})`, function () {
    const fixture = useRemoteDebuggerFixture({disableWebSecurity});

    it('applies the security policy after same-origin and cross-origin navigation', async function () {
      await fixture.selectTestPage();
      const rd = fixture.rd();
      // WebKit assigns document security origins when loading, so the document
      // that was already loaded before attaching must first be reloaded.
      await rd.navToUrl(fixture.freshUrl());
      for (const navigate of [false, true]) {
        if (navigate) {
          // Changing the top-level origin exercises provisional target initialization.
          await rd.navToUrl(`${fixture.address().replace('127.0.0.1', 'localhost')}/?navigated`);
        }
        const frameUrl = navigate ? fixture.address() : fixture.address().replace('127.0.0.1', 'localhost');
        await rd.executeAtom(
          'execute_script',
          [
            `return new Promise((resolve) => {
            const frame = document.createElement('iframe');
            frame.name = 'cross-origin';
            frame.onload = () => resolve(true);
            frame.src = arguments[0];
            document.body.appendChild(frame);
          });`,
            [frameUrl],
          ],
          [],
          {timeoutMs: 10000},
        );

        const readFrame = async () => {
          const {WINDOW: frame} = await rd.executeAtom('frame_by_id_or_name', ['cross-origin']);
          return await rd.executeAtom(
            'execute_script',
            ["return document.getElementById('somediv').textContent;", []],
            [frame],
          );
        };
        if (disableWebSecurity) {
          assert.strictEqual(await readFrame(), 'This is in #somediv');
        } else {
          await assert.rejects(readFrame, /cross-origin|Blocked a frame/i);
        }
      }
    });
  });
}
