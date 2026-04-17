#!/usr/bin/env python3
"""
VanMoof S3 BLE diagnostic CLI.

Setup:
    pip install -r requirements.txt

Credentials:
    Copy the value of 'vm-bike-credentials' from your browser's localStorage
    (DevTools → Application → Local Storage → your site) into credentials.json.

    Format (single bike or array):
        {"mac":"AB:CD:EF:12:34:56","encryptionKey":"aabbccdd...","userKeyId":1,"name":"My Bike"}
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

from Crypto.Cipher import AES
from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError

# ── Service / Characteristic UUIDs ───────────────────────────────────────────

SECURITY_SERVICE   = "6acc5500-e631-4069-944d-b8ca7598ad50"
FIRMWARE_SERVICE   = "6acc5510-e631-4069-944d-b8ca7598ad50"
DEFENSE_SERVICE    = "6acc5520-e631-4069-944d-b8ca7598ad50"
MOVEMENT_SERVICE   = "6acc5530-e631-4069-944d-b8ca7598ad50"
BIKE_INFO_SERVICE  = "6acc5540-e631-4069-944d-b8ca7598ad50"
BIKE_STATE_SERVICE = "6acc5560-e631-4069-944d-b8ca7598ad50"
SOUND_SERVICE      = "6acc5570-e631-4069-944d-b8ca7598ad50"
LIGHT_SERVICE      = "6acc5580-e631-4069-944d-b8ca7598ad50"

CHARS: dict[str, str] = {
    # Security
    "CHALLENGE":                  "6acc5501-e631-4069-944d-b8ca7598ad50",
    "KEY_INDEX":                  "6acc5502-e631-4069-944d-b8ca7598ad50",
    "BACKUP_CODE":                "6acc5503-e631-4069-944d-b8ca7598ad50",
    "BIKE_MESSAGE":               "6acc5505-e631-4069-944d-b8ca7598ad50",
    # Defense
    "LOCK_STATE":                 "6acc5521-e631-4069-944d-b8ca7598ad50",
    "UNLOCK_REQUEST":             "6acc5522-e631-4069-944d-b8ca7598ad50",
    "ALARM_STATE":                "6acc5523-e631-4069-944d-b8ca7598ad50",
    "ALARM_MODE":                 "6acc5524-e631-4069-944d-b8ca7598ad50",
    # Movement
    "DISTANCE":                   "6acc5531-e631-4069-944d-b8ca7598ad50",
    "SPEED":                      "6acc5532-e631-4069-944d-b8ca7598ad50",
    "UNIT_SYSTEM":                "6acc5533-e631-4069-944d-b8ca7598ad50",
    "POWER_LEVEL":                "6acc5534-e631-4069-944d-b8ca7598ad50",
    "SPEED_LIMIT":                "6acc5535-e631-4069-944d-b8ca7598ad50",
    "E_SHIFTER_GEAR":             "6acc5536-e631-4069-944d-b8ca7598ad50",
    "E_SHIFTER_MODE":             "6acc5538-e631-4069-944d-b8ca7598ad50",
    # Bike info
    "MOTOR_BATTERY_LEVEL":        "6acc5541-e631-4069-944d-b8ca7598ad50",
    "MOTOR_BATTERY_STATE":        "6acc5542-e631-4069-944d-b8ca7598ad50",
    "MODULE_BATTERY_LEVEL":       "6acc5543-e631-4069-944d-b8ca7598ad50",
    "BIKE_FIRMWARE_VERSION":      "6acc554a-e631-4069-944d-b8ca7598ad50",
    "BLE_CHIP_FIRMWARE_VERSION":  "6acc554b-e631-4069-944d-b8ca7598ad50",
    "CONTROLLER_FIRMWARE_VERSION":"6acc554c-e631-4069-944d-b8ca7598ad50",
    "FRAME_NUMBER":               "6acc5552-e631-4069-944d-b8ca7598ad50",
    # Bike state
    "MODULE_MODE":                "6acc5561-e631-4069-944d-b8ca7598ad50",
    "MODULE_STATE":               "6acc5562-e631-4069-944d-b8ca7598ad50",
    "ERRORS":                     "6acc5563-e631-4069-944d-b8ca7598ad50",
    "WHEEL_SIZE":                 "6acc5564-e631-4069-944d-b8ca7598ad50",
    # Sound
    "PLAY_SOUND":                 "6acc5571-e631-4069-944d-b8ca7598ad50",
    "SOUND_VOLUME":               "6acc5572-e631-4069-944d-b8ca7598ad50",
    "BELL_SOUND":                 "6acc5574-e631-4069-944d-b8ca7598ad50",
    # Light
    "LIGHT_MODE":                 "6acc5581-e631-4069-944d-b8ca7598ad50",
    # Firmware OTA
    "FIRMWARE_METADATA":          "6acc5511-e631-4069-944d-b8ca7598ad50",
    "FIRMWARE_BLOCK":             "6acc5512-e631-4069-944d-b8ca7598ad50",
}

UUID_TO_NAME = {v: k for k, v in CHARS.items()}

# ── Crypto helpers ────────────────────────────────────────────────────────────

def _aes_ecb(key: bytes) -> AES:
    return AES.new(key, AES.MODE_ECB)

def encrypt_block(key: bytes, data: bytes) -> bytes:
    """AES-ECB encrypt. Data must be a multiple of 16 bytes."""
    return _aes_ecb(key).encrypt(data)

def decrypt_value(key: bytes, data: bytes) -> bytes:
    """Mirrors bike.ts decrypt(): AES-ECB decrypt, strip trailing zero-padding."""
    decrypted = bytearray(_aes_ecb(key).decrypt(data))
    # Reverse, strip leading zeros, reverse back (= strip trailing zeros)
    decrypted.reverse()
    while decrypted and decrypted[0] == 0:
        decrypted = decrypted[1:]
    decrypted.reverse()
    return bytes(decrypted)

# ── Formatting helpers ────────────────────────────────────────────────────────

def fmt_hex(data: bytes) -> str:
    return " ".join(f"{b:02x}" for b in data) if data else "(empty)"

def parse_hex(s: str) -> bytes:
    s = s.replace(" ", "")
    if len(s) % 2 != 0:
        raise ValueError("Odd number of hex digits")
    return bytes(int(s[i:i+2], 16) for i in range(0, len(s), 2))

# ── CLI ───────────────────────────────────────────────────────────────────────

HELP = """
Commands:
  props <char>                       Show GATT properties (read/write/notify/etc.)
  read <char> [dec]                  Read characteristic (add 'dec' to AES-decrypt result)
  write    <char> <hex>              ATT Write Request  — raw bytes, expects ACK
  writewor <char> <hex>              ATT Write Command  — raw bytes, fire-and-forget
  writenonce   <char> <hex> [wor]    Write AES(nonce + data), add 'wor' for no-response
  writedirect  <char> <hex> [wor]    Write AES(data padded to 16), no nonce, add 'wor' for no-response
  sub   <char> [dec]                 Subscribe to notifications (add 'dec' to decrypt)
  unsub <char>                       Unsubscribe
  auth                               Re-authenticate (re-run challenge-response)
  pair                               Attempt BLE pairing/bonding (needed for signed writes)
  writepasscode <char>               Write raw passcode bytes to a characteristic
  unlock                             Macro: try all known unlock sequences in order
  chars                              List all known characteristic names & UUIDs
  quit                               Disconnect and exit

