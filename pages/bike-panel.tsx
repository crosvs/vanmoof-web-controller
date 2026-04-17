import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import {
    Bike, BikeCredentials, Characteristic, CHARACTERISTICS, connectToBike,
    PowerLevel, BellTone, SpeedLimit, LockState,
    LOCK_STATE, SPEED, ALARM_MODE,
    POWER_LEVEL, SPEED_LIMIT, BELL_SOUND,
    MOTOR_BATTERY_LEVEL, MODULE_BATTERY_LEVEL,
    BIKE_FIRMWARE_VERSION, DISTANCE, FRAME_NUMBER,
} from '../lib/bike'
import { Button } from '../components/Button'

// BellSoundWalkthrough uses ffmpeg (WASM) — must be client-only
const BellSoundWalkthrough = dynamic(
    () => import('../components/bellsound/BellSoundWalkthrough'),
    { ssr: false }
)

// ─── types ────────────────────────────────────────────────────────────────────

type ValueSource = 'live' | 'cached' | 'stale' | 'unknown'

interface BikeVarState {
    value: string | null
    rawHex: string | null    // raw decrypted bytes, shown in dev mode
    source: ValueSource
    lastRead: string | null  // ISO timestamp
    reading: boolean
    error: string | null
}

interface VarDef {
    key: string
    label: string
    // TEMPLATE: tune maxAgeMs per variable for your app's refresh requirements.
    // After this many ms, cached values auto-escalate to 'stale'.
    maxAgeMs: number
    subscribable?: boolean
    experimental?: boolean   // shown with ⚠ label
}

interface StoredBikeState {
    mac: string
    savedAt: string
    variables: Record<string, { value: string; lastRead: string }>
}

interface BleStats { outbound: number; inbound: number }

// Duck-type interface satisfied by both Bike and FakeBike.
// Server is accessed separately via type cast where needed.
interface BikeInterface {
    mac: string
    disconnect(): void
    setPowerLvl(level: PowerLevel): Promise<PowerLevel>
    setSpeedLimit(limit: SpeedLimit): Promise<SpeedLimit>
    setBellTone(bell: number): Promise<BellTone>
    playSound(id: number): Promise<void>
    rawRead(characteristic: Characteristic, decrypt?: boolean): Promise<Uint8Array>
    rawWrite(characteristic: Characteristic, data: Uint8Array, encrypt?: boolean): Promise<void>
    rawReadWrite(characteristic: Characteristic, data: Uint8Array, encrypt?: boolean, timeout?: number): Promise<Uint8Array>
    rawCharacteristicProperties(characteristic: Characteristic): Promise<Record<string, boolean>>
    rawSubscribe(characteristic: Characteristic, callback: (data: Uint8Array) => void, decrypt?: boolean): Promise<void>
    rawUnsubscribe(characteristic: Characteristic): Promise<void>
    initiateBellSoundTransfer(buffer: ArrayBuffer): Promise<unknown>
    sendBellSoundChunk(chunk: ArrayBuffer): Promise<unknown>
}

// ─── variable definitions ─────────────────────────────────────────────────────
// TEMPLATE: Add, remove, or reorder variables to match your app's needs.

const VAR_DEFS: VarDef[] = [
    { key: 'lockState',       label: 'Lock State',        maxAgeMs: 60_000,     subscribable: true },
    { key: 'powerLevel',      label: 'Power Level',       maxAgeMs: 300_000 },
    { key: 'speedLimit',      label: 'Speed Limit',       maxAgeMs: 300_000 },
    { key: 'bellTone',        label: 'Bell Tone',         maxAgeMs: Infinity },
    { key: 'motorBattery',    label: 'Motor Battery',     maxAgeMs: 120_000 },
    { key: 'moduleBattery',   label: 'Module Battery',    maxAgeMs: 120_000 },
    { key: 'distance',        label: 'Distance (km)',     maxAgeMs: 60_000 },
    { key: 'firmwareVersion', label: 'Firmware Version',  maxAgeMs: Infinity },
    { key: 'frameNumber',     label: 'Frame Number',      maxAgeMs: Infinity },
    { key: 'alarmMode',       label: 'Alarm Mode',        maxAgeMs: 300_000 },
    { key: 'speed',           label: 'Speed',             maxAgeMs: 5_000,      subscribable: true, experimental: true },
]

// ─── sound definitions (from SoundBoard.tsx) ──────────────────────────────────
// TEMPLATE: Add or remove sounds here.

const SOUND_DEFS: { id: number; label: string }[] = [
    { id: 0x01, label: 'Click' },
    { id: 0x02, label: 'Error' },
    { id: 0x03, label: 'Pling' },
    { id: 0x06, label: 'Cling clong' },
    { id: 0x0A, label: 'Bell' },
    { id: 0x16, label: 'Normal bike bell' },
    { id: 0x17, label: 'Bell Tada' },
    { id: 0x0B, label: 'Whistle' },
    { id: 0x18, label: 'BOAT' },
    { id: 0x14, label: 'Wuup' },
    { id: 0x19, label: 'Success but error' },
    { id: 0x07, label: 'Charging noise' },
    { id: 0x0E, label: 'Alarm' },
    { id: 0x0F, label: 'Alarm stage 2' },
    { id: 0x12, label: 'Charging..' },
    { id: 0x13, label: 'Updating..' },
    { id: 0x15, label: 'Update complete' },
    { id: 0x1A, label: 'Make weird noises' },
]

// ─── helpers ──────────────────────────────────────────────────────────────────

const STORAGE_PREFIX = 'vanmoof-bike-panel-'
const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

function fmtBytes(bytes: Uint8Array): string {
    if (bytes.length === 0) return '(empty — decrypt stripped zeros)'
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')
}

function parseHex(input: string): Uint8Array {
    const cleaned = input.replace(/\s+/g, '')
    if (cleaned.length === 0) return new Uint8Array(0)
    if (cleaned.length % 2 !== 0) throw new Error('Odd number of hex digits')
    return new Uint8Array(cleaned.match(/.{2}/g)!.map(h => {
        const v = parseInt(h, 16)
        if (isNaN(v)) throw new Error(`Invalid hex byte: ${h}`)
        return v
    }))
}

