import type { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import type { Logging, PlatformAccessory, Service } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Homebridge's package exports only its index; the API class is loaded by path.
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { BrilliantPlatform, type MqttLike } from '../src/platform.js';
import { PLATFORM_NAME } from '../src/settings.js';

interface Fixture {
  peripherals: {
    panel: string;
    state_topic: string;
    state: Record<string, unknown>;
    entities: { topic: string; payload: string }[];
  }[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/agent-contract.json', import.meta.url), 'utf8'),
) as Fixture;

class FakeMqtt implements MqttLike {
  published: { topic: string; payload: string }[] = [];
  subscribed: string[] = [];
  private message: (topic: string, payload: string) => void = () => undefined;
  private connect: () => void = () => undefined;
  publish(topic: string, payload: string): void {
    this.published.push({ topic, payload });
  }
  subscribe(topics: string[]): void {
    this.subscribed.push(...topics);
  }
  onMessage(handler: (topic: string, payload: string) => void): void {
    this.message = handler;
  }
  onConnect(handler: () => void): void {
    this.connect = handler;
  }
  end(): void {}
  open(): void {
    this.connect();
  }
  receive(topic: string, payload: string): void {
    this.message(topic, payload);
  }
}

const log = Object.assign(vi.fn(), {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  log: vi.fn(),
  prefix: 'test',
}) as unknown as Logging;

function setup(config: Record<string, unknown> = {}): {
  api: HomebridgeAPI;
  mqtt: FakeMqtt;
  accessories: Map<string, PlatformAccessory>;
  platform: BrilliantPlatform;
} {
  const api = new HomebridgeAPI();
  const mqtt = new FakeMqtt();
  const accessories = new Map<string, PlatformAccessory>();
  const events = api as unknown as EventEmitter;
  events.on('registerPlatformAccessories', (list: PlatformAccessory[]) => {
    for (const accessory of list) {
      accessories.set(accessory.displayName, accessory);
    }
  });
  events.on('unregisterPlatformAccessories', (list: PlatformAccessory[]) => {
    for (const accessory of list) {
      accessories.delete(accessory.displayName);
    }
  });
  const platform = new BrilliantPlatform(
    log,
    { platform: PLATFORM_NAME, ...config },
    api,
    () => mqtt,
  );
  api.signalFinished();
  mqtt.open();
  return { api, mqtt, accessories, platform };
}

function replay(mqtt: FakeMqtt): void {
  mqtt.receive('brilliant/office/availability', 'online');
  mqtt.receive('brilliant/mesh/availability', 'online');
  for (const peripheral of fixture.peripherals) {
    for (const entity of peripheral.entities) {
      mqtt.receive(entity.topic, entity.payload);
    }
    mqtt.receive(peripheral.state_topic, JSON.stringify(peripheral.state));
  }
}

function service(accessory: PlatformAccessory | undefined, subtype: string): Service {
  const found = accessory?.services.find((s) => s.subtype === subtype);
  if (!found) {
    throw new Error(`service ${subtype} not found on ${accessory?.displayName}`);
  }
  return found;
}

describe('BrilliantPlatform', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes to discovery, state, availability and scene topics', () => {
    const { mqtt } = setup();
    expect(mqtt.subscribed).toEqual(
      expect.arrayContaining([
        'homeassistant/+/+/config',
        'brilliant/+/+/state',
        'brilliant/+/availability',
        'brilliant/ha-control/v1/scene/catalog/+',
        'brilliant/ha-control/v1/mode/result/+',
      ]),
    );
  });

  it('builds one accessory per load and one per panel', () => {
    const { mqtt, accessories, api } = setup();
    replay(mqtt);
    vi.advanceTimersByTime(2000);
    expect([...accessories.keys()].sort()).toEqual([
      'Brilliant Office',
      'Ceiling Lights',
      'Dining Room Lights',
      'Fan',
    ]);
    const C = api.hap.Characteristic;
    const light = service(accessories.get('Ceiling Lights'), 'brilliant_office_gangbox_peripheral_0');
    expect(light.UUID).toBe(api.hap.Service.Lightbulb.UUID);
    expect(light.getCharacteristic(C.On).value).toBe(true);
    expect(light.getCharacteristic(C.Brightness).value).toBe(50);
    // Wattage rides on the light itself as the Eve consumption characteristic.
    const consumption = light.characteristics.find(
      (c) => c.UUID === 'E863F10D-079E-48FF-8F27-9C2605A29F52',
    );
    expect(consumption?.value).toBe(23.5);
    // Disabled-by-default tuning entities stay out of HomeKit.
    const subtypes = accessories.get('Ceiling Lights')?.services.map((s) => s.subtype);
    expect(subtypes).not.toContain('brilliant_office_gangbox_peripheral_0_motion_high_threshold');
    expect(subtypes).toContain('brilliant_office_gangbox_peripheral_0_movement_detected');
  });

  it('coalesces On + Brightness writes into one load command', async () => {
    const { mqtt, accessories, api } = setup();
    replay(mqtt);
    vi.advanceTimersByTime(2000);
    const C = api.hap.Characteristic;
    const light = service(accessories.get('Ceiling Lights'), 'brilliant_office_gangbox_peripheral_0');
    await light.getCharacteristic(C.Brightness).handleSetRequest(80);
    await light.getCharacteristic(C.On).handleSetRequest(true);
    expect(mqtt.published).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(mqtt.published).toEqual([
      { topic: 'brilliant/office/gangbox_peripheral_0/set', payload: '{"state":"ON","brightness":204}' },
    ]);
    await light.getCharacteristic(C.On).handleSetRequest(false);
    vi.advanceTimersByTime(100);
    expect(mqtt.published[1]?.payload).toBe('{"state":"OFF"}');
  });

  it('sends aux switch, number and button commands in the agent formats', async () => {
    const { mqtt, accessories, api } = setup();
    replay(mqtt);
    vi.advanceTimersByTime(2000);
    const C = api.hap.Characteristic;
    const panel = accessories.get('Brilliant Office');
    await service(panel, 'brilliant_office_ui_peripheral_child_lock_enabled')
      .getCharacteristic(C.On)
      .handleSetRequest(false);
    const volume = service(panel, 'brilliant_office_hardware_peripheral_output_volume');
    expect(volume.UUID).toBe(api.hap.Service.Fanv2.UUID);
    expect(volume.getCharacteristic(C.RotationSpeed).value).toBe(50);
    await volume.getCharacteristic(C.RotationSpeed).handleSetRequest(30);
    const identify = service(panel, 'brilliant_office_ui_peripheral_request_identify');
    await identify.getCharacteristic(C.On).handleSetRequest(true);
    expect(mqtt.published).toEqual([
      { topic: 'brilliant/office/ui_peripheral/set_child_lock_enabled', payload: 'OFF' },
      { topic: 'brilliant/office/hardware_peripheral/set_output_volume', payload: '30' },
      { topic: 'brilliant/office/ui_peripheral/set_request_identify', payload: 'PRESS' },
    ]);
    vi.advanceTimersByTime(600);
    expect(identify.getCharacteristic(C.On).value).toBe(false);
  });

  it('applies live state updates and keeps the last value while a write is unconfirmed', () => {
    const { mqtt, accessories, api } = setup();
    replay(mqtt);
    vi.advanceTimersByTime(2000);
    const C = api.hap.Characteristic;
    const light = service(accessories.get('Dining Room Lights'), 'brilliant_mesh_mesh_dimmer_1');
    mqtt.receive('brilliant/mesh/mesh_dimmer_1/state', '{"state":"OFF","brightness":0}');
    expect(light.getCharacteristic(C.On).value).toBe(false);
    expect(light.getCharacteristic(C.Brightness).value).toBe(50);
    mqtt.receive('brilliant/mesh/mesh_dimmer_1/state', '{"state":null,"brightness":null}');
    expect(light.getCharacteristic(C.On).value).toBe(false);
    mqtt.receive('brilliant/mesh/mesh_dimmer_1/state', '{"state":"ON","brightness":255}');
    expect(light.getCharacteristic(C.On).value).toBe(true);
    expect(light.getCharacteristic(C.Brightness).value).toBe(100);
  });

  it('rejects writes and reports no-response while the panel is offline', async () => {
    const { mqtt, accessories, api } = setup();
    replay(mqtt);
    vi.advanceTimersByTime(2000);
    mqtt.receive('brilliant/office/availability', 'offline');
    const C = api.hap.Characteristic;
    const fan = service(accessories.get('Fan'), 'brilliant_office_gangbox_peripheral_1');
    expect(fan.getCharacteristic(C.On).statusCode).toBe(
      api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    await expect(fan.getCharacteristic(C.On).handleSetRequest(true)).rejects.toBeDefined();
    expect(mqtt.published).toEqual([]);
    mqtt.receive('brilliant/office/availability', 'online');
    expect(fan.getCharacteristic(C.On).statusCode).toBe(api.hap.HAPStatus.SUCCESS);
  });

  it('removes a service when the agent retires the entity, and the accessory with its last one', () => {
    const { mqtt, accessories } = setup();
    replay(mqtt);
    vi.advanceTimersByTime(2000);
    const fanEntities = fixture.peripherals.find((p) => p.state_topic.includes('gangbox_peripheral_1'));
    mqtt.receive('homeassistant/sensor/brilliant_office_gangbox_peripheral_1_temperature/config', '');
    vi.advanceTimersByTime(2000);
    expect(accessories.get('Fan')?.services.map((s) => s.subtype)).not.toContain(
      'brilliant_office_gangbox_peripheral_1_temperature',
    );
    for (const entity of fanEntities?.entities ?? []) {
      mqtt.receive(entity.topic, '');
    }
    vi.advanceTimersByTime(2000);
    expect(accessories.has('Fan')).toBe(false);
    expect(accessories.has('Ceiling Lights')).toBe(true);
  });

  it('honours expose/exclude/panels filters', () => {
    const { mqtt, accessories } = setup({
      expose: { panelControls: false, diagnostics: false, power: false },
      exclude: ['*motion*'],
      panels: ['office'],
    });
    replay(mqtt);
    vi.advanceTimersByTime(2000);
    expect(accessories.has('Dining Room Lights')).toBe(false);
    const subtypes = [...accessories.values()].flatMap((a) => a.services.map((s) => s.subtype));
    expect(subtypes.filter((s): s is string => s !== undefined).sort()).toEqual([
      'brilliant_office_gangbox_peripheral_0',
      'brilliant_office_gangbox_peripheral_1',
      'brilliant_office_ui_peripheral_active',
    ]);
  });

  it('exposes scenes as momentary switches and publishes confirmed commands', async () => {
    const { mqtt, accessories, api } = setup();
    vi.setSystemTime(new Date(1_700_000_000_000));
    mqtt.receive(
      'brilliant/ha-control/v1/scene/catalog/office',
      JSON.stringify({
        schema_version: 1,
        mapping_version: 1,
        panel: 'office',
        generated_at_ms: 1,
        scenes: [{ scene_id: 'all_off', display_name: 'All Off', icon: 'x' }],
      }),
    );
    vi.advanceTimersByTime(2000);
    const C = api.hap.Characteristic;
    const scene = service(accessories.get('Brilliant Office Scenes'), 'scene:all_off');
    await scene.getCharacteristic(C.On).handleSetRequest(true);
    expect(mqtt.published).toHaveLength(1);
    const sent = mqtt.published[0];
    expect(sent?.topic).toBe('brilliant/ha-control/v1/scene/command/office');
    const body = JSON.parse(sent?.payload ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      schema_version: 1,
      mapping_version: 1,
      panel: 'office',
      scene_id: 'all_off',
      issued_at_ms: 1_700_000_002_000,
    });
    expect(Object.keys(body)).toEqual([...Object.keys(body)].sort());
    mqtt.receive(
      `brilliant/ha-control/v1/scene/result/${String(body.command_id)}`,
      JSON.stringify({ command_id: body.command_id, accepted: true, panel: 'office' }),
    );
    expect(scene.getCharacteristic(C.On).value).toBe(false);
  });
});
