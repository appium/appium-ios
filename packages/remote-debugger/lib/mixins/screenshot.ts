import type {Rect} from '@appium/types';

import type {RemoteDebugger} from '../remote-debugger.js';
import {getAppIdKey, getPageIdKey} from './property-accessors.js';

/**
 * Options for capturing a screenshot.
 */
export interface ScreenshotCaptureOptions {
  /** The rectangle to capture. If null, captures the whole viewport. */
  rect?: Rect | null;
  /** The coordinate system to use for the rectangle. */
  coordinateSystem?: 'Viewport' | 'Page';
  /**
   * Treat `rect` as viewport-relative but capture it in the 'Page' coordinate system,
   * so parts outside the viewport are rendered too (instead of transparent pixels).
   * Takes precedence over `coordinateSystem`; requires `rect`.
   */
  captureBeyondViewport?: boolean;
}

/**
 * Captures a screenshot of a rectangular area of the page or the entire viewport.
 * If no rectangle is provided, captures the full viewport by default.
 *
 * @param opts - Screenshot capture options. If not provided, captures the entire viewport.
 *               - rect: The rectangle to capture. If null, captures the whole viewport.
 *               - coordinateSystem: The coordinate system to use ('Viewport' or 'Page').
 *                                  Defaults to 'Viewport'.
 *               - captureBeyondViewport: Interpret `rect` as viewport-relative, but also capture
 *                                  its parts that are outside the viewport.
 * @returns A promise that resolves to a base64-encoded string of the screenshot
 *          (without the data URL prefix).
 */
export async function captureScreenshot(this: RemoteDebugger, opts: ScreenshotCaptureOptions = {}): Promise<string> {
  const {rect = null, captureBeyondViewport = false} = opts;
  let {coordinateSystem = 'Viewport'} = opts;
  this.log.debug('Capturing screenshot');

  let arect =
    rect ??
    (await this.executeAtom<Rect>('execute_script', [
      'return {x: 0, y: 0, width: window.innerWidth, height: window.innerHeight}',
      [],
    ]));
  if (rect && captureBeyondViewport) {
    // 'Page' expects document coordinates, so shift the viewport-relative rect by the scroll offset
    const {x: scrollX, y: scrollY} = await this.executeAtom<{x: number; y: number}>('execute_script', [
      'return {x: window.pageXOffset, y: window.pageYOffset}',
      [],
    ]);
    arect = {...rect, x: rect.x + scrollX, y: rect.y + scrollY};
    coordinateSystem = 'Page';
  }
  const response = await this.requireRpcClient().send('Page.snapshotRect', {
    ...arect,
    appIdKey: getAppIdKey(this),
    pageIdKey: getPageIdKey(this),
    coordinateSystem,
  });

  if (response.error) {
    throw new Error(response.error);
  }

  return response.dataURL.replace(/^data:image\/png;base64,/, '');
}
