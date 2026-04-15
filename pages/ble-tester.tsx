import { useState, useEffect } from 'react'
import Link from 'next/link'
import { BikeCredentials, Characteristic, CHARACTERISTICS, connectToBike } from '../lib/bike'
import { Button } from '../components/Button'

// ─── helpers ────────────────────────────────────────────────────────────────

function parseHex(input: string): Uint8Array {
    const cleaned = input.replace(/\s+/g, '')
    if (cleaned.length === 0) return new Uint8Array(0)
    if (cleaned.length % 2 !== 0) throw new Error('Odd number of hex digits')
    const bytes = cleaned.match(/.{2}/g)!.map(h => {
        const v = parseInt(h, 16)
        if (isNaN(v)) throw new Error(`Invalid hex byte: ${h}`)
        return v
    })
    return new Uint8Array(bytes)
}

function fmtBytes(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── types ───────────────────────────────────────────────────────────────────

type Op = 'read' | 'write' | 'readwrite' | 'props'

interface LogEntry {
    ts: string
    charKey: string
    op: Op
    payload?: string
    encrypt: boolean
    withoutResponse: boolean
    result: string
}

interface RawBikeInterface {
    mac: string
    disconnect?(): void
    rawRead(characteristic: Characteristic, decrypt?: boolean): Promise<Uint8Array>
    rawWrite(characteristic: Characteristic, data: Uint8Array, encrypt?: boolean, withoutResponse?: boolean): Promise<void>
    rawReadWrite(characteristic: Characteristic, data: Uint8Array, encrypt?: boolean, timeout?: number): Promise<Uint8Array>
    rawCharacteristicProperties(characteristic: Characteristic): Promise<Record<string, boolean>>
}

// ─── fake bike ───────────────────────────────────────────────────────────────

class FakeRawBike implements RawBikeInterface {
    mac = 'FA:KE:BI:KE:00:00'

    async rawRead(_char: Characteristic, _decrypt = true): Promise<Uint8Array> {
        await delay(150)
        return new Uint8Array([0x01, 0x00])
    }

    async rawWrite(_char: Characteristic, _data: Uint8Array, _encrypt = false, _withoutResponse = false): Promise<void> {
        await delay(150)
    }

    async rawReadWrite(_char: Characteristic, _data: Uint8Array, _encrypt = false, timeout = 0): Promise<Uint8Array> {
        await delay(Math.max(150, timeout))
        return new Uint8Array([0x01, 0x00])
    }

    async rawCharacteristicProperties(_char: Characteristic): Promise<Record<string, boolean>> {
        await delay(50)
        return { broadcast: false, read: true, writeWithoutResponse: true, write: false, notify: true, indicate: false }
    }
}

// ─── page ────────────────────────────────────────────────────────────────────

export default function BleTester() {
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
            <h1>Raw BLE Tester</h1>

            {bike ? (
                <>
                    <p className='connected'>Connected to <b>{bike.mac}</b></p>
                    <RawBleWriter bike={bike} />
                    <Button onClick={disconnect} secondary style={{ marginTop: 24 }}>
                        Disconnect
                    </Button>
                </>
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
                .page {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    padding: 2rem;
                    min-height: 100vh;
                }
                h1 { margin-bottom: 0.25rem; }
                .connected {
                    color: var(--label-color);
                    margin: 0 0 1.5rem;
                }
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
                .err { color: red; margin-top: 8px; }
                .divider {
                    display: flex;
                    align-items: center;
                    width: 100%;
                    max-width: 320px;
                    margin: 12px 0;
                    gap: 8px;
                    color: var(--label-color);
                    font-size: 0.85rem;
                }
                .divider::before, .divider::after {
                    content: '';
                    flex: 1;
                    border-top: 1px solid var(--secondary-border-color);
                }
            `}</style>
        </>
    )
}

// ─── raw writer ───────────────────────────────────────────────────────────────

function RawBleWriter({ bike }: { bike: RawBikeInterface }) {
    const charKeys = Object.keys(CHARACTERISTICS)
    const [charKey, setCharKey] = useState('UNLOCK_REQUEST')
    const [op, setOp] = useState<Op>('write')
    const [hexInput, setHexInput] = useState('02 01')
    const [encrypt, setEncrypt] = useState(false)
    const [withoutResponse, setWithoutResponse] = useState(false)
    const [readDelay, setReadDelay] = useState(0)
    const [running, setRunning] = useState(false)
    const [log, setLog] = useState<LogEntry[]>([])

    const pushLog = (entry: LogEntry) => setLog(prev => [entry, ...prev])

    const execute = async () => {
        setRunning(true)
        const ts = new Date().toLocaleTimeString()
        const char: Characteristic = CHARACTERISTICS[charKey]
        let result: string
        try {
            if (op === 'read') {
                const data = await bike.rawRead(char, encrypt)
                result = '← ' + fmtBytes(data)
            } else if (op === 'props') {
                const props = await bike.rawCharacteristicProperties(char)
                const active = Object.entries(props).filter(([, v]) => v).map(([k]) => k)
                result = active.length > 0 ? active.join(', ') : 'none'
            } else {
                const payload = parseHex(hexInput)
                if (op === 'write') {
                    await bike.rawWrite(char, payload, encrypt, withoutResponse)
                    result = '✓ write ok'
                } else {
                    const data = await bike.rawReadWrite(char, payload, encrypt, readDelay)
                    result = '← ' + fmtBytes(data)
                }
            }
        } catch (e) {
            result = '✗ ' + (e instanceof Error ? e.message : String(e))
        }
        const hasPayload = op === 'write' || op === 'readwrite'
        pushLog({ ts, charKey, op, payload: hasPayload ? hexInput : undefined, encrypt, withoutResponse, result })
        setRunning(false)
    }

    const isWrite = op === 'write' || op === 'readwrite'
    const isReadWrite = op === 'readwrite'

    return (
        <div className='writer'>
            <div className='row'>
                <label>Characteristic</label>
                <select value={charKey} onChange={e => setCharKey(e.target.value)}>
                    {charKeys.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
            </div>

            <div className='row'>
                <label>Operation</label>
                <div className='ops'>
                    {(['read', 'write', 'readwrite', 'props'] as Op[]).map(o => (
                        <label key={o} className='radio'>
                            <input type='radio' checked={op === o} onChange={() => setOp(o)} />
                            {o}
                        </label>
                    ))}
                </div>
            </div>

            {isWrite && (
                <div className='row'>
                    <label>Payload (hex)</label>
                    <input
                        className='mono'
                        value={hexInput}
                        onChange={e => setHexInput(e.target.value)}
                        placeholder='e.g. 02 01'
                        spellCheck={false}
                    />
                </div>
            )}

            <div className='row'>
                <label>Encrypt</label>
                <input type='checkbox' checked={encrypt} onChange={e => setEncrypt(e.target.checked)} />
            </div>

            {op === 'write' && (
                <div className='row'>
                    <label>Without response</label>
                    <input type='checkbox' checked={withoutResponse} onChange={e => setWithoutResponse(e.target.checked)} />
                </div>
            )}

            {isReadWrite && (
                <div className='row'>
                    <label>Read delay (ms)</label>
                    <input
                        type='number'
                        className='mono short'
                        value={readDelay}
                        onChange={e => setReadDelay(Number(e.target.value))}
                        min={0}
                    />
                </div>
            )}

            <Button onClick={execute} disabled={running} style={{ marginTop: 12 }}>
                {running ? 'Running…' : 'Execute'}
            </Button>

            {log.length > 0 && (
                <div className='log'>
                    <div className='logHeader'>
                        <span>Log</span>
                        <button className='clear' onClick={() => setLog([])}>clear</button>
                    </div>
                    {log.map((entry, i) => (
                        <div key={i} className='entry'>
                            <span className='ets'>{entry.ts}</span>
                            <span className='echar'>{entry.charKey}</span>
                            <span className='eop'>{entry.op}{entry.encrypt ? ' enc' : ''}{entry.withoutResponse ? ' wor' : ''}</span>
                            {entry.payload && <span className='epay'>→ {entry.payload}</span>}
                            <span className={`eres ${entry.result.startsWith('✗') ? 'err' : ''}`}>
                                {entry.result}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            <style jsx>{`
                .writer {
                    display: flex;
                    flex-direction: column;
                    width: 100%;
                    max-width: 520px;
                    gap: 8px;
                }
                .row {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }
                .row label {
                    width: 130px;
                    flex-shrink: 0;
                    font-size: 0.85rem;
                    color: var(--label-color);
                }
                select, input[type='text'], input.mono {
                    flex: 1;
                    padding: 6px 8px;
                    background-color: var(--main-bg-color);
                    border: 1px solid var(--border-color);
                    color: var(--text-color);
                    font-size: 0.9rem;
                }
                select option {
                    background-color: var(--main-bg-color);
                    color: var(--text-color);
                }
                input.mono { font-family: monospace; }
                input.short { flex: none; width: 80px; }
                .ops { display: flex; gap: 16px; }
                .radio { display: flex; align-items: center; gap: 4px; font-size: 0.9rem; cursor: pointer; }
                .log {
                    margin-top: 16px;
                    border: 1px solid var(--border-color);
                    font-family: monospace;
                    font-size: 0.8rem;
                }
                .logHeader {
                    display: flex;
                    justify-content: space-between;
                    padding: 4px 8px;
                    border-bottom: 1px solid var(--border-color);
                    color: var(--label-color);
                    font-size: 0.75rem;
                }
                .clear {
                    background: none;
                    border: none;
                    color: var(--label-color);
                    cursor: pointer;
                    font-size: 0.75rem;
                    padding: 0;
                }
                .entry {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    padding: 5px 8px;
                    border-bottom: 1px solid var(--secondary-border-color);
                }
                .ets { color: var(--label-color); }
                .echar { color: var(--text-color); font-weight: bold; }
                .eop { color: var(--label-color); }
                .epay { color: var(--text-color); }
                .eres { color: var(--text-color); flex-basis: 100%; }
                .eres.err { color: red; }
            `}</style>
        </div>
    )
}
