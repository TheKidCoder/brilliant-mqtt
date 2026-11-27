# homebridge-brilliant-mqtt

Local HomeKit control for Brilliant smart-home panels through
[Homebridge](https://homebridge.io) — no Home Assistant required.

This is the Homebridge side of a fork of
[joyfulhouse/brilliant-mqtt](https://github.com/joyfulhouse/brilliant-mqtt).
The on-panel agent and its MQTT wire format are **unchanged from upstream**;
this package adds:

- a **Homebridge platform plugin** that reads the agent's retained MQTT
  discovery + state topics and exposes them as HomeKit accessories, and
- **`brilliant-homebridge`**, a CLI that installs, updates and repairs the agent
  on panels over root SSH (the job the Home Assistant integration does
  upstream).

```
 Brilliant panel ──(on-panel agent)──▶ MQTT broker ◀──▶ Homebridge plugin ──▶ HomeKit
```

> **Status: not yet validated on real panels.** The plugin is tested against
> payloads rendered by the agent's own code and smoke-tested in Homebridge 2.5
> against a real broker; the installer is tested against a fake SSH server.
> Neither has run against a physical panel yet. **Pilot one panel first.**

## Why not the panel's built-in HomeKit pairing?

Brilliant panels pair with HomeKit natively, but only expose loads, each panel
is a separate pairing, and mesh devices show up once per panel. Through the
agent you get one deduplicated set of loads plus motion, occupancy,
illuminance, temperatures, per-circuit power, panel settings and Brilliant
scenes — and state survives restarts because it is retained on the broker.
You can leave the native pairing in place as a fallback, but then loads appear
twice in the Home app; most people remove it once this is stable.

## What appears in HomeKit

| Brilliant | HomeKit | Notes |
|---|---|---|
| Dimmer / switch load (panel or BLE mesh) | Lightbulb / Switch | One accessory per load |
| Load power (W) | Eve *Consumption* on the load | Shown by Eve, Controller for HomeKit, Home+ — **not** Apple Home |
| Always-on circuit power | Read-only Outlet + Eve *Consumption* | |
| Motion (mesh dimmers, faceplate PIR) | Motion sensor | Mesh motion needs *Motion Score Reporting* on — see `docs/TROUBLESHOOTING.md` |
| Panel in use | Occupancy sensor | Touchscreen interaction, not room presence |
| Illuminance | Light sensor | |
| Load / CPU / internal temperature | Temperature sensor | |
| Fault, camera active, Wi-Fi / internet / NTP | Contact sensor | "Open" = needs attention (fault, camera on, connection **lost**) |
| Panel settings (screen, mic mute, night mode, child lock, screensaver, …) | Switch | Grouped on one "Brilliant <Panel>" accessory |
| Volume, screen brightness, timeouts | Fan speed (or light brightness) | HomeKit has no plain slider; see `numberService` |
| Identify | Momentary switch | |
| Brilliant scenes and modes | Momentary switches on "Brilliant <Panel> Scenes/Modes" | Confirmed by the panel; failures are logged |

Not exposed (no HomeKit equivalent): raw motion/PIR scores, firmware version
string, mesh write status, voice satellite, camera snapshots/Ambilight.

Entities the agent marks *disabled by default* (motion thresholds, lock-screen
widgets, firmware auto-update, remote assistance) stay hidden unless you turn
on `expose.disabledByDefault`.

**HomeKit allows 150 accessories per bridge.** Each load is one accessory and
each panel adds one to three more. For a large house, run this plugin as a
[child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges).

## Setup

### 1. Prerequisites

- Brilliant panels with **Root SSH Login** enabled —
  [how, and Brilliant's caveats](../docs/install/root-ssh.md).
- An MQTT broker both the panels and Homebridge can reach, with a user for the
  panels — [broker guide](../docs/install/mqtt-broker.md). Mosquitto on the
  Homebridge host is the simplest:

  ```text
  # /etc/mosquitto/conf.d/brilliant.conf
  listener 1883
  allow_anonymous false
  password_file /etc/mosquitto/passwd
  persistence true          # keep retained discovery/state across broker restarts
  ```
  ```bash
  sudo mosquitto_passwd -c /etc/mosquitto/passwd brilliant
  ```

  If you use ACLs, the panels' user needs read/write on `brilliant/#` and
  write on `homeassistant/#` (the agent's discovery prefix — it is just a topic
  name here); the Homebridge user needs read on both and write on
  `brilliant/#`. **Mosquitto ACL denials are silent.**

### 2. Install the plugin

Not on npm yet. From a checkout of this repository:

```bash
cd homebridge
npm install
npm run build
sudo npm install -g .        # or: npm pack, then install the .tgz in Homebridge
```

### 3. Install the agent on each panel

```bash
brilliant-homebridge install \
  --host 192.168.1.50 \
  --panel office \
  --mqtt-host 192.168.1.10 \
  --mesh-priority 1
```

You are prompted for the panel's root password and the broker password (or set
`BRILLIANT_SSH_PASSWORD` / `MQTT_PASSWORD`). The command uploads the agent to
`/var/brilliant-mqtt`, writes `/etc/brilliant-mqtt.env` (mode 0600), installs
and starts the systemd unit, then waits for the panel to report `online` on
the broker. If the new agent fails to start, the previous one is restored.

- `--panel` is a permanent name: it namespaces the MQTT topics and the HomeKit
  accessory identities. Renaming it later creates new accessories.
- `--mqtt-host` is resolved **on the panel** — use the broker's LAN address.
- **BLE mesh devices** (Brilliant plug-in switches and mesh dimmers) are
  published by one elected panel. Give one panel `--mesh-priority 1` and one or
  two others `2`, `3` as standbys; leave the rest at the default `0`.
- The scene/mode bridge is on by default (`--no-scenes` to skip).
- `--bus-watchdog` / `--wifi-watchdog` install upstream's optional recovery
  daemons. Both can **reboot the panel**; read
  [the configuration reference](../docs/CONFIGURATION.md#bus-health-watchdog)
  before enabling them.
- Any other agent setting: `--env KEY=VALUE` (repeatable), e.g.
  `--env HOT_POLL_SECONDS=1`.

The first connection pins the panel's SSH host key in
`~/.config/brilliant-homebridge/known_hosts.json`; a changed key is refused
unless you pass `--accept-new-host-key`.

Other commands:

| Command | Purpose |
|---|---|
| `brilliant-homebridge status --host <ip>` | Agent version, broker settings, service state |
| `brilliant-homebridge logs --host <ip> [--lines 200]` | Recent agent logs |
| `brilliant-homebridge update --host <ip>` | Push this package's agent version; keeps the panel's settings |
| `brilliant-homebridge repair --host <ip>` | Restore the unit + settings from `/var` after a firmware update removed them |
| `brilliant-homebridge uninstall --host <ip>` | Stop and remove the agent |

**After a panel firmware update**, if the panel goes offline in Homebridge, run
`repair`. The agent lives in `/var`, which survives updates, but the systemd
unit in `/etc` may not. (Upstream's Home Assistant integration does this
automatically; here it is a manual step.)

### 4. Configure Homebridge

Use the plugin's settings screen in the Homebridge UI, or `config.json`:

```json
{
  "platforms": [
    {
      "platform": "BrilliantMqtt",
      "name": "Brilliant",
      "mqtt": {
        "url": "mqtt://192.168.1.10:1883",
        "username": "homebridge",
        "password": "…"
      }
    }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `mqtt.url` | `mqtt://localhost:1883` | Broker URL (`mqtts://` for TLS) |
| `mqtt.username` / `mqtt.password` | — | Broker credentials |
| `mqtt.caFile` | — | PEM file for a private CA |
| `mqtt.rejectUnauthorized` | `true` | Verify the broker certificate |
| `expose.panelControls` | `true` | Panel settings switches/sliders (~15 per panel) |
| `expose.diagnostics` | `true` | Temperatures, fault, connectivity, camera-active |
| `expose.power` | `true` | Wattage (Eve characteristic) |
| `expose.scenes` | `true` | Scene / mode switches |
| `expose.disabledByDefault` | `false` | Advanced tuning entities |
| `exclude` | `[]` | Name/id patterns to hide; `*` is a wildcard (`"*Temperature"`) |
| `panels` | `[]` (all) | Only these panel names; mesh devices are panel `mesh` |
| `numberService` | `"fan"` | Show sliders as `"fan"` speed or `"lightbulb"` brightness |
| `pruneStale` | `false` | Also remove accessories that are merely missing from the broker |

Everything is on by default. A typical trim for a calmer Home app:

```json
"expose": { "diagnostics": false },
"exclude": ["*Widget", "*Intercom*"]
```

## Behaviour worth knowing

- **Unconfirmed writes.** After a command, the agent may publish an unknown
  state until the panel confirms it (always for mesh loads). The plugin keeps
  showing the last known value during that window rather than flickering.
- **Offline panels** show *No Response* (from the agent's MQTT last-will), and
  writes to them fail immediately.
- **Accessory removal is conservative.** An accessory is removed only when the
  agent explicitly retires it or you filter it out — never just because it is
  absent from the broker, so a broker rebuild cannot wipe your HomeKit rooms
  and automations. Enable broker persistence anyway.
- **Scenes need roughly synchronised clocks.** The agent rejects scene commands
  whose timestamp is more than 15 s old or 5 s in the future relative to the
  panel's clock.
- **Sliders and "off".** Volume/brightness sliders have no real off state;
  switching one off sends its minimum value.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

`test/fixtures/agent-contract.json` is rendered by the agent's own Python code
so the plugin is tested against the real wire format. Regenerate it from the
repository root after changing the agent's discovery or state payloads:

```bash
uv run python homebridge/scripts/gen_fixtures.py
```

CI fails if it is stale.

## Keeping up with upstream

The fork adds `homebridge/` and one workflow and otherwise leaves upstream's
tree alone, so `git merge upstream/main` should stay conflict-free. After a
merge, rebuild (`npm run build` re-bundles the agent payload from
`custom_components/brilliant_mqtt/agent_payload`) and run
`brilliant-homebridge update` against each panel.
