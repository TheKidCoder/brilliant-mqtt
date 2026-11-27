/**
 * Entity → HomeKit service mapping and value conversion.
 *
 * Pure module: no MQTT, no HAP imports. The platform turns a `ServiceKind`
 * into concrete HAP services.
 */
import type { Entity } from './discovery.js';

export type ServiceKind =
  | 'lightbulb'
  | 'switch'
  | 'motion'
  | 'occupancy'
  | 'contact'
  | 'temperature'
  | 'illuminance'
  | 'power'
  | 'number'
  | 'button';

export interface ExposeConfig {
  /** Panel settings (discovery `entity_category: config`). */
  panelControls: boolean;
  /** Diagnostics (discovery `entity_category: diagnostic`). */
  diagnostics: boolean;
  /** Live per-circuit wattage as an Eve "Consumption" characteristic. */
  power: boolean;
  /** Brilliant scenes and modes as momentary switches. */
  scenes: boolean;
  /** Entities the agent marks disabled-by-default (advanced tuning). */
  disabledByDefault: boolean;
}

export const DEFAULT_EXPOSE: ExposeConfig = {
  panelControls: true,
  diagnostics: true,
  power: true,
  scenes: true,
  disabledByDefault: false,
};

/** Case-insensitive glob (`*` only) → anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function isExcluded(entity: Entity, exclude: readonly RegExp[]): boolean {
  return exclude.some(
    (pattern) =>
      pattern.test(entity.uniqueId) ||
      pattern.test(entity.name) ||
      pattern.test(`${entity.deviceName} ${entity.name}`),
  );
}

/**
 * Decide how (and whether) an entity appears in HomeKit. Returns undefined
 * when it is filtered out or has no HomeKit representation.
 */
export function classify(
  entity: Entity,
  expose: ExposeConfig,
  exclude: readonly RegExp[] = [],
): ServiceKind | undefined {
  if (!entity.enabledByDefault && !expose.disabledByDefault) {
    return undefined;
  }
  if (entity.entityCategory === 'config' && !expose.panelControls) {
    return undefined;
  }
  if (entity.entityCategory === 'diagnostic' && !expose.diagnostics) {
    return undefined;
  }
  if (isExcluded(entity, exclude)) {
    return undefined;
  }
  switch (entity.component) {
    case 'light':
      return 'lightbulb';
    case 'switch':
      return 'switch';
    case 'button':
      return 'button';
    case 'number':
      return entity.min !== undefined && entity.max !== undefined && entity.max > entity.min
        ? 'number'
        : undefined;
    case 'binary_sensor':
      if (entity.deviceClass === 'motion') {
        return 'motion';
      }
      if (entity.deviceClass === 'occupancy') {
        return 'occupancy';
      }
      return 'contact';
    case 'sensor':
      if (entity.deviceClass === 'temperature') {
        return 'temperature';
      }
      if (entity.deviceClass === 'illuminance') {
        return 'illuminance';
      }
      if (entity.deviceClass === 'power') {
        return expose.power ? 'power' : undefined;
      }
      // Scores, firmware strings, write status: no HomeKit equivalent.
      return undefined;
  }
}

/**
 * Accessory grouping. A peripheral with a primary load is its own accessory
 * (so each light/switch is one HomeKit tile carrying its power, temperature
 * and fault). Everything else on a panel collapses into one accessory per
 * discovery device ("Brilliant Office").
 */
export function groupKey(entity: Entity, peripheralsWithPrimary: ReadonlySet<string>): string {
  const peripheralKey = `${entity.panel}/${entity.peripheral}`;
  return peripheralsWithPrimary.has(peripheralKey)
    ? `peripheral:${peripheralKey}`
    : `device:${entity.deviceId}`;
}

export type State = Record<string, unknown>;

export function parseState(payload: string): State | undefined {
  try {
    const value: unknown = JSON.parse(payload);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as State)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * On/off for an entity from its peripheral state, or undefined when unknown
 * (e.g. a wired/mesh write is still unconfirmed and the agent publishes null).
 */
export function readBool(entity: Entity, state: State): boolean | undefined {
  if (entity.primary) {
    const value = state.state;
    return value === 'ON' ? true : value === 'OFF' ? false : undefined;
  }
  if (entity.valueKey === undefined) {
    return undefined;
  }
  const value = state[entity.valueKey];
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'ON' || value === 'OFF') {
    return value === 'ON';
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return undefined;
}

/**
 * Generic binary sensors become contact sensors, where "open" should mean
 * "needs attention": a problem, an active camera — or a *lost* connection.
 */
export function contactOpen(entity: Entity, value: boolean): boolean {
  return entity.deviceClass === 'connectivity' ? !value : value;
}

export function readNumber(entity: Entity, state: State): number | undefined {
  if (entity.valueKey === undefined) {
    return undefined;
  }
  const value = state[entity.valueKey];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Agent brightness (0–255) → HomeKit percent. A lit load never rounds to 0. */
export function brightnessToPercent(brightness: unknown): number | undefined {
  if (typeof brightness !== 'number' || !Number.isFinite(brightness)) {
    return undefined;
  }
  const clamped = Math.max(0, Math.min(255, brightness));
  if (clamped === 0) {
    return 0;
  }
  return Math.max(1, Math.round((clamped / 255) * 100));
}

export function percentToBrightness(percent: number): number {
  const clamped = Math.max(0, Math.min(100, percent));
  if (clamped === 0) {
    return 0;
  }
  return Math.max(1, Math.round((clamped / 100) * 255));
}

/** Number entity value → 0–100 % of its range. */
export function numberToPercent(entity: Entity, value: number): number {
  const min = entity.min ?? 0;
  const max = entity.max ?? 100;
  const clamped = Math.max(min, Math.min(max, value));
  return Math.round(((clamped - min) / (max - min)) * 100);
}

/** 0–100 % → number entity value, snapped to its step. */
export function percentToNumber(entity: Entity, percent: number): number {
  const min = entity.min ?? 0;
  const max = entity.max ?? 100;
  const step = entity.step !== undefined && entity.step > 0 ? entity.step : 1;
  const raw = min + (Math.max(0, Math.min(100, percent)) / 100) * (max - min);
  const snapped = min + Math.round((raw - min) / step) * step;
  return Math.max(min, Math.min(max, Number(snapped.toFixed(6))));
}

/** JSON command for a primary light/switch (`brilliant/<panel>/<p>/set`). */
export function loadCommand(on: boolean | undefined, percent: number | undefined): string {
  if (on === false || percent === 0) {
    return JSON.stringify({ state: 'OFF' });
  }
  const command: { state: string; brightness?: number } = { state: 'ON' };
  if (percent !== undefined) {
    command.brightness = percentToBrightness(percent);
  }
  return JSON.stringify(command);
}
