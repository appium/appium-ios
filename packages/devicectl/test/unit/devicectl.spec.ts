import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it, mock} from 'node:test';

import * as teenProcess from 'teen_process';

import type {Devicectl as DevicectlType} from '../../lib/devicectl.js';

let currentExec: (...args: any[]) => any = async () => ({stdout: '', stderr: ''});

// Must run before `Devicectl` is imported, so its `exec` import resolves to this mock.
mock.module('teen_process', {
  namedExports: {
    SubProcess: teenProcess.SubProcess,
    exec: (...args: any[]) => currentExec(...args),
  },
});

const {Devicectl} = await import('../../lib/devicectl.js');
const {appUrlToFilesystemPath, escapeProcessFilterValue, executablePathField} =
  await import('../../lib/mixins/process.js');

describe('Devicectl', function () {
  let devicectl: DevicectlType;

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
    afterEach(function () {
      currentExec = async () => ({stdout: '', stderr: ''});
    });

    it('should wrap a failed command with the attempted command and the original stderr', async function () {
      currentExec = async () => {
        const err: any = new Error('boom');
        err.stderr = 'ERROR: The device was not found.';
        throw err;
      };

      await assert.rejects(devicectl.execute(['list', 'devices'], {noDevice: true}), (err: any) => {
        assert.match(err.message, /xcrun.*devicectl.*list.*devices/);
        assert.match(err.message, /The device was not found/);
        assert.strictEqual(err.cause.stderr, 'ERROR: The device was not found.');
        return true;
      });
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

    describe('finding the app process', function () {
      const APP_URL = 'file:///private/var/containers/Bundle/Application/ABC/App.app/';
      const APP_PATH = '/private/var/containers/Bundle/Application/ABC/App.app';
      const PROCESSES = JSON.stringify({
        result: {runningProcesses: [{processIdentifier: 42, executable: `${APP_URL}App`}]},
      });

      function fakeDevicectl(jsonVersion: number, failures: {processes?: Error; jsonVersion?: Error} = {}) {
        const filters: string[] = [];
        const terminated: string[] = [];
        const calls = {filters, terminated, jsonVersionLookups: 0};
        mock.method(devicectl, 'execute', async (subcommand: string[], opts: {subcommandOptions: string[]}) => {
          switch (subcommand.join(' ')) {
            case 'list devices':
              calls.jsonVersionLookups++;
              // only the first lookup fails
              if (failures.jsonVersion && calls.jsonVersionLookups === 1) {
                throw failures.jsonVersion;
              }
              return {stdout: JSON.stringify({info: {jsonVersion}})};
            case 'device process terminate':
              calls.terminated.push(opts.subcommandOptions[1]);
              return {stdout: '{}'};
            default:
              calls.filters.push(opts.subcommandOptions[1]);
              if (failures.processes) {
                throw failures.processes;
              }
              return {stdout: PROCESSES};
          }
        });
        return calls;
      }

      beforeEach(function () {
        mock.method(devicectl, 'listApps', async () => [{url: APP_URL}]);
      });

      afterEach(function () {
        mock.restoreAll();
      });

      it('should filter on ExecutablePath, which Xcode 27 accepts', async function () {
        const {filters, terminated} = fakeDevicectl(5);

        assert.strictEqual(await devicectl.terminateApp('com.example.app'), true);
        assert.deepStrictEqual(filters, [`ExecutablePath BEGINSWITH "${APP_PATH}"`]);
        assert.deepStrictEqual(terminated, ['42']);
      });

      it('should filter on executable.path before JSON version 5', async function () {
        const {filters, terminated} = fakeDevicectl(4);

        assert.strictEqual(await devicectl.terminateApp('com.example.app'), true);
        assert.deepStrictEqual(filters, [`executable.path BEGINSWITH "${APP_PATH}"`]);
        assert.deepStrictEqual(terminated, ['42']);
      });

      it('should not retry when devicectl fails', async function () {
        const {filters} = fakeDevicectl(5, {
          processes: new Error(
            "'xcrun devicectl device info processes' failed. Original error: ERROR: The device was not found.",
          ),
        });

        await assert.rejects(devicectl.terminateApp('com.example.app'), /The device was not found/);
        assert.strictEqual(filters.length, 1);
      });

      it('should look up the JSON version only once', async function () {
        const calls = fakeDevicectl(5);

        await devicectl.terminateApp('com.example.app');
        await devicectl.terminateApp('com.example.app');
        assert.strictEqual(calls.jsonVersionLookups, 1);
        assert.strictEqual(calls.filters.length, 2);
      });

      it('should look up the JSON version again after a failed lookup', async function () {
        const calls = fakeDevicectl(5, {jsonVersion: new Error("'xcrun devicectl list devices' failed.")});

        await assert.rejects(devicectl.terminateApp('com.example.app'), /list devices' failed/);
        assert.strictEqual(await devicectl.terminateApp('com.example.app'), true);
        assert.strictEqual(calls.jsonVersionLookups, 2);
      });
    });

    describe('executablePathField', function () {
      it('should be ExecutablePath as of JSON version 5', function () {
        assert.strictEqual(executablePathField(5), 'ExecutablePath');
        assert.strictEqual(executablePathField(6), 'ExecutablePath');
      });

      it('should be executable.path before JSON version 5', function () {
        assert.strictEqual(executablePathField(4), 'executable.path');
      });
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
