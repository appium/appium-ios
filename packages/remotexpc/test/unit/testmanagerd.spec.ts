import assert from 'node:assert/strict';
import {type TestContext, beforeEach, describe, it} from 'node:test';

import {PlistUID, createBinaryPlist} from '../../src/lib/plist/index.js';
import {DTX_CONSTANTS, MessageAux} from '../../src/services/ios/dvt/dtx-message.js';
import {
  DvtTestmanagedProxyService,
  isExpectedCloseError,
  readPrimitiveDictEntry,
} from '../../src/services/ios/testmanagerd/index.js';
import {TestmanagerdEncoder} from '../../src/services/ios/testmanagerd/testmanagerd-encoder.js';
import {canonicalizeUuidString} from '../../src/services/ios/testmanagerd/uuid.js';
import {SELECTOR} from '../../src/services/ios/testmanagerd/xctest-common.js';
import {createNSUUID} from '../../src/services/ios/testmanagerd/xctestconfiguration.js';
import type {XCTestRunner} from '../../src/services/ios/testmanagerd/xcuitest.js';
import {mockImport} from '../helpers/mock-module.js';

/**
 * Testable subclass that exposes private methods for unit testing.
 */
class TestableDvtTestmanagedProxyService extends DvtTestmanagedProxyService {
  public testParseAuxiliaryData(buffer: Buffer): any[] {
    return (this as any).parseAuxiliaryData(buffer);
  }

  public testBuildAuxiliaryData(args: MessageAux): Buffer {
    return (this as any).buildAuxiliaryData(args);
  }

  public testParseAuxiliaryStandard(buffer: Buffer): any[] {
    return (this as any).parseAuxiliaryStandard(buffer);
  }

  public testParseAuxiliaryPrimitiveDictionary(buffer: Buffer): any[] {
    return (this as any).parseAuxiliaryPrimitiveDictionary(buffer);
  }
}

// #region Helpers

function buildStandardAuxBuffer(items: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeBigUInt64LE(BigInt(DTX_CONSTANTS.MESSAGE_AUX_MAGIC), 0);
  header.writeBigUInt64LE(BigInt(items.length), 8);
  return Buffer.concat([header, items]);
}

function buildStandardItem(type: number, value: Buffer): Buffer {
  const marker = Buffer.alloc(4);
  marker.writeUInt32LE(DTX_CONSTANTS.EMPTY_DICTIONARY, 0);
  const typeField = Buffer.alloc(4);
  typeField.writeUInt32LE(type, 0);
  return Buffer.concat([marker, typeField, value]);
}

function buildPrimitiveDictEntry(type: number, value: Buffer): Buffer {
  const key = Buffer.alloc(4);
  key.writeUInt32LE(DTX_CONSTANTS.EMPTY_DICTIONARY, 0);
  const typeField = Buffer.alloc(4);
  typeField.writeUInt32LE(type, 0);
  return Buffer.concat([key, typeField, value]);
}

const RUNNER_BUNDLE_ID = 'com.example.Runner.xctrunner';
const TARGET_BUNDLE_ID = 'com.example.App';
const RUNNER_OPTIONS = {
  udid: 'device-1',
  testRunnerBundleId: RUNNER_BUNDLE_ID,
  appUnderTestBundleId: TARGET_BUNDLE_ID,
  xctestBundleId: 'com.example.Runner',
};

type ExecCallback = [string, any[]] | null;

function createFakeTestmanagerd() {
  return {
    makeChannel: async () => ({getCode: () => 1}),
    sendMessage: async () => {},
    recvPlist: async () => [{}],
    close: async () => {},
  };
}

/**
 * Fake exec connection that delivers `callbacks` in order. A `null` entry, and every poll after the
 * list runs out, is a silent poll that advances the mocked clock by the poll timeout.
 */