function relativeAge(iso: string | null): string {
    if (!iso) return ''
    const diffMs = Date.now() - new Date(iso).getTime()
    if (diffMs < 60_000) return 'just now'
    const diffMin = Math.floor(diffMs / 60_000)
    if (diffMin < 60) return `${diffMin} min ago`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `${diffH} h ago`
    return new Date(iso).toLocaleDateString()
}

function effectiveSource(state: BikeVarState, maxAgeMs: number): ValueSource {
    if (state.source === 'live') return 'live'
    if (state.source === 'unknown' || !state.lastRead) return 'unknown'
    if (state.source === 'stale') return 'stale'
    // cached: check age threshold
    const age = Date.now() - new Date(state.lastRead).getTime()
    return age > maxAgeMs ? 'stale' : 'cached'
}

function loadFromStorage(mac: string): StoredBikeState | null {
    try {
        const raw = localStorage.getItem(STORAGE_PREFIX + mac)
        return raw ? (JSON.parse(raw) as StoredBikeState) : null
    } catch { return null }
}

function saveToStorage(mac: string, variables: Record<string, BikeVarState>) {
    const stored: StoredBikeState = { mac, savedAt: new Date().toISOString(), variables: {} }
    for (const [key, v] of Object.entries(variables)) {
        if (v.value !== null && v.lastRead !== null) {
            stored.variables[key] = { value: v.value, lastRead: v.lastRead }
        }
    }
    try { localStorage.setItem(STORAGE_PREFIX + mac, JSON.stringify(stored)) } catch { /* storage full */ }
}

// Per-variable read. Uses rawRead directly so we always have the raw bytes for dev mode.
// NOTE: Bike.decrypt() strips trailing zero bytes — use `data[0] ?? 0` for characteristics
//       that legitimately return 0x00 (alarmMode=Off, speed=0, etc.).
async function readVar(key: string, bike: BikeInterface): Promise<{ value: string; rawHex: string }> {
    const r = (data: Uint8Array, value: string) => ({ value, rawHex: fmtBytes(data) })

    switch (key) {
        case 'lockState': {
            const data = await bike.rawRead(LOCK_STATE)
            const v = (data[0] ?? 0) as LockState
            return r(data, LockState[v] ?? `${v}`)
        }
        case 'powerLevel': {
            const data = await bike.rawRead(POWER_LEVEL)
            const v = data[0] ?? 0
            return r(data, (['Off', '1', '2', '3', '4', 'Sport'])[v] ?? `${v}`)
        }
        case 'speedLimit': {
            const data = await bike.rawRead(SPEED_LIMIT)
            const v = data[0] === 255 ? 3 : (data[0] ?? 0)
            const names: Record<number, string> = { 0: 'EU (25 km/h)', 1: 'US (32 km/h)', 2: 'JP (24 km/h)', 3: 'No Limit' }
            return r(data, names[v] ?? `${v}`)
        }
        case 'bellTone': {
            const data = await bike.rawRead(BELL_SOUND)
            const v = data[0] ?? 0
            const names: Record<number, string> = { 0x16: 'Bell', 0x0a: 'Sonar', 0x17: 'Party', 0x18: 'Foghorn' }
            return r(data, names[v] ?? `0x${v.toString(16)}`)
        }
        case 'motorBattery': {
            const data = await bike.rawRead(MOTOR_BATTERY_LEVEL)
            return r(data, `${data[0] ?? 0}%`)
        }
        case 'moduleBattery': {
            const data = await bike.rawRead(MODULE_BATTERY_LEVEL)
            return r(data, `${data[0] ?? 0}%`)
        }
        case 'distance': {
            const data = await bike.rawRead(DISTANCE)
            // Pad to 4 bytes — decrypt strips leading zeros
            const padded = new Uint8Array(4)
            padded.set(data.slice(0, 4))
            const dist = new DataView(padded.buffer).getUint32(0, true) / 10
            return r(data, `${dist.toFixed(1)} km`)
        }
        case 'firmwareVersion': {
            const data = await bike.rawRead(BIKE_FIRMWARE_VERSION)
            const raw = new TextDecoder().decode(data)
            const clean = raw.split('.').map(p => p.match(/^0+(.+)/)?.[1] ?? p).join('.')
            return r(data, clean)
        }
        case 'frameNumber': {
            const data = await bike.rawRead(FRAME_NUMBER, false)
            return r(data, new TextDecoder().decode(data))
        }
        case 'alarmMode': {
            const data = await bike.rawRead(ALARM_MODE)
            const v = data[0] ?? 0  // decrypt strips 0x00 → empty array
            return r(data, v === 0 ? 'Off' : v === 1 ? 'On' : `${v}`)
        }
        case 'speed': {
            const data = await bike.rawRead(SPEED)
            const v = data[0] ?? 0  // 0 = stationary
            return r(data, `${v} (raw byte)`)
        }
        default: throw new Error(`Unknown variable: ${key}`)
    }
}

// ─── fake bike ────────────────────────────────────────────────────────────────

class FakeBike implements BikeInterface {
    mac = 'FA:KE:BI:KE:00:00'
    readonly fakeDevice = new EventTarget()
    readonly server = { connected: true, device: this.fakeDevice }

