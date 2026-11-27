import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { envQuote, parseEnv, renderEnv, validatePanelSlug } from '../src/cli/env.js';
import { buildPayload, deploy, findPayloadDir, parseStatus } from '../src/cli/install.js';
import * as plan from '../src/cli/plan.js';
import type { ExecResult, Shell } from '../src/cli/ssh.js';
import { collectFiles, createTar, splitPath } from '../src/cli/tar.js';

const base = {
  panel: 'office',
  mqttHost: '192.0.2.10',
  mqttPort: 1883,
  mqttUsername: 'brilliant',
  mqttPassword: 'p@ss "quoted" \\ #hash $var',
  mqttTls: false,
  meshPriority: 1,
  scenes: true,
};

describe('agent env file', () => {
  it('quotes hostile passwords and round-trips them', () => {
    const text = renderEnv(base);
    expect(text).toContain('MQTT_PASSWORD="p@ss \\"quoted\\" \\\\ #hash $var"\n');
    expect(text).toContain('MESH_PRIORITY=1\n');
    expect(text).toContain('SCENE_BRIDGE_ENABLED=1\n');
    expect(parseEnv(text).MQTT_PASSWORD).toBe(base.mqttPassword);
    expect(parseEnv(text).BRILLIANT_PANEL).toBe('office');
  });

  it('refuses values that could inject another variable', () => {
    expect(() => envQuote('a\nMQTT_HOST=evil')).toThrow(/control characters/);
    expect(() => renderEnv({ ...base, extra: { MQTT_HOST: 'evil' } })).toThrow(/dedicated option/);
    expect(() => renderEnv({ ...base, extra: { 'bad key': 'x' } })).toThrow(/invalid environment/);
    expect(renderEnv({ ...base, extra: { HOT_POLL_SECONDS: '1' } })).toContain(
      'HOT_POLL_SECONDS="1"\n',
    );
  });

  it('validates panel slugs', () => {
    expect(validatePanelSlug('living-room_2')).toBe('living-room_2');
    expect(() => validatePanelSlug('Office')).toThrow();
    expect(() => validatePanelSlug('mesh')).toThrow(/reserved/);
  });
});

describe('tar writer', () => {
  it('produces an archive system tar extracts byte-for-byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brilliant-tar-'));
    const long = `${'deep/'.repeat(25)}${'n'.repeat(60)}.py`;
    const entries = [
      { path: 'app/a.py', data: Buffer.from('print("a")\n') },
      { path: 'empty', data: Buffer.alloc(0) },
      { path: long, data: Buffer.alloc(1500, 7) },
    ];
    writeFileSync(join(dir, 'x.tar'), createTar(entries));
    mkdirSync(join(dir, 'out'));
    execFileSync('tar', ['-xf', join(dir, 'x.tar'), '-C', join(dir, 'out')]);
    for (const entry of entries) {
      expect(readFileSync(join(dir, 'out', entry.path)).equals(entry.data)).toBe(true);
    }
  });

  it('rejects unsafe or unrepresentable paths', () => {
    expect(() => createTar([{ path: '../x', data: Buffer.alloc(0) }])).toThrow(/unsafe/);
    expect(() => createTar([{ path: '/etc/x', data: Buffer.alloc(0) }])).toThrow(/unsafe/);
    expect(() => splitPath('n'.repeat(101))).toThrow(/too long/);
  });
});

class FakeShell implements Shell {
  calls: { command: string; stdin?: Buffer | string }[] = [];
  constructor(private readonly respond: (command: string) => Partial<ExecResult> = () => ({})) {}
  exec(command: string, stdin?: Buffer | string): Promise<ExecResult> {
    this.calls.push({ command, stdin });
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...this.respond(command) });
  }
  close(): void {}
}

