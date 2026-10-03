import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}))

vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    )
  return { ...actual, execFile: execFileMock }
})

const { AgentBrowserSessionPool: BrowserSessionPool } =
  await import('~/processors/agent-browser/agent-browser-pool.service')

function mockExecFileSuccess(): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cb = args.at(-1) as (
      err: NodeJS.ErrnoException | null,
      r?: { stdout: string; stderr: string },
    ) => void
    // sync callback so awaits resolve under fake timers without needing
    // setImmediate / microtask flushing
    cb(null, { stdout: '[]', stderr: '' })
    return undefined
  })
}

beforeEach(() => {
  execFileMock.mockReset()
  mockExecFileSuccess()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserSessionPool', () => {
  it('acquire returns a session name on first use', async () => {
    const pool = new BrowserSessionPool({ maxSize: 2, idleMs: 60_000 })
    const slot = await pool.acquire()
    expect(slot.name).toMatch(/^agent-browser-/)
    pool.release(slot)
    await pool.shutdown()
  })

  it('two concurrent acquires up to cap return distinct slots without queueing', async () => {
    const pool = new BrowserSessionPool({ maxSize: 2, idleMs: 60_000 })
    const a = await pool.acquire()
    const b = await pool.acquire()
    expect(a.name).not.toBe(b.name)
    pool.release(a)
    pool.release(b)
    await pool.shutdown()
  })

  it('third acquire at cap blocks until a slot is released', async () => {
    const pool = new BrowserSessionPool({ maxSize: 2, idleMs: 60_000 })
    const a = await pool.acquire()
    const b = await pool.acquire()
    const cPromise = pool.acquire()
    let resolved = false
    cPromise.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    pool.release(a)
    const c = await cPromise
    expect(c.name).toBe(a.name)
    pool.release(b)
    pool.release(c)
    await pool.shutdown()
  })

  it('release with discard:true closes the session and frees the slot', async () => {
    const pool = new BrowserSessionPool({ maxSize: 1, idleMs: 60_000 })
    const a = await pool.acquire()
    pool.release(a, { discard: true })
    // Close completes before the next session is allocated.
    const b = await pool.acquire()
    expect(b.name).not.toBe(a.name)
    const closedCall = execFileMock.mock.calls.find(
      (call) => (call[1] as string[]).at(-1) === 'close',
    )
    expect(closedCall).toBeDefined()
    pool.release(b)
    await pool.shutdown()
  })

  it('idle slot is closed after idleMs and the slot index is recyclable', async () => {
    const pool = new BrowserSessionPool({ maxSize: 1, idleMs: 1_000 })
    const a = await pool.acquire()
    pool.release(a)
    expect(execFileMock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    await vi.runAllTicks()
    const closedCall = execFileMock.mock.calls.find(
      (call) => (call[1] as string[]).at(-1) === 'close',
    )
    expect(closedCall).toBeDefined()
    await pool.shutdown()
  })

  it('shutdown closes every live slot', async () => {
    const pool = new BrowserSessionPool({ maxSize: 2, idleMs: 60_000 })
    const a = await pool.acquire()
    const b = await pool.acquire()
    pool.release(a)
    pool.release(b)
    await pool.shutdown()
    const closeCalls = execFileMock.mock.calls.filter(
      (call) => (call[1] as string[]).at(-1) === 'close',
    )
    expect(closeCalls.length).toBe(2)
  })

  it('acquire after shutdown rejects', async () => {
    const pool = new BrowserSessionPool({ maxSize: 1, idleMs: 60_000 })
    await pool.shutdown()
    await expect(pool.acquire()).rejects.toThrow(/shut down/i)
  })

  it('retains capacity until close completes without reusing its session', async () => {
    let finishClose!: () => void
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args.at(-1) as (err: Error | null, result?: object) => void
      finishClose = () => cb(null, { stdout: '', stderr: '' })
    })
    const pool = new BrowserSessionPool({ maxSize: 1 })
    const a = await pool.acquire()
    const waiting = pool.acquire()
    let granted = false
    void waiting.then(() => {
      granted = true
    })
    pool.release(a, { discard: true })
    await Promise.resolve()
    expect(granted).toBe(false)
    finishClose()
    const b = await waiting
    expect(b.name).not.toBe(a.name)
    mockExecFileSuccess()
    pool.release(b)
    await pool.shutdown()
  })

  it('does not collide with an active session when an earlier slot closes', async () => {
    const pool = new BrowserSessionPool({ maxSize: 2 })
    const a = await pool.acquire()
    const b = await pool.acquire()
    pool.release(a, { discard: true })
    const c = await pool.acquire()
    expect(new Set([a.name, b.name, c.name]).size).toBe(3)
    pool.release(b)
    pool.release(c)
    await pool.shutdown()
  })

  it('quarantines failed closes and rejects work instead of spawning replacements', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args.at(-1) as (err: Error) => void
      cb(Object.assign(new Error('close failed'), { code: 'ETIMEDOUT' }))
    })
    const pool = new BrowserSessionPool({ maxSize: 1 })
    const a = await pool.acquire()
    const waiting = expect(pool.acquire()).rejects.toThrow(/quarantined/)
    pool.release(a, { discard: true })
    await waiting
    expect(execFileMock).toHaveBeenCalledTimes(2)
    await expect(pool.acquire()).rejects.toThrow(/quarantined/)
    expect(execFileMock).toHaveBeenCalledTimes(2)
    mockExecFileSuccess()
    await pool.shutdown()
  })

  it('bounds waiting even without an abort signal', async () => {
    const pool = new BrowserSessionPool({ maxSize: 1 })
    const a = await pool.acquire()
    const waiting = expect(pool.acquire()).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(30_000)
    await waiting
    pool.release(a)
    await pool.shutdown()
  })

  it('rejects pre-aborted acquisitions without consuming capacity', async () => {
    const pool = new BrowserSessionPool({ maxSize: 1 })
    await expect(pool.acquire({ signal: AbortSignal.abort() })).rejects.toThrow(
      /aborted/,
    )
    const a = await pool.acquire()
    pool.release(a)
    await pool.shutdown()
  })

  it('acquire waiter cancelled by aborted signal rejects without consuming a slot', async () => {
    const pool = new BrowserSessionPool({ maxSize: 1, idleMs: 60_000 })
    const a = await pool.acquire()
    const ac = new AbortController()
    const waiter = pool.acquire({ signal: ac.signal })
    ac.abort()
    await expect(waiter).rejects.toThrow(/aborted/i)
    pool.release(a)
    // ensure no leftover waiter consumed the freed slot
    const b = await pool.acquire()
    expect(b.name).toBe(a.name)
    pool.release(b)
    await pool.shutdown()
  })
})
