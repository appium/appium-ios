import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {afterEach, describe, it} from 'node:test';

import {TunTap} from '../../src/index.js';
import {getPkgRoot} from '../../src/pkg-root.js';
import type {TunTapInterfaceStats} from '../../src/platform/types.js';
import {hasPrivileges} from '../utils.js';

const require = createRequire(import.meta.url);
const {TunDevice, getInterfaceStats} = require('node-gyp-build')(getPkgRoot()) as {
  TunDevice: new (name?: string) => {
    open(): boolean;
    close(): boolean;
    getStats(): TunTapInterfaceStats;
  };
  getInterfaceStats(name: string): TunTapInterfaceStats;
};

const STAT_KEYS: ReadonlyArray<keyof TunTapInterfaceStats> = [
  'rxBytes',
  'txBytes',
  'rxPackets',
  'txPackets',
  'rxErrors',
  'txErrors',
];

const hasRequiredPrivileges = await hasPrivileges();
const skipWithoutPrivileges = hasRequiredPrivileges
  ? false
  : process.platform === 'win32'
    ? 'Requires Administrator privileges on Windows'
    : 'Requires root privileges';

function hasTraffic(stats: TunTapInterfaceStats): boolean {
  return Object.values(stats).some((value) => value > 0);
}

function assertStatsWithinWindow(
  stats: TunTapInterfaceStats,
  before: TunTapInterfaceStats,
  after: TunTapInterfaceStats,
  toolName: string,
  interfaceName: string,
): void {
  for (const key of STAT_KEYS) {
    // On macOS, XNU's sysctl(NET_RT_IFLIST2) quantizes ifi_ibytes/ifi_obytes down
    // to 1024-byte (1 KiB) increments for processes without Apple's private entitlement,
    // whereas /usr/sbin/netstat holds that entitlement and reports unquantized byte counts.
    const isDarwinByteCounter = process.platform === 'darwin' && (key === 'rxBytes' || key === 'txBytes');
    const minExpected = isDarwinByteCounter ? Math.floor(before[key] / 1024) * 1024 : before[key];
    const maxExpected = after[key];
    assert.ok(
      stats[key] >= minExpected && stats[key] <= maxExpected,
      `expected ${interfaceName}.${key} (${stats[key]}) to be between ${toolName} before (${minExpected}) and after (${maxExpected})`,
    );
  }
}

function parseDarwinNetstat(output: string): TunTapInterfaceStats {
  const lines = output.trim().split('\n');
  const names = (lines[0] ?? '').trim().split(/\s+/);
  const values = (lines[1] ?? '').trim().split(/\s+/);
  const column = (name: string): number =>
    parseInt(values[values.length - (names.length - names.indexOf(name))] ?? '', 10) || 0;
  return {
    rxBytes: column('Ibytes'),
    txBytes: column('Obytes'),
    rxPackets: column('Ipkts'),
    txPackets: column('Opkts'),
    rxErrors: column('Ierrs'),
    txErrors: column('Oerrs'),
  };
}

function readDarwinOsStats(interfaceName: string): TunTapInterfaceStats {
  const output = execFileSync('netstat', ['-I', interfaceName, '-b'], {encoding: 'utf8'});
  return parseDarwinNetstat(output);
}

function listDarwinCandidates(): string[] {
  const all = execFileSync('ifconfig', ['-l'], {encoding: 'utf8'}).trim().split(/\s+/).filter(Boolean);
  const quietFirst = [
    ...all.filter((name) => /^utun\d+$/.test(name) || name === 'lo0'),
    ...all.filter((name) => !/^utun\d+$/.test(name) && name !== 'lo0'),
  ];
  return quietFirst.filter((name) => {
    try {
      return hasTraffic(readDarwinOsStats(name));
    } catch {
      return false;
    }
  });
}

