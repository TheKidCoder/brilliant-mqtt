/**
 * Remote shell snippets run on the panel. Pure string builders so the exact
 * commands are unit-testable and reviewable.
 *
 * On-panel layout (the "manual deploy" layout documented in deploy/README.md):
 *
 *   /var/brilliant-mqtt/app, vendor      agent + vendored MQTT client (survives OTA)
 *   /var/brilliant-mqtt/system/          restore copies of the unit(s) and env
 *   /etc/brilliant-mqtt.env              agent settings (0600)
 *   /etc/systemd/system/*.service        units (may be wiped by a firmware OTA;
 *                                        `repair` restores them from system/)
 */
export const ROOT = '/var/brilliant-mqtt';
export const ENV_FILE = '/etc/brilliant-mqtt.env';
export const UNIT_DIR = '/etc/systemd/system';
export const PANEL_PYTHON = '/data/switch-embedded/env/bin/python3';

export const BRIDGE_UNIT = 'brilliant-mqtt.service';
export const BUS_WATCHDOG_UNIT = 'brilliant-bus-watchdog.service';
export const WIFI_WATCHDOG_UNIT = 'brilliant-wifi-watchdog.service';

export interface Components {
  busWatchdog: boolean;
  wifiWatchdog: boolean;
}

/** Single-quote for POSIX sh. */
export function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function preflight(): string {
  return [
    'set -e',
    `test -x ${PANEL_PYTHON} || { echo "panel python not found at ${PANEL_PYTHON} - is this a Brilliant Control?" >&2; exit 20; }`,
    'command -v systemctl >/dev/null || { echo "systemctl not found" >&2; exit 21; }',
    'command -v tar >/dev/null || { echo "tar not found" >&2; exit 22; }',
    `mkdir -p ${ROOT} && test -w ${ROOT} || { echo "${ROOT} is not writable" >&2; exit 23; }`,
    `${PANEL_PYTHON} --version`,
  ].join('\n');
}

/** Receives a tar on stdin into a fresh staging directory. */
export function receive(staging: string): string {
  return `set -e\nrm -rf ${sh(staging)}\nmkdir -p ${sh(staging)}\ntar -xf - -C ${sh(staging)}`;
}

/** Writes stdin to `path` with the given mode, never world-readable in between. */
export function writeFile(path: string, mode: string): string {
  return [
    'set -e',
    'umask 077',
    `mkdir -p "$(dirname ${sh(path)})"`,
    `cat > ${sh(`${path}.new`)}`,
    `chmod ${mode} ${sh(`${path}.new`)}`,
    `mv -f ${sh(`${path}.new`)} ${sh(path)}`,
  ].join('\n');
}

/**
 * Swap the staged payload into place and (re)start services. The previous
 * app/vendor are kept as *.prev until the new bridge is active, and restored
 * if it fails to start.
 */
