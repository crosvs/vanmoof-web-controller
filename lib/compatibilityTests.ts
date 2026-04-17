import {
    Characteristic,
    CHALLENGE, KEY_INDEX, BACKUP_CODE, BIKE_MESSAGE,
    LOCK_STATE, UNLOCK_REQUEST, ALARM_STATE, ALARM_MODE,
    DISTANCE, SPEED, UNIT_SYSTEM, POWER_LEVEL, SPEED_LIMIT,
    E_SHIFTER_GEAR, E_SHIFTIG_POINTS, E_SHIFTER_MODE,
    MOTOR_BATTERY_LEVEL, MOTOR_BATTERY_STATE, MODULE_BATTERY_LEVEL, MODULE_BATTERY_STATE,
    BIKE_FIRMWARE_VERSION, BLE_CHIP_FIRMWARE_VERSION, CONTROLLER_FIRMWARE_VERSION,
    PCBA_HARDWARE_VERSION, FRAME_NUMBER,
    MODULE_MODE, MODULE_STATE, ERRORS, WHEEL_SIZE, CLOCK,
    PLAY_SOUND, SOUND_VOLUME, BELL_SOUND,
    LIGHT_MODE, SENSOR,
} from './bike'

export type TestCategory = 'Security' | 'Defense' | 'Movement' | 'BikeInfo' | 'BikeState' | 'Sound' | 'Light'
export type KnownStatus = 'works' | 'fails' | 'unknown'

export type TestOp =
    | { type: 'read'; decrypt: boolean }
    | { type: 'write'; payload: number[]; encrypt: boolean; withoutResponse?: boolean }
    | { type: 'readwrite'; payload: number[]; encrypt: boolean; timeout?: number }
    | { type: 'subscribe'; decrypt: boolean; durationMs: number }

export interface CompatibilityTest {
    id: string
    name: string
    description: string
    category: TestCategory
    characteristic: Characteristic
    characteristicKey: string       // display name
    operation: TestOp
    requiresPhysicalConfirm: boolean
    physicalConfirmPrompt?: string
    knownStatus: KnownStatus
    knownFailReason?: string
    firmwareNotes?: string
    safeToAutoRun: boolean
}

export const TEST_CATEGORIES: TestCategory[] = [
    'Security', 'Defense', 'Movement', 'BikeInfo', 'BikeState', 'Sound', 'Light',
]

export const FIRMWARE_VERSIONS = ['unknown', '1.7.6', '1.8.2']

