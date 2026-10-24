import { Global, Module } from '@nestjs/common'

import { AgentBrowserService } from './agent-browser.service'
import { AgentBrowserSessionPool } from './agent-browser-pool.service'
import { AgentBrowserWatchdog } from './agent-browser-watchdog.service'

@Global()
@Module({
  providers: [
    AgentBrowserSessionPool,
    AgentBrowserService,
    AgentBrowserWatchdog,
  ],
  exports: [AgentBrowserSessionPool, AgentBrowserService],
})
export class AgentBrowserModule {}
