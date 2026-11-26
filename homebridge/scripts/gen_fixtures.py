"""Generate discovery/state fixtures for the Homebridge plugin's contract tests.

The plugin (homebridge/) consumes exactly what the agent publishes. These
fixtures are rendered by the agent's own mapping/discovery code, so a change
to the wire format fails the plugin's tests (CI runs this with --check).

Usage (repo root):  uv run python homebridge/scripts/gen_fixtures.py [--check]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from brilliant_mqtt import discovery, mapping
from brilliant_mqtt.model import BrilliantDevice, DeviceKind, Variable

OUTPUT = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "agent-contract.json"

_SAMPLE = {"bool": "1", "int": "50", "float": "235", "str": "v1"}


def _device(kind: DeviceKind, peripheral_id: str, name: str) -> BrilliantDevice:
    variables = {
        spec.var: Variable(name=spec.var, value=_SAMPLE[spec.value_kind])
        for spec in mapping.AUX_SPECS.get(kind, ())
    }
    if kind in (DeviceKind.LIGHT, DeviceKind.SWITCH):
        variables["on"] = Variable(name="on", value="1")
    if kind is DeviceKind.LIGHT:
        variables["intensity"] = Variable(name="intensity", value="500")
        variables["max_intensity_value"] = Variable(name="max_intensity_value", value="1000")
    if kind is DeviceKind.BINARY_SENSOR:
        variables["lux"] = Variable(name="lux", value="120")
    return BrilliantDevice(
        device_id="control", peripheral_id=peripheral_id, name=name, kind=kind, variables=variables
    )


def render() -> str:
    cases: list[tuple[str, BrilliantDevice]] = [
        ("office", _device(DeviceKind.LIGHT, "gangbox_peripheral_0", "Ceiling Lights")),
        ("office", _device(DeviceKind.SWITCH, "gangbox_peripheral_1", "Fan")),
        ("office", _device(DeviceKind.ALWAYS_ON, "gangbox_peripheral_2", "Outlets")),
        ("office", _device(DeviceKind.BINARY_SENSOR, "motion_peripheral", "Motion")),
        ("office", _device(DeviceKind.HARDWARE, "hardware_peripheral", "Hardware")),
        ("office", _device(DeviceKind.UI, "ui_peripheral", "UI")),
        ("office", _device(DeviceKind.WIFI, "wifi_peripheral", "WiFi")),
        ("office", _device(DeviceKind.MOTION_CONFIG, "motion_config", "Motion Config")),
        ("office", _device(DeviceKind.ART_CONFIG, "art_config", "Art Config")),
        ("office", _device(DeviceKind.DEVICE_CONFIG, "device_config", "Device Config")),
        ("mesh", _device(DeviceKind.LIGHT, "mesh_dimmer_1", "Dining Room Lights")),
    ]
    peripherals = []
    for panel, device in cases:
        entities = mapping.entities_for(device, panel)
        peripherals.append(
            {
                "panel": panel,
                "kind": device.kind.value,
                "state_topic": discovery.state_topic(panel, device.peripheral_id),
                "state": mapping.payload_fields(device),
                "entities": [
                    {
                        "topic": discovery.config_topic(entity),
                        "payload": discovery.config_payload(entity, sw_version="24.10.1"),
                    }
                    for entity in entities
                ],
            }
        )
    return json.dumps({"peripherals": peripherals}, indent=2, sort_keys=True) + "\n"


def main() -> int:
    rendered = render()
    if "--check" in sys.argv[1:]:
        if not OUTPUT.exists() or OUTPUT.read_text() != rendered:
            print(f"{OUTPUT} is stale; run: uv run python homebridge/scripts/gen_fixtures.py")
            return 1
        return 0
    OUTPUT.write_text(rendered)
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
