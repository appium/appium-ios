import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {useRemoteDebuggerFixture} from './rd-fixture.js';

for (const fullPageInitialization of [false, true]) {
  describe(`Safari cross-origin frames (fullPageInitialization=${fullPageInitialization})`, function () {
    const fixture = useRemoteDebuggerFixture({fullPageInitialization});

    it('updates security in the same connection across reloads and cross-origin navigation', async function () {
      await fixture.selectTestPage();
      const rd = fixture.rd();
      for (const disableWebSecurity of [false, true, false, true]) {
        await rd.setDisableWebSecurity(disableWebSecurity);
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
      }
    });
    it('retains page settings and preferences on new targets and restores defaults', async function () {
      await fixture.selectTestPage();
      const rd = fixture.rd();
      const readPreferences = async () =>
        await rd.executeAtom('execute_script', [
          `return {
          motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          contrast: matchMedia('(prefers-contrast: more)').matches,
          dark: matchMedia('(prefers-color-scheme: dark)').matches,
        };`,
          [],
        ]);
      const baseline = await readPreferences();
      await rd.setUserPreference('PrefersReducedMotion', 'Reduce');
      await rd.setUserPreference('PrefersContrast', 'More');
      await rd.setUserPreference('PrefersColorScheme', 'Dark');
      let sequence = 0;
      for (const enabled of [false, true]) {
        await rd.setPageSetting('AuthorAndUserStylesEnabled', enabled);
        await rd.setPageSetting('ImagesEnabled', enabled);
        await rd.setPageSetting('ScriptEnabled', enabled);
        for (const origin of [fixture.address(), fixture.address().replace('127.0.0.1', 'localhost')]) {
          await rd.navToUrl(`${origin}/page-overrides.html?n=${++sequence}`);
          const state = await rd.executeAtom('execute_script', [
            `return {
              width: getComputedStyle(document.getElementById('styled')).width,
              image: document.getElementById('image').naturalWidth,
              script: window.fixtureScriptRan ?? null,
            };`,
            [],
          ]);
          assert.strictEqual(state.width === '137px', enabled);
          assert.strictEqual(state.image, enabled ? 1 : 0);
          assert.strictEqual(state.script, enabled ? 'ran' : null);
          assert.deepStrictEqual(await readPreferences(), {motion: true, contrast: true, dark: true});
        }
      }
      await rd.setPageSetting('AuthorAndUserStylesEnabled', undefined);
      await rd.setPageSetting('ImagesEnabled', undefined);
      await rd.setPageSetting('ScriptEnabled', undefined);
      await rd.setUserPreference('PrefersReducedMotion', undefined);
      await rd.setUserPreference('PrefersContrast', undefined);
      await rd.setUserPreference('PrefersColorScheme', undefined);
      assert.deepStrictEqual(await readPreferences(), baseline);
    });
  });
}