describe('installer', () => {
  const payloadDir = findPayloadDir();

  it('bundles the agent, vendored deps and unit; watchdogs only on request', () => {
    const plain = buildPayload(payloadDir, { busWatchdog: false, wifiWatchdog: false });
    const names = collectFiles(payloadDir, '').map((entry) => entry.path);
    expect(names.some((name) => name.endsWith('app/brilliant_mqtt/__main__.py'))).toBe(true);
    expect(plain.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(plain.tar.includes('brilliant_bus_watchdog')).toBe(false);
    expect(plain.tar.includes('aiomqtt/')).toBe(true);
    expect(plain.tar.includes('brilliant-mqtt.service')).toBe(true);
    const full = buildPayload(payloadDir, { busWatchdog: true, wifiWatchdog: true });
    expect(full.tar.includes('brilliant_bus_watchdog')).toBe(true);
    expect(full.tar.includes('brilliant-wifi-watchdog.service')).toBe(true);
  });

  it('deploys in order: preflight, env (0600), upload, activate', async () => {
    const shell = new FakeShell();
    const payload = buildPayload(payloadDir, { busWatchdog: false, wifiWatchdog: false });
    await deploy(shell, {
      payload,
      components: { busWatchdog: false, wifiWatchdog: false },
      env: renderEnv(base),
      log: () => undefined,
    });
    expect(shell.calls).toHaveLength(4);
    expect(shell.calls[0]?.command).toContain('/data/switch-embedded/env/bin/python3');
    expect(shell.calls[1]?.command).toContain("chmod 600 '/etc/brilliant-mqtt.env.new'");
    expect(shell.calls[1]?.command).toContain('umask 077');
    expect(String(shell.calls[1]?.stdin)).toContain('BRILLIANT_PANEL="office"');
    expect(shell.calls[2]?.command).toContain("tar -xf - -C '/var/brilliant-mqtt/.staging'");
    expect(shell.calls[2]?.stdin).toBe(payload.tar);
    const activate = shell.calls[3]?.command ?? '';
    expect(activate).toContain('systemctl restart brilliant-mqtt.service');
    expect(activate).toContain('rolling back');
    // Watchdogs can reboot a panel: never enabled unless asked for.
    expect(activate).not.toContain('enable --now brilliant-bus-watchdog.service');
    expect(activate).toContain('systemctl disable --now brilliant-bus-watchdog.service');
  });

  it('update keeps the existing env and refuses a panel that was never installed', async () => {
    const payload = buildPayload(payloadDir, { busWatchdog: true, wifiWatchdog: false });
    const components = { busWatchdog: true, wifiWatchdog: false };
    const existing = renderEnv(base);
    const shell = new FakeShell((command) =>
      command === plan.readEnv() ? { stdout: existing } : {},
    );
    await deploy(shell, { payload, components, log: () => undefined });
    expect(shell.calls[2]?.stdin).toBe(existing);
    expect(shell.calls.at(-1)?.command).toContain('enable --now brilliant-bus-watchdog.service');

    const fresh = new FakeShell();
    await expect(deploy(fresh, { payload, components, log: () => undefined })).rejects.toThrow(
      /run "install" first/,
    );
    expect(fresh.calls.some((call) => call.command.includes('tar -xf'))).toBe(false);
  });

  it('surfaces remote failures with stderr', async () => {
    const shell = new FakeShell(() => ({ code: 20, stderr: 'panel python not found\n' }));
    await expect(
      deploy(shell, {
        payload: buildPayload(payloadDir, { busWatchdog: false, wifiWatchdog: false }),
        components: { busWatchdog: false, wifiWatchdog: false },
        env: renderEnv(base),
        log: () => undefined,
      }),
    ).rejects.toThrow(/exit 20.*panel python not found/);
  });

  it('parses status output', () => {
    expect(
      parseStatus(
        'agent_version=0.11.4\npanel=office\nbrilliant-mqtt.service=active/enabled\nbrilliant-bus-watchdog.service=inactive/\n',
      ),
    ).toEqual({
      agentVersion: '0.11.4',
      panel: 'office',
      units: {
        'brilliant-mqtt.service': 'active/enabled',
        'brilliant-bus-watchdog.service': 'inactive/',
      },
    });
  });

  it('shell snippets are valid POSIX sh', () => {
    const scripts = [
      plan.preflight(),
      plan.receive('/var/brilliant-mqtt/.staging'),
      plan.writeFile('/etc/brilliant-mqtt.env', '600'),
      plan.activate('/var/brilliant-mqtt/.staging', { busWatchdog: true, wifiWatchdog: false }),
      plan.repair(),
      plan.status(),
      plan.logs(80),
      plan.readEnv(),
      plan.uninstall(),
    ];
    for (const script of scripts) {
      execFileSync('sh', ['-n'], { input: script });
    }
    expect(plan.sh("it's")).toBe(`'it'\\''s'`);
  });
});