function parseLinuxIpLink(output: string): TunTapInterfaceStats {
  const lines = output.trim().split('\n');
  const rxIndex = lines.findIndex((line) => line.includes('RX:'));
  const txIndex = lines.findIndex((line) => line.includes('TX:'));
  const rx = (lines[rxIndex + 1] ?? '').trim().split(/\s+/);
  const tx = (lines[txIndex + 1] ?? '').trim().split(/\s+/);
  return {
    rxBytes: parseInt(rx[0] ?? '', 10) || 0,
    rxPackets: parseInt(rx[1] ?? '', 10) || 0,
    rxErrors: parseInt(rx[2] ?? '', 10) || 0,
    txBytes: parseInt(tx[0] ?? '', 10) || 0,
    txPackets: parseInt(tx[1] ?? '', 10) || 0,
    txErrors: parseInt(tx[2] ?? '', 10) || 0,
  };
}

function readLinuxOsStats(interfaceName: string): TunTapInterfaceStats {
  const output = execFileSync('ip', ['-s', 'link', 'show', interfaceName], {encoding: 'utf8'});
  return parseLinuxIpLink(output);
}

function listLinuxCandidates(): string[] {
  const all = readdirSync('/sys/class/net').filter((name) => !/^appium-tun/i.test(name));
  const quietFirst = [...all.filter((name) => name === 'lo'), ...all.filter((name) => name !== 'lo')];
  return quietFirst.filter((name) => {
    try {
      return hasTraffic(readLinuxOsStats(name));
    } catch {
      return false;
    }
  });
}

const WINDOWS_STATS_FIELDS =
  'Name,ReceivedBytes,SentBytes,ReceivedUnicastPackets,ReceivedMulticastPackets,' +
  'ReceivedBroadcastPackets,SentUnicastPackets,SentMulticastPackets,SentBroadcastPackets,' +
  'ReceivedPacketErrors,OutboundPacketErrors';

function parseWindowsStatsRecord(parsed: Record<string, unknown>): TunTapInterfaceStats {
  const num = (key: string): number => {
    const value = parsed[key];
    const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    rxBytes: num('ReceivedBytes'),
    txBytes: num('SentBytes'),
    rxPackets: num('ReceivedUnicastPackets') + num('ReceivedMulticastPackets') + num('ReceivedBroadcastPackets'),
    txPackets: num('SentUnicastPackets') + num('SentMulticastPackets') + num('SentBroadcastPackets'),
    rxErrors: num('ReceivedPacketErrors'),
    txErrors: num('OutboundPacketErrors'),
  };
}

function readWindowsOsStats(interfaceName: string): TunTapInterfaceStats {
  const escaped = interfaceName.replace(/'/g, "''");
  const script = `Get-NetAdapterStatistics -Name '${escaped}' | Select-Object ${WINDOWS_STATS_FIELDS} | ConvertTo-Json -Compress`;
  const stdout = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {encoding: 'utf8'},
  );
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  return parseWindowsStatsRecord(parsed);
}

function listWindowsCandidates(): string[] {
  const script = `Get-NetAdapterStatistics | Select-Object ${WINDOWS_STATS_FIELDS} | ConvertTo-Json -Compress`;
  const stdout = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {encoding: 'utf8'},
  ).trim();
  if (!stdout) {
    return [];
  }
  const parsed = JSON.parse(stdout) as Record<string, unknown> | Array<Record<string, unknown>>;
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const entries = records
    .map((record) => ({
      name: typeof record.Name === 'string' ? record.Name.trim() : '',
      stats: parseWindowsStatsRecord(record),
    }))
    .filter((entry) => entry.name.length > 0 && !/^appium-tun/i.test(entry.name));
  const withTraffic = entries.filter((entry) => hasTraffic(entry.stats)).map((entry) => entry.name);
  return withTraffic.length > 0 ? withTraffic : entries.map((entry) => entry.name);
}