    disconnect() {}
    async setPowerLvl(level: PowerLevel) { await delay(150); return level }
    async setSpeedLimit(limit: SpeedLimit) { await delay(150); return limit }
    async setBellTone(bell: number) { await delay(150); return bell as BellTone }
    async playSound(_id: number) { await delay(150) }
    async rawRead(c: Characteristic, _d = true): Promise<Uint8Array> {
        await delay(120)
        if (c === LOCK_STATE)           return new Uint8Array([0x00])
        if (c === POWER_LEVEL)          return new Uint8Array([0x03])
        if (c === SPEED_LIMIT)          return new Uint8Array([0x00])
        if (c === BELL_SOUND)           return new Uint8Array([0x16])
        if (c === MOTOR_BATTERY_LEVEL)  return new Uint8Array([0x52])
        if (c === MODULE_BATTERY_LEVEL) return new Uint8Array([0x64])
        if (c === DISTANCE)             return new Uint8Array([0x56, 0x30, 0x00, 0x00])
        if (c === BIKE_FIRMWARE_VERSION) return new TextEncoder().encode('1.07.06')
        if (c === FRAME_NUMBER)         return new TextEncoder().encode('ASY2012345')
        if (c === ALARM_MODE)           return new Uint8Array([0x00])
        if (c === SPEED)                return new Uint8Array([0x00])
        return new Uint8Array([0x01, 0x00])
    }
    async rawWrite(_c: Characteristic, _d: Uint8Array, _e = true): Promise<void> { await delay(150) }
    async rawReadWrite(_c: Characteristic, _d: Uint8Array, _e = true, _t = 0): Promise<Uint8Array> {
        await delay(150); return new Uint8Array([0x01, 0x00])
    }
    async rawCharacteristicProperties(_c: Characteristic): Promise<Record<string, boolean>> {
        await delay(50)
        return { broadcast: false, read: true, writeWithoutResponse: false, write: true, notify: true, indicate: false, authenticatedSignedWrites: false }
    }
    async rawSubscribe(_c: Characteristic, cb: (d: Uint8Array) => void, _dec = true): Promise<void> {
        await delay(50)
        setTimeout(() => cb(new Uint8Array([0x00])), 2000)
    }
    async rawUnsubscribe(_c: Characteristic): Promise<void> { await delay(50) }
    async initiateBellSoundTransfer(_buf: ArrayBuffer): Promise<unknown> { await delay(200); return {} }
    async sendBellSoundChunk(_chunk: ArrayBuffer): Promise<unknown> { await delay(50); return {} }
}

// ─── page root ────────────────────────────────────────────────────────────────

export default function BikePanelPage() {
    const [credentials, setCredentials] = useState<BikeCredentials[]>([])
    const [bike, setBike] = useState<BikeInterface | undefined>()
    const [connecting, setConnecting] = useState(false)
    const [connectError, setConnectError] = useState<string | undefined>()

    useEffect(() => {
        try {
            const raw = localStorage.getItem('vm-bike-credentials')
            if (raw) setCredentials(JSON.parse(raw))
        } catch { /* no credentials */ }
    }, [])

    const connect = async (creds: BikeCredentials) => {
        setConnecting(true)
        setConnectError(undefined)
        try {
            const b = await connectToBike(creds)
            await b.authenticate(false)
            setBike(b)
        } catch (e) {
            setConnectError(e instanceof Error ? e.message : String(e))
        } finally {
            setConnecting(false)
        }
    }

    const disconnect = () => {
        bike?.disconnect()
        setBike(undefined)
    }

    return (
        <div className='page'>
            <h1>Bike Control Panel</h1>
            <p className='navLink'>
                <Link href='/ble-tester'>Raw BLE Tester</Link>
                {' · '}
                <Link href='/ble-compatibility'>BLE Compatibility Tester</Link>
            </p>

            {bike ? (
                <BikePanelMain bike={bike} onDisconnect={disconnect} />
            ) : (
                <BikeConnector
                    credentials={credentials}
                    connecting={connecting}
                    error={connectError}
                    onConnect={connect}
                    onFakeBike={() => setBike(new FakeBike())}
                />
            )}

            <style jsx>{`
                .page {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    padding: 2rem;
                    min-height: 100vh;
                }
                h1 { margin-bottom: 0.25rem; }
                .navLink { font-size: 0.85rem; color: var(--label-color); margin: 0 0 1.5rem; }
            `}</style>
        </div>
    )
}

// ─── bike connector ───────────────────────────────────────────────────────────

function BikeConnector({ credentials, connecting, error, onConnect, onFakeBike }: {
    credentials: BikeCredentials[]
    connecting: boolean
    error: string | undefined
    onConnect: (creds: BikeCredentials) => void
    onFakeBike: () => void
}) {
    return (
        <>
            {credentials.length > 0 && (
                <>
                    <p style={{ color: 'var(--label-color)' }}>Select a bike to connect:</p>
                    <div className='bikes'>
                        {credentials.map((creds, i) => (
                            <Button key={i} onClick={() => onConnect(creds)} disabled={connecting}>
                                {creds.name}
                                <span className='mac'>{creds.mac}</span>
                            </Button>
                        ))}
                    </div>
                    {error && <p className='err'>{error}</p>}
                    <div className='divider'><span>or</span></div>
                </>
            )}
            {credentials.length === 0 && (
                <p style={{ color: 'var(--label-color)', textAlign: 'center' }}>
                    No saved credentials — <Link href='/'>log in</Link> to see real bikes, or use the fake bike below.
                </p>
            )}
            <Button onClick={onFakeBike} secondary>
                Use fake bike
                <span className='mac'>FA:KE:BI:KE:00:00</span>
            </Button>
            <style jsx>{`
                .bikes { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 320px; }
                .mac { display: block; font-size: 0.75rem; color: var(--label-color); }
                .err { color: var(--error-text-color); margin-top: 8px; }
                .divider {
                    display: flex; align-items: center; width: 100%;
                    max-width: 320px; margin: 12px 0; gap: 8px;
                    color: var(--label-color); font-size: 0.85rem;
                }
                .divider::before, .divider::after {
                    content: ''; flex: 1; border-top: 1px solid var(--secondary-border-color);
                }
            `}</style>
        </>
    )
}

// ─── main panel ───────────────────────────────────────────────────────────────

