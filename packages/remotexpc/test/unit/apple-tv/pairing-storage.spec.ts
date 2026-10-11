import assert from 'node:assert/strict';
import {type TestContext, describe, it} from 'node:test';

import {mockImport} from '../../helpers/mock-module.js';

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const PAIRING_CONFIG = {timeout: 1, discoveryTimeout: 1, maxRetries: 1};
const ALT_IRK = Buffer.from(Array.from({length: 16}, (_, i) => i));

async function loadStorageWithInMemoryBox(t: TestContext) {
  const items = new Map<string, string>();
  const container = '/tmp/appium-ios-remotexpc';
  const box = {
    container,
    listItems: async (): Promise<{name: string; id: string}[]> => [],
    createItemWithValue: async (name: string, value: string) => {
      items.set(name, value);
      return {name, id: `${container}/${name}`};
    },
  };
  const {PairingStorage} = await mockImport(
    t,
    '../../../src/lib/apple-tv/storage/pairing-storage.js',
    import.meta.url,
    {
      '@appium/strongbox': {
        strongbox: () => box,
        BaseItem: class {
          id: string;

          constructor(
            public readonly name: string,
            parent: {container: string},
          ) {
            this.id = `${parent.container}/${name}`;
          }

          async read(): Promise<string | undefined> {
            return items.get(this.name);
          }
        },
      },
    },
  );
  return {PairingStorage, items};
}

describe('PairingStorage', function () {
  it('discovers Apple TV pair records stored with slugified Strongbox filenames', async function (t) {
    const container = '/tmp/appium-ios-remotexpc';
    const box = {
      container,
      listItems: async () => [
        {
          name: 'appletv-pairing-device-1',
          id: `${container}/appletv-pairing-device-1`,
        },
        {
          name: 'appletv_pairing_device-2',
          id: `${container}/appletv-pairing-device-2`,
        },
        {
          name: 'pair-record-device-3',
          id: `${container}/pair-record-device-3`,
        },
      ],
    };

    const {PairingStorage} = await mockImport(
      t,
      '../../../src/lib/apple-tv/storage/pairing-storage.js',
      import.meta.url,
      {
        '@appium/strongbox': {
          strongbox: () => box,
          BaseItem: class {
            id: string;

            constructor(
              public readonly name: string,
              parent: {container: string},
            ) {
              this.id = `${parent.container}/${slugify(name)}`;
            }
          },
        },
      },
    );

    const storage = new PairingStorage({
      timeout: 1,
      discoveryTimeout: 1,
      maxRetries: 1,
    });

    assert.deepStrictEqual(await storage.getAvailableDeviceIds(), ['device-1', 'device-2']);
  });

  it('stores the device altIRK as peer_alt_irk and reads it back as a Buffer', async function (t) {
    const {PairingStorage, items} = await loadStorageWithInMemoryBox(t);
    const storage = new PairingStorage(PAIRING_CONFIG);

    await storage.save('device-1', Buffer.alloc(32, 1), Buffer.alloc(32, 2), '', 'udid-1', ALT_IRK);
    const record = await storage.load('device-1');

    assert.ok(items.get('appletv_pairing_device-1')?.includes('<key>peer_alt_irk</key>'));
    assert.deepStrictEqual(record?.altIRK, ALT_IRK);
    assert.strictEqual(record?.remotePairingUdid, 'UDID-1');
  });

  it('omits peer_alt_irk when pair-setup provided no altIRK', async function (t) {
    const {PairingStorage, items} = await loadStorageWithInMemoryBox(t);
    const storage = new PairingStorage(PAIRING_CONFIG);

    await storage.save('device-1', Buffer.alloc(32, 1), Buffer.alloc(32, 2), '', 'udid-1');
    const record = await storage.load('device-1');

    assert.strictEqual(items.get('appletv_pairing_device-1')?.includes('peer_alt_irk'), false);
    assert.strictEqual(record?.altIRK, undefined);
  });
});
