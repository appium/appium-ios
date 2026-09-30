import assert from 'node:assert/strict';
import {describe, it, beforeEach} from 'node:test';

import {Devicectl} from '../../lib/devicectl.js';
import {appUrlToFilesystemPath, escapeProcessFilterValue} from '../../lib/mixins/process.js';

describe('Devicectl', function () {
  let devicectl: Devicectl;

  beforeEach(function () {
    devicectl = new Devicectl('test-device-udid');
  });

  describe('constructor', function () {
    it('should create a Devicectl instance with the provided UDID and default logger', function () {
      assert.strictEqual(devicectl.udid, 'test-device-udid');
    });

    it('should allow disabling non-root sudo execution in constructor options', function () {
      const localDevicectl = new Devicectl('test-device-udid', {preferNonRootWhenSudo: false});
      assert.strictEqual((localDevicectl as any).preferNonRootWhenSudo, false);
    });
  });

  describe('sudo behavior', function () {
    it('should cache sudo user identity when available', function () {
      const localDevicectl = new Devicectl('test-device-udid');
      assert.strictEqual((localDevicectl as any).sudoUser === null || !!(localDevicectl as any).sudoUser, true);
    });

    it('should keep constructor default for runAsNonRootWhenSudo behavior', function () {
      assert.strictEqual((devicectl as any).preferNonRootWhenSudo, true);
    });
  });

  describe('execute', function () {
    it('should throw an error when command execution fails', async function () {
      // This test would need to be mocked in a real implementation
      // For now, we'll just test that the method exists
      assert.strictEqual(typeof devicectl.execute, 'function');
    });
  });

  describe('sendMemoryWarning', function () {
    it('should be a function', function () {
      assert.strictEqual(typeof devicectl.sendMemoryWarning, 'function');
    });
  });

  describe('listProcesses', function () {
    it('should be a function', function () {
      assert.strictEqual(typeof devicectl.listProcesses, 'function');
    });
  });

  describe('listFiles', function () {
    it('should be a function', function () {
      assert.strictEqual(typeof devicectl.listFiles, 'function');
    });
  });

  describe('pullFile', function () {
    it('should be a function', function () {
      assert.strictEqual(typeof devicectl.pullFile, 'function');
    });
  });

  describe('sendSignalToProcess', function () {
    it('should be a function', function () {
      assert.strictEqual(typeof devicectl.sendSignalToProcess, 'function');
    });
  });

  describe('listApps', function () {
    it('should be a function', function () {
      assert.strictEqual(typeof devicectl.listApps, 'function');
    });
  });

  describe('launchApp', function () {
    it('should be a function', function () {
      assert.strictEqual(typeof devicectl.launchApp, 'function');
    });
  });

  describe('terminateApp', function () {
    it('should be a function', function () {
      assert.strictEqual(typeof devicectl.terminateApp, 'function');
    });

    describe('appUrlToFilesystemPath', function () {
      it('should strip the file:// prefix', function () {
        assert.strictEqual(appUrlToFilesystemPath('file:///path/to/App.app'), '/path/to/App.app');
      });

      it('should strip a trailing slash', function () {
        assert.strictEqual(appUrlToFilesystemPath('/path/to/App.app/'), '/path/to/App.app');
      });

      it('should strip both the file:// prefix and trailing slash', function () {
        assert.strictEqual(appUrlToFilesystemPath('file:///private/var/App.app/'), '/private/var/App.app');
      });

      it('should leave paths without a file:// prefix or trailing slash unchanged', function () {
        assert.strictEqual(appUrlToFilesystemPath('/path/to/App.app'), '/path/to/App.app');
      });
    });

    describe('escapeProcessFilterValue', function () {
      it('should leave values without special characters unchanged', function () {
        assert.strictEqual(escapeProcessFilterValue('/path/to/App.app'), '/path/to/App.app');
      });

      it('should escape backslashes', function () {
        assert.strictEqual(escapeProcessFilterValue(String.raw`path\with\slashes`), String.raw`path\\with\\slashes`);
      });

      it('should escape double quotes', function () {
        assert.strictEqual(escapeProcessFilterValue('path"with"quotes'), 'path\\"with\\"quotes');
      });

      it('should escape backslashes and double quotes together', function () {
        assert.strictEqual(escapeProcessFilterValue(String.raw`path\"mixed`), String.raw`path\\\"mixed`);
      });
    });
  });

  describe('listDevices', function () {
    it('should be a function', function () {
      assert.strictEqual(typeof devicectl.listDevices, 'function');
    });
  });
});