function BikePanelMain({ bike, onDisconnect }: { bike: BikeInterface; onDisconnect: () => void }) {
    const isRealBike = bike instanceof Bike

    const [variables, setVariables] = useState<Record<string, BikeVarState>>(() => {
        const m: Record<string, BikeVarState> = {}
        for (const def of VAR_DEFS) {
            m[def.key] = { value: null, rawHex: null, source: 'unknown', lastRead: null, reading: false, error: null }
        }
        return m
    })

    const [connected, setConnected] = useState(true)
    const [activeSubs, setActiveSubs] = useState<Set<string>>(new Set())
    const [pendingWrite, setPendingWrite] = useState<Record<string, boolean>>({})
    const [writeSelections, setWriteSelections] = useState<Record<string, string>>({})
    const [cmdSelections, setCmdSelections] = useState<Record<string, string>>({ playSound: String(0x01) })
    const [cmdResult, setCmdResult] = useState<{ key: string; msg: string; isError: boolean } | null>(null)
    const [showBellUploader, setShowBellUploader] = useState(false)

    // TEMPLATE: remove the Dev toggle if you don't want raw output in production
    const [devMode, setDevMode] = useState(false)
    const [tick, setTick] = useState(0)

    // BLE ops counter — written via ref (no re-render), flushed to display state every 1s
    // TEMPLATE: track bleStats.outbound/inbound per call; high rates = battery drain
    const bleStatsRef = useRef<BleStats>({ outbound: 0, inbound: 0 })
    const [bleStatsDisplay, setBleStatsDisplay] = useState<BleStats>({ outbound: 0, inbound: 0 })

    useEffect(() => {
        const stored = loadFromStorage(bike.mac)
        if (!stored) return
        setVariables(prev => {
            const next = { ...prev }
            for (const [key, sv] of Object.entries(stored.variables)) {
                if (next[key]) next[key] = { ...next[key], value: sv.value, source: 'cached', lastRead: sv.lastRead }
            }
            return next
        })
    }, [bike.mac])

    useEffect(() => {
        const bikeServer = (bike as Bike).server ?? (bike as FakeBike).server
        const device = bikeServer?.device as EventTarget | undefined
        if (!device) return
        const onDisc = () => setConnected(false)
        device.addEventListener('gattserverdisconnected', onDisc)
        return () => device.removeEventListener('gattserverdisconnected', onDisc)
    }, [bike])

    useEffect(() => {
        const id = setInterval(() => {
            const bikeServer = (bike as Bike).server ?? (bike as FakeBike).server
            if (bikeServer) setConnected(bikeServer.connected)
        }, 3000)
        return () => clearInterval(id)
    }, [bike])

    useEffect(() => {
        const id = setInterval(() => setTick(t => t + 1), 30_000)
        return () => clearInterval(id)
    }, [])

    useEffect(() => {
        const id = setInterval(() => setBleStatsDisplay({ ...bleStatsRef.current }), 1_000)
        return () => clearInterval(id)
    }, [])

    useEffect(() => {
        return () => {
            if (activeSubs.has('lockState')) bike.rawUnsubscribe(LOCK_STATE).catch(() => {})
            if (activeSubs.has('speed'))    bike.rawUnsubscribe(SPEED).catch(() => {})
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        saveToStorage(bike.mac, variables)
    }, [bike.mac, variables])

    const patchVar = (key: string, patch: Partial<BikeVarState>) =>
        setVariables(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }))

    const trackOut = () => { bleStatsRef.current.outbound++ }
    const trackIn  = () => { bleStatsRef.current.inbound++ }

    const doRead = async (key: string) => {
        patchVar(key, { reading: true, error: null })
        trackOut()
        try {
            const { value, rawHex } = await readVar(key, bike)
            trackIn()
            setVariables(prev => ({
                ...prev,
                [key]: { ...prev[key], value, rawHex, source: 'live', lastRead: new Date().toISOString(), reading: false, error: null },
            }))
        } catch (e) {
            patchVar(key, { reading: false, error: e instanceof Error ? e.message : String(e) })
        }
    }

    const doReadAll = async () => {
        for (const def of VAR_DEFS) {
            await doRead(def.key)
            await delay(150)
        }
    }

    const doWrite = async (key: string, rawVal?: string | number) => {
        const val = rawVal ?? writeSelections[key]
        if (val === undefined || val === '') return
        setPendingWrite(prev => ({ ...prev, [key]: true }))
        // Encrypted writes internally read CHALLENGE first (outbound + inbound), then write (outbound)
        trackOut(); trackOut(); trackIn()
        try {
            if (key === 'powerLevel')  await bike.setPowerLvl(Number(val) as PowerLevel)
            if (key === 'speedLimit')  await bike.setSpeedLimit(Number(val) as SpeedLimit)
            if (key === 'bellTone')    await bike.setBellTone(Number(val))
            if (key === 'alarmMode')   await bike.rawWrite(ALARM_MODE, new Uint8Array([Number(val)]), true)
            // Keep rawHex from last read — stale badge already signals the value is outdated
            patchVar(key, { source: 'stale' })
        } catch (e) {
            patchVar(key, { error: e instanceof Error ? e.message : String(e) })
        } finally {
            setPendingWrite(prev => ({ ...prev, [key]: false }))
        }
    }

    const toggleSub = async (key: string) => {
        const char = key === 'lockState' ? LOCK_STATE : SPEED
        if (activeSubs.has(key)) {
            try { await bike.rawUnsubscribe(char) } catch { /* ignore */ }
            setActiveSubs(prev => { const s = new Set(prev); s.delete(key); return s })
        } else {
            try {
                await bike.rawSubscribe(char, (data) => {
                    trackIn()
                    const rawHex = fmtBytes(data)
                    if (key === 'lockState') {
                        const v = (data[0] ?? 0) as LockState
                        const label = LockState[v] ?? `${v}`
                        setVariables(prev => ({
                            ...prev,
                            lockState: { ...prev.lockState, value: label, rawHex, source: 'live', lastRead: new Date().toISOString(), error: null },
                        }))
                    } else if (key === 'speed') {
                        const v = data[0] ?? 0
                        setVariables(prev => ({
                            ...prev,
                            speed: { ...prev.speed, value: `${v} (raw byte)`, rawHex, source: 'live', lastRead: new Date().toISOString(), error: null },
                        }))
                    }
                }, true)
                setActiveSubs(prev => new Set(prev).add(key))
            } catch (e) {
                patchVar(key, { error: e instanceof Error ? e.message : String(e) })
            }
        }
    }

    // ── commands ──
    // TEMPLATE: Add write-only commands here

    const doPlaySound = async () => {
        const id = Number(cmdSelections['playSound'] ?? 0x01)
        const hex = `0x${id.toString(16).padStart(2, '0')}`
        setCmdResult(null)
        trackOut(); trackOut(); trackIn()
        try {
            await bike.playSound(id)
            setCmdResult({ key: 'playSound', msg: `✓ played ${hex}`, isError: false })
        } catch (e) {
            setCmdResult({ key: 'playSound', msg: '✗ ' + (e instanceof Error ? e.message : String(e)), isError: true })
        }
    }

    return (
        <div className='panel'>

            {/* ── header ── */}
            <div className='header'>
                <div className='headerLeft'>
                    <span className='bikeMac'>{bike.mac}</span>
                    <span className={connected ? 'connPill connLive' : 'connPill connDead'}>
                        {connected ? '● Connected' : '● Disconnected'}
                    </span>
                    <span className='bleStats' title='BLE ops since connect (↑ outbound ↓ inbound)'>
                        ↑ {bleStatsDisplay.outbound}  ↓ {bleStatsDisplay.inbound}
                    </span>
                </div>
                <div className='headerRight'>
                    {/* TEMPLATE: remove the Dev button if you don't want raw output in production */}
                    <Button
                        onClick={() => setDevMode(d => !d)}
                        secondary
                        style={{ width: 'auto', fontSize: '0.85rem', padding: '6px 14px', ...(devMode ? { background: 'var(--warning-box-bg-color)' } : {}) }}
                    >
                        Dev {devMode ? 'on' : 'off'}
                    </Button>
                    <Button onClick={doReadAll} secondary style={{ width: 'auto', fontSize: '0.85rem', padding: '6px 14px' }}>
                        Read All
                    </Button>
                    <Button onClick={onDisconnect} secondary style={{ width: 'auto', fontSize: '0.85rem', padding: '6px 14px' }}>
                        Disconnect
                    </Button>
                </div>
            </div>

            {/* ── active subscriptions strip ── */}
            {/* TEMPLATE: unsubscribe when the user navigates away / app backgrounds */}
            {activeSubs.size > 0 && (
                <ActiveSubsStrip activeSubs={activeSubs} varDefs={VAR_DEFS} onUnsub={toggleSub} />
            )}

            {/* ── bike state section ── */}
            {/* TEMPLATE: Reorder or hide rows to build your app */}
            <div className='section'>
                <div className='sectionTitle'>Bike State</div>
                {VAR_DEFS.map(def => (
                    <StateRow
                        key={def.key}
                        def={def}
                        varState={variables[def.key]}
                        isSubscribed={activeSubs.has(def.key)}
                        pendingWrite={!!pendingWrite[def.key]}
                        writeSelection={writeSelections[def.key] ?? ''}
                        devMode={devMode}
                        onWriteSelectChange={(val) => setWriteSelections(prev => ({ ...prev, [def.key]: val }))}
                        onRead={() => doRead(def.key)}
                        onWrite={(val?) => doWrite(def.key, val)}
                        onToggleSub={() => toggleSub(def.key)}
                        tick={tick}
                    />
                ))}
            </div>

            {/* ── commands section ── */}
            {/* TEMPLATE: Add write-only commands here */}
            <div className='section'>
                <div className='sectionTitle'>Commands</div>

                <div className='cmdRow'>
                    <span className='cmdLabel'>Play Sound</span>
                    <select
                        className='cmdSelect'
                        value={cmdSelections['playSound'] ?? String(0x01)}
                        onChange={e => setCmdSelections(prev => ({ ...prev, playSound: e.target.value }))}
                    >
                        {SOUND_DEFS.map(s => (
                            <option key={s.id} value={s.id}>
                                {s.label} (0x{s.id.toString(16).padStart(2, '0')})
                            </option>
                        ))}
                    </select>
                    <Button onClick={doPlaySound} secondary style={{ width: 'auto', fontSize: '0.85rem', padding: '6px 14px' }}>
                        Play
                    </Button>
                    {cmdResult?.key === 'playSound' && (
                        <span className={cmdResult.isError ? 'cmdErr' : 'cmdOk'}>{cmdResult.msg}</span>
                    )}
                </div>

                <div className='cmdRow'>
                    <span className='cmdLabel'>Custom Bell Sound</span>
                    <Button
                        onClick={() => setShowBellUploader(true)}
                        disabled={!isRealBike}
                        secondary
                        style={{ width: 'auto', fontSize: '0.85rem', padding: '6px 14px' }}
                    >
                        Upload Sound
                    </Button>
                    {!isRealBike && (
                        <span className='cmdNote'>Connect a real bike to upload</span>
                    )}
                </div>
            </div>

            {/* ── dev mode BLE tester ── */}
            {devMode && (
                <DevTester bike={bike} />
            )}

            {/* ── bell sound uploader overlay ── */}
            {showBellUploader && isRealBike && (
                <BellSoundWalkthrough
                    bike={bike as unknown as Bike}
                    onDismiss={() => setShowBellUploader(false)}
                />
            )}

            <style jsx>{`
                .panel { width: 100%; max-width: 780px; }

                .header {
                    display: flex; align-items: center; justify-content: space-between;
                    gap: 12px; padding: 10px 14px;
                    border: 1px solid var(--border-color);
                    margin-bottom: 12px; flex-wrap: wrap;
                }
                .headerLeft  { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
                .headerRight { display: flex; gap: 8px; flex-wrap: wrap; }
                .bikeMac { font-family: monospace; font-size: 0.88rem; }
                .connPill {
                    font-size: 0.78rem; padding: 2px 10px;
                    border-radius: 12px; font-weight: 600;
                }
                .connLive { background: var(--positive-box-bg-color); }
                .connDead { background: var(--error-box-bg-color); }
                .bleStats {
                    font-size: 0.74rem; color: var(--label-color);
                    font-family: monospace; cursor: default;
                }

                .section { margin-bottom: 20px; border: 1px solid var(--border-color); }
                .sectionTitle {
                    font-size: 0.74rem; font-weight: bold; color: var(--label-color);
                    padding: 6px 12px; border-bottom: 1px solid var(--border-color);
                    text-transform: uppercase; letter-spacing: 0.05em;
                }

                .cmdRow {
                    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
                    padding: 10px 12px;
                    border-bottom: 1px solid var(--secondary-border-color);
                }
                .cmdRow:last-child { border-bottom: none; }
                .cmdLabel { font-size: 0.9rem; min-width: 150px; flex-shrink: 0; }
                .cmdSelect {
                    padding: 5px 8px; font-size: 0.85rem;
                    background: var(--main-bg-color);
                    border: 1px solid var(--border-color);
                    color: var(--text-color);
                }
                .cmdOk   { font-size: 0.82rem; color: var(--active-color); }
                .cmdErr  { font-size: 0.82rem; color: var(--error-text-color); }
                .cmdNote { font-size: 0.78rem; color: var(--label-color); }
            `}</style>
        </div>
    )
}

