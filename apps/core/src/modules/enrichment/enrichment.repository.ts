import { Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'

import { PG_DB_TOKEN } from '~/constants/system.constant'
import { enrichmentCache, enrichmentFetchState } from '~/database/schema'
import { BaseRepository } from '~/processors/database/base.repository'
import type { AppDatabase } from '~/processors/database/postgres.provider'
import { SnowflakeService } from '~/shared/id/snowflake.service'

import type {
  EnrichmentImage,
  EnrichmentResult,
  EnrichmentRow,
} from './enrichment.types'

@Injectable()
export class EnrichmentRepository extends BaseRepository {
  private readonly logger = new Logger(EnrichmentRepository.name)

  constructor(
    @Inject(PG_DB_TOKEN) db: AppDatabase,
    private readonly snowflake: SnowflakeService,
  ) {
    super(db)
  }

  async findById(id: string): Promise<EnrichmentRow | null> {
    const rows = await this.db
      .select()
      .from(enrichmentCache)
      .where(eq(enrichmentCache.id, id))
      .limit(1)
    return rows[0] ? this.mapRow(rows[0]) : null
  }

  async findByProviderAndExternalId(
    provider: string,
    externalId: string,
    locale = '',
  ): Promise<EnrichmentRow | null> {
    const rows = await this.db
      .select()
      .from(enrichmentCache)
      .where(
        and(
          eq(enrichmentCache.provider, provider),
          eq(enrichmentCache.externalId, externalId),
          eq(enrichmentCache.locale, locale),
        ),
      )
      .limit(1)
    return rows[0] ? this.mapRow(rows[0]) : null
  }

  async findManyByRefs(
    refs: readonly { provider: string; externalId: string; locale?: string }[],
  ): Promise<EnrichmentRow[]> {
    if (refs.length === 0) return []
    // Group by (provider, locale) so each clause can use inArray on externalId.
    const grouped = new Map<
      string,
      { provider: string; locale: string; ids: string[] }
    >()
    for (const ref of refs) {
      const locale = ref.locale ?? ''
      const key = `${ref.provider} ${locale}`
      const cur = grouped.get(key)
      if (cur) cur.ids.push(ref.externalId)
      else
        grouped.set(key, {
          provider: ref.provider,
          locale,
          ids: [ref.externalId],
        })
    }
    const clauses = [...grouped.values()].map(({ provider, locale, ids }) =>
      and(
        eq(enrichmentCache.provider, provider),
        eq(enrichmentCache.locale, locale),
        inArray(enrichmentCache.externalId, ids),
      ),
    )
    const where = clauses.length === 1 ? clauses[0] : or(...clauses)
    const rows = await this.db.select().from(enrichmentCache).where(where)
    return rows.map((r) => this.mapRow(r))
  }

  async upsert(
    provider: string,
    externalId: string,
    url: string,
    normalized: EnrichmentResult,
    raw: unknown | null,
    expiresAt: Date | null,
    locale = '',
  ): Promise<EnrichmentRow> {
    const [result] = await this.db
      .insert(enrichmentCache)
      .values({
        id: await this.snowflake.nextId(),
        provider,
        externalId,
        locale,
        url,
        normalized: normalized as any,
        raw,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [
          enrichmentCache.provider,
          enrichmentCache.externalId,
          enrichmentCache.locale,
        ],
        set: {
          normalized: normalized as any,
          raw,
          url,
          expiresAt,
          failureCount: sql`0`,
          lastError: sql`NULL`,
          fetchedAt: new Date(),
        } as any,
      })
      .returning()

    return this.mapRow(result)
  }

  async upsertIfAbsent(input: {
    provider: string
    externalId: string
    url: string
    normalized: EnrichmentResult
    raw: unknown | null
    fetchedAt: Date
    expiresAt: Date | null
    locale?: string
  }): Promise<void> {
    const locale = input.locale ?? ''
    const existing = await this.findByProviderAndExternalId(
      input.provider,
      input.externalId,
      locale,
    )
    if (existing) return

    await this.db.insert(enrichmentCache).values({
      id: await this.snowflake.nextId(),
      provider: input.provider,
      externalId: input.externalId,
      locale,
      url: input.url,
      normalized: input.normalized as any,
      raw: input.raw,
      expiresAt: input.expiresAt,
    })
  }

  /**
   * Merge a `captureImage` key into the row's `normalized` JSONB column. Used
   * by the post-persist capture pipeline so an already-inserted row can
   * pick up the capture fields without rewriting the entire normalized
   * payload (which would race with concurrent writers and revert other
   * fields). Uses PostgreSQL's `jsonb` `||` operator for an in-place merge.
   */
  async updateCapture(
    id: string,
    captureImage: EnrichmentImage,
  ): Promise<void> {
    const patch = JSON.stringify({ captureImage })
    const updated = await this.db
      .update(enrichmentCache)
      .set({
        normalized: sql`coalesce(${enrichmentCache.normalized}, '{}'::jsonb) || ${patch}::jsonb`,
      })
      .where(eq(enrichmentCache.id, id))
      .returning({ id: enrichmentCache.id })

    if (updated.length === 0) {
      // Row vanished between persist and capture write — most likely an
      // admin `invalidate` ran concurrently. The S3 object is now orphaned;
      // the warn log is the ops signal for an eventual reconciliation job.
      this.logger.warn(
        `updateCapture: row ${id} disappeared between persist and capture write; S3 object now orphaned`,
      )
    }
  }

  async clearCapture(id: string): Promise<void> {
    await this.db
      .update(enrichmentCache)
      .set({
        normalized: sql`coalesce(${enrichmentCache.normalized}, '{}'::jsonb) - 'captureImage'`,
      })
      .where(eq(enrichmentCache.id, id))
  }

  private fetchRef(provider: string, externalId: string, locale: string) {
    return and(
      eq(enrichmentFetchState.provider, provider),
      eq(enrichmentFetchState.externalId, externalId),
      eq(enrichmentFetchState.locale, locale),
    )
  }

  async findFetchStates(
    refs: readonly { provider: string; externalId: string; locale: string }[],
  ) {
    if (!refs.length) return []
    return this.db
      .select()
      .from(enrichmentFetchState)
      .where(
        or(
          ...refs.map((ref) =>
            this.fetchRef(ref.provider, ref.externalId, ref.locale),
          ),
        ),
      )
  }

  async claimFetch(
    provider: string,
    externalId: string,
    locale: string,
    token: string,
    force = false,
  ): Promise<boolean> {
    const now = sql`now()`
    const leaseExpiresAt = sql`now() + interval '2 minutes'`
    const rows = await this.db
      .insert(enrichmentFetchState)
      .values({
        provider,
        externalId,
        locale,
        leaseToken: token,
        leaseExpiresAt,
        lastAttemptAt: now,
      })
      .onConflictDoUpdate({
        target: [
          enrichmentFetchState.provider,
          enrichmentFetchState.externalId,
          enrichmentFetchState.locale,
        ],
        set: { leaseToken: token, leaseExpiresAt, lastAttemptAt: now },
        setWhere: and(
          or(
            isNull(enrichmentFetchState.leaseExpiresAt),
            lte(enrichmentFetchState.leaseExpiresAt, now),
          ),
          force
            ? undefined
            : or(
                isNull(enrichmentFetchState.nextRetryAt),
                lte(enrichmentFetchState.nextRetryAt, now),
              ),
        ),
      })
      .returning({ token: enrichmentFetchState.leaseToken })
    return rows.length === 1
  }

  async renewFetch(
    provider: string,
    externalId: string,
    locale: string,
    token: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(enrichmentFetchState)
      .set({ leaseExpiresAt: sql`now() + interval '2 minutes'` })
      .where(
        and(
          this.fetchRef(provider, externalId, locale),
          eq(enrichmentFetchState.leaseToken, token),
          gt(enrichmentFetchState.leaseExpiresAt, sql`now()`),
        ),
      )
      .returning({ token: enrichmentFetchState.leaseToken })
    return rows.length === 1
  }

  async releaseFetch(
    provider: string,
    externalId: string,
    locale: string,
    token: string,
  ): Promise<void> {
    await this.db
      .update(enrichmentFetchState)
      .set({ leaseToken: null, leaseExpiresAt: null })
      .where(
        and(
          this.fetchRef(provider, externalId, locale),
          eq(enrichmentFetchState.leaseToken, token),
        ),
      )
  }

  async completeFetch(input: {
    provider: string
    externalId: string
    locale: string
    token: string
    url: string
    result: EnrichmentResult
    expiresAt: Date
    persist: boolean
  }): Promise<EnrichmentRow | null> {
    return this.db.transaction(async (tx) => {
      // Update the lease row first: it serializes completion with a new owner.
      // A worker whose lease expired cannot overwrite the new owner's result.
      const owned = await tx
        .update(enrichmentFetchState)
        .set({
          leaseToken: null,
          leaseExpiresAt: null,
          failureCount: 0,
          lastError: null,
          nextRetryAt: null,
        })
        .where(
          and(
            this.fetchRef(input.provider, input.externalId, input.locale),
            eq(enrichmentFetchState.leaseToken, input.token),
            gt(enrichmentFetchState.leaseExpiresAt, sql`now()`),
          ),
        )
        .returning({ token: enrichmentFetchState.leaseToken })
      if (!owned.length)
        throw new Error('Enrichment fetch lease expired before completion')
      if (!input.persist) return null
      const repository = new EnrichmentRepository(
        tx as unknown as AppDatabase,
        this.snowflake,
      )
      return repository.upsert(
        input.provider,
        input.externalId,
        input.url,
        input.result,
        null,
        input.expiresAt,
        input.locale,
      )
    })
  }

  async recordFailure(
    provider: string,
    externalId: string,
    error: string,
    locale: string,
    token: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [state] = await tx
        .update(enrichmentFetchState)
        .set({
          failureCount: sql`${enrichmentFetchState.failureCount} + 1`,
          lastError: error.slice(0, 2000),
          nextRetryAt: sql`now() + make_interval(secs => least(86400, 60 * power(2, least(${enrichmentFetchState.failureCount} + 1, 11)))::double precision)`,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            this.fetchRef(provider, externalId, locale),
            eq(enrichmentFetchState.leaseToken, token),
            gt(enrichmentFetchState.leaseExpiresAt, sql`now()`),
          ),
        )
        .returning({ failureCount: enrichmentFetchState.failureCount })
      if (!state) return
      // Retain the existing admin counters without inventing a successful
      // preview for a URL that has never been fetched successfully.
      await tx
        .update(enrichmentCache)
        .set({
          failureCount: state.failureCount,
          lastError: error.slice(0, 2000),
        })
        .where(
          and(
            eq(enrichmentCache.provider, provider),
            eq(enrichmentCache.externalId, externalId),
            eq(enrichmentCache.locale, locale),
          ),
        )
    })
  }

  /**
   * Delete cached rows. When `locale` is omitted, removes ALL locale variants
   * of the (provider, externalId) tuple — admin-style purge semantics.
   */
  async deleteByProviderAndExternalId(
    provider: string,
    externalId: string,
    locale?: string,
  ): Promise<void> {
    const conds = [
      eq(enrichmentCache.provider, provider),
      eq(enrichmentCache.externalId, externalId),
    ]
    if (locale !== undefined) {
      conds.push(eq(enrichmentCache.locale, locale))
    }
    await this.db.delete(enrichmentCache).where(and(...conds))
  }

  /**
   * Return every cached locale variant for the given (provider, externalId).
   * Used by `invalidate` and admin "refresh all locales" flows so callers can
   * iterate over the existing locale set without scanning the table.
   */
  async findAllLocalesByRef(
    provider: string,
    externalId: string,
  ): Promise<EnrichmentRow[]> {
    const rows = await this.db
      .select()
      .from(enrichmentCache)
      .where(
        and(
          eq(enrichmentCache.provider, provider),
          eq(enrichmentCache.externalId, externalId),
        ),
      )
    return rows.map((r) => this.mapRow(r))
  }

  async listPaginated(
    page: number,
    size: number,
    opts?: { onlyFailed?: boolean; locale?: string },
  ) {
    const offset = (page - 1) * size
    const conds = [] as any[]
    if (opts?.onlyFailed) conds.push(gt(enrichmentCache.failureCount, 0))
    if (opts?.locale !== undefined)
      conds.push(eq(enrichmentCache.locale, opts.locale))
    const where = conds.length === 0 ? undefined : and(...conds)

    const rowsQuery = this.db
      .select()
      .from(enrichmentCache)
      .orderBy(sql`${enrichmentCache.createdAt} DESC`)
      .limit(size)
      .offset(offset)
    const rows = where ? await rowsQuery.where(where) : await rowsQuery

    const countQuery = this.db
      .select({ count: sql<number>`count(*)` })
      .from(enrichmentCache)
    const countResult = where ? await countQuery.where(where) : await countQuery

    const total = Number(countResult[0].count)
    return {
      data: rows.map((r) => this.mapRow(r)),
      pagination: this.paginationOf(total, page, size),
    }
  }

  private mapRow(row: any): EnrichmentRow {
    return {
      id: row.id,
      provider: row.provider,
      externalId: row.externalId,
      url: row.url,
      locale: row.locale ?? '',
      normalized: row.normalized as EnrichmentResult,
      raw: row.raw,
      fetchedAt: row.fetchedAt,
      expiresAt: row.expiresAt,
      failureCount: row.failureCount,
      lastError: row.lastError,
      createdAt: row.createdAt,
    }
  }
}