function getPlatformReader(): {
  listCandidates: () => string[];
  readOsStats: (name: string) => TunTapInterfaceStats;
  toolName: string;
} {
  switch (process.platform) {
    case 'darwin':
      return {listCandidates: listDarwinCandidates, readOsStats: readDarwinOsStats, toolName: 'netstat'};
    case 'linux':
      return {listCandidates: listLinuxCandidates, readOsStats: readLinuxOsStats, toolName: 'ip -s link'};
    case 'win32':
      return {
        listCandidates: listWindowsCandidates,
        readOsStats: readWindowsOsStats,
        toolName: 'Get-NetAdapterStatistics',
      };
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function buildTestIpv6Packet(): Buffer {
  const payloadLength = 1024;
  const packet = Buffer.alloc(40 + payloadLength);
  packet[0] = 0x60; // IPv6 version 6
  packet.writeUInt16BE(payloadLength, 4);
  packet[6] = 59; // Next Header: No Next Header (IPPROTO_NONE)
  packet[7] = 64; // Hop Limit
  // Source: fd00:127::1
  packet.writeUInt16BE(0xfd00, 8);
  packet.writeUInt16BE(0x0127, 10);
  packet.writeUInt16BE(1, 22);
  // Destination: fd00:127::2
  packet.writeUInt16BE(0xfd00, 24);
  packet.writeUInt16BE(0x0127, 26);
  packet.writeUInt16BE(2, 38);
  return packet;
}

describe('TunTap.getStats', {timeout: 30000}, () => {
  let tun: TunTap | null = null;

  afterEach(() => {
    if (tun && tun.isOpen && !tun.isClosed) {
      try {
        tun.close();
      } catch {}
    }
    tun = null;
  });

  it('rejects when the device is not open', async () => {
    const unopened = new TunTap('lo0');
    await assert.rejects(() => unopened.getStats(), /Device not open/);
    assert.throws(() => new TunDevice('lo0').getStats(), /Device not open/);
  });

  it('rejects invalid or nonexistent interface names in getInterfaceStats', () => {
    assert.throws(() => getInterfaceStats(''), /Interface name must not be empty/);
    assert.throws(() => getInterfaceStats('../../../proc/self/status'), /Invalid interface name|Interface not found/);
    assert.throws(() => getInterfaceStats('no_such_if0'), /Interface not found/);
  });

  it('throws a clear error when the native addon lacks getStats()', async () => {
    const fakeTun = new TunTap();
    Object.assign(fakeTun, {
      _isOpen: true,
      device: {},
    });
    await assert.rejects(() => fakeTun.getStats(), /Native addon is outdated and does not implement getStats\(\)/);
  });

  it('matches the OS tool counters on a real interface', (t) => {
    const {listCandidates, readOsStats, toolName} = getPlatformReader();
    const candidates = listCandidates();
    if (candidates.length === 0) {
      t.skip(`no network interface with traffic found via ${toolName}`);
      return;
    }

    let lastError: unknown;
    for (const interfaceName of candidates) {
      let before: TunTapInterfaceStats;
      let stats: TunTapInterfaceStats;
      let after: TunTapInterfaceStats;
      try {
        before = readOsStats(interfaceName);
        stats = getInterfaceStats(interfaceName);
        after = readOsStats(interfaceName);
      } catch (err) {
        lastError = err;
        continue;
      }
      assertStatsWithinWindow(stats, before, after, toolName, interfaceName);
      return;
    }

    throw lastError ?? new Error(`Failed to read stats from any candidate via ${toolName}`);
  });

  it('matches the OS tool counters on an open TunTap device', {skip: skipWithoutPrivileges}, async () => {
    const {readOsStats, toolName} = getPlatformReader();
    tun = new TunTap();
    tun.open();
    await tun.configure('fd00:127::2', 1500);
    tun.write(buildTestIpv6Packet());

    const deadline = Date.now() + 1000;
    while ((await tun.getStats()).rxPackets === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const before = readOsStats(tun.name);
    const stats = await tun.getStats();
    const after = readOsStats(tun.name);
    assert.ok(
      stats.rxPackets > 0 && (process.platform === 'darwin' || stats.rxBytes > 0),
      `expected non-zero rx counters on ${tun.name}, got ${JSON.stringify(stats)}`,
    );
    assertStatsWithinWindow(stats, before, after, toolName, tun.name);

    tun.close();
    await assert.rejects(() => tun!.getStats(), /Device has been closed/);
  });
});
