import { describe, expect, it, vi } from 'vitest'

import { createPgRepositoryMock, now } from '@/helper/pg-repository-mock'
import { AppException } from '~/common/errors/exception.types'
import { CollectionRefTypes } from '~/constants/db.constant'
import type { AiSummaryRepository } from '~/modules/ai/ai-summary/ai-summary.repository'
import { AiSummaryService } from '~/modules/ai/ai-summary/ai-summary.service'
import { AITaskType } from '~/modules/ai/ai-task/ai-task.types'

const createService = () => {
  const repository = createPgRepositoryMock<AiSummaryRepository>()
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
  const service = new AiSummaryService(
    repository as any,
    databaseService as any,
    configService as any,
    aiService as any,
    aiInFlightService as any,
    taskProcessor as any,
    taskQueueService as any,
    aiTaskService as any,
  )
  return {
    configService,
    databaseService,
    repository,
    service,
    taskProcessor,
    taskQueueService,
  }
}

describe('AiSummaryService', () => {
  it('updates summaries through the PG repository after existence validation', async () => {
    const { repository, service } = createService()
    repository.findById.mockResolvedValue({
      id: 'summary-1',
      refId: 'post-1',
      lang: 'zh',
      summary: 'old',
      hash: 'hash',
      createdAt: now,
    })
    repository.updateSummary.mockResolvedValue({
      id: 'summary-1',
      refId: 'post-1',
      lang: 'zh',
      summary: 'new',
      hash: 'hash',
      createdAt: now,
    })

    await expect(
      service.updateSummaryInDb('summary-1', 'new'),
    ).resolves.toMatchObject({
      id: 'summary-1',
      summary: 'new',
    })
    expect(repository.updateSummary).toHaveBeenCalledWith('summary-1', 'new')
  })

  it('throws when updating a missing summary row', async () => {
    const { repository, service } = createService()
    repository.findById.mockResolvedValue(null)

    await expect(service.updateSummaryInDb('missing', 'new')).rejects.toThrow(
      AppException,
    )
  })

  it('deletes summaries by article id through the PG repository', async () => {
    const { repository, service } = createService()
    repository.deleteForRef.mockResolvedValue(1)

    await service.deleteSummaryByArticleId('post-1')

    expect(repository.deleteForRef).toHaveBeenCalledWith('post-1')
  })

  it('creates one summary task per visible article in the summary-all task', async () => {
    const {
      configService,
      databaseService,
      service,
      taskProcessor,
      taskQueueService,
    } = createService()
    configService.get.mockResolvedValue({
      summaryTargetLanguages: ['zh', 'en'],
    } as any)
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
      .find((registered: any) => registered.type === AITaskType.SummaryAll)

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
          targetLanguages: ['zh', 'en'],
        }),
        type: AITaskType.Summary,
      }),
    )
    expect(context.setResult).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2, createdCount: 2 }),
    )
  })
})
