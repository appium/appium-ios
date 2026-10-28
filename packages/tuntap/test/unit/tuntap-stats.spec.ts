import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {describe, it} from 'node:test';

import {TunTap} from '../../src/index.js';
import {getPkgRoot} from '../../src/pkg-root.js';
import type {TunTapInterfaceStats} from '../../src/platform/types.js';

const require = createRequire(import.meta.url);
const {TunDevice} = require('node-gyp-build')(getPkgRoot()) as {
  TunDevice: new (name?: string) => {getStats(): TunTapInterfaceStats};
};

function readNativeStats(interfaceName: string): TunTapInterfaceStats {
  return new TunDevice(interfaceName).getStats();
}

function hasTraffic(stats: TunTapInterfaceStats): boolean {
  return Object.values(stats).some((value) => value > 0);
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
  const all = readdirSync('/sys/class/net');
  const quietFirst = [...all.filter((name) => name === 'lo'), ...all.filter((name) => name !== 'lo')];
  return quietFirst.filter((name) => {
    try {
      return hasTraffic(readLinuxOsStats(name));
    } catch {
      return false;
    }
  });
}

function readWindowsOsStats(interfaceName: string): TunTapInterfaceStats {
  const escaped = interfaceName.replace(/'/g, "''");
  const script =
    `Get-NetAdapterStatistics -Name '${escaped}' | ` +
    'Select-Object ReceivedBytes,SentBytes,ReceivedUnicastPackets,ReceivedMulticastPackets,' +
    'ReceivedBroadcastPackets,SentUnicastPackets,SentMulticastPackets,SentBroadcastPackets,' +
    'ReceivedPacketErrors,OutboundPacketErrors | ConvertTo-Json -Compress';
  const stdout = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {encoding: 'utf8'},
  );
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
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

function listWindowsCandidates(): string[] {
  const script = 'Get-NetAdapterStatistics | Select-Object -ExpandProperty Name';
  const stdout = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {encoding: 'utf8'},
  );
  const names = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const withTraffic = names.filter((name) => {
    try {
      return hasTraffic(readWindowsOsStats(name));
    } catch {
      return false;
    }
  });
  return withTraffic.length > 0 ? withTraffic : names;
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

describe('TunTap.getStats', {timeout: 30000}, () => {
  it('rejects when the device is not open', async () => {
    const tun = new TunTap();
    await assert.rejects(() => tun.getStats(), /Device not open/);
  });

  it('matches the OS tool counters on a real interface', (t) => {
    const {listCandidates, readOsStats, toolName} = getPlatformReader();
    const candidates = listCandidates();
    if (candidates.length === 0) {
      t.skip(`no network interface with traffic found via ${toolName}`);
      return;
    }

    for (const interfaceName of candidates) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const before = readOsStats(interfaceName);
        const stats = readNativeStats(interfaceName);
        const after = readOsStats(interfaceName);
        if (JSON.stringify(before) === JSON.stringify(after)) {
          assert.deepStrictEqual(stats, before, `mismatch against ${toolName} on ${interfaceName}`);
          return;
        }
      }
    }

    t.skip(`counters changed during every read attempt across: ${candidates.join(', ')}`);
  });
});
