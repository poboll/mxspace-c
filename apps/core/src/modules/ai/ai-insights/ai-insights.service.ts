import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter'
import removeMdCodeblock from 'remove-md-codeblock'

import { AppErrorCode, createAppException } from '~/common/errors'
import { AppException } from '~/common/errors/exception.types'
import { BusinessEvents } from '~/constants/business-event.constant'
import { CollectionRefTypes } from '~/constants/db.constant'
import { paginationOf } from '~/processors/database/base.repository'
import {
  buildRefArticleMap,
  DatabaseService,
} from '~/processors/database/database.service'
import {
  type TaskExecuteContext,
  TaskQueueProcessor,
  TaskQueueService,
} from '~/processors/task-queue'
import type { BasicPagerInput } from '~/shared/dto/pager.dto'
import { createAbortError } from '~/utils/abort.util'
import { md5 } from '~/utils/tool.util'

import { ConfigsService } from '../../configs/configs.service'
import {
  AI_STREAM_IDLE_TIMEOUT_MS,
  AI_STREAM_LOCK_TTL,
  AI_STREAM_MAXLEN,
  AI_STREAM_READ_BLOCK_MS,
  AI_STREAM_RESULT_TTL,
  DEFAULT_SUMMARY_LANG,
} from '../ai.constants'
import { AI_PROMPTS } from '../ai.prompts'
import { AiService } from '../ai.service'
import { isGlobalArticleVisible } from '../ai-article-visibility.util'
import { AiInFlightService } from '../ai-inflight/ai-inflight.service'
import type { AiStreamEvent } from '../ai-inflight/ai-inflight.types'
import { AiTaskService } from '../ai-task/ai-task.service'
import {
  AITaskType,
  computeAITaskDedupKey,
  type InsightsAllTaskPayload,
  type InsightsBatchTaskPayload,
  type InsightsTaskPayload,
} from '../ai-task/ai-task.types'
import { AiInsightsRepository } from './ai-insights.repository'
import type { GetInsightsGroupedQueryInput } from './ai-insights.schema'
import type { AiInsightsRow } from './ai-insights.types'
import { AIInsightsModel } from './ai-insights.types'
import { stripTopLevelCodeFence } from './insights.util'

interface ArticleForInsights {
  title: string
  text: string
  subtitle?: string
  tags?: string[]
  lang?: string
}

@Injectable()
export class AiInsightsService implements OnModuleInit {
  private readonly logger = new Logger(AiInsightsService.name)

