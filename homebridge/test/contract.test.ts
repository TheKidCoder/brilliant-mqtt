import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseEntity, templateKey, type Entity } from '../src/discovery.js';
import {
  brightnessToPercent,
  classify,
  contactOpen,
  DEFAULT_EXPOSE,
  globToRegExp,
  groupKey,
  loadCommand,
  numberToPercent,
  percentToBrightness,
  percentToNumber,
  readBool,
  readNumber,
  type State,
} from '../src/mapping.js';

interface Fixture {
  peripherals: {
    panel: string;
    kind: string;
    state_topic: string;
    state: State;
    entities: { topic: string; payload: string }[];
  }[];
}

// Rendered by the agent's own code (scripts/gen_fixtures.py; CI checks it is current).
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/agent-contract.json', import.meta.url), 'utf8'),
) as Fixture;

const all: { entity: Entity; state: State; kind: string }[] = [];
const unparsed: string[] = [];
for (const peripheral of fixture.peripherals) {
  for (const { topic, payload } of peripheral.entities) {
    const entity = parseEntity(topic, payload);
    if (entity) {
      all.push({ entity, state: peripheral.state, kind: peripheral.kind });
    } else {
      unparsed.push(topic);
    }
  }
}
const byId = (id: string): { entity: Entity; state: State } => {
  const found = all.find((item) => item.entity.uniqueId === id);
  if (!found) {
    throw new Error(`fixture entity ${id} missing`);
  }
  return found;
};