function createFakeExecTestmanagerd(t: TestContext, callbacks: ExecCallback[]) {
  return {
    ...createFakeTestmanagerd(),
    sendReply: async () => {},
    lastMessageExpectsReply: () => false,
    recvPlistWithTimeout: async (_channel: number, timeoutMs: number) => {
      const callback = callbacks.shift();
      if (callback) {
        return callback;
      }
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(timeoutMs);
      return null;
    },
  };
}

async function importMockedXCTestRunner(
  t: TestContext,
  {
    execTestmanagerd = createFakeTestmanagerd(),
    launch,
  }: {
    execTestmanagerd?: object;
    launch: (options: Record<string, any>) => Promise<number>;
  },
): Promise<typeof XCTestRunner> {
  const {XCTestRunner: MockedRunner} = await mockImport<{XCTestRunner: typeof XCTestRunner}>(
    t,
    '../../src/services/ios/testmanagerd/xcuitest.js',
    import.meta.url,
    {
      '../../src/services.js': {
        startXCTestServices: async () => ({
          execTestmanagerd,
          controlTestmanagerd: createFakeTestmanagerd(),
          dvtService: {close: async () => {}},
          processControl: {launch, kill: async () => {}},
          installationProxy: {
            lookup: async () => ({
              [RUNNER_BUNDLE_ID]: {Path: '/private/var/containers/Bundle/Application/A/Runner-Runner.app'},
              [TARGET_BUNDLE_ID]: {Path: '/private/var/containers/Bundle/Application/B/App.app'},
            }),
            close: () => {},
          },
        }),
      },
    },
  );
  return MockedRunner;
}

