import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type {
  API,
  Characteristic,
  CharacteristicValue,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  WithUUID,
} from 'homebridge';
import mqtt from 'mqtt';

import { parseSettings, type Settings } from './config.js';
import { parseBrilliantTopic, parseConfigTopic, parseEntity, type Entity } from './discovery.js';
import {
  brightnessToPercent,
  classify,
  contactOpen,
  groupKey,
  loadCommand,
  numberToPercent,
  parseState,
  percentToNumber,
  readBool,
  readNumber,
  type ServiceKind,
  type State,
} from './mapping.js';
import {
  catalogTopicFilter,
  commandTopic,
  encodeCommand,
  parseCatalog,
  parseResult,
  parseStatus,
  resultTopicFilter,
  statusTopicFilter,
  type Catalog,
  type ControlKind,
} from './scenes.js';
import { DISCOVERY_PREFIX, PLATFORM_NAME, PLUGIN_NAME, TOPIC_PREFIX } from './settings.js';

/** The slice of an MQTT client the platform needs (real client or a test fake). */
export interface MqttLike {
  publish(topic: string, payload: string): void;
  subscribe(topics: string[]): void;
  onMessage(handler: (topic: string, payload: string) => void): void;
  onConnect(handler: () => void): void;
  end(): void;
}

export type MqttFactory = (settings: Settings, log: Logging) => MqttLike;

/** Eve "Consumption" (W) — shown by Eve, Controller for HomeKit, Home+ etc. */
const EVE_CONSUMPTION_UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

const SYNC_DEBOUNCE_MS = 1500;
const SET_COALESCE_MS = 80;
const BUTTON_RESET_MS = 500;
const SCENE_RESULT_TIMEOUT_MS = 16_000;

interface Binding {
  entity: Entity;
  kind: ServiceKind;
  update(): void;
}

interface AccessoryContext {
  groupKey?: string;
  entityIds?: string[];
  control?: { kind: ControlKind; panel: string };
}

type Accessory = PlatformAccessory<AccessoryContext>;

function connectMqtt(settings: Settings, log: Logging): MqttLike {
  const { mqtt: m } = settings;
  const client = mqtt.connect(m.url, {
    username: m.username,
    password: m.password,
    clientId: m.clientId ?? `homebridge-brilliant-${randomUUID().slice(0, 8)}`,
    ca: m.caFile ? readFileSync(m.caFile) : undefined,
    rejectUnauthorized: m.rejectUnauthorized,
    reconnectPeriod: 5000,
    // Retained discovery/state replays on every (re)subscribe; nothing to resume.
    clean: true,
  });
  let lastError = '';
  client.on('error', (error) => {
    if (error.message !== lastError) {
      lastError = error.message;
      log.error(`MQTT error: ${error.message}`);
    }
  });
  client.on('offline', () => log.warn('MQTT broker connection lost; reconnecting'));
  return {
    publish: (topic, payload) => {
      client.publish(topic, payload, { qos: 1, retain: false });
    },
    subscribe: (topics) => {
      client.subscribe(topics, { qos: 1 }, (error) => {
        if (error) {
          log.error(`MQTT subscribe failed: ${error.message}`);
        }
      });
    },
    onMessage: (handler) => {
      client.on('message', (topic, payload) => handler(topic, payload.toString('utf8')));
    },
    onConnect: (handler) => {
      client.on('connect', () => {
        lastError = '';
        log.info(`Connected to MQTT broker ${m.url}`);
        handler();
      });
    },
    end: () => {
      client.end(true);
    },
  };
}

