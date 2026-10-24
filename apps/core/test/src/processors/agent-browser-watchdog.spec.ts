import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentBrowserSessionPool } from '~/processors/agent-browser/agent-browser-pool.service'
import { AgentBrowserWatchdog } from '~/processors/agent-browser/agent-browser-watchdog.service'

const reporters: AgentBrowserWatchdog[] = []
afterEach(() => {
  for (const reporter of reporters.splice(0)) reporter.onModuleDestroy()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function setup() {
  vi.useFakeTimers()
  vi.stubEnv('MX_BROWSER_WATCHDOG_IPC', '1')
  const pool = {
    health: { capacity: 2, quarantined: 0 },
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
  const reporter = new AgentBrowserWatchdog(
    pool as unknown as AgentBrowserSessionPool,
  )
  reporters.push(reporter)
  const send = vi.fn()
  // Worker IPC availability varies by Vitest pool; restore descriptors afterwards.
  const sendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
  const connectedDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'connected',
  )
  Object.defineProperty(process, 'send', { configurable: true, value: send })
  Object.defineProperty(process, 'connected', {
    configurable: true,
    value: true,
  })
  return {
    pool,
    reporter,
    send,
    restore: () => {
      if (sendDescriptor) Object.defineProperty(process, 'send', sendDescriptor)
      else delete process.send
      if (connectedDescriptor)
        Object.defineProperty(process, 'connected', connectedDescriptor)
      else delete (process as any).connected
    },
  }
}

describe('browser health reporter', () => {
  it('publishes current pool health independently of request traffic', async () => {
    const { reporter, pool, send, restore } = setup()
    try {
      reporter.onModuleInit()
      expect(send).toHaveBeenCalledWith(
        { type: 'mx-browser-health', capacity: 2, quarantined: 0 },
        expect.any(Function),
      )
      pool.health.quarantined = 2
      await vi.advanceTimersByTimeAsync(30_000)
      expect(send).toHaveBeenLastCalledWith(
        { type: 'mx-browser-health', capacity: 2, quarantined: 2 },
        expect.any(Function),
      )
      reporter.onModuleDestroy()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(send).toHaveBeenCalledTimes(2)
    } finally {
      restore()
    }
  })

  it('drains the pool once on the supervisor recovery request', async () => {
    const { reporter, pool, restore } = setup()
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never)
    try {
      reporter.onModuleInit()
      process.emit('message', { type: 'mx-browser-shutdown' }, undefined)
      process.emit('message', { type: 'mx-browser-shutdown' }, undefined)
      await Promise.resolve()
      expect(pool.shutdown).toHaveBeenCalledOnce()
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      restore()
    }
  })
})