  constructor(
    private readonly aiInsightsRepository: AiInsightsRepository,
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigsService,
    private readonly aiService: AiService,
    private readonly aiInFlightService: AiInFlightService,
    private readonly taskProcessor: TaskQueueProcessor,
    private readonly taskQueueService: TaskQueueService,
    private readonly aiTaskService: AiTaskService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit() {
    this.registerTaskHandler()
  }

  private registerTaskHandler() {
    this.taskProcessor.registerHandler({
      type: AITaskType.Insights,
      execute: async (
        payload: InsightsTaskPayload,
        context: TaskExecuteContext,
      ) => {
        this.checkAborted(context)
        await context.updateProgress(0, 'Generating insights', 0, 1)
        const result = await this.generateInsights(
          payload.refId,
          context.incrementTokens,
          context.incrementCost,
          { force: payload.force },
        )
        await context.setResult({ insightsId: result.id, lang: result.lang })
        await context.updateProgress(100, 'Done', 1, 1)
      },
    })
    this.taskProcessor.registerHandler({
      type: AITaskType.InsightsBatch,
      execute: async (
        payload: InsightsBatchTaskPayload,
        context: TaskExecuteContext,
      ) => {
        await this.executeInsightsBatchTask(payload, context)
      },
    })
    this.taskProcessor.registerHandler({
      type: AITaskType.InsightsAll,
      execute: async (
        payload: InsightsAllTaskPayload,
        context: TaskExecuteContext,
      ) => {
        await this.executeInsightsAllTask(payload, context)
      },
    })
    this.logger.log('AI insights task handler registered')
  }

  private async executeInsightsBatchTask(
    payload: InsightsBatchTaskPayload,
    context: TaskExecuteContext,
  ) {
    this.checkAborted(context)

    const { force, refIds } = payload
    const total = refIds.length

    await context.appendLog(
      'info',
      `Creating ${total} insights tasks for batch`,
    )

    const articleMap = await this.databaseService.getRefArticleMap(refIds)
    const createdTaskIds: string[] = []

    for (const refId of refIds) {
      this.checkAborted(context)

      const articleInfo = articleMap[refId]
      const result = await this.createInsightsSubTask(
        refId,
        force,
        articleInfo,
        context.taskId,
      )

      if (result.created) {
        createdTaskIds.push(result.taskId)
        await context.appendLog(
          'info',
          `Created task for "${articleInfo?.title || refId}"`,
        )
      } else {
        await context.appendLog(
          'info',
          `Task already exists for "${articleInfo?.title || refId}": ${result.taskId}`,
        )
      }
    }

    await context.setResult({
      total,
      createdCount: createdTaskIds.length,
      taskIds: createdTaskIds,
      groupId: context.taskId,
    })

    await context.appendLog(
      'info',
      `Batch task completed: created ${createdTaskIds.length}/${total} tasks (groupId: ${context.taskId})`,
    )
  }

  private async executeInsightsAllTask(
    _payload: InsightsAllTaskPayload,
    context: TaskExecuteContext,
  ) {
    this.checkAborted(context)

    await context.appendLog('info', 'Fetching all articles for insights')

    const { posts, notes } =
      await this.databaseService.findAllArticlesForAIText()
    const articleMap = buildRefArticleMap({ posts, notes, pages: [] })
    const allArticleIds = Object.keys(articleMap)
    const total = allArticleIds.length

    if (total === 0) {
      await context.appendLog('info', 'No articles found for insights')
      await context.setResult({ total: 0, createdCount: 0 })
      return
    }

    await context.appendLog(
      'info',
      `Found ${total} articles to generate insights`,
    )
    await context.updateProgress(
      0,
      `Creating tasks for ${total} articles`,
      0,
      total,
    )

    const createdTaskIds: string[] = []

    for (let i = 0; i < allArticleIds.length; i++) {
      this.checkAborted(context)

      const refId = allArticleIds[i]
      const articleInfo = articleMap[refId]
      const result = await this.createInsightsSubTask(
        refId,
        _payload.force,
        articleInfo,
        context.taskId,
      )

      if (result.created) {
        createdTaskIds.push(result.taskId)
      }

      if ((i + 1) % 10 === 0 || i === allArticleIds.length - 1) {
        const progress = Math.round(((i + 1) / total) * 100)
        await context.updateProgress(
          progress,
          `Created ${createdTaskIds.length} tasks`,
          i + 1,
          total,
        )
      }
    }

    await context.setResult({
      total,
      createdCount: createdTaskIds.length,
      taskIds: createdTaskIds,
      groupId: context.taskId,
    })

    await context.appendLog(
      'info',
      `All task completed: created ${createdTaskIds.length}/${total} insights tasks (groupId: ${context.taskId})`,
    )
  }

  private async createInsightsSubTask(
    refId: string,
    force: boolean | undefined,
    articleInfo: { title: string; type: CollectionRefTypes } | undefined,
    groupId: string,
  ) {
    const taskPayload: InsightsTaskPayload = {
      refId,
      force,
      title: articleInfo?.title,
      refType: articleInfo?.type,
    }

    const dedupKey = computeAITaskDedupKey(AITaskType.Insights, taskPayload)
    return this.taskQueueService.createTask({
      type: AITaskType.Insights,
      payload: taskPayload as unknown as Record<string, unknown>,
      dedupKey,
      groupId,
      scope: 'ai',
    })
  }

  private checkAborted(context: TaskExecuteContext) {
    if (context.isAborted()) throw createAbortError()
  }

  private serializeText(text: string) {
    return removeMdCodeblock(text)
  }

  private computeContentHash(text: string): string {
    return md5(this.serializeText(text))
  }

  private toInsightsDoc(row: AiInsightsRow | null): AIInsightsModel | null {
    if (!row) return null
    return {
      ...row,
      createdAt: row.createdAt,
    } as unknown as AIInsightsModel
  }

  private toInsightsDocs(rows: AiInsightsRow[]): AIInsightsModel[] {
    return rows.map((row) => this.toInsightsDoc(row)!)
  }

  private buildInsightsKey(articleId: string, lang: string, text: string) {
    return md5(
      JSON.stringify({
        feature: 'insights',
        articleId,
        lang,
        textHash: md5(text),
      }),
    )
  }

  private async resolveArticleForInsights(articleId: string): Promise<{
    article: ArticleForInsights
    type: CollectionRefTypes.Post | CollectionRefTypes.Note
  }> {
    const article = await this.databaseService.findGlobalById(articleId)
    if (!article || !article.document) {
      throw createAppException(AppErrorCode.CONTENT_NOT_FOUND_CANT_PROCESS)
    }
    if (
      article.type === CollectionRefTypes.Recently ||
      article.type === CollectionRefTypes.Page
    ) {
      throw createAppException(AppErrorCode.CONTENT_NOT_FOUND_CANT_PROCESS)
    }
    // Never expose insights for draft / password-protected / future-dated
    // content. Public endpoints and background tasks both flow through here.
    if (!isGlobalArticleVisible(article)) {
      throw createAppException(AppErrorCode.CONTENT_NOT_FOUND_CANT_PROCESS)
    }
    const doc = article.document as any
    return {
      article: {
        title: doc.title,
        text: doc.text,
        subtitle: doc.subtitle,
        tags: Array.isArray(doc.tags) ? doc.tags : undefined,
        lang: doc.lang,
      },
      type: article.type,
    }
  }

  private async findValidInsights(
    articleId: string,
    lang: string,
    text: string,
  ): Promise<AIInsightsModel | null> {
    const contentHash = this.computeContentHash(text)
    const row = await this.aiInsightsRepository.findByRefAndLang(
      articleId,
      lang,
    )
    return row?.hash === contentHash ? this.toInsightsDoc(row) : null
  }

  private resolveSourceLang(article: ArticleForInsights): string {
    return article.lang || DEFAULT_SUMMARY_LANG
  }

  private async generateInsightsViaAIStream(
    article: ArticleForInsights,
    lang: string,
    push?: (event: AiStreamEvent) => Promise<void>,
    onToken?: (count?: number) => Promise<void>,
    onCost?: (usd: number) => Promise<void>,
  ): Promise<{
    content: string
    modelInfo?: { provider: string; model: string }
  }> {
    const runtime = await this.aiService.getInsightsModel()
    const { systemPrompt, prompt, reasoningEffort } = AI_PROMPTS.insightsStream(
      lang,
      article,
    )
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: prompt },
    ]

