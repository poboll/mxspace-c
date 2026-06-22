import { describe, expect, it, vi } from 'vitest'

import { createPgRepositoryMock } from '@/helper/pg-repository-mock'
import type { TranslationEntryRepository } from '~/modules/ai/ai-translation/ai-translation.repository'
import { TranslationEntryService } from '~/modules/ai/ai-translation/translation-entry.service'

const createService = () => {
  const repository = createPgRepositoryMock<TranslationEntryRepository>()
  const categoryService = { findAllCategory: vi.fn().mockResolvedValue([]) }
  const noteService = {
    findRecent: vi.fn().mockResolvedValue([]),
    listPaginated: vi.fn().mockResolvedValue({
      data: [],
      pagination: { totalPage: 1 },
    }),
  }
  const topicRepository = { findAll: vi.fn().mockResolvedValue([]) }
  const aiService = {}
  const configService = {
    get: vi.fn(async () => ({ translationTargetLanguages: ['en'] })),
  }
  const pipeline = {
    hset: vi.fn().mockReturnThis(),
    hdel: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn(),
  }
  const redis = {
    hmget: vi.fn().mockResolvedValue([]),
    pipeline: vi.fn(() => pipeline),
  }
  const redisService = { getClient: vi.fn(() => redis) }
  const service = new TranslationEntryService(
    repository as any,
    categoryService as any,
    noteService as any,
    topicRepository as any,
    aiService as any,
    configService as any,
    redisService as any,
  )
  return { noteService, pipeline, redis, repository, service }
}

describe('TranslationEntryService', () => {
  it('deduplicates entity lookup keys before querying the PG repository', async () => {
    const { repository, service } = createService()
    repository.listByBatch.mockResolvedValue([
      {
        keyType: 'entity',
        keyPath: 'category.name',
        lookupKey: 'cat-1',
        translatedText: 'Category',
      },
    ])

    const result = await service.getTranslations('category.name', 'en', [
      'cat-1',
      'cat-1',
      '',
    ])

    expect(repository.listByBatch).toHaveBeenCalledWith('en', [
      {
        keyPath: 'category.name',
        keyType: 'entity',
        lookupKeys: ['cat-1'],
      },
    ])
    expect(result.get('cat-1')).toBe('Category')
  })

  it('serves dictionary translations from Redis before falling back to PG rows', async () => {
    const { redis, repository, service } = createService()
    redis.hmget.mockResolvedValue(['Sunny'])

    const result = await service.getTranslationsForDict('note.weather', 'en', [
      '晴',
    ])

    expect(repository.listByBatch).not.toHaveBeenCalled()
    expect(result.get('晴')).toBe('Sunny')
  })

  it('updates dictionary cache after PG dictionary entry updates', async () => {
    const { pipeline, repository, service } = createService()
    repository.updateTranslatedText.mockResolvedValue({
      keyType: 'dict',
      keyPath: 'note.mood',
      lang: 'en',
      lookupKey: 'hash-1',
      translatedText: 'Happy',
    })

    await service.updateEntry('entry-1', 'Happy')

    expect(pipeline.hset).toHaveBeenCalledWith(
      expect.any(String),
      'hash-1',
      'Happy',
    )
    expect(pipeline.exec).toHaveBeenCalled()
  })

  it('collects dictionary entry candidates from all visible notes', async () => {
    const { noteService, repository, service } = createService() as any
    noteService.listPaginated.mockResolvedValue({
      data: [
        { mood: '开心', weather: '晴' },
        { mood: '开心', weather: '雨' },
      ],
      pagination: { totalPage: 1 },
    })
    repository.listByKeyPathLookupKeys.mockResolvedValue([
      {
        keyPath: 'note.mood',
        lookupKey: TranslationEntryService.hashSourceText('开心'),
        lang: 'en',
      },
    ])

    const candidates = await service.getEntryCandidates({
      keyPaths: ['note.mood', 'note.weather'],
      targetLangs: ['en', 'ja'],
    })

    expect(noteService.listPaginated).toHaveBeenCalledWith(1, 100, {
      metaOnly: true,
      visibleOnly: true,
    })
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyPath: 'note.mood',
          sourceText: '开心',
          existingLanguages: ['en'],
          missingLanguages: ['ja'],
        }),
        expect.objectContaining({
          keyPath: 'note.weather',
          sourceText: '晴',
          missingLanguages: ['en', 'ja'],
        }),
      ]),
    )
  })

  it('regenerates existing dictionary entries when forced', async () => {
    const { noteService, repository, service } = createService() as any
    noteService.listPaginated.mockResolvedValue({
      data: [{ mood: '开心', weather: null }],
      pagination: { totalPage: 1 },
    })
    repository.listFiltered.mockResolvedValue([
      {
        keyPath: 'note.mood',
        lookupKey: TranslationEntryService.hashSourceText('开心'),
        sourceText: '开心',
      },
    ])

    const aiService = (service as any).aiService
    aiService.getTranslationModel = vi.fn(async () => ({
      generateStructured: vi.fn(async () => ({
        output: {
          translations: {
            [`note.mood::${TranslationEntryService.hashSourceText('开心')}`]:
              'happy',
          },
        },
      })),
    }))

    await expect(
      service.generateTranslations({
        force: true,
        keyPaths: ['note.mood'],
        targetLangs: ['en'],
      }),
    ).resolves.toEqual({ created: 1, skipped: 0 })

    expect(repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPath: 'note.mood',
        sourceText: '开心',
        translatedText: 'happy',
      }),
    )
  })
})
