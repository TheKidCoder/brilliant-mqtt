import type { PlatformConfig } from 'homebridge';

import { DEFAULT_EXPOSE, globToRegExp, type ExposeConfig } from './mapping.js';

export interface MqttSettings {
  url: string;
  username?: string;
  password?: string;
  /** PEM CA file for a private broker CA (mqtts:// only). */
  caFile?: string;
  rejectUnauthorized: boolean;
  clientId?: string;
}

export interface Settings {
  mqtt: MqttSettings;
  expose: ExposeConfig;
  exclude: RegExp[];
  /** HomeKit has no "number" service; sliders borrow one of these. */
  numberService: 'fan' | 'lightbulb';
  /** Remove cached accessories the broker no longer advertises. */
  pruneStale: boolean;
  /** Panels (slugs) to include; empty = all. `mesh` is the BLE-mesh namespace. */
  panels: string[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

/** Normalise raw Homebridge platform config. Throws on an unusable broker URL. */
export function parseSettings(config: PlatformConfig | Record<string, unknown>): Settings {
  const mqtt = record(config.mqtt);
  const url = optionalString(mqtt.url) ?? 'mqtt://localhost:1883';
  if (!/^(mqtts?|wss?):\/\//.test(url)) {
    throw new Error(`mqtt.url must start with mqtt://, mqtts://, ws:// or wss:// (got "${url}")`);
  }
  const expose = record(config.expose);
  return {
    mqtt: {
      url,
      username: optionalString(mqtt.username),
      password: typeof mqtt.password === 'string' && mqtt.password ? mqtt.password : undefined,
      caFile: optionalString(mqtt.caFile),
      rejectUnauthorized: bool(mqtt.rejectUnauthorized, true),
      clientId: optionalString(mqtt.clientId),
    },
    expose: {
      panelControls: bool(expose.panelControls, DEFAULT_EXPOSE.panelControls),
      diagnostics: bool(expose.diagnostics, DEFAULT_EXPOSE.diagnostics),
      power: bool(expose.power, DEFAULT_EXPOSE.power),
      scenes: bool(expose.scenes, DEFAULT_EXPOSE.scenes),
      disabledByDefault: bool(expose.disabledByDefault, DEFAULT_EXPOSE.disabledByDefault),
    },
    exclude: strings(config.exclude).map((glob) => globToRegExp(glob.trim())),
    numberService: config.numberService === 'lightbulb' ? 'lightbulb' : 'fan',
    pruneStale: bool(config.pruneStale, false),
    panels: strings(config.panels).map((panel) => panel.trim()),
  };
}
