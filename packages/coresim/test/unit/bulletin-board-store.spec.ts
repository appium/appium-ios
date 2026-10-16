import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {fs, plist} from '@appium/support';

import {BulletinBoardStore} from '../../src/utils/index.js';

describe('BulletinBoardStore', () => {
  let dataPath: string;
  let store: BulletinBoardStore;

  const writeStore = async (version: number) => {
    await fs.mkdir(path.dirname(store.path), {recursive: true});
    await fs.writeFile(store.path, plist.createPlist({sectionInfoVersionNumber: version, sectionInfo: {}}, false));
  };
  const sections = async () => {
    const content = (await plist.parsePlistFile(store.path)) as {sectionInfo: Record<string, unknown>};
    return Object.keys(content.sectionInfo);
  };

  beforeEach(async () => {
    dataPath = await mkdtemp(path.join(tmpdir(), 'bulletin-board-'));
    store = new BulletinBoardStore(dataPath, [2, 3]);
  });

  afterEach(async () => {
    await rm(dataPath, {recursive: true, force: true});
  });

  it('refuses a store of an unsupported version and leaves it intact', async () => {
    await writeStore(4);
    const before = await readFile(store.path);

    await assert.rejects(store.setNotificationsStatus('com.example.app', 'granted'), /sectionInfoVersionNumber is 4/);

    assert.deepEqual(await readFile(store.path), before);
    assert.deepEqual(await readdir(path.dirname(store.path)), ['VersionedSectionInfo.plist']);
  });

  it('refuses a store of a version outside the given models', async () => {
    await writeStore(3);
    const v2Only = new BulletinBoardStore(dataPath, [2]);

    await assert.rejects(v2Only.setNotificationsStatus('com.example.app', 'granted'), /is 3, supported: 2$/);
  });

  it('creates a missing store in the format of the first model', async () => {
    await new BulletinBoardStore(dataPath, [3]).setNotificationsStatus('com.example.app', 'granted');

    const content = (await plist.parsePlistFile(store.path)) as {sectionInfoVersionNumber: number};
    assert.equal(content.sectionInfoVersionNumber, 3);
  });

  it('rejects an unknown version', () => {
    assert.throws(() => new BulletinBoardStore(dataPath, [2, 9]), /Unknown BulletinBoard store version 9/);
  });

  it('refuses a store without a version', async () => {
    await fs.mkdir(path.dirname(store.path), {recursive: true});
    await fs.writeFile(store.path, plist.createPlist({sectionInfo: {}}, false));

    await assert.rejects(
      store.setNotificationsStatus('com.example.app', 'unset'),
      /sectionInfoVersionNumber is undefined/,
    );
  });

  it('still updates a supported store after a rejected update', async () => {
    await writeStore(4);
    await assert.rejects(store.withLock(() => store.setNotificationsStatus('com.example.app', 'granted')));

    await writeStore(2);
    assert.equal(await store.withLock(() => store.setNotificationsStatus('com.example.app', 'granted')), true);

    assert.deepEqual(await sections(), ['com.example.app']);
  });

  for (const version of [2, 3]) {
    it(`keeps the version ${version} of an existing store and its format`, async () => {
      await writeStore(version);

      await store.setNotificationsStatus('com.example.app', 'critical');

      const content = (await plist.parsePlistFile(store.path)) as {
        sectionInfoVersionNumber: number;
        sectionInfo: Record<string, Buffer>;
      };
      assert.equal(content.sectionInfoVersionNumber, version);
      const archive = (await plist.parsePlist(content.sectionInfo['com.example.app'])) as {
        $objects: Record<string, unknown>[];
      };
      assert.equal('isLocked' in archive.$objects[1], version === 3);
    });
  }

  it('creates a missing store with the app section only', async () => {
    assert.equal(await store.setNotificationsStatus('com.example.app', 'denied'), true);

    assert.deepEqual(await sections(), ['com.example.app']);
    const content = (await plist.parsePlistFile(store.path)) as {sectionInfoVersionNumber: number};
    assert.equal(content.sectionInfoVersionNumber, 2);
  });

  it('writes nothing when unsetting in a missing store', async () => {
    assert.equal(await store.setNotificationsStatus('com.example.app', 'unset'), false);

    assert.equal(await fs.exists(store.path), false);
  });
});
