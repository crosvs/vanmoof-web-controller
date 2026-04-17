import { useState, useRef, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { BikeCredentials, Characteristic, connectToBike } from '../lib/bike'
import {
    COMPATIBILITY_TESTS, TEST_CATEGORIES, FIRMWARE_VERSIONS,
    CompatibilityTest, TestCategory,
} from '../lib/compatibilityTests'
import { Button } from '../components/Button'
import { Modal, ModalConfirmOrDecline } from '../components/Modal'

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmtBytes(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── types ────────────────────────────────────────────────────────────────────

type TestStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skipped' | 'awaiting-confirm'

interface TestResult {
    testId: string
    status: TestStatus
    rawHex?: string
    decodedValue?: string
    errorMessage?: string
    physicalConfirmAnswer?: boolean
    durationMs?: number
    timestamp?: string
}

interface RawBikeInterface {
    mac: string
    disconnect?(): void
    rawRead(characteristic: Characteristic, decrypt?: boolean): Promise<Uint8Array>
    rawWrite(characteristic: Characteristic, data: Uint8Array, encrypt?: boolean, withoutResponse?: boolean): Promise<void>
    rawReadWrite(characteristic: Characteristic, data: Uint8Array, encrypt?: boolean, timeout?: number): Promise<Uint8Array>
    rawCharacteristicProperties(characteristic: Characteristic): Promise<Record<string, boolean>>
    rawSubscribe(characteristic: Characteristic, callback: (data: Uint8Array) => void, decrypt?: boolean): Promise<void>
    rawUnsubscribe(characteristic: Characteristic): Promise<void>
}

// ─── fake bike ────────────────────────────────────────────────────────────────

class FakeRawBike implements RawBikeInterface {
    mac = 'FA:KE:BI:KE:00:00'

    async rawRead(_char: Characteristic, _decrypt = true): Promise<Uint8Array> {
        await delay(120)
        return new Uint8Array([0x01, 0x00])
    }
    async rawWrite(_char: Characteristic, _data: Uint8Array, _encrypt = false, _wor = false): Promise<void> {
        await delay(120)
    }
    async rawReadWrite(_char: Characteristic, _data: Uint8Array, _encrypt = false, timeout = 0): Promise<Uint8Array> {
        await delay(Math.max(120, timeout ?? 0))
        return new Uint8Array([0x01, 0x00])
    }
    async rawCharacteristicProperties(_char: Characteristic): Promise<Record<string, boolean>> {
        await delay(40)
        return { broadcast: false, read: true, writeWithoutResponse: true, write: false, notify: true, indicate: false, authenticatedSignedWrites: false }
    }
    async rawSubscribe(_char: Characteristic, callback: (data: Uint8Array) => void, _decrypt = true): Promise<void> {
        await delay(40)
        setTimeout(() => callback(new Uint8Array([0x01])), 800)
    }
    async rawUnsubscribe(_char: Characteristic): Promise<void> {
        await delay(40)
    }
}

// ─── decoder ──────────────────────────────────────────────────────────────────

function tryDecode(testId: string, data: Uint8Array): string | undefined {
    if (data.length === 0) return undefined

    if (testId.startsWith('defense-lock-state')) {
        const labels = ['Unlocked', 'Locked', 'Standby', 'Alarm']
        const v = data[0]
        return `${labels[v] ?? 'Unknown'} (${v})`
    }
    if (testId === 'bikeinfo-motor-battery-level-read' || testId === 'bikeinfo-module-battery-level-read') {
        return `${data[0]}%`
    }
    if (testId.includes('firmware') || testId === 'bikeinfo-frame-number-read' || testId === 'bikeinfo-pcba-hardware-read') {
        try {
            const text = new TextDecoder().decode(data).replace(/\0/g, '').trim()
            if (text) return text
        } catch { /* ignore */ }
    }
    if (testId === 'movement-distance-read' && data.length > 0) {
        // Trailing zero bytes are stripped by the decrypt function; pad back to 4 bytes before reading LE uint32
        const padded = new Uint8Array(4)
        padded.set(data.slice(0, Math.min(4, data.length)))
        const view = new DataView(padded.buffer)
        return `${(view.getUint32(0, true) / 10).toFixed(1)} km`
    }
    if (testId === 'bikestate-clock-read' && data.length > 0) {
        const padded = new Uint8Array(4)
        padded.set(data.slice(0, Math.min(4, data.length)))
        const view = new DataView(padded.buffer)
        const ts = view.getUint32(0, true)
        return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    }
    if (testId === 'movement-power-level-read') {
        const labels: Record<number, string> = { 0: 'Off', 1: '1', 2: '2', 3: '3', 4: '4', 5: 'Max' }
        return `Level ${labels[data[0]] ?? data[0]}`
    }
    if (testId.startsWith('movement-speed-limit')) {
        const map: Record<number, string> = { 0: 'EU 25 km/h', 1: 'US 32 km/h', 2: 'JP 24 km/h', 255: 'No limit' }
        return map[data[0]] ?? `Unknown (${data[0]})`
    }
    if (testId.startsWith('sound-bell')) {
        const tones: Record<number, string> = { 0x16: 'Bell', 0x0a: 'Sonar', 0x17: 'Tada', 0x18: 'Foghorn' }
        return tones[data[0]] ?? `0x${data[0].toString(16).padStart(2, '0')}`
    }
    return undefined
}

// ─── test executor ────────────────────────────────────────────────────────────

interface OpResult {
    rawHex?: string
    decodedValue?: string
    durationMs: number
    timestamp: string
}

async function executeTestOp(
    bike: RawBikeInterface,
    test: CompatibilityTest,
    onProgress?: (liveRawHex: string) => void,
): Promise<OpResult> {
    const op = test.operation
    const start = Date.now()
    const timestamp = new Date().toISOString()

    if (op.type === 'read') {
        const data = await bike.rawRead(test.characteristic, op.decrypt)
        return { rawHex: fmtBytes(data), decodedValue: tryDecode(test.id, data), durationMs: Date.now() - start, timestamp }
    }
    if (op.type === 'write') {
        await bike.rawWrite(test.characteristic, new Uint8Array(op.payload), op.encrypt, op.withoutResponse)
        return { rawHex: op.payload.map(b => b.toString(16).padStart(2, '0')).join(' '), durationMs: Date.now() - start, timestamp }
    }
    if (op.type === 'readwrite') {
        const data = await bike.rawReadWrite(test.characteristic, new Uint8Array(op.payload), op.encrypt, op.timeout)
        return { rawHex: fmtBytes(data), decodedValue: tryDecode(test.id, data), durationMs: Date.now() - start, timestamp }
    }
    // subscribe — fire onProgress on each notification so the row updates live
    const notifications: string[] = []
    onProgress?.('')
    await bike.rawSubscribe(test.characteristic, (data) => {
        const dec = tryDecode(test.id, data)
        notifications.push(fmtBytes(data) + (dec ? `  —  ${dec}` : ''))
        onProgress?.(notifications.join('\n'))
    }, op.decrypt)
    await delay(op.durationMs)
    await bike.rawUnsubscribe(test.characteristic)
    return {
        rawHex: notifications.length > 0 ? notifications.join('\n') : '',
        durationMs: Date.now() - start,
        timestamp,
    }
}

// ─── status icon ──────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: TestStatus }) {
    const map: Record<TestStatus, string> = {
        pending: '○', running: '◌', pass: '●', fail: '✕', skipped: '–', 'awaiting-confirm': '?',
    }
    return (
        <>
            <span className={`si ${status}`}>{map[status]}</span>
            <style jsx global>{`@keyframes sip{0%,100%{opacity:1}50%{opacity:0.25}}`}</style>
            <style jsx>{`
                .si { width: 18px; text-align: center; font-size: 1rem; flex-shrink: 0; display: inline-block; }
                .si.pass { color: #28a745; }
                .si.fail { color: #dc3545; }
                .si.running { color: var(--active-color, #007bff); animation: sip 1s ease-in-out infinite; }
                .si.awaiting-confirm { color: #e6a800; }
                .si.pending { color: var(--label-color); opacity: 0.5; }
                .si.skipped { color: var(--label-color); opacity: 0.45; }
            `}</style>
        </>
    )
}

// ─── test row ─────────────────────────────────────────────────────────────────

function TestRow({ test, result, isRunning, onRun, expanded, onToggle }: {
    test: CompatibilityTest
    result?: TestResult
    isRunning: boolean
    onRun: () => void
    expanded: boolean
    onToggle: () => void
}) {
    const status: TestStatus = result?.status ?? 'pending'

    return (
        <div className={`tr ${status}`}>
            <div className='main' onClick={onToggle}>
                <StatusIcon status={status} />
                <span className='name'>{test.name}</span>
                <span className='char'>{test.characteristicKey}</span>
                <span className='op'>{test.operation.type}</span>
                {test.knownStatus === 'fails' && <span className='badge kf'>known-fail</span>}
                {!test.safeToAutoRun && test.knownStatus !== 'fails' && <span className='badge man'>manual</span>}
                <button className='runBtn' onClick={e => { e.stopPropagation(); onRun() }} disabled={isRunning}>
                    Run
                </button>
            </div>
            {expanded && (
                <div className='detail'>
                    <p className='desc'>{test.description}</p>
                    {test.knownStatus === 'fails' && test.knownFailReason && (
                        <p className='failReason'>{test.knownFailReason}</p>
                    )}
                    {test.firmwareNotes && <p className='fwNote'>Note: {test.firmwareNotes}</p>}
                    {result && (
                        <div className='res'>
                            {result.rawHex && <div className='hex'>{result.rawHex}</div>}
                            {result.decodedValue && <div className='decoded'>{result.decodedValue}</div>}
                            {result.errorMessage && <div className='errMsg'>{result.errorMessage}</div>}
                            {result.durationMs !== undefined && <div className='timing'>{result.durationMs}ms</div>}
                            {result.physicalConfirmAnswer !== undefined && (
                                <div className='phys'>Physical confirm: {result.physicalConfirmAnswer ? '✓ Yes' : '✗ No'}</div>
                            )}
                        </div>
                    )}
                </div>
            )}
            <style jsx>{`
                .tr { border-bottom: 1px solid var(--secondary-border-color, #eee); }
                .tr.pass .main { background: rgba(40,167,69,0.07); }
                .tr.fail .main { background: rgba(220,53,69,0.07); }
                .tr.awaiting-confirm .main { background: rgba(230,168,0,0.12); }
                .tr.skipped { opacity: 0.5; }
                .main {
                    display: flex; align-items: center; gap: 8px;
                    padding: 7px 10px; cursor: pointer; user-select: none;
                }
                .main:hover { background: rgba(128,128,128,0.05); }
                .name { flex: 1; font-size: 0.88rem; }
                .char { font-size: 0.72rem; font-family: monospace; color: var(--label-color); }
                .op { font-size: 0.72rem; color: var(--label-color); }
                .badge { font-size: 0.67rem; padding: 1px 5px; white-space: nowrap; border-radius: 2px; }
                .badge.kf { background: rgba(220,53,69,0.15); color: #c82333; }
                .badge.man { background: rgba(230,168,0,0.15); color: #856404; }
                .runBtn {
                    font-size: 0.72rem; padding: 3px 9px; flex-shrink: 0;
                    background: none; border: 1px solid var(--border-color, #ccc);
                    color: var(--text-color); cursor: pointer;
                }
                .runBtn:disabled { opacity: 0.35; cursor: not-allowed; }
                .detail { padding: 8px 12px 12px 36px; background: rgba(128,128,128,0.03); font-size: 0.83rem; }
                .desc { margin: 0 0 4px; color: var(--label-color); }
                .failReason { margin: 0 0 4px; color: #dc3545; font-size: 0.78rem; }
                .fwNote { margin: 0 0 4px; color: var(--label-color); font-style: italic; font-size: 0.78rem; }
                .res { margin-top: 6px; font-family: monospace; font-size: 0.78rem; display: flex; flex-direction: column; gap: 3px; }
                .hex { color: var(--label-color); word-break: break-all; white-space: pre-line; }
                .decoded { color: var(--active-color, #007bff); font-weight: bold; }
                .errMsg { color: #dc3545; }
                .timing { color: var(--label-color); font-size: 0.72rem; }
                .phys { color: var(--label-color); }
            `}</style>
        </div>
    )
}

// ─── test category group ──────────────────────────────────────────────────────

function TestCategoryGroup({ category, results, isRunning, onRun, expandedTestId, onToggle }: {
    category: TestCategory
    results: Record<string, TestResult>
    isRunning: boolean
    onRun: (testId: string) => void
    expandedTestId: string | null
    onToggle: (testId: string) => void
}) {
    const tests = COMPATIBILITY_TESTS.filter(t => t.category === category)
    const pass = tests.filter(t => results[t.id]?.status === 'pass').length
    const fail = tests.filter(t => results[t.id]?.status === 'fail').length

    return (
        <div className='grp'>
            <div className='hdr'>
                <span className='cat'>{category}</span>
                <span className='stats'>
                    {pass > 0 && <span className='sp'>✓{pass}</span>}
                    {fail > 0 && <span className='sf'>✗{fail}</span>}
                    <span className='st'>{tests.length}</span>
                </span>
            </div>
            {tests.map(t => (
                <TestRow
                    key={t.id}
                    test={t}
                    result={results[t.id]}
                    isRunning={isRunning}
                    onRun={() => onRun(t.id)}
                    expanded={expandedTestId === t.id}
                    onToggle={() => onToggle(t.id)}
                />
            ))}
            <style jsx>{`
                .grp { border: 1px solid var(--border-color, #ddd); margin-bottom: 12px; }
                .hdr {
                    display: flex; justify-content: space-between; align-items: center;
                    padding: 6px 10px;
                    background: rgba(128,128,128,0.05);
                    border-bottom: 1px solid var(--border-color, #ddd);
                }
                .cat { font-size: 0.72rem; font-weight: bold; text-transform: uppercase; letter-spacing: .06em; color: var(--label-color); }
                .stats { display: flex; gap: 6px; font-size: 0.75rem; font-family: monospace; }
                .sp { color: #28a745; }
                .sf { color: #dc3545; }
                .st { color: var(--label-color); }
            `}</style>
        </div>
    )
}

// ─── progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ completed, total }: { completed: number; total: number }) {
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0
    return (
        <div className='wrap'>
            <div className='bar' style={{ width: `${pct}%` }} />
            <span className='lbl'>{completed} / {total}</span>
            <style jsx>{`
                .wrap { position: relative; height: 20px; background: var(--secondary-border-color, #e0e0e0); margin-bottom: 16px; overflow: hidden; }
                .bar { position: absolute; left: 0; top: 0; bottom: 0; background: var(--active-color, #007bff); transition: width .25s ease; }
                .lbl { position: absolute; width: 100%; text-align: center; font-size: 0.72rem; line-height: 20px; color: var(--text-color); }
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
            {credentials.length > 0 ? (
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
            ) : (
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
                .err { color: red; margin-top: 8px; }
                .divider { display: flex; align-items: center; width: 100%; max-width: 320px; margin: 12px 0; gap: 8px; color: var(--label-color); font-size: 0.85rem; }
                .divider::before, .divider::after { content: ''; flex: 1; border-top: 1px solid var(--secondary-border-color); }
            `}</style>
        </>
    )
}

