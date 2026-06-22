import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { withFauxAi } from '@/helper/faux-ai.helper'
import { AppException } from '~/common/errors/exception.types'
import { AiController } from '~/modules/ai/ai.controller'
import { AIProviderType } from '~/modules/ai/ai.types'
import { PiRuntimeAdapter } from '~/modules/ai/runtime/pi-runtime.adapter'

// Provider id MUST match a host-derivation entry so the adapter resolves the
// faux model from the pi registry. Use api.openai.com -> 'openai'.
const PROVIDER_HOST = 'api.openai.com'
const PROVIDER_ID = 'openai'
const MODEL_ID = 'faux-controller-model'

function mountFaux(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  return withFauxAi({
    api: 'openai-completions',
    provider: PROVIDER_ID,
    models: [{ id: MODEL_ID, name: MODEL_ID }],
    responses,
  })
}

interface BuildOpts {
  enabled?: boolean
  aiReview?: boolean
  aiReviewType?: 'binary' | 'score'
}

function buildController(opts: BuildOpts = {}) {
  const aiConfig = {
    providers: [
      {
        id: PROVIDER_ID,
        name: 'OpenAI',
        type: AIProviderType.OpenAICompatible,
        apiKey: 'k',
        endpoint: `https://${PROVIDER_HOST}/v1`,
        defaultModel: MODEL_ID,
        enabled: opts.enabled !== false,
      },
    ],
  }
  const configsService = {
    get: vi.fn(async (key: string) => {
      if (key === 'ai') return aiConfig
      if (key === 'commentOptions')
        return {
          aiReview: opts.aiReview ?? true,
          aiReviewType: opts.aiReviewType ?? 'binary',
          aiReviewThreshold: 5,
        }
      return {}
    }),
    getAiProviderById: vi.fn(async () => aiConfig.providers[0]),
  }
  // For comment-review, return a PiRuntimeAdapter directly.
  const aiService = {
    getCommentReviewModel: vi.fn(
      async () =>
        new PiRuntimeAdapter({
          apiKey: 'k',
          endpoint: `https://${PROVIDER_HOST}/v1`,
          model: MODEL_ID,
          providerType: AIProviderType.OpenAICompatible,
          providerId: PROVIDER_ID,
        }),
    ),
  }
  const aiTaskService = {
    createSummaryAllTask: vi.fn(async () => ({
      taskId: 'summary-task',
      created: true,
    })),
    createInsightsAllTask: vi.fn(async () => ({
      taskId: 'insights-task',
      created: true,
    })),
    createTranslationAllTask: vi.fn(async () => ({
      taskId: 'translation-task',
      created: true,
    })),
  }
  const translationEntryService = {
    generateTranslations: vi.fn(async () => ({ created: 1, skipped: 0 })),
  }
  const searchService = {
    rebuildSearchDocuments: vi.fn(async () => ({
      total: 1,
      created: 1,
      updated: 0,
      deleted: 0,
      skipped: 0,
    })),
  }
  const controller = new AiController(
    configsService as any,
    aiService as any,
    aiTaskService as any,
    translationEntryService as any,
    searchService as any,
  )
  return {
    aiService,
    aiTaskService,
    configsService,
    controller,
    searchService,
    translationEntryService,
  }
}

const torn: Array<() => void> = []
afterEach(() => {
  while (torn.length) torn.pop()!()
})

describe('AiController test endpoints (faux)', () => {
  it('reconciles search only when no AI feature is selected', async () => {
    const { aiTaskService, controller, searchService } = buildController()

    await expect(controller.reconcile({})).resolves.toMatchObject({
      search: { total: 1 },
    })

    expect(searchService.rebuildSearchDocuments).toHaveBeenCalledWith()
    expect(aiTaskService.createSummaryAllTask).not.toHaveBeenCalled()
    expect(aiTaskService.createInsightsAllTask).not.toHaveBeenCalled()
    expect(aiTaskService.createTranslationAllTask).not.toHaveBeenCalled()
  })

  it('reconciles search and selected AI features for DB-side changes', async () => {
    const {
      aiTaskService,
      controller,
      searchService,
      translationEntryService,
    } = buildController()

    await expect(
      controller.reconcile({
        features: ['summary', 'insights', 'translation', 'translation-entries'],
        force: true,
        targetLanguages: ['en'],
      }),
    ).resolves.toMatchObject({
      search: { total: 1 },
      summary: { taskId: 'summary-task' },
      insights: { taskId: 'insights-task' },
      translation: { taskId: 'translation-task' },
      translationEntries: { created: 1 },
    })

    expect(searchService.rebuildSearchDocuments).toHaveBeenCalledWith()
    expect(aiTaskService.createSummaryAllTask).toHaveBeenCalledWith({
      force: true,
      targetLanguages: ['en'],
    })
    expect(aiTaskService.createInsightsAllTask).toHaveBeenCalledWith({
      force: true,
    })
    expect(aiTaskService.createTranslationAllTask).toHaveBeenCalledWith({
      force: true,
      targetLanguages: ['en'],
    })
    expect(translationEntryService.generateTranslations).toHaveBeenCalledWith({
      force: true,
      keyPaths: undefined,
      targetLangs: ['en'],
    })
  })

  describe('POST /ai/test (testProviderConnection)', () => {
    it('succeeds when adapter generates text via faux', async () => {
      const handle = mountFaux([fauxAssistantMessage('ok')])
      torn.push(() => handle.teardown())
      const { controller } = buildController()
      const res = await controller.testProviderConnection({
        type: AIProviderType.OpenAICompatible,
        apiKey: 'k',
        endpoint: `https://${PROVIDER_HOST}/v1`,
        model: MODEL_ID,
      })
      expect(res.ok).toBe(true)
    })

    it('throws AppException when pi reports error', async () => {
      const handle = mountFaux([
        fauxAssistantMessage('boom', {
          stopReason: 'error',
          errorMessage: 'pi blew',
        }),
      ])
      torn.push(() => handle.teardown())
      const { controller } = buildController()
      await expect(
        controller.testProviderConnection({
          type: AIProviderType.OpenAICompatible,
          apiKey: 'k',
          endpoint: `https://${PROVIDER_HOST}/v1`,
          model: MODEL_ID,
        }),
      ).rejects.toBeInstanceOf(AppException)
    })
  })

  describe('POST /ai/comment-review/test (testCommentReview)', () => {
    it('binary mode: flags spammy via hasSensitiveContent', async () => {
      const handle = mountFaux([
        fauxAssistantMessage([
          fauxToolCall('structured_output', {
            isSpam: false,
            hasSensitiveContent: true,
          }),
        ]),
      ])
      torn.push(() => handle.teardown())
      const { controller } = buildController({ aiReviewType: 'binary' })
      const res = await controller.testCommentReview({
        text: 'some comment',
      })
      expect(res.isSpam).toBe(true)
      expect(res.reason).toMatch(/sensitive/i)
    })

    it('score mode: flags via score threshold', async () => {
      const handle = mountFaux([
        fauxAssistantMessage([
          fauxToolCall('structured_output', {
            score: 8,
            hasSensitiveContent: false,
          }),
        ]),
      ])
      torn.push(() => handle.teardown())
      const { controller } = buildController({ aiReviewType: 'score' })
      const res = await controller.testCommentReview({
        text: 'spammy text',
      })
      expect(res.isSpam).toBe(true)
      expect(res.score).toBe(8)
    })
  })
})
