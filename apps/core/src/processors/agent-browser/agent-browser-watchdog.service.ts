import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Injectable } from '@nestjs/common'

import { AgentBrowserSessionPool } from './agent-browser-pool.service'

/** Reports pool health; process monitoring and recovery live outside the app. */
@Injectable()
export class AgentBrowserWatchdog implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>
  private stopping = false

  constructor(private readonly pool: AgentBrowserSessionPool) {}

  onModuleInit(): void {
    if (process.env.MX_BROWSER_WATCHDOG_IPC !== '1' || !process.send) return
    this.report()
    this.timer = setInterval(() => this.report(), 30_000)
    this.timer.unref()
    process.on('message', this.onMessage)
  }

  private report(): void {
    if (!process.connected || this.stopping) return
    process.send?.({ type: 'mx-browser-health', ...this.pool.health }, () => {})
  }

  private readonly onMessage = (message: unknown): void => {
    if (
      (message as { type?: string })?.type !== 'mx-browser-shutdown' ||
      this.stopping
    )
      return
    this.onModuleDestroy()
    // The supervisor enforces the deadline even if this event loop is blocked.
    void this.pool.shutdown().finally(() => process.exit(1))
  }

  onModuleDestroy(): void {
    this.stopping = true
    clearInterval(this.timer)
    process.off('message', this.onMessage)
  }
}