    let fullText = ''
    let totalTokens = 0
    let totalCost = 0
    if (runtime.streamMessage) {
      const events = runtime.streamMessage({
        messages,
        temperature: 0.6,
        maxRetries: 2,
        reasoningEffort,
      })
      for await (const event of events) {
        if (event.type === 'text_delta') {
          const delta = event.delta
          if (typeof delta !== 'string' || delta.length === 0) continue
          fullText += delta
          if (push) await push({ type: 'token', data: delta })
        } else if (
          event.type === 'thinking_delta' ||
          event.type === 'toolcall_start' ||
          event.type === 'toolcall_delta' ||
          event.type === 'toolcall_end'
        ) {
          this.logger.debug(`stream non-text event filtered: ${event.type}`)
        } else if (event.type === 'done') {
          totalTokens = event.message.usage?.totalTokens ?? 0
          totalCost = event.message.usage?.cost?.total ?? 0
        } else if (event.type === 'error') {
          throw new Error(
            event.error.errorMessage || 'AI insights stream error',
          )
        }
      }
    } else {
      const result = await runtime.generateText({
        messages,
        temperature: 0.6,
        maxRetries: 2,
        reasoningEffort,
      })
      fullText = result.text
      totalTokens = result.usage?.totalTokens ?? 0
      totalCost = result.usage?.cost ?? 0
      if (push && result.text) await push({ type: 'token', data: result.text })
    }
    if (onToken) await onToken(totalTokens)
    if (onCost && totalCost > 0) await onCost(totalCost)
    // Strip an accidental top-level code fence if the model wrapped the whole answer.
    const stripped = stripTopLevelCodeFence(fullText)
    return { content: stripped.trim() }
  }

  private async runInsightsGeneration(
    articleId: string,
    lang: string,
    article: ArticleForInsights,
    onToken?: (count?: number) => Promise<void>,
    onCost?: (usd: number) => Promise<void>,
    options?: { force?: boolean },
  ) {
    const text = this.serializeText(article.text)
    const key = this.buildInsightsKey(
      articleId,
      lang,
      options?.force ? `${text}:${Date.now()}` : text,
    )

    return this.aiInFlightService.runWithStream<AIInsightsModel>({
      key,
      lockTtlSec: AI_STREAM_LOCK_TTL,
      resultTtlSec: AI_STREAM_RESULT_TTL,
      streamMaxLen: AI_STREAM_MAXLEN,
      readBlockMs: AI_STREAM_READ_BLOCK_MS,
      idleTimeoutMs: AI_STREAM_IDLE_TIMEOUT_MS,
      onLeader: async ({ push }) => {
        const { content } = await this.generateInsightsViaAIStream(
          article,
          lang,
          push,
          onToken,
          onCost,
        )
        const contentMd5 = md5(text)
        const sourceLang = lang
        // Invalidate stale translations before writing the new source row.
        await this.aiInsightsRepository.deleteTranslationsWithDifferentHash(
          articleId,
          contentMd5,
        )
        // Upsert source row to satisfy the unique (refId, lang) index when
        // a previous source row exists (e.g. on article text update).
        const doc = this.toInsightsDoc(
          await this.aiInsightsRepository.upsert({
            hash: contentMd5,
            lang,
            refId: articleId,
            content,
            isTranslation: false,
            sourceLang,
            sourceInsightsId: null,
          }),
        )!
        this.eventEmitter.emit(BusinessEvents.INSIGHTS_GENERATED, {
          refId: articleId,
          sourceLang,
          insightsId: doc.id,
          sourceHash: contentMd5,
        })
        return { result: doc, resultId: doc.id! }
      },
      parseResult: async (resultId) => {
        const doc = this.toInsightsDoc(
          await this.aiInsightsRepository.findById(resultId),
        )
        if (!doc) {
          throw createAppException(AppErrorCode.CONTENT_NOT_FOUND_CANT_PROCESS)
        }
        return doc
      },
    })
  }

  async generateInsights(
    articleId: string,
    onToken?: (count?: number) => Promise<void>,
    onCost?: (usd: number) => Promise<void>,
    options?: { force?: boolean },
  ): Promise<AIInsightsModel> {
    const {
      ai: { enableInsights },
    } = await this.configService.waitForConfigReady()
    if (!enableInsights) {
      throw createAppException(AppErrorCode.AI_NOT_ENABLED)
    }
    const { article } = await this.resolveArticleForInsights(articleId)
    const lang = this.resolveSourceLang(article)
    try {
      const { result } = await this.runInsightsGeneration(
        articleId,
        lang,
        article,
        onToken,
        onCost,
        options,
      )
      return await result
    } catch (error) {
      if (error instanceof AppException) throw error
      this.logger.error(
        `AI insights generation failed for article ${articleId}: ${(error as Error).message}`,
        (error as Error).stack,
      )
      throw createAppException(AppErrorCode.AI_SERVICE_ERROR, {
        message: (error as Error).message,
      })
    }
  }

  private wrapAsImmediateStream(doc: AIInsightsModel): {
    events: AsyncIterable<AiStreamEvent>
    result: Promise<AIInsightsModel>
  } {
    const events = (async function* () {
      yield { type: 'done' as const, data: { resultId: doc.id! } }
    })()
    return { events, result: Promise.resolve(doc) }
  }

  async streamInsightsForArticle(
    articleId: string,
    options: { lang: string },
  ): Promise<{
    events: AsyncIterable<AiStreamEvent>
    result: Promise<AIInsightsModel>
  }> {
    const aiConfig = await this.configService.get('ai')
    if (!aiConfig?.enableInsights) {
      throw createAppException(AppErrorCode.AI_NOT_ENABLED)
    }
    const { article } = await this.resolveArticleForInsights(articleId)
    const lang = options.lang || this.resolveSourceLang(article)
    const existing = await this.findValidInsights(articleId, lang, article.text)
    if (existing) {
      this.logger.debug(`Insights cache hit: article=${articleId} lang=${lang}`)
      return this.wrapAsImmediateStream(existing)
    }
    return this.runInsightsGeneration(articleId, lang, article)
  }

  async getOrGenerateInsightsForArticle(
    articleId: string,
    options: { lang: string; onlyDb?: boolean },
  ): Promise<AIInsightsModel | null> {
    const { article } = await this.resolveArticleForInsights(articleId)
    const lang = options.lang || this.resolveSourceLang(article)
    const existing = await this.findValidInsights(articleId, lang, article.text)
    if (existing) return existing
    if (options.onlyDb) return null
    const aiConfig = await this.configService.get('ai')
    if (!aiConfig?.enableInsights) {
      throw createAppException(AppErrorCode.AI_NOT_ENABLED)
    }
    return this.generateInsights(articleId)
  }

  async findSourceInsightsForArticle(
    refId: string,
  ): Promise<AIInsightsModel | null> {
    return this.toInsightsDoc(
      await this.aiInsightsRepository.findSourceForRef(refId),
    )
  }

  /**
   * Lightweight existence check used by article responses to tell the
   * frontend whether insights are already available in the requested lang —
   * either as a source row or as a translation. Hash is not verified; this
   * only answers "do we have any insights document for (refId, lang)?".
   */
  async hasInsightsInLang(refId: string, lang: string): Promise<boolean> {
    return !!(await this.aiInsightsRepository.findByRefAndLang(refId, lang))
  }

  async getInsightsById(id: string) {
    const doc = this.toInsightsDoc(await this.aiInsightsRepository.findById(id))
    if (!doc)
      throw createAppException(AppErrorCode.CONTENT_NOT_FOUND_CANT_PROCESS)
    return doc
  }

  async getInsightsByRefId(refId: string) {
    const article = await this.databaseService.findGlobalById(refId)
    if (!article)
      throw createAppException(AppErrorCode.CONTENT_NOT_FOUND, { id: refId })
    const insights = this.toInsightsDocs(
      await this.aiInsightsRepository.listForRef(refId),
    )
    return { insights, article }
  }

  async getAllInsights(pager: BasicPagerInput) {
    const { page, size } = pager
    const result = await this.aiInsightsRepository.list(page, size)
    const docs = this.toInsightsDocs(result.data)
    return {
      data: docs,
      pagination: result.pagination,
      articles: await this.getRefArticles(docs),
    }
  }

  async getAllInsightsGrouped(query: GetInsightsGroupedQueryInput) {
    const { page, size } = query
    const search = query.search?.trim()
    const searchableRefIds = search
      ? await this.databaseService.findArticleIdsByTitle(search)
      : undefined

    if (search && searchableRefIds?.length === 0) {
      return {
        data: [],
        pagination: paginationOf(0, page, size),
      }
    }

    const grouped = await this.aiInsightsRepository.groupedByRef(
      page,
      size,
      searchableRefIds,
    )
    const groupedRefIds = grouped.data
    const total = grouped.pagination.total
    if (!groupedRefIds.length) {
      return {
        data: [],
        pagination: paginationOf(0, page, size),
      }
    }

    const refIds = groupedRefIds.map((g) => g.refId)
    const insights = this.toInsightsDocs(
      await this.aiInsightsRepository.listByRefIds(refIds),
    )
    const articleMap = await this.databaseService.getRefArticleMap(refIds)
    const insightsByRef = insights.reduce(
      (acc, ins) => {
        ;(acc[ins.refId] ||= []).push(ins)
        return acc
      },
      {} as Record<string, AIInsightsModel[]>,
    )
    const groupedData = refIds
      .map((refId: string) => {
        const article = articleMap[refId]
        if (!article) return null
        return { article, insights: insightsByRef[refId] || [] }
      })
      .filter(Boolean)
    return {
      data: groupedData,
      pagination: paginationOf(total, page, size),
    }
  }

  async getInsightsCandidates() {
    const { posts, notes } =
      await this.databaseService.findAllArticlesForAIText()
    const articleMap = buildRefArticleMap({ posts, notes, pages: [] })
    const refIds = Object.keys(articleMap)
    const insights = this.toInsightsDocs(
      await this.aiInsightsRepository.listByRefIds(refIds),
    )
    const countByRefId = insights.reduce(
      (acc, item) => {
        acc[item.refId] = (acc[item.refId] || 0) + 1
        return acc
      },
      {} as Record<string, number>,
    )

    return refIds.map((refId) => ({
      article: articleMap[refId],
      insightsCount: countByRefId[refId] || 0,
    }))
  }

  private async getRefArticles(docs: AIInsightsModel[]) {
    return this.databaseService.getRefArticleMap(docs.map((d) => d.refId))
  }

  async updateInsightsInDb(id: string, content: string) {
    const doc = this.toInsightsDoc(await this.aiInsightsRepository.findById(id))
    if (!doc)
      throw createAppException(AppErrorCode.CONTENT_NOT_FOUND_CANT_PROCESS)
    return this.toInsightsDoc(
      await this.aiInsightsRepository.updateContent(id, content),
    )
  }

  async deleteInsightsInDb(id: string) {
    await this.aiInsightsRepository.deleteById(id)
  }

  async deleteInsightsByArticleId(refId: string) {
    await this.aiInsightsRepository.deleteForRef(refId)
  }

  @OnEvent(BusinessEvents.POST_DELETE)
  @OnEvent(BusinessEvents.NOTE_DELETE)
  @OnEvent(BusinessEvents.PAGE_DELETE)
  async handleDeleteArticle(event: { id: string }) {
    await this.deleteInsightsByArticleId(event.id)
  }

  @OnEvent(BusinessEvents.POST_CREATE)
  @OnEvent(BusinessEvents.NOTE_CREATE)
  async handleCreateArticle(event: { id: string }) {
    const aiConfig = await this.configService.get('ai')
    if (
      !aiConfig.enableInsights ||
      !aiConfig.enableAutoGenerateInsightsOnCreate
    ) {
      return
    }

    const minLen = aiConfig.insightsMinTextLength ?? 0
    if (minLen > 0) {
      try {
        const { article } = await this.resolveArticleForInsights(event.id)
        if ((article.text?.length ?? 0) < minLen) {
          this.logger.debug(
            `AI auto insights skipped (text below threshold ${minLen}): article=${event.id}`,
          )
          return
        }
      } catch {
        return
      }
    }

    this.logger.log(`AI auto insights task created: article=${event.id}`)
    await this.aiTaskService.createInsightsTask({ refId: event.id })
  }

  @OnEvent(BusinessEvents.POST_UPDATE)
  @OnEvent(BusinessEvents.NOTE_UPDATE)
  async handleUpdateArticle(event: { id: string }) {
    const aiConfig = await this.configService.get('ai')
    if (
      !aiConfig.enableInsights ||
      !aiConfig.enableAutoGenerateInsightsOnUpdate
    ) {
      return
    }
    let article: ArticleForInsights
    try {
      const resolved = await this.resolveArticleForInsights(event.id)
      article = resolved.article
    } catch {
      return
    }
    const minLen = aiConfig.insightsMinTextLength ?? 0
    if (minLen > 0 && (article.text?.length ?? 0) < minLen) {
      this.logger.debug(
        `AI auto insights skipped (text below threshold ${minLen}): article=${event.id}`,
      )
      return
    }
    const newHash = this.computeContentHash(article.text)
    const existing = await this.aiInsightsRepository.findSourceForRef(event.id)
    if (!existing) return
    const stale = existing.hash !== newHash
    if (!stale) return
    this.logger.log(
      `AI auto insights task created (update): article=${event.id}`,
    )
    await this.aiTaskService.createInsightsTask({ refId: event.id })
  }
}
