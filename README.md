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
