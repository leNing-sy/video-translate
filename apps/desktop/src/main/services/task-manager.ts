/**
 * TaskManager：任务生命周期门面（CRUD / 通知 / 队列）。
 * 流水线实现见 translation-pipeline（深层模块）。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import dayjs from 'dayjs'
import { app, type BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { IpcChannels } from '../../shared/ipc'
import type {
  SubtitleBurnMode,
  TaskCreationSettings,
} from '../../shared/settings'
import {
  normalizeTaskRuntimeOptions,
  taskOptionsFromAppSettings,
} from '../../shared/task-options'
import {
  isBulkDeletableTaskStatus,
  normalizeTaskKind,
  type TaskKind,
  type TaskLog,
  type TaskOutputArtifacts,
  type TaskRuntimeOptions,
  TaskStatus,
  type TranscriptionSegment,
  type TranslationTask,
  type VideoFile,
} from '../../shared/types/video'
import {
  isProtectedDownloadCacheEntry,
  resolveDownloadCacheProtection,
} from '../utils/download-cache-protection'
import type { SubtitleColors } from '../utils/subtitle-artifacts'
import { ensureSenseVoiceModel } from './asr/model-downloader'
import { databaseManager } from './database/manager'
import { runDocumentPipeline } from './document-pipeline'
import { findBestPlatformSubtitle } from './download/platform-subtitles'
import {
  derivePlaceholderName,
  displayUrl,
  downloadVideo,
  validateVideoUrl,
} from './download/yt-dlp-downloader'
import { ffmpegProcessor } from './ffmpeg/processor'
import { ollamaClient } from './ollama/client'
import { getByokApiKey } from './secure-store'
import { tempWorkspace } from './temp-workspace'
import {
  burnHardSubtitlesStage,
  createAbortError,
  isAbortError,
  prepareBurnSubtitleFile,
  resolveSubtitleColors,
  runTranslationPipeline,
} from './translation-pipeline'
import {
  TaskRunCoordinator,
  type TaskRunRequest,
} from './task-run-coordinator'

export interface CreateTaskOptions extends Partial<TaskCreationSettings> {
  filePath: string
  sourceLanguage: string
  targetLanguage: string
  /** 默认字幕工作流 */
  kind?: TaskKind
}

export interface CreateUrlTaskOptions extends Partial<TaskCreationSettings> {
  url: string
  sourceLanguage: string
  targetLanguage: string
  kind?: TaskKind
}

function getDownloadsRoot(): string {
  return path.join(app.getPath('userData'), 'downloads')
}