// ─── active subscriptions strip ──────────────────────────────────────────────

function ActiveSubsStrip({ activeSubs, varDefs, onUnsub }: {
    activeSubs: Set<string>
    varDefs: VarDef[]
    onUnsub: (key: string) => void
}) {
    return (
        <div className='strip'>
            <span className='stripLabel'>Active subscriptions:</span>
            {Array.from(activeSubs).map(key => {
                const def = varDefs.find(d => d.key === key)!
                return (
                    <button key={key} className='chip' onClick={() => onUnsub(key)}>
                        {def.label}{def.experimental ? ' (exp)' : ''}  ✕
                    </button>
                )
            })}
            <style jsx>{`
                .strip {
                    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
                    padding: 6px 10px; margin-bottom: 12px;
                    border: 1px solid var(--secondary-border-color);
                    background: var(--warning-box-bg-color);
                    font-size: 0.8rem;
                }
                .stripLabel { color: var(--label-color); white-space: nowrap; }
                .chip {
                    background: none; border: 1px solid var(--secondary-border-color);
                    padding: 2px 8px; cursor: pointer; font-size: 0.76rem;
                    color: var(--text-color);
                }
            `}</style>
        </div>
    )
}

// ─── state row ────────────────────────────────────────────────────────────────

function StateRow({ def, varState, isSubscribed, pendingWrite, writeSelection, devMode, onWriteSelectChange, onRead, onWrite, onToggleSub, tick }: {
    def: VarDef
    varState: BikeVarState
    isSubscribed: boolean
    pendingWrite: boolean
    writeSelection: string
    devMode: boolean
    onWriteSelectChange: (val: string) => void
    onRead: () => void
    onWrite: (val?: string | number) => void
    onToggleSub: () => void
    tick: number
}) {
    void tick  // triggers re-render for relative age display

    const src = effectiveSource(varState, def.maxAgeMs)
    const age = relativeAge(varState.lastRead)

    const badgeText = src === 'unknown' ? '' : src
    const badgeClass =
        src === 'live'    ? 'badgeLive' :
        src === 'cached'  ? 'badgeCached' :
        src === 'stale'   ? 'badgeStale' : ''

    return (
        <div className='row'>
            <div className='rowMain'>
                <span className='rowLabel'>
                    {def.label}
                    {def.experimental && <span className='expTag'> ⚠ exp</span>}
                </span>
                <span className='rowValue'>
                    {varState.reading ? '…' : (varState.value ?? '—')}
                </span>
                <div className='rowMeta'>
                    {badgeText && <span className={`badge ${badgeClass}`}>{badgeText}</span>}
                    {age && <span className='rowAge'>{age}</span>}
                </div>
                <div className='rowActions'>
                    <Button
                        onClick={onRead}
                        disabled={varState.reading}
                        secondary
                        style={{ width: 'auto', fontSize: '0.76rem', padding: '3px 10px' }}
                    >
                        {varState.reading ? '…' : 'Read'}
                    </Button>
                    {def.subscribable && (
                        <Button
                            onClick={onToggleSub}
                            secondary
                            style={{ width: 'auto', fontSize: '0.76rem', padding: '3px 10px' }}
                        >
                            {isSubscribed ? 'Unsub' : 'Sub'}
                        </Button>
                    )}
                </div>
            </div>

            {/* Dev mode: show raw decrypted bytes */}
            {devMode && varState.rawHex !== null && (
                <div className='rawHex'>raw: {varState.rawHex}</div>
            )}

            {varState.error && (
                <div className='rowError'>{varState.error}</div>
            )}

            {/* Inline write controls — TEMPLATE: adjust per variable */}

            {(def.key === 'powerLevel' || def.key === 'speedLimit' || def.key === 'bellTone') && (
                <WriteSelectRow
                    defKey={def.key}
                    selection={writeSelection}
                    pending={pendingWrite}
                    onChange={onWriteSelectChange}
                    onSet={() => onWrite()}
                />
            )}

            {def.key === 'alarmMode' && (
                <div className='writeRow'>
                    <Button onClick={() => onWrite(1)} disabled={pendingWrite} secondary style={{ width: 'auto', fontSize: '0.76rem', padding: '3px 10px' }}>
                        {pendingWrite ? '…' : 'Enable Alarm'}
                    </Button>
                    <Button onClick={() => onWrite(0)} disabled={pendingWrite} secondary style={{ width: 'auto', fontSize: '0.76rem', padding: '3px 10px' }}>
                        {pendingWrite ? '…' : 'Disable Alarm'}
                    </Button>
                </div>
            )}

            <style jsx>{`
                .row {
                    display: flex; flex-direction: column; gap: 4px;
                    padding: 8px 12px;
                    border-bottom: 1px solid var(--secondary-border-color);
                }
                .row:last-child { border-bottom: none; }
                .rowMain { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
                .rowLabel { flex: 0 0 150px; font-size: 0.9rem; font-weight: 500; }
                .expTag { font-size: 0.67rem; color: var(--label-color); }
                .rowValue { flex: 1; font-family: monospace; font-size: 0.88rem; min-width: 80px; }
                .rowMeta { display: flex; align-items: center; gap: 6px; }
                .badge {
                    font-size: 0.68rem; padding: 1px 7px; border-radius: 10px;
                    font-weight: 600; white-space: nowrap;
                }
                .badgeLive   { background: var(--positive-box-bg-color); }
                .badgeCached { color: var(--label-color); border: 1px solid var(--secondary-border-color); opacity: 0.85; }
                .badgeStale  { background: var(--warning-box-bg-color); }
                .rowAge { font-size: 0.7rem; color: var(--label-color); }
                .rowActions { display: flex; gap: 6px; margin-left: auto; }
                .rawHex {
                    font-family: monospace; font-size: 0.74rem;
                    color: var(--label-color); padding-left: 158px;
                    opacity: 0.9;
                }
                .rowError { font-size: 0.77rem; color: var(--error-text-color); padding-left: 158px; }
                .writeRow { display: flex; gap: 8px; padding-left: 158px; }
            `}</style>
        </div>
    )
}