// ─── subscribe prep modal ─────────────────────────────────────────────────────

function SubscribePrepModal({ testId, onStart, onCancel }: {
    testId: string | null
    onStart: () => void
    onCancel: () => void
}) {
    const test = testId ? COMPATIBILITY_TESTS.find(t => t.id === testId) ?? null : null
    if (!test || test.operation.type !== 'subscribe') return null
    const durationSec = test.operation.durationMs / 1000
    return (
        <Modal open onClose={onCancel} title={test.name}>
            <p style={{ fontSize: '0.95rem', margin: '0 0 12px' }}>
                {test.physicalConfirmPrompt}
            </p>
            <p style={{ fontSize: '0.83rem', color: 'var(--label-color)', margin: 0 }}>
                The {durationSec}-second listen window will start when you press Start.
                Notifications will appear live in the test row.
            </p>
            <ModalConfirmOrDecline
                onCancel={onCancel}
                onConfirm={onStart}
                confirmText={`Start (${durationSec}s)`}
            />
        </Modal>
    )
}

// ─── physical confirm modal ───────────────────────────────────────────────────

function PhysicalConfirmModal({ test, result, onConfirm, onCancel }: {
    test: CompatibilityTest | null
    result?: TestResult
    onConfirm: () => void
    onCancel: () => void
}) {
    if (!test) return null
    const isSubscribe = test.operation.type === 'subscribe'
    const rawHex = result?.rawHex ?? ''
    const notifLines = rawHex ? rawHex.split('\n') : []
    const durationSec = isSubscribe
        ? (test.operation as { durationMs: number }).durationMs / 1000
        : 0
    return (
        <Modal open onClose={onCancel} title='Physical Confirmation'>
            <p style={{ fontWeight: 'bold', marginBottom: 6 }}>{test.name}</p>
            {isSubscribe ? (
                <>
                    <p style={{ fontSize: '0.83rem', color: 'var(--label-color)', margin: '0 0 10px' }}>
                        {durationSec}s window closed.{' '}
                        {notifLines.length > 0
                            ? `${notifLines.length} notification${notifLines.length > 1 ? 's' : ''} received:`
                            : 'No notifications were received.'}
                    </p>
                    {notifLines.length > 0 && (
                        <div className='notifBox'>
                            {notifLines.map((line, i) => (
                                <div key={i} className='notifLine'>{line}</div>
                            ))}
                        </div>
                    )}
                    <p style={{ marginTop: 12, fontSize: '0.9rem' }}>
                        Did the notification(s) match your physical action?
                    </p>
                </>
            ) : (
                <>
                    <p style={{ fontSize: '0.9rem', margin: '0 0 8px' }}>
                        {test.physicalConfirmPrompt}
                    </p>
                    {rawHex && (
                        <p style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--label-color)', wordBreak: 'break-all', margin: 0 }}>
                            Raw: {rawHex}
                        </p>
                    )}
                </>
            )}
            <ModalConfirmOrDecline
                onCancel={onCancel}
                onConfirm={onConfirm}
                confirmText={isSubscribe ? 'Yes, it matched' : 'Yes, it worked'}
            />
            <style jsx>{`
                .notifBox {
                    width: 100%; text-align: left;
                    border: 1px solid var(--border-color, #ddd);
                    background: rgba(128,128,128,0.04);
                    font-family: monospace; font-size: 0.8rem;
                    max-height: 140px; overflow-y: auto;
                }
                .notifLine {
                    padding: 5px 10px;
                    border-bottom: 1px solid var(--secondary-border-color, #eee);
                    color: var(--text-color);
                }
                .notifLine:last-child { border-bottom: none; }
            `}</style>
        </Modal>
    )
}

