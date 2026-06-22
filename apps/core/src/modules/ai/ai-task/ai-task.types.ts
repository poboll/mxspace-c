export enum AITaskType {
  Summary = 'ai:summary',
  SummaryBatch = 'ai:summary:batch',
  SummaryAll = 'ai:summary:all',
  Translation = 'ai:translation',
  TranslationBatch = 'ai:translation:batch',
  TranslationAll = 'ai:translation:all',
  SlugBackfill = 'ai:slug:backfill',
  Insights = 'ai:insights',
  InsightsBatch = 'ai:insights:batch',
  InsightsAll = 'ai:insights:all',
  InsightsTranslation = 'ai:insights:translation',
}

export interface SummaryTaskPayload {
  refId: string
  targetLanguages?: string[]
  force?: boolean
  // Human-readable info
  title?: string
  refType?: string
}

export interface SummaryBatchTaskPayload {
  refIds: string[]
  targetLanguages?: string[]
  force?: boolean
}

export interface SummaryAllTaskPayload {
  targetLanguages?: string[]
  force?: boolean
  articleCount?: number
}

export interface TranslationTaskPayload {
  refId: string
  targetLanguages?: string[]
  // Human-readable info
  title?: string
  refType?: string
}

export interface TranslationBatchTaskPayload {
  refIds: string[]
  targetLanguages?: string[]
  // Human-readable info (count is derived from refIds.length)
}

export interface TranslationAllTaskPayload {
  targetLanguages?: string[]
  // Human-readable info
  articleCount?: number
}

export interface SlugBackfillTaskPayload {
  // Human-readable info
  noteCount?: number
  noteIds?: string[]
}

export interface InsightsTaskPayload {
  refId: string
  force?: boolean
  title?: string
  refType?: string
}

export interface InsightsBatchTaskPayload {
  refIds: string[]
  force?: boolean
}

export interface InsightsAllTaskPayload {
  force?: boolean
  articleCount?: number
}

export interface InsightsTranslationTaskPayload {
  refId: string
  sourceInsightsId: string
  targetLang: string
  title?: string
  refType?: string
}

export type AITaskPayload =
  | SummaryTaskPayload
  | SummaryBatchTaskPayload
  | SummaryAllTaskPayload
  | TranslationTaskPayload
  | TranslationBatchTaskPayload
  | TranslationAllTaskPayload
  | SlugBackfillTaskPayload
  | InsightsTaskPayload
  | InsightsBatchTaskPayload
  | InsightsAllTaskPayload
  | InsightsTranslationTaskPayload

export function computeAITaskDedupKey(
  type: AITaskType,
  payload: AITaskPayload,
): string {
  switch (type) {
    case AITaskType.Summary: {
      const p = payload as SummaryTaskPayload
      return `${p.refId}:${(p.targetLanguages || []).slice().sort().join(',')}`
    }
    case AITaskType.SummaryBatch: {
      const p = payload as SummaryBatchTaskPayload
      return `${(p.refIds || []).slice().sort().join(',')}:${(p.targetLanguages || []).slice().sort().join(',')}`
    }
    case AITaskType.SummaryAll: {
      const p = payload as SummaryAllTaskPayload
      return `all:${(p.targetLanguages || []).slice().sort().join(',')}`
    }
    case AITaskType.Translation: {
      const p = payload as TranslationTaskPayload
      return `${p.refId}:${(p.targetLanguages || []).slice().sort().join(',')}`
    }
    case AITaskType.TranslationBatch: {
      const p = payload as TranslationBatchTaskPayload
      return `${(p.refIds || []).slice().sort().join(',')}:${(p.targetLanguages || []).slice().sort().join(',')}`
    }
    case AITaskType.TranslationAll: {
      const p = payload as TranslationAllTaskPayload
      return `all:${(p.targetLanguages || []).slice().sort().join(',')}`
    }
    case AITaskType.SlugBackfill: {
      const p = payload as SlugBackfillTaskPayload
      if (p.noteIds?.length) {
        return `slug:backfill:${p.noteIds.slice().sort().join(',')}`
      }
      return `slug:backfill`
    }
    case AITaskType.Insights: {
      const p = payload as InsightsTaskPayload
      return `${p.refId}`
    }
    case AITaskType.InsightsBatch: {
      const p = payload as InsightsBatchTaskPayload
      return `${(p.refIds || []).slice().sort().join(',')}`
    }
    case AITaskType.InsightsAll: {
      return 'all'
    }
    case AITaskType.InsightsTranslation: {
      const p = payload as InsightsTranslationTaskPayload
      return `${p.refId}:${p.targetLang}`
    }
  }
}
