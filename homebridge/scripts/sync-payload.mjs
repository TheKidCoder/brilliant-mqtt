#!/usr/bin/env node
// Copy the committed on-panel agent payload into this package so the published
// plugin (and its installer CLI) is self-contained. The payload's source of
// truth stays at custom_components/brilliant_mqtt/agent_payload, which upstream
// CI verifies is in sync with src/ via scripts/build_payload.sh.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../custom_components/brilliant_mqtt/agent_payload');
const dest = resolve(here, '../agent-payload');

if (!existsSync(source)) {
  if (existsSync(dest)) {
    console.log('agent payload source not found; keeping existing agent-payload/');
    process.exit(0);
  }
  console.error(`agent payload not found at ${source}`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(source, dest, {
  recursive: true,
  filter: (path) => !path.includes('__pycache__') && !path.endsWith('.pyc'),
});
console.log(`agent payload synced to ${dest}`);
