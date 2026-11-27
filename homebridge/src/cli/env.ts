/**
 * Rendering of /etc/brilliant-mqtt.env (a systemd EnvironmentFile read by a
 * root unit). Mirrors the HA integration's quoting rules: string values are
 * double-quoted with `\` and `"` escaped, and control characters are refused
 * so a value can never inject another variable.
 */
export interface AgentEnv {
  panel: string;
  mqttHost: string;
  mqttPort: number;
  mqttUsername: string;
  mqttPassword: string;
  mqttTls: boolean;
  meshPriority: number;
  scenes: boolean;
  logLevel?: string;
  /** Extra raw agent variables (see docs/CONFIGURATION.md). */
  extra?: Record<string, string>;
}

const PANEL_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

export function validatePanelSlug(panel: string): string {
  if (!PANEL_SLUG.test(panel)) {
    throw new Error(
      `invalid panel name "${panel}": use lowercase letters, digits, "_" or "-" (max 64)`,
    );
  }
  if (panel === 'mesh') {
    throw new Error('"mesh" is reserved for the BLE-mesh namespace; pick another panel name');
  }
  return panel;
}

export function envQuote(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('environment values must not contain control characters');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function envUnquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return value;
}

export function parseEnv(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const index = trimmed.indexOf('=');
    if (index <= 0) {
      continue;
    }
    parsed[trimmed.slice(0, index).trim()] = envUnquote(trimmed.slice(index + 1));
  }
  return parsed;
}

export function renderEnv(env: AgentEnv): string {
  validatePanelSlug(env.panel);
  if (!Number.isInteger(env.mqttPort) || env.mqttPort < 1 || env.mqttPort > 65535) {
    throw new Error(`invalid MQTT port: ${env.mqttPort}`);
  }
  if (!Number.isInteger(env.meshPriority) || env.meshPriority < 0) {
    throw new Error(`invalid mesh priority: ${env.meshPriority}`);
  }
  if (!env.mqttHost || !env.mqttUsername || !env.mqttPassword) {
    throw new Error('MQTT host, username and password are required');
  }
  const lines = [
    `BRILLIANT_PANEL=${envQuote(env.panel)}`,
    `MQTT_HOST=${envQuote(env.mqttHost)}`,
    `MQTT_PORT=${env.mqttPort}`,
    `MQTT_USERNAME=${envQuote(env.mqttUsername)}`,
    `MQTT_PASSWORD=${envQuote(env.mqttPassword)}`,
    `MQTT_TLS_ENABLED=${env.mqttTls ? 1 : 0}`,
    `MESH_PRIORITY=${env.meshPriority}`,
    `SCENE_BRIDGE_ENABLED=${env.scenes ? 1 : 0}`,
    `LOG_LEVEL=${envQuote(env.logLevel ?? 'INFO')}`,
  ];
  const managed = new Set(lines.map((line) => line.slice(0, line.indexOf('='))));
  for (const [key, value] of Object.entries(env.extra ?? {})) {
    if (!ENV_KEY.test(key)) {
      throw new Error(`invalid environment variable name: ${key}`);
    }
    if (managed.has(key)) {
      throw new Error(`${key} is set by a dedicated option; do not pass it via --env`);
    }
    lines.push(`${key}=${envQuote(value)}`);
  }
  return `${lines.join('\n')}\n`;
}