Char names are case-insensitive, e.g.:  LOCK_STATE  unlock_request  alarm_mode

Quick unlock test sequence:
  props UNLOCK_REQUEST
  sub LOCK_STATE dec
  writepasscode BACKUP_CODE          # send passcode as secondary auth
  writewor UNLOCK_REQUEST 01         # then try raw unlock byte
  writedirect UNLOCK_REQUEST 01 wor  # AES(01 + zeros)
  writenonce UNLOCK_REQUEST 0201 wor # AES(nonce + 0201)
  unlock                             # automated sweep of all sequences
"""


class BikeCLI:
    def __init__(self, client: BleakClient, key: bytes, user_key_id: int, passcode: bytes | None = None):
        self.client = client
        self.key = key
        self.user_key_id = user_key_id
        self.passcode = passcode
        self._subscribed: set[str] = set()

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _resolve(self, name: str) -> str:
        """Resolve a char name (case-insensitive) or UUID to a UUID string."""
        upper = name.upper()
        if upper in CHARS:
            return CHARS[upper]
        lower = name.lower()
        if lower in UUID_TO_NAME:
            return lower
        raise ValueError(
            f"Unknown characteristic: {name!r}\n"
            f"  Known names: {', '.join(CHARS)}"
        )

    async def _read_challenge(self) -> bytes:
        return bytes(await self.client.read_gatt_char(CHARS["CHALLENGE"]))

    async def _make_nonce_payload(self, data: bytes) -> bytes:
        """Mirrors bike.ts makeEncryptedPayloadWithoutQueue: encrypt(nonce + data + padding)."""
        nonce = await self._read_challenge()
        combined = nonce + data
        pad_len = 16 - (len(combined) % 16)  # always 1–16, matching TypeScript behaviour
        combined = combined + b"\x00" * pad_len
        return encrypt_block(self.key, combined)

    # ── Commands ──────────────────────────────────────────────────────────────

    async def authenticate(self):
        nonce = await self._read_challenge()
        to_encrypt = nonce + b"\x00" * (16 - len(nonce))
        encrypted = encrypt_block(self.key, to_encrypt)
        payload = encrypted + bytes([0, 0, 0, self.user_key_id])
        await self.client.write_gatt_char(CHARS["KEY_INDEX"], payload, response=True)
        print("  Authenticated.")

    async def cmd_props(self, char_name: str):
        uuid = self._resolve(char_name)
        char = self.client.services.get_characteristic(uuid)
        if char is None:
            print(f"  Characteristic {uuid} not found in GATT service table.")
            return
        props = list(char.properties)
        print(f"  {UUID_TO_NAME.get(uuid, uuid)}: {', '.join(props) if props else 'none'}")

    async def cmd_read(self, char_name: str, decrypt: bool = False):
        uuid = self._resolve(char_name)
        raw = bytes(await self.client.read_gatt_char(uuid))
        print(f"  raw: {fmt_hex(raw)}")
        if decrypt:
            try:
                dec = decrypt_value(self.key, raw)
                val = dec[0] if dec else 0
                print(f"  dec: {fmt_hex(dec)}  (value={val})")
            except Exception as e:
                print(f"  decrypt error: {e}")

    async def cmd_write(self, char_name: str, hex_str: str, response: bool):
        uuid = self._resolve(char_name)
        data = parse_hex(hex_str)
        mode = "write" if response else "writewor"
        print(f"  {mode} {UUID_TO_NAME.get(uuid, uuid)} ← {fmt_hex(data)}")
        await self.client.write_gatt_char(uuid, data, response=response)
        print(f"  ok")

    async def cmd_write_nonce(self, char_name: str, hex_str: str, response: bool):
        """Write with nonce-based AES (same as bike.ts default encrypted write)."""
        uuid = self._resolve(char_name)
        data = parse_hex(hex_str)
        payload = await self._make_nonce_payload(data)
        mode = "writenonce" if response else "writenonce wor"
        print(f"  {mode} {UUID_TO_NAME.get(uuid, uuid)} ← nonce+data → {fmt_hex(payload)}")
        await self.client.write_gatt_char(uuid, payload, response=response)
        print(f"  ok")

    async def cmd_write_direct(self, char_name: str, hex_str: str, response: bool):
        """Write with direct AES: pad data to 16 bytes, encrypt, no nonce."""
        uuid = self._resolve(char_name)
        data = parse_hex(hex_str)
        padded = data[:16] + b"\x00" * max(0, 16 - len(data))
        payload = encrypt_block(self.key, padded)
        mode = "writedirect" if response else "writedirect wor"
        print(f"  {mode} {UUID_TO_NAME.get(uuid, uuid)} ← AES({fmt_hex(padded)}) → {fmt_hex(payload)}")
        await self.client.write_gatt_char(uuid, payload, response=response)
        print(f"  ok")

    async def cmd_subscribe(self, char_name: str, decrypt: bool = False):
        uuid = self._resolve(char_name)
        label = UUID_TO_NAME.get(uuid, uuid)

        def on_notify(sender, data: bytearray):
            raw = fmt_hex(bytes(data))
            if decrypt:
                try:
                    dec = decrypt_value(self.key, bytes(data))
                    val = dec[0] if dec else 0
                    print(f"\n  [{label}] raw={raw}  dec={fmt_hex(dec)} val={val}")
                except Exception:
                    print(f"\n  [{label}] raw={raw}  (decrypt failed)")
            else:
                print(f"\n  [{label}] {raw}")

        await self.client.start_notify(uuid, on_notify)
        self._subscribed.add(uuid)
        print(f"  Subscribed to {label}. Notifications will appear inline.")

    async def cmd_unsubscribe(self, char_name: str):
        uuid = self._resolve(char_name)
        await self.client.stop_notify(uuid)
        self._subscribed.discard(uuid)
        print(f"  Unsubscribed from {UUID_TO_NAME.get(uuid, uuid)}.")

    async def cmd_pair(self):
        """Attempt BLE pairing/bonding. Needed for authenticated-signed-writes."""
        print("  Requesting BLE pairing (a Windows dialog may appear)...")
        try:
            result = await self.client.pair()
            print(f"  Pair result: {result}")
        except Exception as e:
            print(f"  Pair error: {type(e).__name__}: {e}")

    async def cmd_write_passcode(self, char_name: str):
        """Write raw passcode bytes to a characteristic."""
        if self.passcode is None:
            print("  No passcode loaded (add 'passcode' field to credentials.json).")
            return
        uuid = self._resolve(char_name)
        print(f"  writepasscode {UUID_TO_NAME.get(uuid, uuid)} ← {fmt_hex(self.passcode)}")
        await self.client.write_gatt_char(uuid, self.passcode, response=True)
        print("  ok")

    async def cmd_unlock(self):
        """
        Automated unlock sweep — tries every known sequence in order and reports
        which one (if any) causes LOCK_STATE to change.
        """
        if self.passcode is None:
            print("  Warning: no passcode in credentials.json — skipping passcode steps.")

        lock_uuid = CHARS["LOCK_STATE"]
        unlock_uuid = CHARS["UNLOCK_REQUEST"]
        backup_uuid = CHARS["BACKUP_CODE"]

        # Subscribe to LOCK_STATE so we can watch for changes
        changes: list[str] = []
        def on_lock(sender, data: bytearray):
            try:
                dec = decrypt_value(self.key, bytes(data))
                val = dec[0] if dec else 0
                changes.append(f"LOCK_STATE changed → raw={fmt_hex(bytes(data))} val={val}")
                print(f"\n  *** LOCK_STATE changed → val={val} ({fmt_hex(bytes(data))})")
            except Exception:
                changes.append(f"LOCK_STATE changed → raw={fmt_hex(bytes(data))} (decrypt failed)")

        await self.client.start_notify(lock_uuid, on_lock)
        print("  Subscribed to LOCK_STATE.")

        async def _try(label: str, coro):
            print(f"\n  ── {label}")
            try:
                await coro
                print("    → write ok")
            except BleakError as e:
                print(f"    → BLE error: {e}")
            except Exception as e:
                print(f"    → {type(e).__name__}: {e}")
            await asyncio.sleep(0.5)  # give bike time to respond

        # Step 1: Props check
        print("\n  [1] GATT properties of UNLOCK_REQUEST:")
        await self.cmd_props("UNLOCK_REQUEST")

        # Step 2: Current lock state
        print("\n  [2] Current LOCK_STATE:")
        await self.cmd_read("LOCK_STATE", decrypt=True)

        # Step 3: Try writing passcode to BACKUP_CODE first (secondary auth hypothesis)
        if self.passcode:
            await _try("Write passcode to BACKUP_CODE (secondary auth)",
                       self.cmd_write_passcode("BACKUP_CODE"))

        # Step 4: Raw byte sequences to UNLOCK_REQUEST
        payloads = [
            ("01", True),        # ATT Write Request, raw 0x01
            ("0201", True),      # raw 0x02 0x01
            ("01", False),       # ATT Write Command (no response), raw 0x01
        ]
        for hex_str, response in payloads:
            mode = "write" if response else "writewor"
            await _try(f"{mode} UNLOCK_REQUEST {hex_str}",
                       self.cmd_write(f"UNLOCK_REQUEST", hex_str, response=response))

        # Step 5: Nonce-encrypted
        for hex_str in ["0201", "01"]:
            await _try(f"writenonce UNLOCK_REQUEST {hex_str}",
                       self.cmd_write_nonce("UNLOCK_REQUEST", hex_str, response=True))
            await _try(f"writenonce UNLOCK_REQUEST {hex_str} wor",
                       self.cmd_write_nonce("UNLOCK_REQUEST", hex_str, response=False))

        # Step 6: Direct AES (no nonce)
        for hex_str in ["01", "0201"]:
            await _try(f"writedirect UNLOCK_REQUEST {hex_str}",
                       self.cmd_write_direct("UNLOCK_REQUEST", hex_str, response=True))
            await _try(f"writedirect UNLOCK_REQUEST {hex_str} wor",
                       self.cmd_write_direct("UNLOCK_REQUEST", hex_str, response=False))

        # Step 7: Try ALARM_MODE = 00 (alternative unlock method)
        await _try("write ALARM_MODE 00 (some firmwares unlock via alarm mode)",
                   self.cmd_write("ALARM_MODE", "00", response=True))

        # Step 8: Re-auth then retry
        print("\n  [8] Re-authenticating and retrying...")
        await self.authenticate()
        await _try("writenonce UNLOCK_REQUEST 0201 (post re-auth)",
                   self.cmd_write_nonce("UNLOCK_REQUEST", "0201", response=True))

        await self.client.stop_notify(lock_uuid)

        print("\n  ── Unlock sweep complete.")
        if changes:
            print("  LOCK_STATE changes observed:")
            for c in changes:
                print(f"    {c}")
        else:
            print("  No LOCK_STATE changes observed during sweep.")

    # ── REPL ──────────────────────────────────────────────────────────────────

    async def run(self):
        print("\nConnected and authenticated. Type 'help' for commands.\n")
        loop = asyncio.get_event_loop()
        while True:
            try:
                line = await loop.run_in_executor(None, input, "bike> ")
            except (EOFError, KeyboardInterrupt):
                print()
                break

            parts = line.strip().split()
            if not parts:
                continue
            cmd, *args = parts

            try:
                match cmd.lower():
                    case "quit" | "exit" | "q":
                        break

                    case "help":
                        print(HELP)

                    case "auth":
                        await self.authenticate()

                    case "chars":
                        for name, uuid in CHARS.items():
                            print(f"  {name:<32} {uuid}")

                    case "props":
                        if not args:
                            print("  Usage: props <char>")
                        else:
                            await self.cmd_props(args[0])

                    case "read":
                        if not args:
                            print("  Usage: read <char> [dec]")
                        else:
                            await self.cmd_read(args[0], decrypt="dec" in args[1:])

                    case "write":
                        if len(args) < 2:
                            print("  Usage: write <char> <hex>")
                        else:
                            await self.cmd_write(args[0], args[1], response=True)

                    case "writewor":
                        if len(args) < 2:
                            print("  Usage: writewor <char> <hex>")
                        else:
                            await self.cmd_write(args[0], args[1], response=False)

                    case "writenonce":
                        if len(args) < 2:
                            print("  Usage: writenonce <char> <hex> [wor]")
                        else:
                            await self.cmd_write_nonce(args[0], args[1], response="wor" not in args[2:])

                    case "writedirect":
                        if len(args) < 2:
                            print("  Usage: writedirect <char> <hex> [wor]")
                        else:
                            await self.cmd_write_direct(args[0], args[1], response="wor" not in args[2:])

                    case "sub":
                        if not args:
                            print("  Usage: sub <char> [dec]")
                        else:
                            await self.cmd_subscribe(args[0], decrypt="dec" in args[1:])

                    case "unsub":
                        if not args:
                            print("  Usage: unsub <char>")
                        else:
                            await self.cmd_unsubscribe(args[0])

                    case "pair":
                        await self.cmd_pair()

                    case "writepasscode":
                        if not args:
                            print("  Usage: writepasscode <char>")
                        else:
                            await self.cmd_write_passcode(args[0])

                    case "unlock":
                        await self.cmd_unlock()

                    case _:
                        print(f"  Unknown command: {cmd!r}. Type 'help'.")

            except BleakError as e:
                print(f"  BLE error: {e}")
            except ValueError as e:
                print(f"  Error: {e}")
            except Exception as e:
                print(f"  {type(e).__name__}: {e}")


# ── Entry point ───────────────────────────────────────────────────────────────

async def main():
    script_dir = Path(__file__).parent
    creds_file = script_dir / "credentials.json"

    if not creds_file.exists():
        print(f"Error: credentials.json not found at {creds_file}")
        print()
        print("Create it with the contents from your browser's localStorage key 'vm-bike-credentials'.")
        print("(DevTools → Application → Local Storage → your site URL)")
        print()
        print('Example format:')
        print('  {"mac":"AB:CD:EF:12:34:56","encryptionKey":"aabb...","userKeyId":1,"name":"My Bike"}')
        sys.exit(1)

    with open(creds_file) as f:
        raw = json.load(f)

    bikes = raw if isinstance(raw, list) else [raw]

    if len(bikes) == 1:
        creds = bikes[0]
        print(f"Using bike: {creds.get('name', creds['mac'])}")
    else:
        print("Multiple bikes in credentials.json:")
        for i, b in enumerate(bikes):
            print(f"  [{i}] {b.get('name', '?')} — {b['mac']}")
        idx = int(input("Select index: "))
        creds = bikes[idx]

    mac        = creds["mac"]
    key        = bytes.fromhex(creds["encryptionKey"])
    key_id     = int(creds["userKeyId"])
    name       = creds.get("name", mac)
    passcode_hex = creds.get("passcode")
    passcode   = bytes.fromhex(passcode_hex) if passcode_hex else None

    if passcode:
        print(f"Passcode loaded: {fmt_hex(passcode)}")

    # ── Scan first (Windows BLE stack needs to see the device before connecting) ─
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--scan-only", action="store_true",
                        help="Scan for BLE devices and exit (no connection)")
    parser.add_argument("--no-scan", action="store_true",
                        help="Skip pre-scan and connect directly by MAC")
    parser.add_argument("--scan-time", type=float, default=10.0,
                        help="Scan duration in seconds (default: 10)")
    args = parser.parse_args()

    if args.scan_only:
        await cmd_scan(args.scan_time, filter_mac=mac)
        return

    device = None
    if not args.no_scan:
        device = await scan_for_device(mac, name, timeout=args.scan_time)
        if device is None:
            print(f"\nDevice not found during scan. Trying direct connection anyway...")

    target = device if device is not None else mac

    print(f"Connecting to {name} ({mac})...")
    try:
        async with BleakClient(target, timeout=20.0) as client:
            if not client.is_connected:
                print("Failed to connect.")
                sys.exit(1)
            print("Authenticating...")
            cli = BikeCLI(client, key, key_id, passcode=passcode)
            await cli.authenticate()
            await cli.run()
        print("Disconnected.")
    except BleakError as e:
        print(f"Connection error: {e}")
        print()
        print("Troubleshooting tips:")
        print("  • Make sure the bike is powered on and not connected to another device/app")
        print("  • Try turning the bike off and on again")
        print("  • Run  python main.py --scan-only  to see nearby BLE devices")
        print("  • On Windows, try toggling Bluetooth off/on in Settings")
        sys.exit(1)


def _bike_ble_names(mac: str) -> list[str]:
    """
    VanMoof bikes advertise as 'ES3-<MAC>' or 'EX3-<MAC>' (colons stripped, uppercase).
    This is how the official app filters devices.
    """
    mac_flat = mac.replace(":", "").upper()
    return [f"ES3-{mac_flat}", f"EX3-{mac_flat}"]


async def scan_for_device(mac: str, name: str, timeout: float = 10.0):
    """Scan for a VanMoof BLE device by MAC address or advertised name.
    Returns BLEDevice if found, else None."""
    mac_upper = mac.upper()
    ble_names = _bike_ble_names(mac)
    print(f"Scanning for {name} ({mac_upper}) — up to {timeout:.0f}s...")
    print(f"  Matching on address {mac_upper} or name {' / '.join(ble_names)}")

    found = None
    def on_detect(device, adv):
        nonlocal found
        if found:
            return
        addr_match = device.address.upper() == mac_upper
        name_match = device.name and device.name.upper() in (n.upper() for n in ble_names)
        if addr_match or name_match:
            found = device
            print(f"  Found: '{device.name or '(no name)'}' @ {device.address}  RSSI: {adv.rssi} dBm")

    async with BleakScanner(detection_callback=on_detect):
        for i in range(int(timeout * 2)):
            await asyncio.sleep(0.5)
            if found:
                break
            if (i + 1) % 4 == 0:  # progress dot every 2s
                print(f"  ... still scanning ({(i+1)/2:.0f}s)")

    if found is None:
        print(f"  Device not found. Expected name: {' or '.join(ble_names)}")
    return found


async def cmd_scan(timeout: float, filter_mac: str | None = None):
    """Scan for all nearby BLE devices and print them."""
    print(f"Scanning for BLE devices ({timeout:.0f}s)...")
    devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
    if not devices:
        print("  No devices found.")
        return
    print(f"\n  {'Address':<20} {'RSSI':>6}  Name")
    print(f"  {'-'*20} {'-'*6}  {'-'*30}")
    for addr, (dev, adv) in sorted(devices.items(), key=lambda x: -(x[1][1].rssi or -999)):
        marker = " ◄ YOUR BIKE" if filter_mac and addr.upper() == filter_mac.upper() else ""
        print(f"  {addr:<20} {adv.rssi or '?':>5}  {dev.name or '(unnamed)'}{marker}")


if __name__ == "__main__":
    asyncio.run(main())
