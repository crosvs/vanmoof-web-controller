## [Mooovy](https://mooovy.app/)

A web app for changing the speed limit of your VanMoof S3 and X3.

**NOT** an offical VanMoof service/product!

![preview](public/screenshot_light.png?raw=true "preview")

- **[Web app: mooovy.app](https://mooovy.app/)**
- [Discord server](https://discord.gg/gQFC2n7Tc9)

### Current features

- Change your speed limit to JP (24 km/h), EU (25 km/h), US (32 km/h) or 😎 (37 km/h).
- Set your power level, this also unlocks a new power level 5.
- A sound board with the following sounds:

| Short | 🔘 Click            | 🧨 Error | 👍 Pling         | 🤔 Cling clong | 🔔 Bell       | 🔔 Normal bike bell | 🎉 Bell Tada         | 😚 Whistle | 🚢 BOAT | ⚡️ Wuup | 🫤 Success but error |
| ----- | ------------------- | -------- | ---------------- | -------------- | ------------- | ------------------- | -------------------- | ---------- | ------- | -------- | ------------------- |
| Long  | 🔋 Charding noise.. | 🚨 Alarm | 🚨 Alarm stage 2 | 🔋 Charging..  | 🆕 Updating.. | 🎉 Update complete  | 💥 Make wired noises |

- Share your bike to someone using their email.
- Show a list of people you are currently sharing your bike with and a button to stop sharing.
- Set your bell tone (Bell, Submarine, Sonar, Party & Foghorn)
- Upload your own custom bell (will replace the Foghorn/Ping bell)

### Want to help?

Here are some things you can do to help!

- [Confirm v1.8.**2** still works](https://github.com/mjarkk/vanmoof-web-controller/issues/22) (v1.8.**1** has been confirmed to work already!)
- Help reverse engineer how the refresh token works for the VanMoof API
- Hackin support for older/newer bikes
- Help with finding out what is send from / to the bike over bluetooth and having a good workflow for doing this

### Developer Tools

Three pages are included for reverse-engineering and extending the VanMoof BLE protocol.
All require Web Bluetooth (Chrome / Edge on a supported OS).

#### `/bike-panel` — Bike Control Panel (developer template)

An interactive control panel showing the full bike state with live/cached indicators.
Values are persisted to `localStorage` keyed by MAC address so the last-known state survives page reloads.
Each state variable has a configurable `maxAgeMs` threshold — if cached data is older than that, the badge
automatically escalates from **cached → stale**.

The page also shows a BLE traffic counter (↑ outbound / ↓ inbound operations) so developers can see how
chatty their app is, and a connection status pill that reacts to the `gattserverdisconnected` event.

**Using it as a template:** The page is intentionally structured as a developer template. Reorder or hide
`VAR_DEFS` entries and `StateRow` components to match your app's needs. Tune `maxAgeMs` per variable.
Add write-only commands to the Commands section.

#### `/ble-tester` — Raw BLE Tester

Ad-hoc BLE packet sender. Enter any characteristic, choose read/write/readwrite, send arbitrary hex payloads,
and watch live notifications. Good for one-off exploration.

#### `/ble-compatibility` — BLE Compatibility Tester

Structured community compatibility tester. Runs all known BLE commands sequentially against a real bike,
pauses for physical confirmation (speaker, display, motor) where needed, and exports results as JSON.
Submit your export to help document firmware compatibility across versions.

#### Known BLE limitations

`UNLOCK_REQUEST` (6acc5522) requires an **ATT Signed Write Command (opcode 0xD2)** — a BLE-level
authenticated write that requires a CSRK key established via BLE bonding/pairing.
**Web Bluetooth does not support ATT Signed Write on any platform**, so remote unlock via the browser
is permanently blocked. See `CLAUDE.md` for full investigation details.

#### Python BLE CLI (`ble-cli/`)

For deeper exploration (and eventually unlock via Linux + BlueZ), a Python CLI is included in `ble-cli/`.
Requires Python 3.9+ and [Bleak](https://github.com/hbldh/bleak).

```sh
cd ble-cli
pip install -r requirements.txt

# Set up credentials (copy from localStorage vm-bike-credentials):
cp credentials.example.json credentials.json  # fill in mac, encryptionKey, userKeyId

python main.py              # scan then connect
python main.py --no-scan    # connect directly by MAC
```

Key REPL commands:

| Command | Description |
|---------|-------------|
| `props <char>` | Print GATT properties for a characteristic |
| `sub <char> [dec]` | Subscribe to notifications |
| `writenonce <char> <hex>` | AES-encrypted write |
| `writedirect <char> <hex>` | Raw (unencrypted) write |
| `unlock` | Automated sweep of all known unlock sequences |

---

### BLE Protocol Reference

All characteristic UUIDs share the suffix `-e631-4069-944d-b8ca7598ad50`.
The short form used below is the 8-character prefix only (e.g. `6acc5521`).

#### Encryption

All reads and writes use AES-ECB with the bike's `encryptionKey` from the VanMoof API.

- **Encrypted write** — reads a nonce from `CHALLENGE` (6acc5501), builds a 16-byte payload
  `AES(nonce[0..11] + data + padding)`, writes that to the target characteristic. Costs 1 extra
  read round-trip per write.
- **Encrypted read** — reads raw bytes from the characteristic, AES-decrypts, strips trailing zero
  bytes. **Caution:** a value that decodes to a single `0x00` byte returns an empty array — check
  `data[0] ?? 0` rather than `data[0]` to distinguish "zero" from "no data".
- **Authentication** — on connect, writes a signed token to `KEY_INDEX` (6acc5502) that proves
  possession of `encryptionKey` and `userKeyId`. Required before any encrypted read/write.
- `passcode` in the VanMoof API response equals the first 6 bytes of `encryptionKey`.

---

#### Security Service — `6acc5500`

| Char (suffix) | Name | GATT Properties | Status | Notes |
|---|---|---|---|---|
| `6acc5501` | CHALLENGE | read | ✅ Working | Returns a 12-byte nonce used by every encrypted write. |
| `6acc5502` | KEY_INDEX | write | ✅ Working | Authentication handshake — writes encrypted `userKeyId`. Must be the first operation after connect. |
| `6acc5503` | BACKUP_CODE | read, write, notify, auth-signed-writes | ⚠️ Partial | Readable. Write (encrypted) is accepted by the firmware but triggers a **security disconnect** immediately after. The passcode value is the first 6 bytes of `encryptionKey` (`94ef010857f0` on tested bike); the correct write format is unknown. |
| `6acc5505` | BIKE_MESSAGE | write, notify, auth-signed-writes | ❓ Unknown | Write (encrypted `01`) accepted, followed by a **security disconnect**. Likely a higher-level command channel (firmware update, diagnostics?). Format completely unknown. |

---

#### Firmware Service — `6acc5510`

| Char (suffix) | Name | GATT Properties | Status | Notes |
|---|---|---|---|---|
| `6acc5511` | FIRMWARE_METADATA | write | ✅ Working (bell upload) | Initiates a data transfer. For bell sound upload: write 9 bytes encrypted — command byte `0x19`, 4-byte big-endian file size, 4-byte big-endian CRC32. Likely also used for OTA firmware (command byte unknown). |
| `6acc5512` | FIRMWARE_BLOCK | write | ✅ Working (bell upload) | Receives raw (unencrypted) data chunks, 240 bytes at a time. Used by both bell sound upload and presumably OTA firmware. No per-chunk acknowledgement — bike buffers the stream. |

---

#### Defense Service — `6acc5520`

| Char (suffix) | Name | GATT Properties | Status | Notes |
|---|---|---|---|---|
| `6acc5521` | LOCK_STATE | read, write, notify, auth-signed-writes | ✅ Working (read/notify) | Decrypts to 1 byte: `0`=Unlocked, `1`=Locked, `2`=Standby (unobserved), `3`=Alarm (unobserved). Notifications fire reliably on physical lock/unlock. **Write (encrypted `00`) is accepted by the firmware but silently ignored** — the lock state does not change. Read returns `0x00 ba` when locked (meaning of second byte unknown). |
| `6acc5522` | UNLOCK_REQUEST | auth-signed-writes, notify | ❌ Permanently blocked | Requires ATT Signed Write Command (BLE opcode `0xD2`). Web Bluetooth only exposes Write Request (`0x12`) and Write Without Response (`0x52`). Chrome refuses with "GATT operation not permitted" because neither `write` nor `write-without-response` is in the GATT properties. Tested on Chrome/Windows, Chrome/Android, and Bleak/Windows — all blocked. The only viable path is BlueZ on Linux after BLE bonding. |
| `6acc5523` | ALARM_STATE | unknown | ❓ Unknown | Not tested. Likely the current alarm state (triggered/not). Properties not confirmed. |
| `6acc5524` | ALARM_MODE | write | ✅ Working | Encrypted write `00` disables the alarm (same effect as the official VanMoof app). Encrypted write `01` presumably re-enables it (untested). Does **not** unlock the bike. |

---

#### Movement Service — `6acc5530`

| Char (suffix) | Name | GATT Properties | Status | Notes |
|---|---|---|---|---|
| `6acc5531` | DISTANCE | read | ✅ Working | 4-byte little-endian uint32, divide by 10 for km. Decrypt strips leading zeros — pad to 4 bytes before parsing. |
| `6acc5532` | SPEED | read, notify (experimental) | ⚠️ Partial | Raw byte, value while stationary is `0` (decrypt returns empty array — use `data[0] ?? 0`). Notify property is present but behaviour unconfirmed; subscription attempted but no notifications observed at rest. |
| `6acc5533` | UNIT_SYSTEM | unknown | ❓ Unknown | Not tested. Likely toggles km/mi display on the bike's own screen. |
| `6acc5534` | POWER_LEVEL | read, write | ✅ Working | 1 byte: `0`=Off, `1`–`4`=levels 1–4, `5`=Max/Sport. Encrypted read/write. Writing power level `5` unlocks a hidden Sport mode not available in the stock VanMoof app. |
| `6acc5535` | SPEED_LIMIT | read, write | ✅ Working | 1 byte: `0`=EU (25 km/h), `1`=US (32 km/h), `2`=JP (24 km/h), `255`=No Limit (37 km/h). Encrypted read/write. |
| `6acc5536` | E_SHIFTER_GEAR | unknown | ❓ Unknown | Not tested. Presumably the current gear on bikes with the optional electronic shifter (S3/X3 have 3-speed). |
| `6acc5537` | E_SHIFTING_POINTS | unknown | ❓ Unknown | Not tested. Likely the speed thresholds at which the e-shifter changes gear — potentially writable to tune shift points. |
| `6acc5538` | E_SHIFTER_MODE | unknown | ❓ Unknown | Not tested. Possibly enables/disables automatic shifting or manual override. |

---

#### Bike Info Service — `6acc5540`

| Char (suffix) | Name | GATT Properties | Status | Notes |
|---|---|---|---|---|
| `6acc5541` | MOTOR_BATTERY_LEVEL | read | ✅ Working | 1 byte, percentage (0–100). |
| `6acc5542` | MOTOR_BATTERY_STATE | unknown | ❓ Unknown | Not tested. Likely charging/discharging/full state similar to the module battery. |
| `6acc5543` | MODULE_BATTERY_LEVEL | read | ✅ Working | 1 byte, percentage. Subject to the zero-strip bug when at 0% — use `data[0] ?? 0`. |
| `6acc5544` | MODULE_BATTERY_STATE | unknown | ❓ Unknown | Not tested. Module = the Bluetooth/GSM controller module, separate from the drive motor. |
| `6acc554a` | BIKE_FIRMWARE_VERSION | read | ✅ Working | UTF-8 string, e.g. `1.8.2`. |
| `6acc554b` | BLE_CHIP_FIRMWARE_VERSION | unknown | ❓ Unknown | Not tested. Firmware version of the on-board BLE chip (separate from main firmware). |
| `6acc554c` | CONTROLLER_FIRMWARE_VERSION | unknown | ❓ Unknown | Not tested. Motor controller firmware. |
| `6acc554d` | PCBA_HARDWARE_VERSION | unknown | ❓ Unknown | Not tested. Hardware revision of the printed circuit board assembly. |
| `6acc554e` | GSM_FIRMWARE_VERSION | unknown | ❓ Unknown | Not tested. Firmware of the cellular (GSM) module used for theft tracking. |
| `6acc554f` | E_SHIFTER_FIRMWARE_VERSION | unknown | ❓ Unknown | Not tested. Only present on bikes with the electronic shifter option. |
| `6acc5550` | BATTERY_FIRMWARE_VERSION | unknown | ❓ Unknown | Not tested. Smart battery pack firmware version. |
| `6acc5551` | _(unknown)_ | unknown | ❓ Unknown | UUID present in the service but purpose entirely unknown. |
| `6acc5552` | FRAME_NUMBER | read | ✅ Working | UTF-8 string — the bike's unique frame/serial number. |

---

#### Bike State Service — `6acc5560`

| Char (suffix) | Name | GATT Properties | Status | Notes |
|---|---|---|---|---|
| `6acc5561` | MODULE_MODE | read, notify, auth-signed-writes | ⚠️ Partial | Readable and subscribable, but has no regular `write` property (only `auth-signed-writes`). Raw value meaning unknown — likely indicates what mode the module is in (normal, ship mode, update mode, etc.). |
| `6acc5562` | MODULE_STATE | read, write, notify, auth-signed-writes | ❓ Unknown | Readable and writable but decoded meaning unknown. May control whether the module is awake or in low-power state. |
| `6acc5563` | ERRORS | unknown | ❓ Unknown | Not tested. Likely a bitmask or list of active error codes. Could be useful for diagnostics. |
| `6acc5564` | WHEEL_SIZE | unknown | ❓ Unknown | Not tested. Probably the configured wheel circumference used for odometer and speed calculations. |
| `6acc5567` | CLOCK | unknown | ❓ Unknown | Not tested. Possibly the bike's internal RTC — may be writable to sync time. |

---

#### Sound Service — `6acc5570`

| Char (suffix) | Name | GATT Properties | Status | Notes |
|---|---|---|---|---|
| `6acc5571` | PLAY_SOUND | write | ✅ Working | Write two bytes `[sound_id, 0x01]` (encrypted) to trigger a sound. See sound table below. |
| `6acc5572` | SOUND_VOLUME | unknown | ❓ Unknown | Not tested. Likely a 1-byte volume level. |
| `6acc5574` | BELL_SOUND | read, write | ✅ Working | 1 byte selecting the bell slot: `0x0a`=Sonar, `0x16`=Bell, `0x17`=Party, `0x18`=Foghorn/Custom. Writing `0x18` activates the custom uploaded sound. |

##### Known Sound IDs (PLAY_SOUND)

Write `[id, 0x01]` encrypted to `6acc5571`.

| ID | Name | Duration |
|----|------|----------|
| `0x01` | Click | Short |
| `0x02` | Error | Short |
| `0x03` | Pling | Short |
| `0x06` | Cling clong | Short |
| `0x07` | Charging noise | Long |
| `0x0A` | Bell | Short |
| `0x0B` | Whistle | Short |
| `0x0E` | Alarm | Long |
| `0x0F` | Alarm stage 2 | Long |
| `0x12` | Charging.. | Long |
| `0x13` | Updating.. | Long |
| `0x14` | Wuup | Short |
| `0x15` | Update complete | Long |
| `0x16` | Normal bike bell | Short |
| `0x17` | Bell Tada | Short |
| `0x18` | BOAT | Short |
| `0x19` | Success but error | Short |
| `0x1A` | Make weird noises | Long |

IDs not listed above (`0x04`, `0x05`, `0x08`–`0x09`, `0x0C`–`0x0D`, `0x10`–`0x11`, `0x1B`+) are
untested — they may produce sounds or be silent. Contributions welcome.

---

#### Custom Bell Sound Upload

The custom bell sound feature repurposes the **Firmware Service** (`6acc5510`) — the same channel used
for OTA firmware updates — to stream arbitrary audio data into the bike's sound storage.

##### What it replaces

The uploaded sound occupies the **Foghorn / Ping** bell slot (`0x18`). After a successful upload,
`BELL_SOUND` is set to `0x18` automatically. To revert to a built-in bell, write a different
`BellTone` value to `BELL_SOUND`.

##### File constraints

| Constraint | Value | Why |
|---|---|---|
| Max final size | **400 000 bytes** | Bike's sound storage limit |
| Format on-wire | **PCM 16-bit signed LE mono WAV** | Only format the bike accepts |
| Best duration | **≤ 10 seconds** | Longer files require heavy downsampling |
| Sample rate | Auto-selected | See table below |

The app picks the highest sample rate that keeps the PCM payload under 400 KB:

| Max duration | Sample rate chosen |
|---|---|
| ≤ ~4.5 s | 44 100 Hz |
| ≤ ~9 s | 22 050 Hz |
| ≤ ~12.5 s | 16 000 Hz |
| ≤ ~18 s | 11 025 Hz |
| ≤ ~25 s | 8 000 Hz |
| longer | 6 000 Hz (minimum) |

Input format is flexible — anything ffmpeg can decode works (MP3, AAC, FLAC, OGG, M4A, AIFF, …).
Conversion runs entirely in the browser via **ffmpeg.wasm** (`@ffmpeg/core` loaded from unpkg).

##### VanMoof file format (on-wire)

Before upload, the raw PCM WAV is wrapped in a VanMoof-specific container:

```
Offset  Length  Value / Description
──────  ──────  ──────────────────────────────────────────────────────
     0       8  56 4D 5F 53 4F 55 4E 44  — ASCII "VM_SOUND" magic
     8       4  FF FF FF FF              — purpose unknown (placeholder?)
    12       1  01                       — version / file-type flag
    13       4  58 58 58 58              — purpose unknown ("XXXX")
    17       1  00                       — null separator
    18       6  58 58 58 58 58 58        — purpose unknown ("XXXXXX")
    24       4  <fileSize, little-endian> — byte length of the WAV that follows
    28       n  <raw PCM WAV data>
```

Total header overhead: 28 bytes. Max `n`: ~399 972 bytes.

##### BLE transfer protocol

The upload uses two characteristics from the **Firmware Service** (`6acc5510`):

**Step 1 — Initiate** — Write 9 bytes (encrypted) to `FIRMWARE_METADATA` (`6acc5511`):

```
Byte 0     : 0x19  — transfer-type command byte
Bytes 1–4  : total file size (header + WAV), big-endian uint32
Bytes 5–8  : CRC32 of entire buffer (header + WAV), big-endian uint32
```

**Step 2 — Stream chunks** — Write raw (unencrypted) 240-byte chunks to `FIRMWARE_BLOCK` (`6acc5512`),
sequentially, until all bytes are sent. No acknowledgement between chunks — the bike buffers them.
The buffer is **always padded to exactly 400 000 bytes** with zeros before chunking (see note below).

**Step 3 — Activate** — Write `[0x18, 0x01]` encrypted to `BELL_SOUND` (`6acc5574`) to switch the
active bell tone to the Foghorn slot, which now contains the uploaded sound.

##### Why always upload 400 KB even for short sounds?

The bike stores the sound in a **fixed-size 400 KB flash region**. When you upload a 50 KB sound,
only those 50 KB are written. The remaining 350 KB still contain whatever was in flash before —
typically the tail of the previous (longer) sound. If the bike's playback doesn't perfectly respect
the size field in the VM_SOUND header, it reads into those stale bytes and you hear the old audio
bleeding through at the end.

Zero-padding the payload to the full 400 KB before upload overwrites the entire region.
The VM_SOUND `fileSize` field still correctly marks where the real audio ends, and any bytes the
bike reads past that point are `0x0000` PCM — silence. This adds upload time for short sounds
(~20–40 s over BLE for the zero region) but eliminates the artifact entirely.

##### Why the Firmware Service?

The bike has no dedicated "sound upload" service. VanMoof re-used the firmware OTA channel (likely
already in the codebase for firmware updates) for sound data. The `0x19` command byte in the
initiation header presumably tells the bike to route the incoming data to sound storage rather than
flash. `FIRMWARE_BLOCK` writes are unencrypted because the data is already wrapped in the
VanMoof container format — the bike validates integrity via the CRC32 in the initiation header.

---

#### Light Service — `6acc5580`

| Char (suffix) | Name | GATT Properties | Status | Notes |
|---|---|---|---|---|
| `6acc5581` | LIGHT_MODE | unknown | ❓ Unknown | Not tested. Likely controls front/rear light on/off or automatic mode. The bike model is known to report a `'Dark'` colour scheme — other values unknown. |
| `6acc5584` | SENSOR | unknown | ❓ Unknown | Not tested. Possibly the ambient light sensor reading used for auto-lighting. |

---

#### Known-to-fail commands

| Command | Result | Why |
|---------|--------|-----|
| Write to `UNLOCK_REQUEST` (6acc5522) | `GATT operation not permitted` | Firmware requires **ATT Signed Write Command** (opcode `0xD2`), which needs a CSRK session key from BLE bonding. Web Bluetooth spec only exposes Write Request (`0x12`) and Write Without Response (`0x52`). Chrome, Edge, and all Web Bluetooth implementations reject it at the protocol level before even sending the packet. |
| Encrypted write to `LOCK_STATE` (6acc5521) | Accepted, no effect | The firmware accepts the write (no error) but does not change the lock state. The characteristic has `write` in its GATT properties, but the firmware ignores non-signed writes for the actual lock operation. Likely the `write` property is used for something else (mode change?). |
| Encrypted write to `BACKUP_CODE` (6acc5503) | Accepted, then security disconnect | The characteristic accepts standard writes, but the firmware immediately drops the BLE connection after receiving the payload. The correct message format is unknown — the field is likely used by the VanMoof app during key provisioning or theft recovery. |
| Encrypted write to `BIKE_MESSAGE` (6acc5505) | Accepted, then security disconnect | Same pattern as BACKUP_CODE. Payload `01` was tried. Suspected to be a privileged command channel for factory/service use. Format unknown. |
| Write to `MODULE_MODE` (6acc5561) | `GATT operation not permitted` | The characteristic only has `authenticated-signed-writes` for writes — no standard `write` or `write-without-response` property. Same root cause as UNLOCK_REQUEST: requires BLE-layer signing. |
| BLE bonding on Windows via WinRT | Bonds successfully, still can't send signed writes | Windows pairs and establishes a CSRK, but WinRT's Bluetooth API exposes no method to send an ATT Signed Write Command. Bleak inherits this limitation. Linux + BlueZ is currently the only platform with signed-write support after bonding. |

---

### Development

This project is build using [NextJS (a React framework)](https://nextjs.org) and deployed on [vercel](https://vercel.com)

**Install**

```sh
npm i
```

**Run**

```sh
npm run dev
```

**Compress logos**

```sh
cd public
npx @squoosh/cli --max-optimizer-rounds 10 --quant '{numColors:8}' --output-dir compressed_logos --webp auto --oxipng auto logo_full.png
npx @squoosh/cli --max-optimizer-rounds 10 --resize '{width:512,height:512}' --quant '{numColors:8}' --output-dir compressed_logos --webp auto --oxipng auto --suffix _512 logo_full.png
npx @squoosh/cli --max-optimizer-rounds 10 --resize '{width:256,height:256}' --quant '{numColors:8}' --output-dir compressed_logos --webp auto --oxipng auto --suffix _256 logo_full.png
npx @squoosh/cli --max-optimizer-rounds 10 --resize '{width:128,height:128}' --quant '{numColors:8}' --output-dir compressed_logos --webp auto --oxipng auto --suffix _128 logo_full.png
npx @squoosh/cli --max-optimizer-rounds 10 --resize '{width:64,height:64}' --quant '{numColors:8}' --output-dir compressed_logos --webp auto --oxipng auto --suffix _64 logo_full.png
```