export class BrilliantPlatform implements DynamicPlatformPlugin {
  private readonly settings: Settings | undefined;
  private readonly accessories = new Map<string, Accessory>();
  private readonly entities = new Map<string, Entity>();
  private readonly deleted = new Set<string>();
  private readonly states = new Map<string, State>();
  private readonly availability = new Map<string, boolean>();
  private readonly bindings = new Map<string, Binding>();
  private readonly catalogs = new Map<string, Catalog>();
  private readonly controlAvailable = new Map<string, boolean>();
  private readonly pendingCommands = new Map<string, (accepted: boolean, error?: string) => void>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly consumption: WithUUID<new () => Characteristic>;
  private client: MqttLike | undefined;
  private syncTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly log: Logging,
    config: PlatformConfig,
    private readonly api: API,
    private readonly mqttFactory: MqttFactory = connectMqtt,
  ) {
    const { Characteristic: C, Formats, Perms } = api.hap;
    this.consumption = class Consumption extends C {
      static readonly UUID = EVE_CONSUMPTION_UUID;
      constructor() {
        super('Consumption', EVE_CONSUMPTION_UUID, {
          format: Formats.FLOAT,
          unit: 'W',
          minValue: 0,
          maxValue: 100000,
          minStep: 0.1,
          perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
      }
    };

    try {
      this.settings = parseSettings(config);
    } catch (error) {
      this.log.error(`Invalid configuration; plugin disabled: ${(error as Error).message}`);
      return;
    }
    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => this.stop());
  }

  /** Homebridge restores cached accessories through this hook before launch. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory as Accessory);
  }

  private start(): void {
    const settings = this.settings;
    if (!settings) {
      return;
    }
    const client = this.mqttFactory(settings, this.log);
    this.client = client;
    client.onMessage((topic, payload) => {
      try {
        this.handleMessage(topic, payload);
      } catch (error) {
        this.log.error(`Failed handling ${topic}: ${(error as Error).stack ?? String(error)}`);
      }
    });
    client.onConnect(() => {
      const topics = [
        `${DISCOVERY_PREFIX}/+/+/config`,
        `${TOPIC_PREFIX}/+/+/state`,
        `${TOPIC_PREFIX}/+/availability`,
      ];
      if (settings.expose.scenes) {
        for (const kind of ['scene', 'mode'] as const) {
          topics.push(catalogTopicFilter(kind), resultTopicFilter(kind), statusTopicFilter(kind));
        }
      }
      client.subscribe(topics);
    });
  }

  private stop(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.client?.end();
  }

  private later(ms: number, fn: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private includesPanel(panel: string): boolean {
    const panels = this.settings?.panels ?? [];
    return panels.length === 0 || panels.includes(panel);
  }

  // ---------------------------------------------------------------- inbound

  /** Exposed for tests: feed one MQTT message through the platform. */
  handleMessage(topic: string, payload: string): void {
    if (topic.startsWith(`${DISCOVERY_PREFIX}/`)) {
      this.handleDiscovery(topic, payload);
      return;
    }
    if (topic.startsWith(`${TOPIC_PREFIX}/ha-control/`)) {
      this.handleControl(topic, payload);
      return;
    }
    const parts = topic.split('/');
    if (parts.length === 3 && parts[0] === TOPIC_PREFIX && parts[2] === 'availability') {
      const online = payload === 'online';
      if (this.availability.get(topic) !== online) {
        this.availability.set(topic, online);
        this.log.info(`Panel ${parts[1]} is ${online ? 'online' : 'offline'}`);
        for (const binding of this.bindings.values()) {
          if (binding.entity.availabilityTopic === topic) {
            binding.update();
          }
        }
      }
      return;
    }
    const location = parseBrilliantTopic(topic);
    if (location?.leaf === 'state') {
      const state = parseState(payload);
      if (!state) {
        return;
      }
      this.states.set(topic, state);
      for (const binding of this.bindings.values()) {
        if (binding.entity.stateTopic === topic) {
          binding.update();
        }
      }
    }
  }

  private handleDiscovery(topic: string, payload: string): void {
    const parsed = parseConfigTopic(topic);
    if (!parsed) {
      return;
    }
    if (payload.length === 0) {
      // Empty retained payload = the agent retired this entity.
      for (const [id, entity] of this.entities) {
        if (id === parsed.objectId || entity.uniqueId === parsed.objectId) {
          this.entities.delete(id);
        }
      }
      this.deleted.add(parsed.objectId);
      this.scheduleSync();
      return;
    }
    const entity = parseEntity(topic, payload);
    if (!entity || !this.includesPanel(entity.panel)) {
      return;
    }
    this.deleted.delete(entity.uniqueId);
    const previous = this.entities.get(entity.uniqueId);
    if (previous && JSON.stringify(previous) === JSON.stringify(entity)) {
      return;
    }
    this.entities.set(entity.uniqueId, entity);
    this.scheduleSync();
  }

  private handleControl(topic: string, payload: string): void {
    const result = parseResult(topic, payload);
    if (result) {
      const resolve = this.pendingCommands.get(result.commandId);
      if (resolve) {
        this.pendingCommands.delete(result.commandId);
        resolve(result.accepted, result.error);
      }
      return;
    }
    const status = parseStatus(topic, payload);
    if (status) {
      this.controlAvailable.set(`${status.kind}/${status.panel}`, status.available);
      return;
    }
    const catalog = parseCatalog(topic, payload);
    if (catalog && this.includesPanel(catalog.panel)) {
      this.catalogs.set(`${catalog.kind}/${catalog.panel}`, catalog);
      this.scheduleSync();
    }
  }

  private scheduleSync(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      try {
        this.sync();
      } catch (error) {
        this.log.error(`Accessory sync failed: ${(error as Error).stack ?? String(error)}`);
      }
    }, SYNC_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------------- sync

  /** Reconcile HomeKit accessories with the discovered entity set. */
  sync(): void {
    const settings = this.settings;
    if (!settings) {
      return;
    }
    const exposed: { entity: Entity; kind: ServiceKind }[] = [];
    for (const entity of this.entities.values()) {
      const kind = classify(entity, settings.expose, settings.exclude);
      if (kind) {
        exposed.push({ entity, kind });
      }
    }
    const withPrimary = new Set(
      exposed.filter((e) => e.entity.primary).map((e) => `${e.entity.panel}/${e.entity.peripheral}`),
    );
    const groups = new Map<string, { entity: Entity; kind: ServiceKind }[]>();
    for (const item of exposed) {
      const key = groupKey(item.entity, withPrimary);
      const group = groups.get(key);
      if (group) {
        group.push(item);
      } else {
        groups.set(key, [item]);
      }
    }

    this.bindings.clear();
    const live = new Set<string>();

    for (const [key, members] of groups) {
      const primary = members.find((m) => m.entity.primary);
      const first = members[0];
      if (!first) {
        continue;
      }
      const name = primary?.entity.name ?? first.entity.deviceName;
      const accessory = this.ensureAccessory(key, name);
      live.add(accessory.UUID);
      accessory.context.groupKey = key;
      accessory.context.entityIds = [
        ...new Set([...(accessory.context.entityIds ?? []), ...members.map((m) => m.entity.uniqueId)]),
      ];
      this.setInformation(accessory, first.entity, key);

      const wanted = new Set<string>();
      // Primaries first so power can attach to the load's own service.
      const ordered = [...members].sort((a, b) => Number(b.entity.primary) - Number(a.entity.primary));
      let primaryService: Service | undefined;
      for (const { entity, kind } of ordered) {
        const binding = this.bind(accessory, entity, kind, primaryService, wanted);
        if (!binding) {
          continue;
        }
        if (entity.primary) {
          primaryService = accessory.getServiceById(this.serviceType(kind), entity.uniqueId);
          primaryService?.setPrimaryService(true);
        }
        this.bindings.set(entity.uniqueId, binding);
        binding.update();
      }
      this.removeUnwantedServices(accessory, wanted);
      this.api.updatePlatformAccessories([accessory]);
    }

    if (settings.expose.scenes) {
      for (const catalog of this.catalogs.values()) {
        if (catalog.items.length === 0) {
          continue;
        }
        live.add(this.syncCatalog(catalog).UUID);
      }
    }

    // Retire accessories that are provably gone. An accessory merely missing
    // from the broker (e.g. retained messages lost in a broker rebuild) is kept
    // unless pruneStale is set: removing it would discard the user's HomeKit
    // room assignments and automations.
    for (const [uuid, accessory] of this.accessories) {
      if (live.has(uuid)) {
        continue;
      }
      const ids = accessory.context.entityIds ?? [];
      const provablyGone =
        ids.length > 0 &&
        ids.every((id) => this.deleted.has(id) || (this.entities.has(id) && !this.bindings.has(id)));
      const control = accessory.context.control;
      const sceneDisabled =
        control !== undefined &&
        (!settings.expose.scenes ||
          this.catalogs.get(`${control.kind}/${control.panel}`)?.items.length === 0);
      if (settings.pruneStale || provablyGone || sceneDisabled) {
        this.log.info(`Removing accessory ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  private ensureAccessory(key: string, name: string): Accessory {
    const uuid = this.api.hap.uuid.generate(`brilliant:${key}`);
    const existing = this.accessories.get(uuid);
    if (existing) {
      return existing;
    }
    this.log.info(`Adding accessory ${name}`);
    const accessory = new this.api.platformAccessory<AccessoryContext>(name, uuid);
    this.accessories.set(uuid, accessory);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    return accessory;
  }

  private setInformation(accessory: Accessory, entity: Entity, key: string): void {
    const { Service: S, Characteristic: C } = this.api.hap;
    const info = accessory.getService(S.AccessoryInformation);
    if (!info) {
      return;
    }
    info
      .setCharacteristic(C.Manufacturer, 'Brilliant')
      .setCharacteristic(C.Model, entity.model ?? 'Control')
      .setCharacteristic(C.SerialNumber, key.replace(/^[a-z]+:/, '').slice(0, 64));
    if (entity.firmware && /^\d+(\.\d+){0,2}$/.test(entity.firmware)) {
      info.setCharacteristic(C.FirmwareRevision, entity.firmware);
    }
  }

  private serviceType(kind: ServiceKind): WithUUID<typeof Service> {
    const { Service: S } = this.api.hap;
    switch (kind) {
      case 'lightbulb':
        return S.Lightbulb;
      case 'switch':
      case 'button':
        return S.Switch;
      case 'motion':
        return S.MotionSensor;
      case 'occupancy':
        return S.OccupancySensor;
      case 'contact':
        return S.ContactSensor;
      case 'temperature':
        return S.TemperatureSensor;
      case 'illuminance':
        return S.LightSensor;
      case 'power':
        return S.Outlet;
      case 'number':
        return this.settings?.numberService === 'lightbulb' ? S.Lightbulb : S.Fanv2;
    }
  }

  /** Get or (re)create the service for an entity, keyed by its unique id. */
  private ensureService(accessory: Accessory, entity: Entity, kind: ServiceKind): Service {
    const { Characteristic: C } = this.api.hap;
    const type = this.serviceType(kind);
    const stale = accessory.services.find((s) => s.subtype === entity.uniqueId && s.UUID !== type.UUID);
    if (stale) {
      accessory.removeService(stale);
    }
    const existing = accessory.getServiceById(type, entity.uniqueId);
    if (existing) {
      return existing;
    }
    const service = accessory.addService(type, entity.name, entity.uniqueId);
    // ConfiguredName is what the Home app shows for services of a multi-service
    // accessory. Set once at creation so user renames survive.
    service.addOptionalCharacteristic(C.ConfiguredName);
    service.setCharacteristic(C.ConfiguredName, entity.name);
    return service;
  }

  private removeUnwantedServices(accessory: Accessory, wanted: ReadonlySet<string>): void {
    for (const service of [...accessory.services]) {
      if (service.subtype !== undefined && !wanted.has(service.subtype)) {
        accessory.removeService(service);
      }
    }
  }

  // --------------------------------------------------------------- bindings

  private isOnline(entity: Entity): boolean {
    // Unknown availability (no retained LWT seen yet) is treated as online.
    return entity.availabilityTopic === undefined
      ? true
      : this.availability.get(entity.availabilityTopic) !== false;
  }

  private stateOf(entity: Entity): State {
    return (entity.stateTopic && this.states.get(entity.stateTopic)) || {};
  }

  private offline(): Error {
    const { HapStatusError, HAPStatus } = this.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private publish(entity: Entity, payload: string): void {
    if (!entity.commandTopic || !this.client) {
      throw this.offline();
    }
    if (!this.isOnline(entity)) {
      throw this.offline();
    }
    this.log.debug(`→ ${entity.commandTopic} ${payload}`);
    this.client.publish(entity.commandTopic, payload);
  }

  /**
   * Push `value` into a characteristic, or the offline error when the panel's
   * LWT says it is down. An unknown value leaves the last value in place.
   */
  private push(
    service: Service,
    characteristic: WithUUID<new () => Characteristic>,
    entity: Entity,
    value: CharacteristicValue | undefined,
  ): void {
    if (!this.isOnline(entity)) {
      service.updateCharacteristic(characteristic, this.offline());
      return;
    }
    if (value !== undefined) {
      service.updateCharacteristic(characteristic, value);
    }
  }

  private ensureConsumption(service: Service): void {
    if (!service.characteristics.some((c) => c.UUID === EVE_CONSUMPTION_UUID)) {
      service.addCharacteristic(this.consumption);
    }
  }

  private bind(
    accessory: Accessory,
    entity: Entity,
    kind: ServiceKind,
    primaryService: Service | undefined,
    wanted: Set<string>,
  ): Binding | undefined {
    const { Characteristic: C } = this.api.hap;

    if (kind === 'power' && primaryService) {
      // Wattage rides on the load's own tile as an Eve characteristic.
      this.ensureConsumption(primaryService);
      const service = primaryService;
      return {
        entity,
        kind,
        update: () => {
          const watts = readNumber(entity, this.stateOf(entity));
          if (watts !== undefined) {
            service.updateCharacteristic(this.consumption, Math.max(0, watts));
          }
        },
      };
    }

    const service = this.ensureService(accessory, entity, kind);
    wanted.add(entity.uniqueId);
    const bool = (): boolean | undefined => readBool(entity, this.stateOf(entity));
    const number = (): number | undefined => readNumber(entity, this.stateOf(entity));

    switch (kind) {
      case 'lightbulb': {
        let pending: { on?: boolean; percent?: number } | undefined;
        const queue = (change: { on?: boolean; percent?: number }): void => {
          if (!this.isOnline(entity)) {
            throw this.offline();
          }
          if (pending) {
            Object.assign(pending, change);
            return;
          }
          pending = { ...change };
          // HomeKit sends On and Brightness as separate writes for one gesture;
          // coalesce them into a single command so the load moves once.
          this.later(SET_COALESCE_MS, () => {
            const batch = pending;
            pending = undefined;
            if (!batch) {
              return;
            }
            try {
              this.publish(entity, loadCommand(batch.on, batch.percent));
            } catch {
              this.log.warn(`${entity.name}: panel offline; command dropped`);
            }
          });
        };
        service.getCharacteristic(C.On).onSet((value) => queue({ on: value === true }));
        if (entity.brightness) {
          service
            .getCharacteristic(C.Brightness)
            .onSet((value) => queue({ percent: Number(value) }));
        } else if (service.testCharacteristic(C.Brightness)) {
          service.removeCharacteristic(service.getCharacteristic(C.Brightness));
        }
        return {
          entity,
          kind,
          update: () => {
            const state = this.stateOf(entity);
            this.push(service, C.On, entity, bool());
            if (entity.brightness) {
              const percent = brightnessToPercent(state.brightness);
              // Keep the last level while off so "on" restores the slider.
              if (percent !== undefined && percent > 0) {
                service.updateCharacteristic(C.Brightness, percent);
              }
            }
          },
        };
      }

      case 'switch': {
        service.getCharacteristic(C.On).onSet((value) => {
          const on = value === true;
          this.publish(
            entity,
            entity.primary ? JSON.stringify({ state: on ? 'ON' : 'OFF' }) : on ? 'ON' : 'OFF',
          );
        });
        return { entity, kind, update: () => this.push(service, C.On, entity, bool()) };
      }

      case 'button': {
        service.updateCharacteristic(C.On, false);
        service.getCharacteristic(C.On).onSet((value) => {
          if (value !== true) {
            return;
          }
          this.publish(entity, 'PRESS');
          this.later(BUTTON_RESET_MS, () => service.updateCharacteristic(C.On, false));
        });
        return { entity, kind, update: () => undefined };
      }

      case 'motion':
        return { entity, kind, update: () => this.push(service, C.MotionDetected, entity, bool()) };

      case 'occupancy':
        return {
          entity,
          kind,
          update: () => {
            const value = bool();
            this.push(service, C.OccupancyDetected, entity, value === undefined ? undefined : value ? 1 : 0);
          },
        };

      case 'contact':
        return {
          entity,
          kind,
          update: () => {
            const value = bool();
            this.push(
              service,
              C.ContactSensorState,
              entity,
              value === undefined ? undefined : contactOpen(entity, value) ? 1 : 0,
            );
          },
        };

      case 'temperature': {
        service.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -40, maxValue: 150 });
        return {
          entity,
          kind,
          update: () => {
            const value = number();
            this.push(
              service,
              C.CurrentTemperature,
              entity,
              value === undefined ? undefined : Math.max(-40, Math.min(150, value)),
            );
          },
        };
      }

      case 'illuminance':
        return {
          entity,
          kind,
          update: () => {
            const value = number();
            this.push(
              service,
              C.CurrentAmbientLightLevel,
              entity,
              value === undefined ? undefined : Math.max(0.0001, Math.min(100000, value)),
            );
          },
        };

      case 'power': {
        // An always-on circuit has no load tile; give its wattage a read-only outlet.
        this.ensureConsumption(service);
        service.updateCharacteristic(C.On, true);
        service.getCharacteristic(C.On).onSet((value) => {
          if (value !== true) {
            this.later(BUTTON_RESET_MS, () => service.updateCharacteristic(C.On, true));
          }
        });
        return {
          entity,
          kind,
          update: () => {
            const watts = number();
            if (watts !== undefined) {
              service.updateCharacteristic(this.consumption, Math.max(0, watts));
              service.updateCharacteristic(C.OutletInUse, watts > 0);
            }
          },
        };
      }

      case 'number': {
        const lightbulb = this.settings?.numberService === 'lightbulb';
        const level = lightbulb ? C.Brightness : C.RotationSpeed;
        const send = (percent: number): void =>
          this.publish(entity, String(percentToNumber(entity, percent)));
        service.getCharacteristic(level).onSet((value) => send(Number(value)));
        // The slider has no real "off": switching off sends the minimum.
        if (lightbulb) {
          service.getCharacteristic(C.On).onSet((value) => {
            if (value !== true) {
              send(0);
            }
          });
        } else {
          service.getCharacteristic(C.Active).onSet((value) => {
            if (value !== 1) {
              send(0);
            }
          });
        }
        return {
          entity,
          kind,
          update: () => {
            const value = number();
            const percent = value === undefined ? undefined : numberToPercent(entity, value);
            this.push(service, level, entity, percent);
            if (percent !== undefined) {
              if (lightbulb) {
                service.updateCharacteristic(C.On, percent > 0);
              } else {
                service.updateCharacteristic(C.Active, percent > 0 ? 1 : 0);
              }
            }
          },
        };
      }
    }
  }

  // ----------------------------------------------------------------- scenes

  private syncCatalog(catalog: Catalog): Accessory {
    const { Service: S, Characteristic: C } = this.api.hap;
    const panelName = catalog.panel.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const label = catalog.kind === 'scene' ? 'Scenes' : 'Modes';
    const accessory = this.ensureAccessory(
      `control:${catalog.kind}/${catalog.panel}`,
      `Brilliant ${panelName} ${label}`,
    );
    accessory.context.control = { kind: catalog.kind, panel: catalog.panel };
    accessory
      .getService(S.AccessoryInformation)
      ?.setCharacteristic(C.Manufacturer, 'Brilliant')
      .setCharacteristic(C.Model, `Control ${label}`)
      .setCharacteristic(C.SerialNumber, `${catalog.kind}/${catalog.panel}`.slice(0, 64));

    const wanted = new Set<string>();
    for (const item of catalog.items) {
      const subtype = `${catalog.kind}:${item.id}`;
      wanted.add(subtype);
      let service = accessory.getServiceById(S.Switch, subtype);
      if (!service) {
        service = accessory.addService(S.Switch, item.name, subtype);
        service.addOptionalCharacteristic(C.ConfiguredName);
        service.setCharacteristic(C.ConfiguredName, item.name);
      }
      const target = service;
      target.updateCharacteristic(C.On, false);
      target.getCharacteristic(C.On).onSet((value) => {
        if (value !== true) {
          return;
        }
        this.runControl(catalog.kind, catalog.panel, item.id, item.name, () =>
          target.updateCharacteristic(C.On, false),
        );
      });
    }
    this.removeUnwantedServices(accessory, wanted);
    this.api.updatePlatformAccessories([accessory]);
    return accessory;
  }

  /**
   * Run a scene / set a mode. Returns immediately (the agent confirms only
   * after it observes the execution, which can outlast HomeKit's write
   * timeout); the outcome is logged and the momentary switch resets.
   */
  private runControl(
    kind: ControlKind,
    panel: string,
    id: string,
    name: string,
    reset: () => void,
  ): void {
    if (!this.client || this.controlAvailable.get(`${kind}/${panel}`) === false) {
      this.later(BUTTON_RESET_MS, reset);
      throw this.offline();
    }
    const commandId = randomUUID();
    const timeout = this.later(SCENE_RESULT_TIMEOUT_MS, () => {
      if (this.pendingCommands.delete(commandId)) {
        this.log.warn(`${kind} "${name}" on ${panel}: no confirmation from the panel`);
        reset();
      }
    });
    this.pendingCommands.set(commandId, (accepted, error) => {
      clearTimeout(timeout);
      this.timers.delete(timeout);
      if (accepted) {
        this.log.info(`${kind} "${name}" ran on ${panel}`);
      } else {
        this.log.warn(`${kind} "${name}" rejected by ${panel}: ${error ?? 'unknown error'}`);
      }
      reset();
    });
    this.client.publish(
      commandTopic(kind, panel),
      encodeCommand(kind, panel, id, commandId, Date.now()),
    );
  }
}