// ─── write select row (powerLevel / speedLimit / bellTone) ────────────────────

function WriteSelectRow({ defKey, selection, pending, onChange, onSet }: {
    defKey: string
    selection: string
    pending: boolean
    onChange: (val: string) => void
    onSet: () => void
}) {
    const options: { value: number; label: string }[] =
        defKey === 'powerLevel' ? [
            { value: PowerLevel.Off,    label: 'Off' },
            { value: PowerLevel.First,  label: '1' },
            { value: PowerLevel.Second, label: '2' },
            { value: PowerLevel.Third,  label: '3' },
            { value: PowerLevel.Fourth, label: '4' },
            { value: PowerLevel.Max,    label: 'Sport' },
        ] :
        defKey === 'speedLimit' ? [
            { value: SpeedLimit.EU,       label: 'EU (25 km/h)' },
            { value: SpeedLimit.US,       label: 'US (32 km/h)' },
            { value: SpeedLimit.JP,       label: 'JP (24 km/h)' },
            { value: SpeedLimit.NO_LIMIT, label: 'No Limit' },
        ] : [
            { value: BellTone.Bell,    label: 'Bell' },
            { value: BellTone.Sonar,   label: 'Sonar' },
            { value: BellTone.Party,   label: 'Party' },
            { value: BellTone.Foghorn, label: 'Foghorn' },
        ]

    const placeholder =
        defKey === 'powerLevel' ? '— set level —' :
        defKey === 'speedLimit' ? '— set limit —' : '— set tone —'

    return (
        <div className='wRow'>
            <select className='wSelect' value={selection} onChange={e => onChange(e.target.value)}>
                <option value=''>{placeholder}</option>
                {options.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                ))}
            </select>
            <Button
                onClick={onSet}
                disabled={pending || !selection}
                secondary
                style={{ width: 'auto', fontSize: '0.76rem', padding: '3px 10px' }}
            >
                {pending ? '…' : 'Set'}
            </Button>
            <style jsx>{`
                .wRow { display: flex; align-items: center; gap: 8px; padding-left: 158px; }
                .wSelect {
                    padding: 3px 8px; font-size: 0.82rem;
                    background: var(--main-bg-color); border: 1px solid var(--border-color);
                    color: var(--text-color);
                }
                .wSelect option { background: var(--main-bg-color); color: var(--text-color); }
            `}</style>
        </div>
    )
}