// ─── main tester ──────────────────────────────────────────────────────────────

function CompatibilityTesterMain({ bike, onDisconnect }: {
    bike: RawBikeInterface
    onDisconnect: () => void
}) {
    const [results, setResults] = useState<Record<string, TestResult>>({})
    const [isRunning, setIsRunning] = useState(false)
    const [runStats, setRunStats] = useState({ completed: 0, total: 0 })
    const [physicalConfirmTestId, setPhysicalConfirmTestId] = useState<string | null>(null)
    const [subscribePrepTestId, setSubscribePrepTestId] = useState<string | null>(null)
    const [showRunAllWarning, setShowRunAllWarning] = useState(false)
    const [selectedFirmware, setSelectedFirmware] = useState('unknown')
    const [expandedTestId, setExpandedTestId] = useState<string | null>(null)

    const abortRef = useRef<AbortController | null>(null)
    const confirmResolveRef = useRef<((answer: boolean) => void) | null>(null)
    const subscribePrepResolveRef = useRef<((start: boolean) => void) | null>(null)

    const startRun = useCallback(async (testIds: string[], forceKnownFail = false) => {
        const controller = new AbortController()
        abortRef.current = controller
        setIsRunning(true)
        setRunStats({ completed: 0, total: testIds.length })
        let completed = 0

        for (const testId of testIds) {
            if (controller.signal.aborted) break
            const test = COMPATIBILITY_TESTS.find(t => t.id === testId)!
            setResults(prev => ({ ...prev, [testId]: { testId, status: 'running' } }))

            if (test.knownStatus === 'fails' && !forceKnownFail) {
                setResults(prev => ({ ...prev, [testId]: { testId, status: 'skipped' } }))
                completed++
                setRunStats(s => ({ ...s, completed }))
                continue
            }

            const isSubscribe = test.operation.type === 'subscribe'
            if (isSubscribe) setExpandedTestId(testId)

            // For subscribe tests: show prep modal so the user knows what to do before the window opens
            if (isSubscribe && test.requiresPhysicalConfirm) {
                setSubscribePrepTestId(testId)
                const shouldStart = await new Promise<boolean>(resolve => {
                    subscribePrepResolveRef.current = resolve
                })
                setSubscribePrepTestId(null)
                if (!shouldStart) {
                    setResults(prev => ({ ...prev, [testId]: { testId, status: 'skipped' } }))
                    completed++
                    setRunStats(s => ({ ...s, completed }))
                    continue
                }
            }

            try {
                const opResult = await executeTestOp(bike, test, isSubscribe ? (liveHex) => {
                    setResults(prev => ({ ...prev, [testId]: { ...prev[testId]!, rawHex: liveHex } }))
                } : undefined)
                if (controller.signal.aborted) break

                if (test.requiresPhysicalConfirm) {
                    setResults(prev => ({ ...prev, [testId]: { ...opResult, testId, status: 'awaiting-confirm' } }))
                    setPhysicalConfirmTestId(testId)

                    const answer = await new Promise<boolean>(resolve => {
                        confirmResolveRef.current = resolve
                    })

                    setPhysicalConfirmTestId(null)
                    setResults(prev => ({
                        ...prev,
                        [testId]: { ...prev[testId]!, status: answer ? 'pass' : 'fail', physicalConfirmAnswer: answer },
                    }))
                } else {
                    setResults(prev => ({ ...prev, [testId]: { ...opResult, testId, status: 'pass' } }))
                }
            } catch (e) {
                if (controller.signal.aborted) break
                setResults(prev => ({
                    ...prev,
                    [testId]: {
                        testId, status: 'fail',
                        errorMessage: e instanceof Error ? e.message : String(e),
                        timestamp: new Date().toISOString(),
                    },
                }))
            }

            completed++
            setRunStats(s => ({ ...s, completed }))
            await delay(300)
        }

        setIsRunning(false)
        abortRef.current = null
    }, [bike])

    const handleRunSingle = useCallback((testId: string) => {
        startRun([testId], true)
    }, [startRun])

    const handleStop = () => {
        abortRef.current?.abort()
        subscribePrepResolveRef.current?.(false)
        subscribePrepResolveRef.current = null
        setSubscribePrepTestId(null)
        confirmResolveRef.current?.(false)
        confirmResolveRef.current = null
    }

    const handleSubscribePrep = (start: boolean) => {
        subscribePrepResolveRef.current?.(start)
        subscribePrepResolveRef.current = null
        setSubscribePrepTestId(null)
    }

    const handlePhysicalConfirm = (answer: boolean) => {
        confirmResolveRef.current?.(answer)
        confirmResolveRef.current = null
        setPhysicalConfirmTestId(null)
    }

    const handleRunAllConfirmed = () => {
        setShowRunAllWarning(false)
        startRun(COMPATIBILITY_TESTS.map(t => t.id))
    }

    const handleExport = () => {
        const r = Object.values(results)
        const passed = r.filter(x => x.status === 'pass').length
        const failed = r.filter(x => x.status === 'fail').length
        const skipped = r.filter(x => x.status === 'skipped').length
        const data = {
            exportedAt: new Date().toISOString(),
            bike: { mac: bike.mac, firmwareVersion: selectedFirmware },
            platform: { userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown' },
            summary: {
                total: COMPATIBILITY_TESTS.length, passed, failed, skipped,
                unknown: COMPATIBILITY_TESTS.length - passed - failed - skipped,
            },
            results: COMPATIBILITY_TESTS.map(test => ({
                testId: test.id,
                testName: test.name,
                category: test.category,
                characteristic: test.characteristicKey,
                operationType: test.operation.type,
                knownStatus: test.knownStatus,
                status: results[test.id]?.status ?? 'pending',
                rawHex: results[test.id]?.rawHex,
                decodedValue: results[test.id]?.decodedValue,
                errorMessage: results[test.id]?.errorMessage,
                physicalConfirmAnswer: results[test.id]?.physicalConfirmAnswer,
                durationMs: results[test.id]?.durationMs,
                timestamp: results[test.id]?.timestamp,
            })),
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
        a.href = url
        a.download = `vanmoof-ble-compat-${bike.mac.replace(/:/g, '')}-fw${selectedFirmware}-${ts}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }

    const confirmTest = physicalConfirmTestId
        ? COMPATIBILITY_TESTS.find(t => t.id === physicalConfirmTestId) ?? null
        : null

    return (
        <div className='main'>
            <div className='hdr'>
                <div className='bikeInfo'>
                    <span className='mac'>{bike.mac}</span>
                    <label className='fw'>
                        Firmware:
                        <select value={selectedFirmware} onChange={e => setSelectedFirmware(e.target.value)}>
                            {FIRMWARE_VERSIONS.map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                    </label>
                </div>
                <div className='acts'>
                    {isRunning ? (
                        <Button onClick={handleStop} secondary style={{ fontSize: '0.83rem', padding: '5px 12px' }}>
                            Stop
                        </Button>
                    ) : (
                        <>
                            <Button
                                onClick={() => startRun(COMPATIBILITY_TESTS.filter(t => t.safeToAutoRun).map(t => t.id))}
                                style={{ fontSize: '0.83rem', padding: '5px 12px' }}
                            >
                                Run All Safe
                            </Button>
                            <Button
                                onClick={() => setShowRunAllWarning(true)}
                                secondary
                                style={{ fontSize: '0.83rem', padding: '5px 12px' }}
                            >
                                Run All
                            </Button>
                        </>
                    )}
                    <Button onClick={handleExport} secondary style={{ fontSize: '0.83rem', padding: '5px 12px' }}>
                        Export
                    </Button>
                    <Button onClick={onDisconnect} secondary style={{ fontSize: '0.83rem', padding: '5px 12px' }}>
                        Disconnect
                    </Button>
                </div>
            </div>

            {isRunning && <ProgressBar completed={runStats.completed} total={runStats.total} />}

            {TEST_CATEGORIES.map(cat => (
                <TestCategoryGroup
                    key={cat}
                    category={cat}
                    results={results}
                    isRunning={isRunning}
                    onRun={handleRunSingle}
                    expandedTestId={expandedTestId}
                    onToggle={id => setExpandedTestId(prev => prev === id ? null : id)}
                />
            ))}

            <Modal open={showRunAllWarning} onClose={() => setShowRunAllWarning(false)} title='Run All Tests'>
                <p>This will run all {COMPATIBILITY_TESTS.length} tests, including writes to the bike (alarm mode, power level, speed limit, sounds).</p>
                <p>Known-fail tests are still skipped. Tests requiring physical confirmation will pause for your input.</p>
                <p>Make sure you are in a safe environment before proceeding.</p>
                <ModalConfirmOrDecline
                    onCancel={() => setShowRunAllWarning(false)}
                    onConfirm={handleRunAllConfirmed}
                    confirmText='Run All'
                />
            </Modal>

            <SubscribePrepModal
                testId={subscribePrepTestId}
                onStart={() => handleSubscribePrep(true)}
                onCancel={() => handleSubscribePrep(false)}
            />
            <PhysicalConfirmModal
                test={confirmTest}
                result={confirmTest ? results[confirmTest.id] : undefined}
                onConfirm={() => handlePhysicalConfirm(true)}
                onCancel={() => handlePhysicalConfirm(false)}
            />

            <style jsx>{`
                .main { width: 100%; max-width: 760px; }
                .hdr {
                    display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center;
                    gap: 12px; margin-bottom: 16px; padding-bottom: 12px;
                    border-bottom: 1px solid var(--border-color);
                }
                .bikeInfo { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
                .mac { font-family: monospace; font-size: 0.88rem; color: var(--label-color); }
                .fw { font-size: 0.83rem; color: var(--label-color); display: flex; align-items: center; gap: 6px; }
                select { padding: 4px 8px; background-color: var(--main-bg-color); border: 1px solid var(--border-color); color: var(--text-color); font-size: 0.83rem; }
                select option { background-color: var(--main-bg-color); color: var(--text-color); }
                .acts { display: flex; gap: 8px; flex-wrap: wrap; }
            `}</style>
        </div>
    )
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function BleCompatibilityPage() {
    const [credentials, setCredentials] = useState<BikeCredentials[]>([])
    const [bike, setBike] = useState<RawBikeInterface | undefined>()
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
        bike?.disconnect?.()
        setBike(undefined)
    }

    return (
        <div className='page'>
            <h1>BLE Compatibility Tester</h1>
            <p className='nav'>
                For raw ad-hoc testing → <Link href='/ble-tester'>Raw BLE Tester</Link>
            </p>
            {bike ? (
                <CompatibilityTesterMain bike={bike} onDisconnect={disconnect} />
            ) : (
                <BikeConnector
                    credentials={credentials}
                    connecting={connecting}
                    error={connectError}
                    onConnect={connect}
                    onFakeBike={() => setBike(new FakeRawBike())}
                />
            )}
            <style jsx>{`
                .page { display: flex; flex-direction: column; align-items: center; padding: 2rem; min-height: 100vh; }
                h1 { margin-bottom: 0.25rem; }
                .nav { font-size: 0.85rem; color: var(--label-color); margin: 0 0 1.5rem; }
            `}</style>
        </div>
    )
}
