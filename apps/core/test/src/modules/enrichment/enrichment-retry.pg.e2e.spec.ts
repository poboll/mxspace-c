import * as schema from '@mx-space/db-schema/schema'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { createIsolatedPgDatabase } from 'test/helper/pg-testcontainer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { EnrichmentRepository } from '~/modules/enrichment/enrichment.repository'
import {
  EnrichmentService,
  refKey,
} from '~/modules/enrichment/enrichment.service'
import {
  EnrichmentDeferredError,
  type EnrichmentResult,
} from '~/modules/enrichment/enrichment.types'
import type { AppDatabase } from '~/processors/database/postgres.provider'
import { SnowflakeService } from '~/shared/id/snowflake.service'

describe('Enrichment fetch ownership and cooldown (real PG)', () => {
  let database: Awaited<ReturnType<typeof createIsolatedPgDatabase>>
  let pool: Pool
  let db: AppDatabase
  let repository: EnrichmentRepository

  beforeAll(async () => {
    database = await createIsolatedPgDatabase()
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 4 })
    db = drizzle(pool, { schema }) as AppDatabase
    repository = new EnrichmentRepository(db, new SnowflakeService())
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await database?.drop()
  })

  function fixture(id: string) {
    const url = `https://example.test/${id}`
    const result = (): EnrichmentResult => ({
      title: id,
      url,
      category: 'web',
      fetchedAt: new Date().toISOString(),
    })
    const provider = {
      name: 'open-graph',
      category: 'web',
      defaultTtl: 604800,
      requiresUrlContext: true,
      fetch: vi.fn(async () => result()),
    }
    const build = () => {
      const service = Object.create(EnrichmentService.prototype) as any
      service.repository = repository
      service.providerRegistry = {
        getByName: () => provider,
        match: () => ({ provider, match: { id, fullUrl: url } }),
      }
      service.configsService = { get: async () => ({}) }
      service.redisService = {
        getClient: () => ({
          get: async () => null,
          set: async () => 'OK',
          del: async () => 1,
        }),
      }
      service.taskQueueService = {
        createTask: vi.fn(async () => ({ taskId: 'task', created: true })),
      }
      service.taskQueueProcessor = { registerHandler: vi.fn() }
      service.browserFetch = { takeScreenshotBytes: () => undefined }
      service.logger = { warn: vi.fn(), log: vi.fn() }
      return service as EnrichmentService
    }
    return { url, provider, build, result }
  }

  it('persists first-fetch failure and blocks subsequent reads until retry is due', async () => {
    const f = fixture('cold-failure')
    const service = f.build()
    f.provider.fetch.mockRejectedValueOnce(new Error('browser timeout'))
    await expect(service.resolve(f.url)).rejects.toThrow('browser timeout')
    expect(
      await repository.findByProviderAndExternalId(
        'open-graph',
        'cold-failure',
      ),
    ).toBeNull()
    const [state] = await repository.findFetchStates([
      { provider: 'open-graph', externalId: 'cold-failure', locale: '' },
    ])
    expect(state.failureCount).toBe(1)
    expect(state.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() + 100_000)
    await expect(service.resolve(f.url)).rejects.toBeInstanceOf(
      EnrichmentDeferredError,
    )
    expect(
      await service.hydrateRefs([
        { provider: 'open-graph', externalId: 'cold-failure', url: f.url },
      ]),
    ).toEqual({})
    expect((service as any).taskQueueService.createTask).not.toHaveBeenCalled()
    expect(f.provider.fetch).toHaveBeenCalledTimes(1)

    await db
      .update(schema.enrichmentFetchState)
      .set({ nextRetryAt: new Date(Date.now() - 1) })
      .where(eq(schema.enrichmentFetchState.externalId, 'cold-failure'))
    await expect(service.resolve(f.url)).resolves.toMatchObject({
      result: { title: 'cold-failure' },
    })
    const [recovered] = await repository.findFetchStates([
      { provider: 'open-graph', externalId: 'cold-failure', locale: '' },
    ])
    expect(recovered.failureCount).toBe(0)
    expect(recovered.nextRetryAt).toBeNull()
    expect(recovered.leaseToken).toBeNull()
  })

  it('uses recent failure time even when the successful cache is weeks old', async () => {
    const f = fixture('stale-failure')
    await repository.upsert(
      'open-graph',
      'stale-failure',
      f.url,
      f.result(),
      null,
      new Date(Date.now() - 7 * 86400_000),
    )
    await db
      .update(schema.enrichmentCache)
      .set({ fetchedAt: new Date(Date.now() - 14 * 86400_000) })
      .where(eq(schema.enrichmentCache.externalId, 'stale-failure'))
    const service = f.build()
    f.provider.fetch.mockRejectedValueOnce(new Error('browser timeout'))
    await expect(
      service.refresh('open-graph', 'stale-failure'),
    ).rejects.toThrow('browser timeout')
    const out = await service.hydrateRefs([
      { provider: 'open-graph', externalId: 'stale-failure' },
    ])
    expect(out[refKey('open-graph', 'stale-failure')].title).toBe(
      'stale-failure',
    )
    expect((service as any).taskQueueService.createTask).not.toHaveBeenCalled()
    await expect(
      service.refresh('open-graph', 'stale-failure'),
    ).rejects.toBeInstanceOf(EnrichmentDeferredError)
    await expect(
      service.refresh('open-graph', 'stale-failure', undefined, {
        force: true,
      }),
    ).resolves.toMatchObject({ title: 'stale-failure' })
    expect(f.provider.fetch).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent callers and excludes a second application instance', async () => {
    const f = fixture('concurrent')
    const service = f.build()
    let finish!: (value: EnrichmentResult) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.provider.fetch.mockImplementationOnce(() => {
      entered()
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const first = service.resolve(f.url)
    await started
    const sameInstance = service.resolve(f.url)
    await expect(f.build().resolve(f.url)).rejects.toBeInstanceOf(
      EnrichmentDeferredError,
    )
    await expect(
      f.build().refresh('open-graph', 'concurrent', undefined, { force: true }),
    ).rejects.toBeInstanceOf(EnrichmentDeferredError)
    finish(f.result())
    const results = await Promise.all([first, sameInstance])
    expect(results[0].result.id).toBe(results[1].result.id)
    expect(f.provider.fetch).toHaveBeenCalledTimes(1)
  })

  it('cannot let an expired owner overwrite or release its successor', async () => {
    const f = fixture('lease-takeover')
    expect(
      await repository.claimFetch('open-graph', 'lease-takeover', '', 'old'),
    ).toBe(true)
    await db
      .update(schema.enrichmentFetchState)
      .set({ leaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.enrichmentFetchState.externalId, 'lease-takeover'))
    expect(
      await repository.renewFetch('open-graph', 'lease-takeover', '', 'old'),
    ).toBe(false)
    expect(
      await repository.claimFetch('open-graph', 'lease-takeover', '', 'new'),
    ).toBe(true)
    await expect(
      repository.completeFetch({
        provider: 'open-graph',
        externalId: 'lease-takeover',
        locale: '',
        token: 'old',
        url: f.url,
        result: f.result(),
        expiresAt: new Date(),
        persist: true,
      }),
    ).rejects.toThrow('lease expired')
    await repository.recordFailure(
      'open-graph',
      'lease-takeover',
      'late failure',
      '',
      'old',
    )
    await repository.releaseFetch('open-graph', 'lease-takeover', '', 'old')
    const [state] = await repository.findFetchStates([
      { provider: 'open-graph', externalId: 'lease-takeover', locale: '' },
    ])
    expect(state.leaseToken).toBe('new')
    expect(state.failureCount).toBe(0)
    await repository.releaseFetch('open-graph', 'lease-takeover', '', 'new')
  })

  it('rechecks freshness when an old queued job runs after another fetch succeeded', async () => {
    const f = fixture('queued-after-success')
    const service = f.build()
    await service.resolve(f.url)
    service.onModuleInit()
    const handler = (service as any).taskQueueProcessor.registerHandler.mock
      .calls[0][0]
    await handler.execute({
      provider: 'open-graph',
      externalId: 'queued-after-success',
      locale: '',
      url: f.url,
    })
    expect(f.provider.fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps locale failures isolated', async () => {
    expect(
      await repository.claimFetch('tmdb', 'movie/locale', 'zh', 'zh'),
    ).toBe(true)
    await repository.recordFailure(
      'tmdb',
      'movie/locale',
      'failed in zh',
      'zh',
      'zh',
    )
    expect(
      await repository.claimFetch('tmdb', 'movie/locale', 'zh', 'zh-again'),
    ).toBe(false)
    expect(
      await repository.claimFetch('tmdb', 'movie/locale', 'en', 'en'),
    ).toBe(true)
    await repository.releaseFetch('tmdb', 'movie/locale', 'en', 'en')
  })
})
