import { describe, expect, it, vi } from 'vitest'

import { createPgRepositoryMock, now } from '@/helper/pg-repository-mock'
import { AppException } from '~/common/errors/exception.types'
import { CollectionRefTypes } from '~/constants/db.constant'
import type { AiInsightsRepository } from '~/modules/ai/ai-insights/ai-insights.repository'
import { AiInsightsService } from '~/modules/ai/ai-insights/ai-insights.service'
import { AITaskType } from '~/modules/ai/ai-task/ai-task.types'

const row = {
  id: 'insights-1',
  refId: 'post-1',
  lang: 'zh',
  content: 'insight',
  hash: 'hash',
  isTranslation: false,
  sourceInsightsId: null,
  sourceLang: null,
  modelInfo: null,
  createdAt: now,
}

const createService = () => {
  const repository = createPgRepositoryMock<AiInsightsRepository>()
  const databaseService = {
    findGlobalById: vi.fn(),
    getRefArticleMap: vi.fn().mockResolvedValue({}),
    findAllArticlesForAIText: vi.fn(),
  }
  const configService = { get: vi.fn() }
  const aiService = {}
  const aiInFlightService = {}
  const taskProcessor = { registerHandler: vi.fn() }
  const taskQueueService = { createTask: vi.fn() }
  const aiTaskService = {}
  const eventEmitter = { emit: vi.fn() }
  const service = new AiInsightsService(
    repository as any,
    databaseService as any,
    configService as any,
    aiService as any,
    aiInFlightService as any,
    taskProcessor as any,
    taskQueueService as any,
    aiTaskService as any,
    eventEmitter as any,
  )
  return {
    databaseService,
    repository,
    service,
    taskProcessor,
    taskQueueService,
  }
}

describe('AiInsightsService', () => {
  it('checks insight language availability through the PG repository', async () => {
    const { repository, service } = createService()
    repository.findByRefAndLang.mockResolvedValue(row as any)

    await expect(service.hasInsightsInLang('post-1', 'zh')).resolves.toBe(true)
    expect(repository.findByRefAndLang).toHaveBeenCalledWith('post-1', 'zh')
  })

  it('updates insight content after validating the target row exists', async () => {
    const { repository, service } = createService()
    repository.findById.mockResolvedValue(row as any)
    repository.updateContent.mockResolvedValue({
      ...row,
      content: 'new',
    } as any)

    await expect(
      service.updateInsightsInDb('insights-1', 'new'),
    ).resolves.toMatchObject({
      id: 'insights-1',
      content: 'new',
    })
  })

  it('throws when updating a missing insight row', async () => {
    const { repository, service } = createService()
    repository.findById.mockResolvedValue(null)

    await expect(service.updateInsightsInDb('missing', 'new')).rejects.toThrow(
      AppException,
    )
  })

  it('loads grouped insight article metadata from the PG database service', async () => {
    const { databaseService, repository, service } = createService()
    repository.groupedByRef.mockResolvedValue({
      data: [{ refId: 'post-1' }],
      pagination: { total: 1 },
    })
    repository.listByRefIds.mockResolvedValue([row] as any)
    databaseService.getRefArticleMap.mockResolvedValue({
      'post-1': { id: 'post-1', title: 'Post', type: CollectionRefTypes.Post },
    })

    await expect(
      service.getAllInsightsGrouped({ page: 1, size: 10 }),
    ).resolves.toMatchObject({
      data: [{ article: { id: 'post-1', title: 'Post' } }],
      pagination: { total: 1, currentPage: 1, size: 10 },
    })
  })

  it('creates one insights task per visible article in the insights-all task', async () => {
    const { databaseService, service, taskProcessor, taskQueueService } =
      createService()
    databaseService.findAllArticlesForAIText.mockResolvedValue({
      posts: [{ id: 'post-1', title: 'Post' }],
      notes: [{ id: 'note-1', title: 'Note' }],
    })
    taskQueueService.createTask.mockImplementation(
      async ({ payload }: any) => ({
        created: true,
        taskId: `task-${payload.refId}`,
      }),
    )

    service.onModuleInit()
    const handler = taskProcessor.registerHandler.mock.calls
      .map(([registered]) => registered)
      .find((registered: any) => registered.type === AITaskType.InsightsAll)

    const context = {
      taskId: 'group-1',
      isAborted: () => false,
      appendLog: vi.fn(),
      updateProgress: vi.fn(),
      setResult: vi.fn(),
    }
    await handler.execute({ force: true }, context as any)

    expect(databaseService.findAllArticlesForAIText).toHaveBeenCalled()
    expect(taskQueueService.createTask).toHaveBeenCalledTimes(2)
    expect(taskQueueService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 'group-1',
        payload: expect.objectContaining({
          force: true,
          refId: 'post-1',
          refType: CollectionRefTypes.Post,
        }),
        type: AITaskType.Insights,
      }),
    )
    expect(context.setResult).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2, createdCount: 2 }),
    )
  })
})