async function fileLooksReady(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

export class TaskManager {
  private activeTasks = new Map<string, TranslationTask>()
  private mainWindow: BrowserWindow | null = null
  private tempLogs = new Map<string, TaskLog[]>()
  /** 补烧硬字幕流程使用的 AbortController；主任务运行实例使用 scheduledControllers。 */
  private abortControllers = new Map<string, AbortController>()
  private readonly MAX_CONCURRENT_TASKS = 3
  private readonly runCoordinator = new TaskRunCoordinator(
    this.MAX_CONCURRENT_TASKS
  )
  /** 每个主任务运行实例独立持有 controller，避免旧实例清掉新实例的 controller。 */
  private readonly scheduledControllers = new Map<
    string,
    { runId: string; controller: AbortController }
  >()

  constructor() {
    this.loadActiveTasks()
    void this.initializeServices()
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  private async initializeServices(): Promise<void> {
    try {
      const activeIds = [...this.activeTasks.keys()].filter(id => {
        const status = this.activeTasks.get(id)?.status
        return (
          status &&
          status !== TaskStatus.COMPLETED &&
          status !== TaskStatus.FAILED &&
          status !== TaskStatus.CANCELLED
        )
      })
      const stale = await tempWorkspace.cleanupStale(
        24 * 60 * 60 * 1000,
        activeIds
      )
      if (stale.removedEntries > 0) {
        console.log(
          `[Temp] 已清理 ${stale.removedEntries} 项残留缓存，释放约 ${stale.freedBytes} 字节`
        )
      }

      if (!(await ollamaClient.isRunning())) {
        await ollamaClient.startDaemon()
      }

      const asrReady = await ensureSenseVoiceModel(p => {
        if (p.stage === 'downloading' || p.stage === 'extracting') {
          console.log(`[ASR] ${p.message}`)
        }
      })
      if (!asrReady.available) {
        console.warn('SenseVoice 自动准备失败:', asrReady.error)
      }
    } catch (error) {
      console.error('服务初始化失败:', error)
    }
  }

  private addTaskLog(
    taskId: string,
    level: TaskLog['level'],
    message: string,
    details?: string
  ): void {
    const baseLog = {
      timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      level,
      message,
      details,
    }
    const log: TaskLog = { id: uuidv4(), ...baseLog }

    try {
      databaseManager.addTaskLog(taskId, baseLog)
    } catch (error: unknown) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? (error as { code?: string }).code
          : undefined
      if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        const cached = this.tempLogs.get(taskId) ?? []
        cached.push(log)
        this.tempLogs.set(taskId, cached)
      } else {
        console.error('保存日志失败:', error)
      }
    }

    const task = this.activeTasks.get(taskId)
    if (task) {
      task.logs = task.logs ?? []
      task.logs.push(log)
      this.notifyTaskUpdate(task)
    }
  }

  private resolveOptions(task: TranslationTask): TaskRuntimeOptions {
    return normalizeTaskRuntimeOptions(task.options)
  }

  async createTask(options: CreateTaskOptions): Promise<string> {
    const taskId = uuidv4()
    const runtime = taskOptionsFromAppSettings(options)
    const kind = normalizeTaskKind(options.kind)
    const isDocument = kind === 'document'

    try {
      this.addTaskLog(
        taskId,
        'info',
        isDocument ? '开始创建文稿任务' : '开始创建翻译任务',
        `文件路径: ${options.filePath}`
      )

      const stats = await fs.stat(options.filePath)
      if (!stats.isFile()) {
        throw new Error('文件不存在')
      }

      const videoInfo = await ffmpegProcessor.getVideoInfo(options.filePath)
      const videoFile: VideoFile = {
        id: uuidv4(),
        name: path.basename(options.filePath),
        path: options.filePath,
        size: stats.size,
        duration: videoInfo.duration,
        format: videoInfo.format,
        createdAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      }

      databaseManager.saveVideoFile(videoFile)

      const task: TranslationTask = {
        id: taskId,
        videoFile,
        kind,
        status: TaskStatus.PENDING,
        progress: 0,
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        options: runtime,
        segments: [],
        subtitles: [],
        logs: [],
        createdAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      }

      databaseManager.createTranslationTask(task)
      this.activeTasks.set(taskId, task)

      this.flushTempLogs(taskId, task)

      this.addTaskLog(
        taskId,
        'success',
        isDocument ? '文稿任务创建成功' : '翻译任务创建成功',
        isDocument
          ? `源语言: ${options.sourceLanguage}`
          : `源语言: ${options.sourceLanguage}, 目标语言: ${options.targetLanguage}`
      )

      this.notifyTaskUpdate(task)
      this.enqueueRun(taskId)

      return taskId
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.addTaskLog(taskId, 'error', '创建任务失败', message)
      this.activeTasks.delete(taskId)
      databaseManager.deleteTranslationTask(taskId)
      throw error
    }
  }

  /**
   * 从在线视频链接创建任务：先 yt-dlp 下载，再走同一套 ASR → 翻译 → 字幕流水线。
   */
  async createTaskFromUrl(options: CreateUrlTaskOptions): Promise<string> {
    const taskId = uuidv4()
    const runtime = taskOptionsFromAppSettings(options)
    const url = validateVideoUrl(options.url)
    const kind = normalizeTaskKind(options.kind)
    const isDocument = kind === 'document'

    try {
      this.addTaskLog(
        taskId,
        'info',
        isDocument ? '开始创建在线文稿任务' : '开始创建在线下载翻译任务',
        displayUrl(url)
      )

      const downloadDir = path.join(getDownloadsRoot(), taskId)
      await fs.mkdir(downloadDir, { recursive: true })

      // 占位路径：下载完成后会更新为真实文件
      const placeholderPath = path.join(downloadDir, '.pending')
      const videoFile: VideoFile = {
        id: uuidv4(),
        name: derivePlaceholderName(url),
        path: placeholderPath,
        size: 0,
        duration: 0,
        format: 'pending',
        createdAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        sourceUrl: url,
      }

      databaseManager.saveVideoFile(videoFile)

      const task: TranslationTask = {
        id: taskId,
        videoFile,
        kind,
        status: TaskStatus.PENDING,
        progress: 0,
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        options: runtime,
        sourceUrl: url,
        segments: [],
        subtitles: [],
        logs: [],
        createdAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      }

      databaseManager.createTranslationTask(task)
      this.activeTasks.set(taskId, task)
      this.flushTempLogs(taskId, task)

      this.addTaskLog(
        taskId,
        'success',
        '在线任务创建成功，等待下载',
        isDocument
          ? `源语言: ${options.sourceLanguage}`
          : `源语言: ${options.sourceLanguage}, 目标语言: ${options.targetLanguage}`
      )

      this.notifyTaskUpdate(task)
      this.enqueueRun(taskId)

      return taskId
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.addTaskLog(taskId, 'error', '创建在线任务失败', message)
      this.activeTasks.delete(taskId)
      databaseManager.deleteTranslationTask(taskId)
      throw error
    }
  }

  private flushTempLogs(taskId: string, task: TranslationTask): void {
    const cachedLogs = this.tempLogs.get(taskId)
    if (!cachedLogs) return
    for (const log of cachedLogs) {
      databaseManager.addTaskLog(taskId, {
        timestamp: log.timestamp,
        level: log.level,
        message: log.message,
        details: log.details,
      })
    }
    task.logs = cachedLogs
    this.tempLogs.delete(taskId)
  }

  private enqueueRun(taskId: string): void {
    const run = this.runCoordinator.enqueue(taskId)
    if (!run) return
    void this.drainQueue()
  }

  private async drainQueue(): Promise<void> {
    while (true) {
      const run = this.runCoordinator.takeNext()
      if (!run) return

      void this.processTask(run)
        .catch(error => {
          console.error('[TaskManager] 任务执行异常:', error)
        })
        .finally(() => {
          void this.drainQueue()
        })
    }
  }

  private async processTask(run: TaskRunRequest): Promise<void> {
    const { taskId } = run
    let controller: AbortController | undefined

    try {
      const task =
        this.activeTasks.get(taskId) ?? databaseManager.getTranslationTask(taskId)
      if (!task || !this.isCurrentRun(run)) {
        if (!task) console.error(`任务 ${taskId} 不存在`)
        return
      }

      // 排队期间已被暂停/删除则不再启动
      if (
        task.status === TaskStatus.PAUSED ||
        task.status === TaskStatus.CANCELLED
      ) {
        return
      }

      this.activeTasks.set(taskId, task)
      controller = new AbortController()
      this.scheduledControllers.set(taskId, {
        runId: run.runId,
        controller,
      })

      const options = this.resolveOptions(task)
      // 确保 options 已落库（旧任务 resume 时也会补写）
      task.options = options
      databaseManager.saveTaskOptions(taskId, options)

      if (!this.isCurrentRun(run)) return

      // 在线任务：先下载到本地，再进入对应流水线
      await this.ensureLocalVideoReady(task, run, controller.signal)
      if (!this.isCurrentRun(run)) return

      const hooks = {
        onLog: (level: TaskLog['level'], message: string, details?: string) => {
          this.addRunLog(run, level, message, details)
        },
        onStatus: (
          status: TaskStatus,
          progress?: number,
          errorMessage?: string
        ) => this.updateRunStatus(run, status, progress, errorMessage),
        onArtifacts: (artifacts: TaskOutputArtifacts) => {
          if (!this.isCurrentRun(run)) return
          const taskRef = this.activeTasks.get(taskId)
          if (taskRef) {
            taskRef.outputArtifacts = artifacts
          }
          databaseManager.saveTaskArtifacts(taskId, artifacts)
        },
        onSegments: (segments: TranscriptionSegment[]) => {
          if (!this.isCurrentRun(run)) return
          const taskRef = this.activeTasks.get(taskId)
          if (taskRef) taskRef.segments = segments
        },
        onDetectedLanguage: (language: TranslationTask['detectedLanguage']) => {
          if (!this.isCurrentRun(run)) return
          const taskRef = this.activeTasks.get(taskId)
          if (taskRef) {
            taskRef.detectedLanguage = language
            this.notifyTaskUpdate(taskRef)
          }
          databaseManager.saveDetectedLanguage(taskId, language)
        },
        resolveByokApiKey: () => getByokApiKey() ?? undefined,
      }

      if (normalizeTaskKind(task.kind) === 'document') {
        const context = await runDocumentPipeline(
          task,
          options,
          hooks,
          controller.signal
        )
        await this.finalizeTask(run, undefined, context.outputArtifacts)
      } else {
        const context = await runTranslationPipeline(
          task,
          options,
          hooks,
          controller.signal
        )
        await this.finalizeTask(
          run,
          context.subtitles,
          context.outputArtifacts
        )
      }
    } catch (error) {
      if (
        controller &&
        (isAbortError(error) || controller.signal.aborted)
      ) {
        const current = this.activeTasks.get(taskId)
        // pause 会预先设 PAUSED；若已立即 resume，则等待本次实例退出后再启动新实例。
        if (current?.status === TaskStatus.PAUSED) {
          this.addRunLog(run, 'warn', '任务已暂停')
        } else if (
          this.runCoordinator.hasPendingResume(taskId)
        ) {
          // resumeTask 已将状态设为 PENDING，不要让旧实例把它改回 CANCELLED。
        } else if (current && this.isCurrentRun(run)) {
          await this.updateRunStatus(run, TaskStatus.CANCELLED, undefined)
          this.addRunLog(run, 'warn', '任务已取消')
        }
      } else {
        await this.failTask(run, error)
      }
    } finally {
      const scheduled = this.scheduledControllers.get(taskId)
      if (scheduled?.runId === run.runId) {
        this.scheduledControllers.delete(taskId)
      }

      const finished = this.runCoordinator.finish(run)
      if (finished.resumeRequested) {
        const current = this.activeTasks.get(taskId)
        if (current?.status === TaskStatus.PENDING) {
          this.enqueueRun(taskId)
        }
      }
    }
  }

  private isCurrentRun(run: TaskRunRequest): boolean {
    return this.runCoordinator.isCurrent(run)
  }

  private addRunLog(
    run: TaskRunRequest,
    level: TaskLog['level'],
    message: string,
    details?: string
  ): void {
    if (!this.isCurrentRun(run)) return
    this.addTaskLog(run.taskId, level, message, details)
  }

  private async updateRunStatus(
    run: TaskRunRequest,
    status: TaskStatus,
    progress?: number,
    errorMessage?: string
  ): Promise<void> {
    if (!this.isCurrentRun(run)) return
    await this.updateTaskStatus(run.taskId, status, progress, errorMessage)
  }

  /**
   * 若任务带 sourceUrl 且本地文件未就绪，则用 yt-dlp 下载。
   * 重试时若文件仍在则跳过下载。
   */
  private async ensureLocalVideoReady(
    task: TranslationTask,
    run: TaskRunRequest,
    signal: AbortSignal
  ): Promise<void> {
    const sourceUrl = task.sourceUrl || task.videoFile.sourceUrl
    if (!sourceUrl || !this.isCurrentRun(run)) return

    const downloadDir = path.join(getDownloadsRoot(), task.id)

    if (
      task.videoFile.format !== 'pending' &&
      (await fileLooksReady(task.videoFile.path))
    ) {
      this.addRunLog(
        run,
        'info',
        '已存在本地下载文件，跳过重新下载',
        path.basename(task.videoFile.path)
      )
      // 仍尝试恢复/发现平台字幕（可能上次未写入 path 字段）
      await this.attachPlatformSubtitleIfPresent(task, downloadDir, run)
      return
    }

    await this.updateRunStatus(run, TaskStatus.DOWNLOADING, 0)
    this.addRunLog(
      run,
      'info',
      '开始下载在线视频（优先抓取平台字幕）',
      displayUrl(sourceUrl)
    )

    await fs.mkdir(downloadDir, { recursive: true })

    let lastLoggedPercent = -10
    const result = await downloadVideo({
      url: sourceUrl,
      outputDir: downloadDir,
      signal,
      sourceLanguage: task.sourceLanguage,
      targetLanguage: task.targetLanguage,
      writeSubtitles: true,
      onProgress: progress => {
        if (!this.isCurrentRun(run)) return
        const percent =
          progress.percent !== undefined
            ? Math.min(95, Math.max(0, progress.percent))
            : undefined
        if (percent !== undefined) {
          void this.updateRunStatus(
            run,
            TaskStatus.DOWNLOADING,
            Math.round(percent * 0.15) // 下载占整体约 0–15%
          )
          // 每跨约 10% 记一条日志，避免刷屏
          if (percent - lastLoggedPercent >= 10) {
            lastLoggedPercent = percent
            this.addRunLog(
              run,
              'info',
              `下载进度 ${percent.toFixed(0)}%`,
              progress.message
            )
          }
        }
      },
    })

    if (!this.isCurrentRun(run)) return

    let duration = 0
    let format = result.format
    try {
      const info = await ffmpegProcessor.getVideoInfo(result.videoPath)
      duration = info.duration
      format = info.format || result.format
    } catch (error) {
      this.addRunLog(
        run,
        'warn',
        '下载完成但读取视频信息失败，将使用默认元数据',
        error instanceof Error ? error.message : String(error)
      )
    }

    if (!this.isCurrentRun(run)) return

    const safeName = sanitizeDownloadedName(result.title, result.format)
    const videoFile: VideoFile = {
      ...task.videoFile,
      name: safeName,
      path: result.videoPath,
      size: result.size,
      duration,
      format,
      sourceUrl,
    }

    databaseManager.updateVideoFile(videoFile)
    task.videoFile = videoFile
    task.sourceUrl = sourceUrl

    if (result.platformSubtitle) {
      task.platformSubtitlePath = result.platformSubtitle.path
      task.platformSubtitleLanguage = result.platformSubtitle.language
      databaseManager.savePlatformSubtitle(
        task.id,
        result.platformSubtitle.path,
        result.platformSubtitle.language
      )
      this.addRunLog(
        run,
        'success',
        '已获取平台字幕，将跳过语音识别',
        `${result.platformSubtitle.language}` +
          (result.platformSubtitle.likelyAuto
            ? '（自动字幕）'
            : '（人工字幕）') +
          ` · ${path.basename(result.platformSubtitle.path)}`
      )
    } else {
      task.platformSubtitlePath = undefined
      task.platformSubtitleLanguage = undefined
      databaseManager.savePlatformSubtitle(task.id, null, null)
      this.addRunLog(
        run,
        'info',
        '未找到可用平台字幕，将使用本地 ASR 识别'
      )
    }

    this.activeTasks.set(task.id, task)
    this.notifyTaskUpdate(task)

    this.addRunLog(
      run,
      'success',
      '视频下载完成',
      `${safeName}（${formatFileSize(result.size)}）`
    )
    await this.updateRunStatus(run, TaskStatus.DOWNLOADING, 15)
  }

  /** 从下载目录恢复平台字幕路径（跳过重下时） */
  private async attachPlatformSubtitleIfPresent(
    task: TranslationTask,
    downloadDir: string,
    run: TaskRunRequest
  ): Promise<void> {
    if (!this.isCurrentRun(run)) return
    if (
      task.platformSubtitlePath &&
      (await fileLooksReady(task.platformSubtitlePath))
    ) {
      this.addRunLog(
        run,
        'info',
        '使用已缓存的平台字幕',
        path.basename(task.platformSubtitlePath)
      )
      return
    }

    const selected = await findBestPlatformSubtitle(downloadDir, {
      sourceLanguage: task.sourceLanguage,
      targetLanguage: task.targetLanguage,
    })
    if (!this.isCurrentRun(run)) return
    if (!selected) {
      task.platformSubtitlePath = undefined
      task.platformSubtitleLanguage = undefined
      databaseManager.savePlatformSubtitle(task.id, null, null)
      return
    }

    task.platformSubtitlePath = selected.path
    task.platformSubtitleLanguage = selected.language
    databaseManager.savePlatformSubtitle(
      task.id,
      selected.path,
      selected.language
    )
    this.activeTasks.set(task.id, task)
    this.notifyTaskUpdate(task)
    this.addRunLog(
      run,
      'success',
      '发现平台字幕，将跳过语音识别',
      `${selected.language} · ${path.basename(selected.path)}`
    )
  }

  private async finalizeTask(
    run: TaskRunRequest,
    subtitles?: TranslationTask['subtitles'],
    artifacts?: TaskOutputArtifacts
  ): Promise<void> {
    if (!this.isCurrentRun(run)) return
    const task = this.activeTasks.get(run.taskId)
    if (task && subtitles) {
      task.subtitles = subtitles
    }
    if (task && artifacts) {
      task.outputArtifacts = artifacts
      databaseManager.saveTaskArtifacts(run.taskId, artifacts)
    }

    this.addRunLog(run, 'success', '任务处理完成')
    await this.updateRunStatus(run, TaskStatus.COMPLETED, 100)
  }

  private async failTask(run: TaskRunRequest, error: unknown): Promise<void> {
    if (!this.isCurrentRun(run)) return
    const message = error instanceof Error ? error.message : String(error)
    this.addRunLog(run, 'error', '任务处理失败', message)
    await this.updateRunStatus(run, TaskStatus.FAILED, undefined, message)
    console.error(`任务 ${run.taskId} 处理失败:`, error)
  }

  private async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    progress?: number,
    errorMessage?: string
  ): Promise<void> {
    databaseManager.updateTaskStatus(taskId, status, progress, errorMessage)

    const task = this.activeTasks.get(taskId)
    if (task) {
      task.status = status
      if (progress !== undefined) task.progress = progress
      if (errorMessage !== undefined) task.errorMessage = errorMessage
      task.updatedAt = dayjs().format('YYYY-MM-DD HH:mm:ss')

      if (
        status === TaskStatus.COMPLETED ||
        status === TaskStatus.FAILED ||
        status === TaskStatus.CANCELLED
      ) {
        task.completedAt = dayjs().format('YYYY-MM-DD HH:mm:ss')
        // 完成后仍可从 DB 读取；内存 map 保留 completed 任务给 notify 一次
      }

      this.notifyTaskUpdate(task)

      if (
        status === TaskStatus.COMPLETED ||
        status === TaskStatus.FAILED ||
        status === TaskStatus.CANCELLED
      ) {
        this.activeTasks.delete(taskId)
      }
    }
  }

  private notifyTaskUpdate(task: TranslationTask): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // 产物以内存 / DB 一等字段为准，不再解析日志
      const fromDb = databaseManager.getTranslationTask(task.id)
      const payload: TranslationTask = {
        ...task,
        options: task.options ?? fromDb?.options,
        outputArtifacts: task.outputArtifacts ?? fromDb?.outputArtifacts,
      }
      this.mainWindow.webContents.send(IpcChannels.taskUpdated, payload)
    }
  }

  private loadActiveTasks(): void {
    const tasks = databaseManager.getAllTranslationTasks()
    for (const task of tasks) {
      // 仅恢复未完成任务到内存
      if (
        task.status !== TaskStatus.COMPLETED &&
        task.status !== TaskStatus.FAILED &&
        task.status !== TaskStatus.CANCELLED
      ) {
        this.activeTasks.set(task.id, task)
      }
    }
  }

  getAllTasks(kind?: TaskKind): TranslationTask[] {
    return databaseManager.getAllTranslationTasks(kind)
  }

  getTask(taskId: string): TranslationTask | null {
    const task =
      this.activeTasks.get(taskId) ?? databaseManager.getTranslationTask(taskId)
    if (!task) return null
    return { ...task, kind: normalizeTaskKind(task.kind) }
  }

  /** 读取文稿任务润色后的 Markdown 文本 */
  async getTaskMarkdownContent(
    taskId: string
  ): Promise<{
    success: boolean
    content?: string
    path?: string
    error?: string
  }> {
    const task = this.getTask(taskId)
    if (!task) {
      return { success: false, error: '任务不存在' }
    }
    if (normalizeTaskKind(task.kind) !== 'document') {
      return { success: false, error: '仅文稿任务可读取 Markdown' }
    }
    const mdPath = task.outputArtifacts?.polishedMarkdown
    if (!mdPath) {
      return { success: false, error: '文稿尚未生成' }
    }
    try {
      const content = await fs.readFile(mdPath, 'utf-8')
      return { success: true, content, path: mdPath }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: `读取文稿失败：${message}` }
    }
  }

  pauseTask(taskId: string): void {
    const task =
      this.activeTasks.get(taskId) ?? databaseManager.getTranslationTask(taskId)
    if (!task) return

    const activeRun = this.runCoordinator.pause(taskId)
    task.status = TaskStatus.PAUSED
    this.activeTasks.set(taskId, task)
    databaseManager.updateTaskStatus(taskId, TaskStatus.PAUSED)
    this.addTaskLog(taskId, 'info', '正在暂停任务…')
    this.notifyTaskUpdate(task)

    const scheduled = this.scheduledControllers.get(taskId)
    if (
      activeRun &&
      scheduled?.runId === activeRun.runId
    ) {
      scheduled.controller.abort(createAbortError('任务已暂停'))
    }
    // 补烧硬字幕仍使用独立 controller；保持原有暂停/取消行为。
    this.abortControllers
      .get(taskId)
      ?.abort(createAbortError('任务已暂停'))
  }

  resumeTask(taskId: string): void {
    const task =
      this.activeTasks.get(taskId) ?? databaseManager.getTranslationTask(taskId)
    if (!task) return
    if (
      task.status !== TaskStatus.PAUSED &&
      task.status !== TaskStatus.FAILED &&
      task.status !== TaskStatus.CANCELLED
    ) {
      return
    }

    task.status = TaskStatus.PENDING
    task.progress = 0
    task.errorMessage = undefined
    this.activeTasks.set(taskId, task)
    databaseManager.updateTaskStatus(taskId, TaskStatus.PENDING, 0, '')
    this.addTaskLog(taskId, 'info', '恢复任务（将重新执行流水线）')
    this.notifyTaskUpdate(task)
    this.runCoordinator.resume(taskId)
    void this.drainQueue()
  }

  deleteTask(taskId: string): void {
    const activeRun = this.runCoordinator.cancel(taskId)
    const scheduled = this.scheduledControllers.get(taskId)
    if (activeRun && scheduled?.runId === activeRun.runId) {
      scheduled.controller.abort(createAbortError('任务已删除'))
    }
    this.scheduledControllers.delete(taskId)
    this.abortControllers.get(taskId)?.abort(createAbortError('任务已删除'))
    this.abortControllers.delete(taskId)
    this.activeTasks.delete(taskId)
    this.tempLogs.delete(taskId)
    databaseManager.deleteTranslationTask(taskId)
    void tempWorkspace.removeTaskDir(taskId)
    // 清理在线任务下载缓存（本地上传源文件不删）
    void fs
      .rm(path.join(getDownloadsRoot(), taskId), {
        recursive: true,
        force: true,
      })
      .catch(() => {})

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IpcChannels.taskDeleted, taskId)
    }
  }

  async deleteTasks(taskIds: string[]): Promise<{
    deletedTaskIds: string[]
    rejected: Array<{ taskId: string; reason: string }>
  }> {
    const uniqueTaskIds = [...new Set(taskIds.filter(Boolean))]
    const deletedTaskIds: string[] = []
    const rejected: Array<{ taskId: string; reason: string }> = []

    for (const taskId of uniqueTaskIds) {
      const task =
        this.activeTasks.get(taskId) ??
        databaseManager.getTranslationTask(taskId)
      if (!task) {
        rejected.push({ taskId, reason: '任务不存在' })
        continue
      }
      if (!isBulkDeletableTaskStatus(task.status)) {
        rejected.push({ taskId, reason: '任务尚未结束，不能批量删除' })
        continue
      }

      const activeRun = this.runCoordinator.cancel(taskId)
      const scheduled = this.scheduledControllers.get(taskId)
      if (activeRun && scheduled?.runId === activeRun.runId) {
        scheduled.controller.abort(createAbortError('任务已删除'))
      }
      this.scheduledControllers.delete(taskId)
      this.abortControllers.get(taskId)?.abort(createAbortError('任务已删除'))
      this.abortControllers.delete(taskId)
      this.activeTasks.delete(taskId)
      this.tempLogs.delete(taskId)
      databaseManager.deleteTranslationTask(taskId)
      await tempWorkspace.removeTaskDir(taskId).catch(error => {
        console.warn(`清理任务临时缓存失败 (${taskId}):`, error)
      })
      await removeDownloadCachePreservingOutputs(task).catch(error => {
        console.warn(`清理任务下载缓存失败 (${taskId}):`, error)
      })
      deletedTaskIds.push(taskId)

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(IpcChannels.taskDeleted, taskId)
      }
    }

    return { deletedTaskIds, rejected }
  }

  retryTask(taskId: string): void {
    const task =
      this.activeTasks.get(taskId) ?? databaseManager.getTranslationTask(taskId)
    if (!task) return
    if (this.runCoordinator.hasActive(taskId)) return

    task.status = TaskStatus.PENDING
    task.progress = 0
    task.errorMessage = undefined
    task.segments = []
    task.subtitles = []
    this.activeTasks.set(taskId, task)
    databaseManager.updateTaskStatus(taskId, TaskStatus.PENDING, 0, '')
    this.addTaskLog(taskId, 'info', '重试任务')
    this.notifyTaskUpdate(task)
    this.enqueueRun(taskId)
  }

  getTaskLogs(taskId: string): TaskLog[] {
    return databaseManager.getTaskLogs(taskId)
  }

  getStatistics() {
    return databaseManager.getStatistics()
  }

  private getActiveProcessingTaskIds(): string[] {
    return [...this.activeTasks.entries()]
      .filter(
        ([, task]) =>
          task.status !== TaskStatus.COMPLETED &&
          task.status !== TaskStatus.FAILED &&
          task.status !== TaskStatus.PAUSED &&
          task.status !== TaskStatus.CANCELLED
      )
      .map(([id]) => id)
  }

  async getTempCacheStats() {
    return tempWorkspace.getStats()
  }

  async clearTempCache() {
    const keep = this.getActiveProcessingTaskIds()
    return tempWorkspace.clearCache(keep)
  }

  /**
   * 任务已完成后，按指定字幕模式补烧硬字幕。
   */
  async burnSubtitlesForTask(
    taskId: string,
    mode: SubtitleBurnMode,
    colors?: SubtitleColors | null
  ): Promise<{ success: boolean; burnedVideo?: string; error?: string }> {
    const existing = this.activeTasks.get(taskId)
    if (existing?.status === TaskStatus.BURNING_SUBTITLES) {
      return { success: false, error: '该任务正在烧录中' }
    }

    const task = existing ?? databaseManager.getTranslationTask(taskId)
    if (!task) {
      return { success: false, error: '任务不存在' }
    }

    if (normalizeTaskKind(task.kind) === 'document') {
      return { success: false, error: '文稿任务不支持烧录字幕' }
    }

    if (
      task.status !== TaskStatus.COMPLETED &&
      task.status !== TaskStatus.BURNING_SUBTITLES
    ) {
      return { success: false, error: '仅已完成的任务可以补烧硬字幕' }
    }

    if (!task.segments || task.segments.length === 0) {
      return { success: false, error: '任务没有可用的字幕段落' }
    }

    try {
      await fs.access(task.videoFile.path)
    } catch {
      return { success: false, error: '源视频文件不存在，无法烧录' }
    }

    this.activeTasks.set(taskId, task)
    let workDir: string | undefined
    const options = this.resolveOptions(task)
    const controller = new AbortController()
    this.abortControllers.set(taskId, controller)

    const hooks = {
      onLog: (level: TaskLog['level'], message: string, details?: string) =>
        this.addTaskLog(taskId, level, message, details),
      onStatus: (
        status: TaskStatus,
        progress?: number,
        errorMessage?: string
      ) => this.updateTaskStatus(taskId, status, progress, errorMessage),
      onArtifacts: (artifacts: TaskOutputArtifacts) => {
        task.outputArtifacts = artifacts
        databaseManager.saveTaskArtifacts(taskId, artifacts)
      },
      onSegments: (_segments: TranscriptionSegment[]) => {},
      onDetectedLanguage: () => {},
      resolveByokApiKey: () => getByokApiKey() ?? undefined,
    }

    try {
      await this.updateTaskStatus(taskId, TaskStatus.BURNING_SUBTITLES, 5)
      this.addTaskLog(taskId, 'info', '开始补烧硬字幕', `模式: ${mode}`)

      workDir = await tempWorkspace.ensureTaskDir(taskId)

      if (!(await ffmpegProcessor.isAvailable())) {
        throw new Error('FFmpeg 不可用，请先安装 FFmpeg')
      }

      const videoInfo = await ffmpegProcessor.getVideoInfo(task.videoFile.path)
      const videoSize = {
        width: videoInfo.width,
        height: videoInfo.height,
      }

      const burnSubtitlePath = await prepareBurnSubtitleFile(
        taskId,
        task.segments,
        mode,
        videoSize,
        workDir,
        colors ?? resolveSubtitleColors(options),
        hooks
      )

      await this.updateTaskStatus(taskId, TaskStatus.BURNING_SUBTITLES, 15)

      const burnedVideo = await burnHardSubtitlesStage(
        task,
        burnSubtitlePath,
        workDir,
        hooks,
        controller.signal,
        {
          progressStatus: TaskStatus.BURNING_SUBTITLES,
          progressBase: 15,
          progressSpan: 80,
        }
      )

      const artifacts = databaseManager.mergeTaskArtifacts(taskId, {
        burnedVideo,
        outputDirectory:
          task.outputArtifacts?.outputDirectory ||
          path.join(path.dirname(task.videoFile.path), 'output'),
      })
      task.outputArtifacts = artifacts

      await this.updateTaskStatus(taskId, TaskStatus.COMPLETED, 100, '')
      this.addTaskLog(taskId, 'success', '补烧硬字幕完成', `模式: ${mode}`)

      const updated = this.getTask(taskId)
      if (updated) this.notifyTaskUpdate(updated)

      return { success: true, burnedVideo }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.addTaskLog(taskId, 'error', '补烧硬字幕失败', message)
      try {
        await this.updateTaskStatus(taskId, TaskStatus.COMPLETED, 100)
      } catch {
        // ignore
      }
      const updated = this.getTask(taskId)
      if (updated) this.notifyTaskUpdate(updated)
      return { success: false, error: message }
    } finally {
      this.abortControllers.delete(taskId)
      if (workDir) {
        await tempWorkspace.removeTaskDir(taskId)
      }
      this.activeTasks.delete(taskId)
    }
  }

  cleanup(): void {
    this.runCoordinator.clearPending()
    for (const { controller } of this.scheduledControllers.values()) {
      controller.abort(createAbortError('应用退出'))
    }
    this.scheduledControllers.clear()
    for (const controller of this.abortControllers.values()) {
      controller.abort(createAbortError('应用退出'))
    }
    this.abortControllers.clear()
    this.activeTasks.clear()
  }
}

