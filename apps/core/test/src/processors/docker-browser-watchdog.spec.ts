import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  readdir: mocks.readdir,
}))
const { countBrowserProcesses, evaluate, supervise } =
  await import('../../../../../docker-browser-watchdog.mjs')

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalTerm = process.listeners('SIGTERM')
const originalInt = process.listeners('SIGINT')
afterEach(() => {
  for (const fn of process.listeners('SIGTERM'))
    if (!originalTerm.includes(fn)) process.off('SIGTERM', fn)
  for (const fn of process.listeners('SIGINT'))
    if (!originalInt.includes(fn)) process.off('SIGINT', fn)
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function setup() {
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'linux',
  })
  vi.stubEnv('MX_BROWSER_WATCHDOG', 'true')
  mocks.readFile.mockImplementation(async (path: string) =>
    path === '/proc/1/comm' ? 'docker-init\n' : '',
  )
  mocks.readdir.mockResolvedValue([])
  const child = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    kill: vi.fn(),
    connected: true,
  })
  mocks.spawn.mockReturnValue(child)
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation(() => undefined as never)
  return { child, exit }
}

describe('container browser supervisor', () => {
  it('counts browser zombies without including unrelated processes', () => {
    expect(
      countBrowserProcesses([
        '1 (chromium) Z 1',
        '2 (chrome_crashpad) S 1',
        '3 (node) Z 1',
        '4 (name ) space) Z 1',
      ]),
    ).toEqual({ total: 2, zombies: 1 })
  })

  it('requires consecutive failures and resets on recovery', () => {
    const unhealthy = { total: 40, zombies: 32 }
    expect(evaluate(unhealthy, null, false, 1).recover).toBe(false)
    expect(evaluate(unhealthy, null, false, 2).recover).toBe(true)
    expect(
      evaluate({ total: 10, zombies: 0 }, null, false, 2).consecutive,
    ).toBe(0)
    expect(
      evaluate(
        { total: 0, zombies: 0 },
        { capacity: 2, quarantined: 2 },
        false,
        2,
      ).recover,
    ).toBe(true)
    expect(evaluate({ total: 128, zombies: 0 }, null, false, 2).recover).toBe(
      true,
    )
  })

  it('kills an unresponsive application after lost heartbeats and the shutdown deadline', async () => {
    const { child, exit } = setup()
    await supervise(['main.mjs'])
    child.emit('message', {
      type: 'mx-browser-health',
      capacity: 2,
      quarantined: 0,
    })
    await vi.advanceTimersByTimeAsync(150_000)
    expect(child.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(child.send).toHaveBeenCalledWith(
      { type: 'mx-browser-shutdown' },
      expect.any(Function),
    )
    await vi.advanceTimersByTimeAsync(15_000)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('forwards docker stop and propagates application exit', async () => {
    const { child, exit } = setup()
    await supervise(['main.mjs'])
    process.emit('SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('exit', 0, null)
    expect(exit).toHaveBeenCalledWith(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('allows startup time before recovering an application that never reports', async () => {
    const { child } = setup()
    await supervise(['main.mjs'])
    await vi.advanceTimersByTimeAsync(240_000)
    expect(child.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(child.send).toHaveBeenCalledOnce()
  })

  it('preserves supervision without automatic recovery when explicitly disabled', async () => {
    const { child } = setup()
    vi.stubEnv('MX_BROWSER_WATCHDOG', 'false')
    await supervise(['main.mjs'])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(child.send).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })
})
