/**
 * Brilliant scene/mode transport (`brilliant/ha-control/v1/...`).
 *
 * Wire contract: docs/brilliant-panel/home-assistant-integration.md. Requires
 * `SCENE_BRIDGE_ENABLED=1` on the panel agent. Pure module.
 */
import { CONTROL_PREFIX } from './settings.js';

export type ControlKind = 'scene' | 'mode';

export interface CatalogItem {
  id: string;
  name: string;
}

export interface Catalog {
  kind: ControlKind;
  panel: string;
  items: CatalogItem[];
}

export interface ControlResult {
  kind: ControlKind;
  commandId: string;
  accepted: boolean;
  error?: string;
}

const PANEL_SLUG = /^[a-z0-9][a-z0-9_-]*$/;

export function catalogTopicFilter(kind: ControlKind): string {
  return `${CONTROL_PREFIX}/${kind}/catalog/+`;
}

export function resultTopicFilter(kind: ControlKind): string {
  return `${CONTROL_PREFIX}/${kind}/result/+`;
}

export function statusTopicFilter(kind: ControlKind): string {
  return `${CONTROL_PREFIX}/status/${kind}/+`;
}

export function commandTopic(kind: ControlKind, panel: string): string {
  return `${CONTROL_PREFIX}/${kind}/command/${panel}`;
}

function object(payload: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(payload);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Topic under the control prefix → `[segment, ...]` after the prefix. */
function controlPath(topic: string): string[] | undefined {
  return topic.startsWith(`${CONTROL_PREFIX}/`)
    ? topic.slice(CONTROL_PREFIX.length + 1).split('/')
    : undefined;
}

export function parseCatalog(topic: string, payload: string): Catalog | undefined {
  const path = controlPath(topic);
  if (!path || path.length !== 3 || path[1] !== 'catalog') {
    return undefined;
  }
  const kind = path[0];
  const panel = path[2];
  if ((kind !== 'scene' && kind !== 'mode') || panel === undefined || !PANEL_SLUG.test(panel)) {
    return undefined;
  }
  const doc = object(payload);
  if (!doc || doc.schema_version !== 1 || doc.panel !== panel) {
    return undefined;
  }
  const list = kind === 'scene' ? doc.scenes : doc.modes;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const idKey = kind === 'scene' ? 'scene_id' : 'mode_id';
  const items: CatalogItem[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const item = raw as Record<string, unknown>;
    const id = item[idKey];
    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }
    const name = typeof item.display_name === 'string' && item.display_name ? item.display_name : id;
    items.push({ id, name });
  }
  return { kind, panel, items };
}

/** Retained transport status → `{kind, panel, available}`. */
export function parseStatus(
  topic: string,
  payload: string,
): { kind: ControlKind; panel: string; available: boolean } | undefined {
  const path = controlPath(topic);
  if (!path || path.length !== 3 || path[0] !== 'status') {
    return undefined;
  }
  const kind = path[1];
  const panel = path[2];
  if ((kind !== 'scene' && kind !== 'mode') || panel === undefined) {
    return undefined;
  }
  const doc = object(payload);
  if (!doc) {
    return undefined;
  }
  return { kind, panel, available: doc.available === true };
}

export function parseResult(topic: string, payload: string): ControlResult | undefined {
  const path = controlPath(topic);
  if (!path || path.length !== 3 || path[1] !== 'result') {
    return undefined;
  }
  const kind = path[0];
  const commandId = path[2];
  if ((kind !== 'scene' && kind !== 'mode') || commandId === undefined) {
    return undefined;
  }
  const doc = object(payload);
  if (!doc || doc.command_id !== commandId || typeof doc.accepted !== 'boolean') {
    return undefined;
  }
  return {
    kind,
    commandId,
    accepted: doc.accepted,
    error: typeof doc.error === 'string' ? doc.error : undefined,
  };
}

/** Canonical compact JSON with sorted keys, as the agent's decoder expects. */
export function encodeCommand(
  kind: ControlKind,
  panel: string,
  id: string,
  commandId: string,
  nowMs: number,
): string {
  const body: Record<string, unknown> = {
    command_id: commandId,
    issued_at_ms: nowMs,
    mapping_version: 1,
    panel,
    schema_version: 1,
    [kind === 'scene' ? 'scene_id' : 'mode_id']: id,
  };
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(body).sort()) {
    sorted[key] = body[key];
  }
  return JSON.stringify(sorted);
}
