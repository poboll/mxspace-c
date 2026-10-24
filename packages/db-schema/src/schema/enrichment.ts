import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

import { createdAt, pkText, refText } from './columns'

// A failed first fetch has no successful cache row. Keep retry/lease state
// separately so it never masquerades as a usable link preview.
export const enrichmentFetchState = pgTable(
  'enrichment_fetch_state',
  {
    provider: varchar('provider', { length: 64 }).notNull(),
    externalId: varchar('external_id', { length: 256 }).notNull(),
    locale: varchar('locale', { length: 8 }).notNull().default(''),
    failureCount: integer('failure_count').notNull().default(0),
    lastError: text('last_error'),
    lastAttemptAt: timestamp('last_attempt_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
    nextRetryAt: timestamp('next_retry_at', {
      withTimezone: true,
      mode: 'date',
    }),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.externalId, table.locale] }),
  ],
)

export const enrichmentCache = pgTable(
  'enrichment_cache',
  {
    id: pkText(),
    provider: varchar('provider', { length: 64 }).notNull(),
    externalId: varchar('external_id', { length: 256 }).notNull(),
    url: text('url').notNull(),

    locale: varchar('locale', { length: 8 }).notNull().default(''),

    normalized: jsonb('normalized').$type<Record<string, unknown>>().notNull(),
    raw: jsonb('raw'),

    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    failureCount: integer('failure_count').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('enrichment_provider_external_id_locale_uniq').on(
      table.provider,
      table.externalId,
      table.locale,
    ),
    index('enrichment_expires_at_idx').on(table.expiresAt),
  ],
)

export interface EnrichmentImagePalette {
  dominant: string
  swatches?: string[]
}

export const enrichmentCaptures = pgTable(
  'enrichment_captures',
  {
    enrichmentId: refText('enrichment_id')
      .primaryKey()
      .notNull()
      .references(() => enrichmentCache.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    bytes: integer('bytes').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    thumbhash: text('thumbhash'),
    palette: jsonb('palette').$type<EnrichmentImagePalette>(),
    createdAt: createdAt(),
    lastAccessedAt: timestamp('last_accessed_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('enrichment_captures_lru_idx').on(table.lastAccessedAt.asc()),
  ],
)
