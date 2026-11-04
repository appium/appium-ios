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
        await rd.setWebInspectorSettings(disableWebSecurity ? {pageSettings: {WebSecurityEnabled: false}} : {});
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
    it('replaces grouped settings, preferences and UA across new targets and restores defaults', async function () {
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
      const baselineUA = await rd.execute('navigator.userAgent');
      const userAgent = 'Appium-Grouped-Overrides/1.0';
      let sequence = 0;
      for (const enabled of [false, true]) {
        await rd.setWebInspectorSettings({
          pageSettings: {AuthorAndUserStylesEnabled: enabled, ImagesEnabled: enabled, ScriptEnabled: enabled},
          userPreferences: {PrefersReducedMotion: 'Reduce', PrefersContrast: 'More', PrefersColorScheme: 'Dark'},
          userAgent,
        });
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
          assert.strictEqual(await rd.execute('navigator.userAgent'), userAgent);
        }
      }
      // A replacement containing only UA must reset all omitted settings/preferences.
      await rd.setWebInspectorSettings({userAgent: 'Appium-Replacement/2.0'});
      await rd.navToUrl(`${fixture.address()}/page-overrides.html?n=${++sequence}`);
      assert.deepStrictEqual(await readPreferences(), baseline);
      assert.strictEqual(await rd.execute('navigator.userAgent'), 'Appium-Replacement/2.0');
      assert.deepStrictEqual(
        await rd.executeAtom('execute_script', [
          `return {
            width: getComputedStyle(document.getElementById('styled')).width,
            image: document.getElementById('image').naturalWidth,
            script: window.fixtureScriptRan,
          };`,
          [],
        ]),
        {width: '137px', image: 1, script: 'ran'},
      );
      await rd.setWebInspectorSettings({});
      await rd.navToUrl(`${fixture.address()}/page-overrides.html?n=${sequence + 1}`);
      assert.strictEqual(await rd.execute('navigator.userAgent'), baselineUA);
      assert.deepStrictEqual(await readPreferences(), baseline);
    });
  });
}
