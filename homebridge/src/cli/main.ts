#!/usr/bin/env node
/**
 * brilliant-homebridge — provision the brilliant-mqtt agent on Brilliant
 * panels over root SSH, without Home Assistant.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';

import mqtt from 'mqtt';

import { parseEnv, renderEnv, validatePanelSlug } from './env.js';
import { buildPayload, deploy, findPayloadDir, parseStatus } from './install.js';
import * as plan from './plan.js';
import { connect, run, type Shell } from './ssh.js';

const USAGE = `brilliant-homebridge <command> [options]

Commands
  install    Install (or reconfigure) the agent on a panel
  update     Push this package's agent version, keeping the panel's settings
  repair     Restore units + settings after a panel firmware update wiped them
  status     Show the installed agent version and service state
  logs       Show recent agent logs
  uninstall  Stop and remove the agent from a panel

Connection (all commands)
  --host <ip>              Panel IP or hostname (required)
  --ssh-port <port>        Default 22
  --accept-new-host-key    Trust a changed SSH host key (e.g. after a panel reset)
  The panel's root password is read from BRILLIANT_SSH_PASSWORD or prompted for.

install
  --panel <slug>           Panel name, e.g. "office" (lowercase, a-z 0-9 _ -)
  --mqtt-host <host>       Broker address AS SEEN FROM THE PANEL (not localhost)
  --mqtt-port <port>       Default 1883 (8883 with --mqtt-tls)
  --mqtt-user <user>       Broker user for the panels (default "brilliant")
  --mqtt-tls               Strict TLS using the panel's system CA store
  --mesh-priority <n>      BLE-mesh election priority (1 = primary, 0 = never; default 0)
  --no-scenes              Do not enable the scene/mode bridge
  --bus-watchdog           Also install the bus-health watchdog (can REBOOT the panel)
  --wifi-watchdog          Also install the Wi-Fi watchdog (can REBOOT the panel)
  --env KEY=VALUE          Extra agent setting (repeatable; see docs/CONFIGURATION.md)
  --log-level <level>      Default INFO
  --no-verify              Skip waiting for the panel to appear on the broker
  --verify-url <url>       Broker URL as seen from THIS machine, for verification
                           (default mqtt://<mqtt-host>:<mqtt-port>)
  The broker password is read from MQTT_PASSWORD or prompted for.

update
  --bus-watchdog / --wifi-watchdog   Defaults to whatever is installed now

logs
  --lines <n>              Default 80

Other
  --payload <dir>          Use an agent payload directory other than the bundled one
  --help
`;

const options = {
  host: { type: 'string' },
  'ssh-port': { type: 'string', default: '22' },
  'accept-new-host-key': { type: 'boolean', default: false },
  panel: { type: 'string' },
  'mqtt-host': { type: 'string' },
  'mqtt-port': { type: 'string' },
  'mqtt-user': { type: 'string', default: 'brilliant' },
  'mqtt-tls': { type: 'boolean', default: false },
  'mesh-priority': { type: 'string', default: '0' },
  'no-scenes': { type: 'boolean', default: false },
  'bus-watchdog': { type: 'boolean' },
  'wifi-watchdog': { type: 'boolean' },
  env: { type: 'string', multiple: true },
  'log-level': { type: 'string', default: 'INFO' },
  'no-verify': { type: 'boolean', default: false },
  'verify-url': { type: 'string' },
  lines: { type: 'string', default: '80' },
  payload: { type: 'string' },
  help: { type: 'boolean', default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options }>>['values'];

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function integer(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function required(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

/** Prompt without echoing (falls back to an error when not a TTY). */
function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error(`${question.trim()} — not a TTY; set the environment variable`));
  }
  return new Promise((resolve) => {
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (!muted) {
          process.stdout.write(chunk);
        }
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function secret(variable: string, question: string): Promise<string> {
  const value = process.env[variable];
  return value && value.length > 0 ? value : promptSecret(question);
}

// SSH host keys are pinned on first use: the root password is sent to this host.
const PIN_FILE = join(homedir(), '.config', 'brilliant-homebridge', 'known_hosts.json');

function readPins(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(PIN_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

async function open(values: Values): Promise<Shell> {
  const host = required(values.host, '--host');
  const port = integer(values['ssh-port'], '--ssh-port');
  const password = await secret('BRILLIANT_SSH_PASSWORD', `root password for ${host}: `);
  const pins = readPins();
  const key = `${host}:${port}`;
  const pinned = values['accept-new-host-key'] ? undefined : pins[key];
  let seen = '';
  let shell: Shell;
  try {
    shell = await connect({
      host,
      port,
      username: 'root',
      password,
      hostKeySha256: pinned,
      onHostKey: (fingerprint) => {
        seen = fingerprint;
      },
    });
  } catch (error) {
    if (pinned && seen && seen !== pinned) {
      throw new Error(
        `SSH host key for ${key} changed (pinned SHA256:${pinned}, got SHA256:${seen}). ` +
          'If the panel was reset or updated, re-run with --accept-new-host-key.',
      );
    }
    throw error;
  }
  if (seen && pins[key] !== seen) {
    log(`pinning SSH host key for ${key}: SHA256:${seen}`);
    pins[key] = seen;
    mkdirSync(dirname(PIN_FILE), { recursive: true });
    writeFileSync(PIN_FILE, `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
  }
  return shell;
}

/** Wait for the panel's retained availability topic to read "online". */
function waitOnline(
  url: string,
  username: string,
  password: string,
  panel: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const client = mqtt.connect(url, { username, password, reconnectPeriod: 0, connectTimeout: 10_000 });
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      client.end(true);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.on('error', () => finish(false));
    client.on('connect', () => client.subscribe(`brilliant/${panel}/availability`));
    client.on('message', (_topic, payload) => {
      if (payload.toString() === 'online') {
        finish(true);
      }
    });
  });
}

async function install(values: Values): Promise<void> {
  const panel = validatePanelSlug(required(values.panel, '--panel'));
  const mqttHost = required(values['mqtt-host'], '--mqtt-host');
  if (/^(localhost|127\.|::1$)/.test(mqttHost)) {
    throw new Error('--mqtt-host is resolved on the panel; use the broker\'s LAN address, not localhost');
  }
  const mqttTls = values['mqtt-tls'];
  const mqttPort = integer(values['mqtt-port'] ?? (mqttTls ? '8883' : '1883'), '--mqtt-port');
  const mqttUsername = values['mqtt-user'];
  const mqttPassword = await secret('MQTT_PASSWORD', `MQTT password for "${mqttUsername}": `);
  const extra: Record<string, string> = {};
  for (const pair of values.env ?? []) {
    const index = pair.indexOf('=');
    if (index <= 0) {
      throw new Error(`--env expects KEY=VALUE (got "${pair}")`);
    }
    extra[pair.slice(0, index)] = pair.slice(index + 1);
  }
  const env = renderEnv({
    panel,
    mqttHost,
    mqttPort,
    mqttUsername,
    mqttPassword,
    mqttTls,
    meshPriority: integer(values['mesh-priority'], '--mesh-priority'),
    scenes: !values['no-scenes'],
    logLevel: values['log-level'],
    extra,
  });
  const components = {
    busWatchdog: values['bus-watchdog'] ?? false,
    wifiWatchdog: values['wifi-watchdog'] ?? false,
  };
  const payload = buildPayload(findPayloadDir(values.payload), components);
  const shell = await open(values);
  try {
    await deploy(shell, { payload, components, env, log });
  } finally {
    shell.close();
  }
  log(`agent ${payload.version} installed on "${panel}"`);

  if (!values['no-verify']) {
    const url = values['verify-url'] ?? `${mqttTls ? 'mqtts' : 'mqtt'}://${mqttHost}:${mqttPort}`;
    log(`waiting for "${panel}" to come online at ${url} …`);
    const online = await waitOnline(url, mqttUsername, mqttPassword, panel, 60_000);
    if (!online) {
      throw new Error(
        `the agent is running but brilliant/${panel}/availability never read "online". ` +
          'Check the broker address/credentials/ACL (Mosquitto ACL denials are silent) with ' +
          '"brilliant-homebridge logs".',
      );
    }
    log(`"${panel}" is online — it will appear in Homebridge shortly`);
  }
}

async function update(values: Values): Promise<void> {
  const shell = await open(values);
  try {
    const before = parseStatus(await run(shell, plan.status()));
    const installed = (unit: string): boolean => (before.units[unit] ?? '').endsWith('/enabled');
    const components = {
      busWatchdog: values['bus-watchdog'] ?? installed(plan.BUS_WATCHDOG_UNIT),
      wifiWatchdog: values['wifi-watchdog'] ?? installed(plan.WIFI_WATCHDOG_UNIT),
    };
    const payload = buildPayload(findPayloadDir(values.payload), components);
    log(`installed agent: ${before.agentVersion}; bundled agent: ${payload.version}`);
    await deploy(shell, { payload, components, log });
    log(`agent ${payload.version} active on "${before.panel || values.host}"`);
  } finally {
    shell.close();
  }
}

async function simple(values: Values, command: string): Promise<void> {
  const shell = await open(values);
  try {
    process.stdout.write(await run(shell, command));
  } finally {
    shell.close();
  }
}

async function showStatus(values: Values): Promise<void> {
  const shell = await open(values);
  try {
    const state = parseStatus(await run(shell, plan.status()));
    const env = parseEnv(await run(shell, plan.readEnv()));
    log(`panel:          ${state.panel || '(not configured)'}`);
    log(`agent version:  ${state.agentVersion}`);
    log(`broker:         ${env.MQTT_HOST ?? '?'}:${env.MQTT_PORT ?? '?'} as ${env.MQTT_USERNAME ?? '?'}`);
    log(`mesh priority:  ${env.MESH_PRIORITY ?? '0'}`);
    log(`scene bridge:   ${env.SCENE_BRIDGE_ENABLED === '1' ? 'on' : 'off'}`);
    for (const [unit, value] of Object.entries(state.units)) {
      log(`${`${unit}:`.padEnd(34)} ${value === '/' ? 'not installed' : value}`);
    }
  } finally {
    shell.close();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options, allowPositionals: true });
  const command = positionals[0];
  if (values.help || !command) {
    log(USAGE);
    process.exitCode = command || values.help ? 0 : 2;
    return;
  }
  switch (command) {
    case 'install':
      return install(values);
    case 'update':
      return update(values);
    case 'repair':
      return simple(values, plan.repair());
    case 'status':
      return showStatus(values);
    case 'logs':
      return simple(values, plan.logs(integer(values.lines, '--lines')));
    case 'uninstall':
      return simple(values, plan.uninstall());
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