function countActiveTimeouts(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

// #endregion

describe('canonicalizeUuidString', function () {
  it('should normalize dashed, brace, and undashed forms', function () {
    const expected = 'aabbccdd-1122-3344-5566-778899aabbcc';
    assert.strictEqual(canonicalizeUuidString('AABBCCDD-1122-3344-5566-778899AABBCC'), expected);
    assert.strictEqual(canonicalizeUuidString('{aabbccdd-1122-3344-5566-778899aabbcc}'), expected);
    assert.strictEqual(canonicalizeUuidString('aabbccdd112233445566778899aabbcc'), expected);
  });

  it('should reject invalid input', function () {
    assert.throws(() => canonicalizeUuidString(''));
    assert.throws(() => canonicalizeUuidString('not-a-uuid'));
    assert.throws(() => canonicalizeUuidString('11111111-1111-1111-1111-111'));
  });
});

describe('TestmanagerdEncoder', function () {
  let encoder: TestmanagerdEncoder;

  beforeEach(function () {
    encoder = new TestmanagerdEncoder();
  });

  it('should encode NSUUID with correct bytes and class', function () {
    const uuid = 'AABBCCDD-1122-3344-5566-778899AABBCC';
    const result = encoder.encode(createNSUUID(uuid));
    const objects = result.$objects;

    const nsUuidObj = objects.find((o: any) => o && typeof o === 'object' && 'NS.uuidbytes' in o);
    assert.ok(nsUuidObj['NS.uuidbytes'] instanceof Buffer);
    assert.strictEqual(nsUuidObj['NS.uuidbytes'].length, 16);
    assert.strictEqual(nsUuidObj['NS.uuidbytes'].equals(Buffer.from(uuid.replace(/-/g, ''), 'hex')), true);

    const classObj = objects.find((o: any) => o && typeof o === 'object' && o.$classname === 'NSUUID');
    assert.deepStrictEqual(classObj.$classes, ['NSUUID', 'NSObject']);
  });

  it('should encode NSSet of NSUUID for _IDE_deleteAttachmentsWithUUIDs payload', function () {
    const uuids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
    const result = encoder.encode(new Set(uuids.map((u) => createNSUUID(u))));
    const objects = result.$objects as any[];
    const rootIdx = result.$top.root.value;
    const setObj = objects[rootIdx];
    assert.strictEqual(setObj['NS.objects'].length, 2);
    const classDef = objects[setObj.$class.value];
    assert.strictEqual(classDef.$classname, 'NSSet');
    assert.deepStrictEqual(classDef.$classes, ['NSSet', 'NSObject']);

    const hexSorted = (buf: Buffer) => buf.toString('hex');
    const expectedHex = uuids.map((u) => hexSorted(Buffer.from(u.replace(/-/g, ''), 'hex'))).sort();
    const gotHex = setObj['NS.objects']
      .map((uid: PlistUID) => hexSorted(objects[uid.value]['NS.uuidbytes'] as Buffer))
      .sort();
    assert.deepStrictEqual(gotHex, expectedHex);
    for (const uid of setObj['NS.objects'] as PlistUID[]) {
      const uuidClass = objects[objects[uid.value].$class.value];
      assert.strictEqual(uuidClass.$classname, 'NSUUID');
    }
  });

  it('should encode XCTCapabilities with referenced dictionary', function () {
    const result = encoder.encode({
      __type: 'XCTCapabilities',
      capabilities: {cap1: 1, cap2: 2},
    });
    const objects = result.$objects;

    const capObj = objects.find((o: any) => o && typeof o === 'object' && 'capabilities-dictionary' in o);
    assert.notStrictEqual(capObj, undefined);
    assert.ok(capObj['capabilities-dictionary'] instanceof PlistUID);

    const dictObj = objects[capObj['capabilities-dictionary'].value];
    assert.strictEqual(dictObj['NS.keys'].length, 2);
  });

  it('should encode empty/missing capabilities without error', function () {
    const empty = encoder.encode({
      __type: 'XCTCapabilities',
      capabilities: {},
    });
    const missing = new TestmanagerdEncoder().encode({
      __type: 'XCTCapabilities',
    });

    for (const result of [empty, missing]) {
      const capObj = result.$objects.find((o: any) => o && typeof o === 'object' && 'capabilities-dictionary' in o);
      assert.notStrictEqual(capObj, undefined);
    }
  });
});

describe('isExpectedCloseError', function () {
  it('should return true for EPIPE and ECONNRESET codes', function () {
    assert.strictEqual(isExpectedCloseError(Object.assign(new Error(), {code: 'EPIPE'})), true);
    assert.strictEqual(isExpectedCloseError(Object.assign(new Error(), {code: 'ECONNRESET'})), true);
  });

  it('should return true for expected close messages', function () {
    for (const msg of [
      'write after end',
      'Write After FIN',
      'Socket closed during read',
      'This socket has been ended by the other party',
    ]) {
      assert.strictEqual(isExpectedCloseError(new Error(msg)), true);
    }
  });

  it('should return false for non-matching inputs', function () {
    assert.strictEqual(isExpectedCloseError(null), false);
    assert.strictEqual(isExpectedCloseError('string'), false);
    assert.strictEqual(isExpectedCloseError(Object.assign(new Error(), {code: 'ETIMEDOUT'})), false);
    assert.strictEqual(isExpectedCloseError(new Error('Something else')), false);
  });
});

describe('readPrimitiveDictEntry', function () {
  it('should parse null type', function () {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(DTX_CONSTANTS.PRIMITIVE_TYPE_NULL, 0);
    const result = readPrimitiveDictEntry(buf, 0);
    assert.strictEqual(result.data, null);
    assert.strictEqual(result.newOffset, 4);
  });

  it('should parse uint32 type', function () {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(DTX_CONSTANTS.PRIMITIVE_TYPE_UINT32, 0);
    buf.writeUInt32LE(42, 4);
    const result = readPrimitiveDictEntry(buf, 0);
    assert.strictEqual(result.data, 42);
    assert.strictEqual(result.newOffset, 8);
  });

  it('should parse string type', function () {
    const strBuf = Buffer.from('hello world', 'utf8');
    const buf = Buffer.alloc(4 + 4 + strBuf.length);
    buf.writeUInt32LE(DTX_CONSTANTS.PRIMITIVE_TYPE_STRING, 0);
    buf.writeUInt32LE(strBuf.length, 4);
    strBuf.copy(buf, 8);
    const result = readPrimitiveDictEntry(buf, 0);
    assert.strictEqual(result.data, 'hello world');
  });

  it('should throw for unknown type', function () {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(0xff, 0);
    assert.throws(
      () => readPrimitiveDictEntry(buf, 0),
      (err: any) => err.message.includes('Unknown PrimitiveDict type: 0xff'),
    );
  });
});

describe('DvtTestmanagedProxyService auxiliary helpers', function () {
  let service: TestableDvtTestmanagedProxyService;

  beforeEach(function () {
    service = new TestableDvtTestmanagedProxyService('test-udid');
  });

  describe('parseAuxiliaryData', function () {
    it('should route to standard parser when magic matches', function () {
      const val = Buffer.alloc(4);
      val.writeUInt32LE(7, 0);
      const item = buildStandardItem(DTX_CONSTANTS.AUX_TYPE_INT32, val);
      const result = service.testParseAuxiliaryData(buildStandardAuxBuffer(item));
      assert.deepStrictEqual(result, [7]);
    });

    it('should route to primitive dict parser for non-standard magic', function () {
      const fakeHeader = Buffer.alloc(16);
      fakeHeader.writeBigUInt64LE(BigInt(0xdeadbeef), 0);
      fakeHeader.writeBigUInt64LE(BigInt(100), 8);

      const entry = buildPrimitiveDictEntry(DTX_CONSTANTS.PRIMITIVE_TYPE_NULL, Buffer.alloc(0));
      const result = service.testParseAuxiliaryData(Buffer.concat([fakeHeader, entry]));
      assert.deepStrictEqual(result, [null]);
    });
  });

  describe('parseAuxiliaryStandard', function () {
    it('should parse multiple values of different types', function () {
      const int32Val = Buffer.alloc(4);
      int32Val.writeUInt32LE(1, 0);
      const item1 = buildStandardItem(DTX_CONSTANTS.AUX_TYPE_INT32, int32Val);

      const int64Val = Buffer.alloc(8);
      int64Val.writeBigUInt64LE(BigInt(2), 0);
      const item2 = buildStandardItem(DTX_CONSTANTS.AUX_TYPE_INT64, int64Val);

      const result = service.testParseAuxiliaryStandard(buildStandardAuxBuffer(Buffer.concat([item1, item2])));
      assert.deepStrictEqual(result, [1, BigInt(2)]);
    });

    it('should parse object values as binary plist', function () {
      const plistBuf = createBinaryPlist('hello');
      const lengthBuf = Buffer.alloc(4);
      lengthBuf.writeUInt32LE(plistBuf.length, 0);
      const item = buildStandardItem(DTX_CONSTANTS.AUX_TYPE_OBJECT, Buffer.concat([lengthBuf, plistBuf]));
      const result = service.testParseAuxiliaryStandard(buildStandardAuxBuffer(item));
      assert.deepStrictEqual(result, ['hello']);
    });
  });

  describe('parseAuxiliaryPrimitiveDictionary', function () {
    it('should parse multiple entries', function () {
      const nullEntry = buildPrimitiveDictEntry(DTX_CONSTANTS.PRIMITIVE_TYPE_NULL, Buffer.alloc(0));
      const uint32Val = Buffer.alloc(4);
      uint32Val.writeUInt32LE(77, 0);
      const uint32Entry = buildPrimitiveDictEntry(DTX_CONSTANTS.PRIMITIVE_TYPE_UINT32, uint32Val);
      const result = service.testParseAuxiliaryPrimitiveDictionary(Buffer.concat([nullEntry, uint32Entry]));
      assert.deepStrictEqual(result, [null, 77]);
    });

    it('should stop on unexpected key type', function () {
      const validEntry = buildPrimitiveDictEntry(DTX_CONSTANTS.PRIMITIVE_TYPE_NULL, Buffer.alloc(0));
      const badKey = Buffer.alloc(4);
      badKey.writeUInt32LE(0xff, 0);
      const result = service.testParseAuxiliaryPrimitiveDictionary(Buffer.concat([validEntry, badKey]));
      assert.deepStrictEqual(result, [null]);
    });
  });

  describe('buildAuxiliaryData round-trip', function () {
    it('should round-trip int32 and int64 values', function () {
      const args = new MessageAux();
      args.appendInt(99);
      args.appendLong(BigInt(123456789));
      args.appendInt(3);
      const built = service.testBuildAuxiliaryData(args);
      const parsed = service.testParseAuxiliaryStandard(built);
      assert.deepStrictEqual(parsed, [99, BigInt(123456789), 3]);
    });

    it('should round-trip object values as NSKeyedArchiver', function () {
      const args = new MessageAux();
      args.appendObj('hello');
      const built = service.testBuildAuxiliaryData(args);
      const parsed = service.testParseAuxiliaryStandard(built);
      assert.strictEqual(parsed.length, 1);
      assert.strictEqual(parsed[0].$archiver, 'NSKeyedArchiver');
    });
  });
});

describe('XCTestRunner', function () {
  it('should launch the test runner in the background', async function (t) {
    const launchCalls: Record<string, any>[] = [];
    const MockedRunner = await importMockedXCTestRunner(t, {
      launch: async (options) => {
        launchCalls.push(options);
        throw new Error('launch intercepted');
      },
    });

    const runner = new MockedRunner(RUNNER_OPTIONS);
    await assert.rejects(runner.run(), (err: any) => err.stage === 'launch_runner');

    assert.strictEqual(launchCalls.length, 1);
    assert.strictEqual(launchCalls[0].bundleId, RUNNER_BUNDLE_ID);
    assert.strictEqual(launchCalls[0].extraOptions?.ActivateSuspended, true);
  });

  it('should not fail a run whose exec channel is silent for over 60s within timeoutMs', async function (t) {
    t.mock.timers.enable({apis: ['setTimeout', 'Date']});
    const MockedRunner = await importMockedXCTestRunner(t, {
      execTestmanagerd: createFakeExecTestmanagerd(t, [
        [SELECTOR.testRunnerReady, []],
        ...Array<ExecCallback>(90).fill(null),
        [SELECTOR.testPlanFinished, []],
      ]),
      launch: async () => 1234,
    });

    const result = await new MockedRunner(RUNNER_OPTIONS).run();

    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.error, undefined);
  });

  it('should report timed_out when the exec channel stays silent past timeoutMs', async function (t) {
    t.mock.timers.enable({apis: ['setTimeout', 'Date']});
    const MockedRunner = await importMockedXCTestRunner(t, {
      execTestmanagerd: createFakeExecTestmanagerd(t, [[SELECTOR.testRunnerReady, []]]),
      launch: async () => 1234,
    });

    const result = await new MockedRunner(RUNNER_OPTIONS).run();

    assert.strictEqual(result.status, 'timed_out');
  });

  it('should not leave its timeout timer keeping the event loop alive after the run finishes', async function (t) {
    const MockedRunner = await importMockedXCTestRunner(t, {
      execTestmanagerd: createFakeExecTestmanagerd(t, [
        [SELECTOR.testRunnerReady, []],
        [SELECTOR.testPlanFinished, []],
      ]),
      launch: async () => 1234,
    });
    const activeTimeoutsBefore = countActiveTimeouts();

    const result = await new MockedRunner({...RUNNER_OPTIONS, timeoutMs: 5000}).run();

    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(countActiveTimeouts(), activeTimeoutsBefore);
  });
});
