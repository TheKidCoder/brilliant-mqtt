import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as plan from './plan.js';
import { run, type Shell } from './ssh.js';
import { collectFiles, createTar, type TarEntry } from './tar.js';

export interface Payload {
  version: string;
  tar: Buffer;
  files: number;
}

/** Locate the agent payload: bundled in the package, or the repo checkout. */
export function findPayloadDir(explicit?: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    resolve(here, '../../agent-payload'),
    resolve(here, '../../../custom_components/brilliant_mqtt/agent_payload'),
  ].filter((candidate): candidate is string => typeof candidate === 'string');
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'app', 'brilliant_mqtt', '__main__.py'))) {
      return candidate;
    }
  }
  throw new Error(
    `agent payload not found (looked in: ${candidates.join(', ')}). Run "npm run build" or pass --payload.`,
  );
}

export function buildPayload(dir: string, components: plan.Components): Payload {
  const version = readFileSync(join(dir, 'VERSION'), 'utf8').trim();
  const entries: TarEntry[] = [
    ...collectFiles(join(dir, 'app'), 'app'),
    ...collectFiles(join(dir, 'vendor'), 'vendor'),
    { path: 'VERSION', data: Buffer.from(version) },
    { path: plan.BRIDGE_UNIT, data: readFileSync(join(dir, plan.BRIDGE_UNIT)) },
  ];
  if (components.busWatchdog) {
    entries.push(
      ...collectFiles(join(dir, 'bus_watchdog'), 'bus_watchdog'),
      { path: plan.BUS_WATCHDOG_UNIT, data: readFileSync(join(dir, plan.BUS_WATCHDOG_UNIT)) },
    );
  }
  if (components.wifiWatchdog) {
    entries.push(
      ...collectFiles(join(dir, 'wifi_watchdog'), 'wifi_watchdog'),
      { path: plan.WIFI_WATCHDOG_UNIT, data: readFileSync(join(dir, plan.WIFI_WATCHDOG_UNIT)) },
    );
  }
  return { version, tar: createTar(entries), files: entries.length };
}

export interface DeployOptions {
  payload: Payload;
  components: plan.Components;
  /** New env content; undefined keeps the panel's existing env (update). */
  env?: string;
  log: (message: string) => void;
}

/** Push the payload, write the env, swap it in and start the services. */
export async function deploy(shell: Shell, options: DeployOptions): Promise<void> {
  const { payload, components, log } = options;
  const python = (await run(shell, plan.preflight())).trim();
  log(`panel runtime: ${python}`);

  if (options.env === undefined) {
    const existing = await run(shell, plan.readEnv());
    if (!existing.includes('MQTT_HOST=')) {
      throw new Error('no existing agent configuration on this panel; run "install" first');
    }
    // Re-seat /etc from the /var copy if an OTA removed it.
    await run(shell, plan.writeFile(plan.ENV_FILE, '600'), existing);
  } else {
    await run(shell, plan.writeFile(plan.ENV_FILE, '600'), options.env);
  }

  const staging = `${plan.ROOT}/.staging`;
  log(`uploading agent ${payload.version} (${payload.files} files)`);
  await run(shell, plan.receive(staging), payload.tar);
  log('activating');
  await run(shell, plan.activate(staging, components));
}

export interface InstalledState {
  agentVersion: string;
  panel: string;
  units: Record<string, string>;
}

export function parseStatus(output: string): InstalledState {
  const values: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) {
      values[line.slice(0, index)] = line.slice(index + 1).trim();
    }
  }
  const { agent_version: agentVersion = 'none', panel = '', ...units } = values;
  return { agentVersion, panel, units };
}