describe('agent discovery contract', () => {
  it('parses every entity the agent publishes', () => {
    expect(unparsed).toEqual([]);
    expect(all.length).toBeGreaterThan(70);
  });

  it('every stateful entity reads a key that exists in its state payload', () => {
    for (const { entity, state } of all) {
      if (entity.valueKey !== undefined && !entity.primary) {
        expect(Object.keys(state), entity.uniqueId).toContain(entity.valueKey);
      }
      expect(entity.stateTopic ?? entity.commandTopic).toMatch(/^brilliant\//);
      expect(entity.availabilityTopic).toBe(`brilliant/${entity.panel}/availability`);
    }
  });

  it('maps a dimmable panel load', () => {
    const { entity, state } = byId('brilliant_office_gangbox_peripheral_0');
    expect(entity).toMatchObject({
      component: 'light',
      name: 'Ceiling Lights',
      panel: 'office',
      peripheral: 'gangbox_peripheral_0',
      primary: true,
      brightness: true,
      commandTopic: 'brilliant/office/gangbox_peripheral_0/set',
      deviceId: 'brilliant_panel_office',
      firmware: '24.10.1',
    });
    expect(classify(entity, DEFAULT_EXPOSE)).toBe('lightbulb');
    expect(readBool(entity, state)).toBe(true);
    expect(brightnessToPercent(state.brightness)).toBe(50);
  });

  it('maps primary and aux switches to the right command shapes', () => {
    const primary = byId('brilliant_office_gangbox_peripheral_1').entity;
    expect(primary.primary).toBe(true);
    expect(primary.commandTopic).toBe('brilliant/office/gangbox_peripheral_1/set');
    const aux = byId('brilliant_office_ui_peripheral_child_lock_enabled');
    expect(aux.entity.primary).toBe(false);
    expect(aux.entity.commandTopic).toBe('brilliant/office/ui_peripheral/set_child_lock_enabled');
    expect(aux.entity.entityCategory).toBe('config');
    expect(readBool(aux.entity, aux.state)).toBe(true);
  });

  it('classifies sensors', () => {
    const kinds = new Map<string, number>();
    for (const { entity } of all) {
      const kind = classify(entity, { ...DEFAULT_EXPOSE, disabledByDefault: true }) ?? 'none';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    expect(Object.fromEntries(kinds)).toMatchInlineSnapshot(`
      {
        "button": 1,
        "contact": 9,
        "illuminance": 1,
        "lightbulb": 2,
        "motion": 5,
        "none": 6,
        "number": 15,
        "occupancy": 1,
        "power": 4,
        "switch": 28,
        "temperature": 6,
      }
    `);
  });

  it('honours the agent disabled-by-default flag and category filters', () => {
    const tuning = byId('brilliant_office_gangbox_peripheral_0_motion_high_threshold').entity;
    expect(tuning.enabledByDefault).toBe(false);
    expect(classify(tuning, DEFAULT_EXPOSE)).toBeUndefined();
    expect(classify(tuning, { ...DEFAULT_EXPOSE, disabledByDefault: true })).toBe('number');

    const lock = byId('brilliant_office_ui_peripheral_child_lock_enabled').entity;
    expect(classify(lock, { ...DEFAULT_EXPOSE, panelControls: false })).toBeUndefined();
    expect(classify(lock, DEFAULT_EXPOSE, [globToRegExp('*child lock*')])).toBeUndefined();
    expect(classify(lock, DEFAULT_EXPOSE, [globToRegExp('*volume*')])).toBe('switch');

    const power = byId('brilliant_office_gangbox_peripheral_0_power');
    expect(classify(power.entity, { ...DEFAULT_EXPOSE, power: false })).toBeUndefined();
    expect(readNumber(power.entity, power.state)).toBe(23.5);
  });

  it('groups loads per peripheral and panel internals per device', () => {
    const withPrimary = new Set(
      all.filter((i) => i.entity.primary).map((i) => `${i.entity.panel}/${i.entity.peripheral}`),
    );
    const key = (id: string): string => groupKey(byId(id).entity, withPrimary);
    expect(key('brilliant_office_gangbox_peripheral_0_power')).toBe(
      'peripheral:office/gangbox_peripheral_0',
    );
    expect(key('brilliant_office_gangbox_peripheral_2_power')).toBe('device:brilliant_panel_office');
    expect(key('brilliant_office_ui_peripheral_child_lock_enabled')).toBe(
      'device:brilliant_panel_office',
    );
    expect(key('brilliant_mesh_mesh_dimmer_1')).toBe('peripheral:mesh/mesh_dimmer_1');
  });

  it('reads number bounds', () => {
    const { entity, state } = byId('brilliant_office_hardware_peripheral_output_volume');
    expect(entity).toMatchObject({ component: 'number', min: 0, max: 100 });
    expect(numberToPercent(entity, readNumber(entity, state) ?? -1)).toBe(50);
  });
});

describe('value conversion', () => {
  const entity = (overrides: Partial<Entity>): Entity => ({
    uniqueId: 'x',
    component: 'number',
    name: 'x',
    panel: 'office',
    peripheral: 'p',
    deviceId: 'd',
    deviceName: 'Brilliant Office',
    primary: false,
    brightness: false,
    enabledByDefault: true,
    ...overrides,
  });

  it('extracts template keys and rejects anything else', () => {
    expect(templateKey('{{ value_json.power }}')).toBe('power');
    expect(templateKey("{{ 'ON' if value_json.led_on else 'OFF' }}")).toBe('led_on');
    expect(templateKey('{{ value_json.state }}')).toBe('state');
    expect(templateKey("{%- set s = value_json.get('x') -%}{{ s }}")).toBeUndefined();
    expect(templateKey(undefined)).toBeUndefined();
  });

  it('round-trips brightness without rounding a lit load to zero', () => {
    expect(brightnessToPercent(1)).toBe(1);
    expect(brightnessToPercent(255)).toBe(100);
    expect(brightnessToPercent(0)).toBe(0);
    expect(brightnessToPercent(null)).toBeUndefined();
    expect(percentToBrightness(100)).toBe(255);
    expect(percentToBrightness(1)).toBe(3);
    for (let percent = 1; percent <= 100; percent++) {
      expect(brightnessToPercent(percentToBrightness(percent))).toBe(percent);
    }
  });

  it('builds load commands', () => {
    expect(loadCommand(false, 80)).toBe('{"state":"OFF"}');
    expect(loadCommand(undefined, 0)).toBe('{"state":"OFF"}');
    expect(loadCommand(true, undefined)).toBe('{"state":"ON"}');
    expect(loadCommand(undefined, 50)).toBe('{"state":"ON","brightness":128}');
    expect(loadCommand(true, 100)).toBe('{"state":"ON","brightness":255}');
  });

  it('treats a null/unknown primary state as unknown, not off', () => {
    const light = entity({ component: 'light', primary: true });
    expect(readBool(light, { state: null })).toBeUndefined();
    expect(readBool(light, {})).toBeUndefined();
    expect(readBool(light, { state: 'OFF' })).toBe(false);
  });

  it('scales numbers onto their range and step', () => {
    const brightness = entity({ min: 0, max: 15, step: 1 });
    expect(percentToNumber(brightness, 50)).toBe(8);
    expect(numberToPercent(brightness, 15)).toBe(100);
    const timeout = entity({ min: 30, max: 3600, step: 30 });
    expect(percentToNumber(timeout, 0)).toBe(30);
    expect(percentToNumber(timeout, 100)).toBe(3600);
    expect(percentToNumber(timeout, 50) % 30).toBe(0);
  });

  it('reports a lost connection, not a healthy one, as an open contact', () => {
    expect(contactOpen(entity({ deviceClass: 'connectivity' }), true)).toBe(false);
    expect(contactOpen(entity({ deviceClass: 'connectivity' }), false)).toBe(true);
    expect(contactOpen(entity({ deviceClass: 'problem' }), true)).toBe(true);
  });
});