// ─── dev tester ───────────────────────────────────────────────────────────────
// Embedded mini-BLE-tester shown only when Dev mode is on.
// Covers both known characteristics (quick-read buttons) and custom operations.

interface DevLogEntry {
    ts: string
    charKey: string
    op: string
    result: string
}

type DevOp = 'read' | 'write' | 'readwrite' | 'props'

function DevTester({ bike }: { bike: BikeInterface }) {
    const charKeys = Object.keys(CHARACTERISTICS)
    const [charKey, setCharKey] = useState('LOCK_STATE')
    const [op, setOp] = useState<DevOp>('read')
    const [hexInput, setHexInput] = useState('')
    const [encrypt, setEncrypt] = useState(true)
    const [timeout, setTimeout_] = useState(0)
    const [running, setRunning] = useState(false)
    const [log, setLog] = useState<DevLogEntry[]>([])

    const pushLog = (entry: DevLogEntry) =>
        setLog(prev => [entry, ...prev.slice(0, 99)])

    const execute = async (overrideKey?: string, overrideOp?: DevOp) => {
        const ck = overrideKey ?? charKey
        const o  = overrideOp  ?? op
        const char = CHARACTERISTICS[ck]
        const ts = new Date().toLocaleTimeString()
        setRunning(true)
        let result: string
        try {
            if (o === 'props') {
                const props = await bike.rawCharacteristicProperties(char)
                const active = Object.entries(props).filter(([, v]) => v).map(([k]) => k)
                result = active.length > 0 ? active.join(', ') : 'none'
            } else if (o === 'read') {
                const data = await bike.rawRead(char, encrypt)
                result = '← ' + fmtBytes(data)
            } else if (o === 'write') {
                const payload = parseHex(hexInput)
                await bike.rawWrite(char, payload, encrypt)
                result = '✓ write ok'
            } else {
                const payload = parseHex(hexInput)
                const data = await bike.rawReadWrite(char, payload, encrypt, timeout)
                result = '← ' + fmtBytes(data)
            }
        } catch (e) {
            result = '✗ ' + (e instanceof Error ? e.message : String(e))
        }
        pushLog({ ts, charKey: ck, op: o, result })
        setRunning(false)
    }

    const showPayload = op === 'write' || op === 'readwrite'

    return (
        <div className='devTester'>
            <div className='devTitle'>Dev Tester</div>

            {/* Quick reads — one button per known variable */}
            <div className='quickSection'>
                <span className='quickLabel'>Quick reads:</span>
                <div className='quickBtns'>
                    {VAR_DEFS.map(def => {
                        // Map var key → characteristic key
                        const charMap: Record<string, string> = {
                            lockState: 'LOCK_STATE', powerLevel: 'POWER_LEVEL',
                            speedLimit: 'SPEED_LIMIT', bellTone: 'BELL_SOUND',
                            motorBattery: 'MOTOR_BATTERY_LEVEL', moduleBattery: 'MODULE_BATTERY_LEVEL',
                            distance: 'DISTANCE', firmwareVersion: 'BIKE_FIRMWARE_VERSION',
                            frameNumber: 'FRAME_NUMBER', alarmMode: 'ALARM_MODE', speed: 'SPEED',
                        }
                        const ck = charMap[def.key]
                        if (!ck) return null
                        return (
                            <button
                                key={def.key}
                                className='quickBtn'
                                onClick={() => execute(ck, 'read')}
                                disabled={running}
                            >
                                {def.label}
                            </button>
                        )
                    })}
                </div>
            </div>

            {/* Custom operation */}
            <div className='customSection'>
                <div className='customRow'>
                    <label className='fieldLabel'>Characteristic</label>
                    <select className='sel' value={charKey} onChange={e => setCharKey(e.target.value)}>
                        {charKeys.map(k => <option key={k} value={k}>{k}</option>)}
                    </select>
                </div>
                <div className='customRow'>
                    <label className='fieldLabel'>Operation</label>
                    <select className='sel selSm' value={op} onChange={e => setOp(e.target.value as DevOp)}>
                        <option value='read'>read</option>
                        <option value='write'>write</option>
                        <option value='readwrite'>readwrite</option>
                        <option value='props'>props</option>
                    </select>
                    <label className='checkLabel'>
                        <input
                            type='checkbox'
                            checked={encrypt}
                            onChange={e => setEncrypt(e.target.checked)}
                        />
                        {op === 'read' ? ' decrypt' : ' encrypt'}
                    </label>
                </div>
                {showPayload && (
                    <div className='customRow'>
                        <label className='fieldLabel'>Payload (hex)</label>
                        <input
                            type='text'
                            className='hexIn'
                            placeholder='e.g. 02 01'
                            value={hexInput}
                            onChange={e => setHexInput(e.target.value)}
                        />
                        {op === 'readwrite' && (
                            <label className='checkLabel'>
                                delay
                                <input
                                    type='number'
                                    className='numIn'
                                    value={timeout}
                                    min={0}
                                    step={50}
                                    onChange={e => setTimeout_(Number(e.target.value))}
                                />
                                ms
                            </label>
                        )}
                    </div>
                )}
                <div className='customRow'>
                    <Button
                        onClick={() => execute()}
                        disabled={running}
                        secondary
                        style={{ width: 'auto', fontSize: '0.82rem', padding: '5px 16px' }}
                    >
                        {running ? '…' : 'Execute'}
                    </Button>
                </div>
            </div>

            {/* Log */}
            {log.length > 0 && (
                <div className='logWrap'>
                    <div className='logHeader'>
                        <span>Log</span>
                        <button className='clearBtn' onClick={() => setLog([])}>clear</button>
                    </div>
                    {log.map((e, i) => (
                        <div key={i} className='logEntry'>
                            <span className='logTs'>{e.ts}</span>
                            <span className='logChar'>{e.charKey}</span>
                            <span className='logOp'>{e.op}</span>
                            <span className='logResult'>{e.result}</span>
                        </div>
                    ))}
                </div>
            )}

            <style jsx>{`
                .devTester {
                    border: 1px solid var(--warning-box-bg-color);
                    margin-bottom: 20px;
                }
                .devTitle {
                    font-size: 0.74rem; font-weight: bold; color: var(--label-color);
                    padding: 6px 12px; border-bottom: 1px solid var(--warning-box-bg-color);
                    text-transform: uppercase; letter-spacing: 0.05em;
                    background: var(--warning-box-bg-color);
                }
                .quickSection {
                    padding: 8px 12px;
                    border-bottom: 1px solid var(--secondary-border-color);
                    display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap;
                }
                .quickLabel {
                    font-size: 0.78rem; color: var(--label-color);
                    white-space: nowrap; padding-top: 3px;
                }
                .quickBtns { display: flex; flex-wrap: wrap; gap: 6px; }
                .quickBtn {
                    font-size: 0.74rem; padding: 3px 8px;
                    border: 1px solid var(--secondary-border-color);
                    background: none; color: var(--text-color); cursor: pointer;
                }
                .quickBtn:disabled { opacity: 0.5; cursor: default; }
                .quickBtn:hover:not(:disabled) { background: var(--active-button-bg-color); }
                .customSection {
                    padding: 8px 12px;
                    display: flex; flex-direction: column; gap: 6px;
                    border-bottom: 1px solid var(--secondary-border-color);
                }
                .customRow {
                    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
                }
                .fieldLabel {
                    font-size: 0.78rem; color: var(--label-color);
                    flex: 0 0 110px;
                }
                .sel {
                    padding: 4px 6px; font-size: 0.82rem;
                    background: var(--main-bg-color);
                    border: 1px solid var(--border-color);
                    color: var(--text-color); flex: 1; min-width: 0;
                }
                .sel option { background: var(--main-bg-color); color: var(--text-color); }
                .selSm { flex: 0 0 auto; width: 110px; }
                .hexIn {
                    flex: 1; padding: 4px 6px; font-size: 0.82rem; font-family: monospace;
                    background: var(--main-bg-color);
                    border: 1px solid var(--border-color);
                    color: var(--text-color);
                }
                .numIn {
                    width: 64px; padding: 2px 4px; font-size: 0.78rem;
                    background: var(--main-bg-color);
                    border: 1px solid var(--border-color);
                    color: var(--text-color);
                }
                .checkLabel {
                    font-size: 0.78rem; color: var(--label-color);
                    display: flex; align-items: center; gap: 4px; white-space: nowrap;
                }
                .logWrap { font-family: monospace; font-size: 0.78rem; }
                .logHeader {
                    display: flex; justify-content: space-between;
                    padding: 4px 12px;
                    border-bottom: 1px solid var(--secondary-border-color);
                    color: var(--label-color); font-size: 0.72rem;
                }
                .clearBtn {
                    background: none; border: none; color: var(--label-color);
                    cursor: pointer; font-size: 0.72rem; padding: 0;
                }
                .logEntry {
                    display: flex; flex-wrap: wrap; gap: 6px;
                    padding: 4px 12px;
                    border-bottom: 1px solid var(--secondary-border-color);
                }
                .logEntry:last-child { border-bottom: none; }
                .logTs     { color: var(--label-color); flex-shrink: 0; }
                .logChar   { font-weight: bold; flex-shrink: 0; }
                .logOp     { color: var(--label-color); flex-shrink: 0; }
                .logResult { flex-basis: 100%; word-break: break-all; }
            `}</style>
        </div>
    )
}
