/**
 * Parsing of the agent's retained discovery payloads.
 *
 * The on-panel agent publishes Home Assistant MQTT-Discovery documents. They
 * are plain JSON with a small, fixed set of shapes (see
 * src/brilliant_mqtt/discovery.py), so this plugin reads them directly rather
 * than requiring a different wire format from the agent.
 *
 * Pure module: no MQTT, no HAP.
 */
import { DISCOVERY_PREFIX, TOPIC_PREFIX } from './settings.js';

export type Component = 'light' | 'switch' | 'binary_sensor' | 'sensor' | 'number' | 'button';

const COMPONENTS: ReadonlySet<string> = new Set([
  'light',
  'switch',
  'binary_sensor',
  'sensor',
  'number',
  'button',
]);

export interface Entity {
  uniqueId: string;
  component: Component;
  name: string;
  panel: string;
  peripheral: string;
  /** Discovery device identifier (one per panel; one per mesh peripheral). */
  deviceId: string;
  deviceName: string;
  model?: string;
  firmware?: string;
  stateTopic?: string;
  commandTopic?: string;
  availabilityTopic?: string;
  /**
   * Key of the shared JSON state payload this entity reads. Undefined for a
   * primary light (which reads `state`/`brightness` directly).
   */
  valueKey?: string;
  /** True when the entity is a load's primary light/switch (JSON commands). */
  primary: boolean;
  brightness: boolean;
  deviceClass?: string;
  unit?: string;
  entityCategory?: 'config' | 'diagnostic';
  enabledByDefault: boolean;
  min?: number;
  max?: number;
  step?: number;
}

/** `homeassistant/<component>/<object_id>/config` → parts, or undefined. */
export function parseConfigTopic(
  topic: string,
): { component: Component; objectId: string } | undefined {
  const parts = topic.split('/');
  if (parts.length !== 4 || parts[0] !== DISCOVERY_PREFIX || parts[3] !== 'config') {
    return undefined;
  }
  const [, component, objectId] = parts as [string, string, string, string];
  if (!COMPONENTS.has(component) || !objectId.startsWith('brilliant_')) {
    return undefined;
  }
  return { component: component as Component, objectId };
}

/** `brilliant/<panel>/<peripheral>/<leaf>` → parts, or undefined. */
export function parseBrilliantTopic(
  topic: string,
): { panel: string; peripheral: string; leaf: string } | undefined {
  const parts = topic.split('/');
  if (parts.length !== 4 || parts[0] !== TOPIC_PREFIX) {
    return undefined;
  }
  const [, panel, peripheral, leaf] = parts as [string, string, string, string];
  if (!panel || !peripheral || !leaf) {
    return undefined;
  }
  return { panel, peripheral, leaf };
}

/**
 * Extract the state-payload key from one of the agent's value templates:
 * `{{ value_json.KEY }}` or `{{ 'ON' if value_json.KEY else 'OFF' }}`.
 * Anything else (e.g. the multi-line mesh write-status template) is
 * unsupported and returns undefined.
 */
export function templateKey(template: unknown): string | undefined {
  if (typeof template !== 'string') {
    return undefined;
  }
  const simple = /^\{\{\s*value_json\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(template);
  if (simple) {
    return simple[1];
  }
  const bool =
    /^\{\{\s*'ON'\s+if\s+value_json\.([A-Za-z_][A-Za-z0-9_]*)\s+else\s+'OFF'\s*\}\}$/.exec(
      template,
    );
  return bool?.[1];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse one discovery document. Returns undefined for documents this plugin
 * cannot represent (not ours, malformed, or an unsupported template).
 */
export function parseEntity(topic: string, payload: string): Entity | undefined {
  const parsedTopic = parseConfigTopic(topic);
  if (!parsedTopic) {
    return undefined;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return undefined;
  }
  const d = doc as Record<string, unknown>;
  const { component } = parsedTopic;
  const uniqueId = str(d.unique_id) ?? parsedTopic.objectId;
  const stateTopic = str(d.state_topic);
  const commandTopic = str(d.command_topic);
  const location = parseBrilliantTopic(stateTopic ?? commandTopic ?? '');
  if (!location) {
    return undefined;
  }

  const device = (typeof d.device === 'object' && d.device !== null ? d.device : {}) as Record<
    string,
    unknown
  >;
  const identifiers = Array.isArray(device.identifiers) ? device.identifiers : [];
  const deviceId = str(identifiers[0]) ?? `brilliant_panel_${location.panel}`;

  const availability = Array.isArray(d.availability) ? d.availability : [];
  const firstAvailability = (
    typeof availability[0] === 'object' && availability[0] !== null ? availability[0] : {}
  ) as Record<string, unknown>;

  const primary =
    (component === 'light' || component === 'switch') &&
    commandTopic !== undefined &&
    commandTopic.endsWith('/set');

  let valueKey: string | undefined;
  if (component === 'light') {
    valueKey = undefined;
  } else if (component === 'button') {
    valueKey = undefined;
  } else {
    valueKey = templateKey(d.value_template);
    if (valueKey === undefined) {
      return undefined;
    }
  }

  const category = d.entity_category;
  return {
    uniqueId,
    component,
    name: str(d.name) ?? uniqueId,
    panel: location.panel,
    peripheral: location.peripheral,
    deviceId,
    deviceName: str(device.name) ?? `Brilliant ${location.panel}`,
    model: str(device.model),
    firmware: str(device.sw_version),
    stateTopic,
    commandTopic,
    availabilityTopic: str(firstAvailability.topic),
    valueKey,
    primary,
    brightness: component === 'light' && d.brightness === true,
    deviceClass: str(d.device_class),
    unit: str(d.unit_of_measurement),
    entityCategory: category === 'config' || category === 'diagnostic' ? category : undefined,
    enabledByDefault: d.enabled_by_default !== false,
    min: num(d.min),
    max: num(d.max),
    step: num(d.step),
  };
}