export const COMPATIBILITY_TESTS: CompatibilityTest[] = [

    // ── Security ──────────────────────────────────────────────────────────────

    {
        id: 'security-challenge-read',
        name: 'Read challenge nonce',
        description: 'Reads the 16-byte AES nonce from CHALLENGE. This is used internally during authentication and for encrypting all subsequent writes.',
        category: 'Security', characteristic: CHALLENGE, characteristicKey: 'CHALLENGE',
        operation: { type: 'read', decrypt: false },
        requiresPhysicalConfirm: false,
        knownStatus: 'works', safeToAutoRun: true,
    },
    {
        id: 'security-key-index-read',
        name: 'Read key index',
        description: 'Reads the KEY_INDEX characteristic. Normally written to (not read) during authentication.',
        category: 'Security', characteristic: KEY_INDEX, characteristicKey: 'KEY_INDEX',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'security-backup-code-read',
        name: 'Read backup code',
        description: 'Reads BACKUP_CODE. The backup code can be used to unlock the bike without the app.',
        category: 'Security', characteristic: BACKUP_CODE, characteristicKey: 'BACKUP_CODE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'security-bike-message-read',
        name: 'Read bike message',
        description: 'Reads BIKE_MESSAGE. Used for cloud-to-bike message delivery from the VanMoof servers.',
        category: 'Security', characteristic: BIKE_MESSAGE, characteristicKey: 'BIKE_MESSAGE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },

    // ── Defense ───────────────────────────────────────────────────────────────

    {
        id: 'defense-lock-state-read',
        name: 'Read lock state',
        description: 'Reads the current electronic lock state. 0=Unlocked, 1=Locked, 2=Standby, 3=Alarm.',
        category: 'Defense', characteristic: LOCK_STATE, characteristicKey: 'LOCK_STATE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'works', safeToAutoRun: true,
    },
    {
        id: 'defense-lock-state-subscribe',
        name: 'Subscribe to lock state notifications',
        description: 'Subscribes to LOCK_STATE for 10 seconds. Lock or unlock the bike manually to trigger a notification.',
        category: 'Defense', characteristic: LOCK_STATE, characteristicKey: 'LOCK_STATE',
        operation: { type: 'subscribe', decrypt: true, durationMs: 10000 },
        requiresPhysicalConfirm: true,
        physicalConfirmPrompt: 'Lock or unlock the bike manually during the 10-second window. Did a notification appear in the result?',
        knownStatus: 'works', safeToAutoRun: true,
    },
    {
        id: 'defense-unlock-write',
        name: 'Write unlock request',
        description: 'Attempts to unlock the bike by writing [0x02, 0x01] encrypted to UNLOCK_REQUEST.',
        category: 'Defense', characteristic: UNLOCK_REQUEST, characteristicKey: 'UNLOCK_REQUEST',
        operation: { type: 'write', payload: [0x02, 0x01], encrypt: true },
        requiresPhysicalConfirm: true,
        physicalConfirmPrompt: 'Did the bike attempt to unlock (motor sound, display change)?',
        knownStatus: 'fails',
        knownFailReason: 'UNLOCK_REQUEST requires ATT Signed Write Command (opcode 0xD2). Web Bluetooth only supports Write Request (0x12) and Write Without Response (0x52). This is a permanent browser API limitation.',
        safeToAutoRun: false,
    },
    {
        id: 'defense-alarm-state-read',
        name: 'Read alarm state',
        description: 'Reads the current alarm state from ALARM_STATE.',
        category: 'Defense', characteristic: ALARM_STATE, characteristicKey: 'ALARM_STATE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'defense-alarm-mode-read',
        name: 'Read alarm mode',
        description: 'Reads the current alarm mode. 0=off, 1=on.',
        category: 'Defense', characteristic: ALARM_MODE, characteristicKey: 'ALARM_MODE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'works', safeToAutoRun: true,
    },
    {
        id: 'defense-alarm-mode-write',
        name: 'Write alarm mode (set off)',
        description: 'Disables the alarm by writing [0x00, 0x01] encrypted to ALARM_MODE. Same operation as the VanMoof app\'s alarm toggle.',
        category: 'Defense', characteristic: ALARM_MODE, characteristicKey: 'ALARM_MODE',
        operation: { type: 'write', payload: [0x00, 0x01], encrypt: true },
        requiresPhysicalConfirm: true,
        physicalConfirmPrompt: 'Did the bike\'s alarm indicator change?',
        knownStatus: 'works', safeToAutoRun: false,
    },

    // ── Movement ──────────────────────────────────────────────────────────────

    {
        id: 'movement-distance-read',
        name: 'Read odometer distance',
        description: 'Reads total distance ridden. 4-byte little-endian integer, divide by 10 for km.',
        category: 'Movement', characteristic: DISTANCE, characteristicKey: 'DISTANCE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'works', safeToAutoRun: true,
    },
    {
        id: 'movement-speed-read',
        name: 'Read current speed',
        description: 'Reads the current speed. Only meaningful while the bike is moving.',
        category: 'Movement', characteristic: SPEED, characteristicKey: 'SPEED',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown',
        firmwareNotes: 'Will read 0 or near-zero when the bike is stationary.',
        safeToAutoRun: true,
    },
    {
        id: 'movement-unit-system-read',
        name: 'Read unit system',
        description: 'Reads the current unit system setting (metric / imperial).',
        category: 'Movement', characteristic: UNIT_SYSTEM, characteristicKey: 'UNIT_SYSTEM',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'movement-power-level-read',
        name: 'Read power level',
        description: 'Reads the current pedal assist level. 0=Off, 1–4=levels, 5=Max.',
        category: 'Movement', characteristic: POWER_LEVEL, characteristicKey: 'POWER_LEVEL',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'works', safeToAutoRun: true,
    },
    {
        id: 'movement-power-level-write',
        name: 'Write power level (set to 1)',
        description: 'Sets pedal assist to level 1 using an encrypted read-write. Reads back the confirmed new value.',
        category: 'Movement', characteristic: POWER_LEVEL, characteristicKey: 'POWER_LEVEL',
        operation: { type: 'readwrite', payload: [0x01, 0x01], encrypt: true },
        requiresPhysicalConfirm: true,
        physicalConfirmPrompt: 'Did the assist level indicator on the bike display change to level 1?',
        knownStatus: 'works',
        firmwareNotes: 'Level 5 (Max) requires firmware 1.7.6 or later.',
        safeToAutoRun: false,
    },
    {
        id: 'movement-speed-limit-read',
        name: 'Read speed limit',
        description: 'Reads the current speed limit. 0=EU (25 km/h), 1=US (32 km/h), 2=JP (24 km/h), 255=No limit.',
        category: 'Movement', characteristic: SPEED_LIMIT, characteristicKey: 'SPEED_LIMIT',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'works', safeToAutoRun: true,
    },
    {
        id: 'movement-speed-limit-write',
        name: 'Write speed limit (set to EU)',
        description: 'Sets speed limit to EU 25 km/h by writing [0x00, 0x01] encrypted with a 400ms read-back.',
        category: 'Movement', characteristic: SPEED_LIMIT, characteristicKey: 'SPEED_LIMIT',
        operation: { type: 'readwrite', payload: [0x00, 0x01], encrypt: true, timeout: 400 },
        requiresPhysicalConfirm: true,
        physicalConfirmPrompt: 'Did the speed limit indicator update on the bike display?',
        knownStatus: 'works', safeToAutoRun: false,
    },
    {
        id: 'movement-e-shifter-gear-read',
        name: 'Read e-shifter gear',
        description: 'Reads the current gear. Only applicable on e-shifter equipped bikes (S3 Pro, X3).',
        category: 'Movement', characteristic: E_SHIFTER_GEAR, characteristicKey: 'E_SHIFTER_GEAR',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown',
        firmwareNotes: 'Will likely fail on standard S3 without e-shifter hardware.',
        safeToAutoRun: true,
    },
    {
        id: 'movement-e-shifter-points-read',
        name: 'Read e-shifter shift points',
        description: 'Reads the configured gear shift points for the e-shifter.',
        category: 'Movement', characteristic: E_SHIFTIG_POINTS, characteristicKey: 'E_SHIFTIG_POINTS',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown',
        firmwareNotes: 'Only applicable on e-shifter equipped bikes.',
        safeToAutoRun: true,
    },
    {
        id: 'movement-e-shifter-mode-read',
        name: 'Read e-shifter mode',
        description: 'Reads the e-shifter mode (manual / automatic).',
        category: 'Movement', characteristic: E_SHIFTER_MODE, characteristicKey: 'E_SHIFTER_MODE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown',
        firmwareNotes: 'Only applicable on e-shifter equipped bikes.',
        safeToAutoRun: true,
    },

    // ── BikeInfo ──────────────────────────────────────────────────────────────

    {
        id: 'bikeinfo-motor-battery-level-read',
        name: 'Read motor battery level',
        description: 'Reads the main motor battery charge as a percentage (0–100).',
        category: 'BikeInfo', characteristic: MOTOR_BATTERY_LEVEL, characteristicKey: 'MOTOR_BATTERY_LEVEL',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'works', safeToAutoRun: true,
    },
    {
        id: 'bikeinfo-motor-battery-state-read',
        name: 'Read motor battery state',
        description: 'Reads the motor battery charge state (e.g. charging, discharging).',
        category: 'BikeInfo', characteristic: MOTOR_BATTERY_STATE, characteristicKey: 'MOTOR_BATTERY_STATE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'bikeinfo-module-battery-level-read',
        name: 'Read module battery level',
        description: 'Reads the smartmodule (BLE/GSM module) battery level.',
        category: 'BikeInfo', characteristic: MODULE_BATTERY_LEVEL, characteristicKey: 'MODULE_BATTERY_LEVEL',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'bikeinfo-module-battery-state-read',
        name: 'Read module battery state',
        description: 'Reads the smartmodule battery charge state.',
        category: 'BikeInfo', characteristic: MODULE_BATTERY_STATE, characteristicKey: 'MODULE_BATTERY_STATE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'bikeinfo-bike-firmware-read',
        name: 'Read bike firmware version',
        description: 'Reads the main bike firmware version string (e.g. "1.7.6").',
        category: 'BikeInfo', characteristic: BIKE_FIRMWARE_VERSION, characteristicKey: 'BIKE_FIRMWARE_VERSION',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'works', safeToAutoRun: true,
    },
    {
        id: 'bikeinfo-ble-firmware-read',
        name: 'Read BLE chip firmware version',
        description: 'Reads the firmware version of the Bluetooth Low Energy chip.',
        category: 'BikeInfo', characteristic: BLE_CHIP_FIRMWARE_VERSION, characteristicKey: 'BLE_CHIP_FIRMWARE_VERSION',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'bikeinfo-controller-firmware-read',
        name: 'Read controller firmware version',
        description: 'Reads the motor controller firmware version.',
        category: 'BikeInfo', characteristic: CONTROLLER_FIRMWARE_VERSION, characteristicKey: 'CONTROLLER_FIRMWARE_VERSION',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'bikeinfo-pcba-hardware-read',
        name: 'Read PCBA hardware version',
        description: 'Reads the printed circuit board assembly hardware revision.',
        category: 'BikeInfo', characteristic: PCBA_HARDWARE_VERSION, characteristicKey: 'PCBA_HARDWARE_VERSION',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'bikeinfo-frame-number-read',
        name: 'Read frame number',
        description: 'Reads the bike frame number (VIN / serial number).',
        category: 'BikeInfo', characteristic: FRAME_NUMBER, characteristicKey: 'FRAME_NUMBER',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },

    // ── BikeState ─────────────────────────────────────────────────────────────

    {
        id: 'bikestate-module-mode-read',
        name: 'Read module mode',
        description: 'Reads the current smartmodule operating mode.',
        category: 'BikeState', characteristic: MODULE_MODE, characteristicKey: 'MODULE_MODE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'bikestate-module-state-read',
        name: 'Read module state',
        description: 'Reads the current smartmodule state flags.',
        category: 'BikeState', characteristic: MODULE_STATE, characteristicKey: 'MODULE_STATE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'bikestate-errors-read',
        name: 'Read error codes',
        description: 'Reads any active error codes from the bike.',
        category: 'BikeState', characteristic: ERRORS, characteristicKey: 'ERRORS',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'bikestate-wheel-size-read',
        name: 'Read wheel size',
        description: 'Reads the configured wheel size.',
        category: 'BikeState', characteristic: WHEEL_SIZE, characteristicKey: 'WHEEL_SIZE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'bikestate-clock-read',
        name: 'Read clock',
        description: 'Reads the bike\'s internal clock.',
        category: 'BikeState', characteristic: CLOCK, characteristicKey: 'CLOCK',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown',
        firmwareNotes: 'May return a Unix timestamp or be unused on some firmware versions.',
        safeToAutoRun: true,
    },

    // ── Sound ─────────────────────────────────────────────────────────────────

    {
        id: 'sound-play-sound-write',
        name: 'Play sound (authentication click)',
        description: 'Plays the standard connection sound (id=0x01) by writing [0x01, 0x01] encrypted to PLAY_SOUND.',
        category: 'Sound', characteristic: PLAY_SOUND, characteristicKey: 'PLAY_SOUND',
        operation: { type: 'write', payload: [0x01, 0x01], encrypt: true },
        requiresPhysicalConfirm: true,
        physicalConfirmPrompt: 'Did the bike play a click / beep sound?',
        knownStatus: 'works', safeToAutoRun: false,
    },
    {
        id: 'sound-volume-read',
        name: 'Read sound volume',
        description: 'Reads the current speaker volume setting.',
        category: 'Sound', characteristic: SOUND_VOLUME, characteristicKey: 'SOUND_VOLUME',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'sound-bell-read',
        name: 'Read bell tone',
        description: 'Reads the configured bell sound. 0x16=Bell, 0x0a=Sonar, 0x17=Tada, 0x18=Foghorn.',
        category: 'Sound', characteristic: BELL_SOUND, characteristicKey: 'BELL_SOUND',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'works', safeToAutoRun: true,
    },
    {
        id: 'sound-bell-write',
        name: 'Write bell tone (set to default Bell)',
        description: 'Sets the bell to the default Bell tone (0x16) by writing [0x16, 0x01] encrypted. Idempotent for most users.',
        category: 'Sound', characteristic: BELL_SOUND, characteristicKey: 'BELL_SOUND',
        operation: { type: 'write', payload: [0x16, 0x01], encrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'works', safeToAutoRun: false,
    },

    // ── Light ─────────────────────────────────────────────────────────────────

    {
        id: 'light-mode-read',
        name: 'Read light mode',
        description: 'Reads the current light mode setting (on / off / auto).',
        category: 'Light', characteristic: LIGHT_MODE, characteristicKey: 'LIGHT_MODE',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
    {
        id: 'light-sensor-read',
        name: 'Read light sensor',
        description: 'Reads the ambient light sensor value. Used by the automatic light mode.',
        category: 'Light', characteristic: SENSOR, characteristicKey: 'SENSOR',
        operation: { type: 'read', decrypt: true },
        requiresPhysicalConfirm: false,
        knownStatus: 'unknown', safeToAutoRun: true,
    },
]