async function removeDownloadCachePreservingOutputs(
  task: TranslationTask
): Promise<void> {
  const taskRoot = path.resolve(getDownloadsRoot(), task.id)
  const downloadsRoot = path.resolve(getDownloadsRoot())
  if (
    taskRoot === downloadsRoot ||
    !taskRoot.startsWith(`${downloadsRoot}${path.sep}`)
  ) {
    throw new Error('任务下载缓存路径不安全，已停止清理')
  }

  const protection = resolveDownloadCacheProtection(taskRoot, task)
  if (protection.preserveRoot) return

  let entries: Array<{ name: string }> = []
  try {
    entries = await fs.readdir(taskRoot, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (isProtectedDownloadCacheEntry(protection, entry.name)) continue
    await fs.rm(path.join(taskRoot, entry.name), {
      recursive: true,
      force: true,
    })
  }

  if (protection.topLevelEntries.size === 0) {
    await fs.rm(taskRoot, { recursive: true, force: true })
  }
}
export const taskManager = new TaskManager()

function sanitizeDownloadedName(title: string, format: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  const base = cleaned || 'downloaded-video'
  const ext = format ? `.${format.replace(/^\./, '')}` : ''
  // 若标题已含扩展名则不再追加
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) {
    return base
  }
  return `${base}${ext}`
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  )
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