export function activate(staging: string, components: Components): string {
  const s = sh(staging);
  const lines = [
    'set -e',
    `cd ${ROOT}`,
    `test -d ${s}/app/brilliant_mqtt && test -d ${s}/vendor || { echo "staged payload incomplete" >&2; exit 30; }`,
    `test -s ${ENV_FILE} || { echo "${ENV_FILE} missing" >&2; exit 31; }`,
    'mkdir -p system state',
    'chmod 700 system',
    `cp -f ${ENV_FILE} system/brilliant-mqtt.env && chmod 600 system/brilliant-mqtt.env`,
    `cp -f ${s}/${BRIDGE_UNIT} system/${BRIDGE_UNIT}`,
    `systemctl stop ${BRIDGE_UNIT} 2>/dev/null || true`,
    'rm -rf app.prev vendor.prev',
    'if [ -d app ]; then mv app app.prev; fi',
    'if [ -d vendor ]; then mv vendor vendor.prev; fi',
    `mv ${s}/app app`,
    `mv ${s}/vendor vendor`,
    `cp -f ${s}/VERSION VERSION`,
    `cp -f system/${BRIDGE_UNIT} ${UNIT_DIR}/${BRIDGE_UNIT}`,
  ];
  const watchdog = (enabled: boolean, dir: string, unit: string): void => {
    if (enabled) {
      lines.push(
        `systemctl stop ${unit} 2>/dev/null || true`,
        `rm -rf ${dir}`,
        `mv ${s}/${dir} ${dir}`,
        `cp -f VERSION ${dir}/VERSION`,
        `cp -f ${s}/${unit} system/${unit}`,
        `cp -f system/${unit} ${UNIT_DIR}/${unit}`,
      );
    } else {
      lines.push(
        `systemctl disable --now ${unit} 2>/dev/null || true`,
        `rm -f ${UNIT_DIR}/${unit} system/${unit}`,
        `rm -rf ${dir}`,
      );
    }
  };
  watchdog(components.busWatchdog, 'bus_watchdog', BUS_WATCHDOG_UNIT);
  watchdog(components.wifiWatchdog, 'wifi_watchdog', WIFI_WATCHDOG_UNIT);
  lines.push(
    // A stale phase marker from a different agent version must not be read by
    // the bus watchdog (docs/reference/deployment.md).
    'rm -f /run/brilliant-mqtt/bus-phase',
    'systemctl daemon-reload',
    `systemctl enable ${BRIDGE_UNIT} >/dev/null 2>&1`,
    `systemctl restart ${BRIDGE_UNIT}`,
    'sleep 5',
    `if ! systemctl is-active --quiet ${BRIDGE_UNIT}; then`,
    '  echo "bridge failed to start; rolling back" >&2',
    `  journalctl -u ${BRIDGE_UNIT} -n 30 --no-pager >&2 || true`,
    `  systemctl stop ${BRIDGE_UNIT} 2>/dev/null || true`,
    '  if [ -d app.prev ]; then rm -rf app vendor; mv app.prev app; mv vendor.prev vendor;',
    `    systemctl restart ${BRIDGE_UNIT} || true; fi`,
    '  exit 40',
    'fi',
    'rm -rf app.prev vendor.prev',
  );
  if (components.busWatchdog) {
    lines.push(`systemctl enable --now ${BUS_WATCHDOG_UNIT} >/dev/null 2>&1`, `systemctl restart ${BUS_WATCHDOG_UNIT}`);
  }
  if (components.wifiWatchdog) {
    lines.push(`systemctl enable --now ${WIFI_WATCHDOG_UNIT} >/dev/null 2>&1`, `systemctl restart ${WIFI_WATCHDOG_UNIT}`);
  }
  lines.push(`rm -rf ${s}`, 'echo activated');
  return lines.join('\n');
}

/** Restore units + env from the /var copies (after a firmware OTA wiped /etc). */
export function repair(): string {
  return [
    'set -e',
    `cd ${ROOT}/system 2>/dev/null || { echo "no install found under ${ROOT}/system; run install" >&2; exit 50; }`,
    `test -s brilliant-mqtt.env || { echo "no saved environment; run install" >&2; exit 51; }`,
    'umask 077',
    `cp -f brilliant-mqtt.env ${ENV_FILE} && chmod 600 ${ENV_FILE}`,
    'for unit in brilliant-*.service; do',
    '  [ -f "$unit" ] || continue',
    `  cp -f "$unit" ${UNIT_DIR}/"$unit" && chmod 644 ${UNIT_DIR}/"$unit"`,
    'done',
    'systemctl daemon-reload',
    'for unit in brilliant-*.service; do',
    '  [ -f "$unit" ] || continue',
    '  systemctl enable "$unit" >/dev/null 2>&1',
    '  systemctl restart "$unit"',
    'done',
    'echo repaired',
  ].join('\n');
}

export function status(): string {
  return [
    `echo "agent_version=$(cat ${ROOT}/VERSION 2>/dev/null || echo none)"`,
    `echo "panel=$(sed -n 's/^BRILLIANT_PANEL=//p' ${ENV_FILE} 2>/dev/null | tr -d '\\"')"`,
    `for unit in ${BRIDGE_UNIT} ${BUS_WATCHDOG_UNIT} ${WIFI_WATCHDOG_UNIT}; do`,
    '  echo "$unit=$(systemctl is-active "$unit" 2>/dev/null || true)/$(systemctl is-enabled "$unit" 2>/dev/null || true)"',
    'done',
  ].join('\n');
}

export function logs(lines: number): string {
  return `journalctl -u ${BRIDGE_UNIT} -n ${Math.max(1, Math.min(2000, Math.trunc(lines)))} --no-pager`;
}

export function readEnv(): string {
  return `cat ${ENV_FILE} 2>/dev/null || cat ${ROOT}/system/brilliant-mqtt.env 2>/dev/null || true`;
}

/**
 * Stop and remove the agent. The bridge is stopped first so its LWT marks the
 * panel offline; retained discovery topics are left for the operator to clear.
 */
export function uninstall(): string {
  return [
    `for unit in ${WIFI_WATCHDOG_UNIT} ${BUS_WATCHDOG_UNIT} ${BRIDGE_UNIT}; do`,
    '  systemctl disable --now "$unit" 2>/dev/null || true',
    `  rm -f ${UNIT_DIR}/"$unit"`,
    'done',
    'systemctl daemon-reload',
    `rm -rf ${ROOT} ${ENV_FILE}`,
    'echo uninstalled',
  ].join('\n');
}
