export interface TaskRunRequest {
  taskId: string
  runId: string
}

export interface TaskRunFinishResult {
  accepted: boolean
  resumeRequested: boolean
}

/**
 * 管理任务运行实例的排队、并发槽位和暂停恢复衔接。
 * 任务本身的状态与 AbortController 仍由 TaskManager 负责。
 */
export class TaskRunCoordinator {
  private readonly queue: TaskRunRequest[] = []
  private readonly queuedTaskIds = new Set<string>()
  private readonly activeRuns = new Map<string, TaskRunRequest>()
  private readonly resumeAfterRun = new Set<string>()
  /** 已暂停或已删除的运行实例不能再写回任务状态。 */
  private readonly invalidatedRunIds = new Set<string>()
  private nextRunNumber = 0
  private readonly maxConcurrentRuns: number

  constructor(maxConcurrentRuns: number) {
    this.maxConcurrentRuns = maxConcurrentRuns
    if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
      throw new Error('并发任务数必须是正整数')
    }
  }

  enqueue(taskId: string): TaskRunRequest | undefined {
    if (this.queuedTaskIds.has(taskId) || this.activeRuns.has(taskId)) {
      return undefined
    }

    const run = {
      taskId,
      runId: `${taskId}:${++this.nextRunNumber}`,
    }
    this.queue.push(run)
    this.queuedTaskIds.add(taskId)
    return run
  }

  takeNext(): TaskRunRequest | undefined {
    if (this.activeRuns.size >= this.maxConcurrentRuns) return undefined

    const run = this.queue.shift()
    if (!run) return undefined

    this.queuedTaskIds.delete(run.taskId)
    this.activeRuns.set(run.taskId, run)
    return run
  }

  /**
   * 暂停任务：运行中的实例由调用方负责 abort；排队中的实例直接移除。
   * 当前运行实例从这一刻起失去写回资格，避免 abort 期间的迟到回调覆盖暂停状态。
   */
  pause(taskId: string): TaskRunRequest | undefined {
    this.resumeAfterRun.delete(taskId)
    const activeRun = this.activeRuns.get(taskId)
    if (activeRun) {
      this.invalidatedRunIds.add(activeRun.runId)
      return activeRun
    }

    this.removeQueued(taskId)
    return undefined
  }

  /**
   * 请求恢复。若旧实例尚未退出，只记录恢复意图，避免重复启动。
   */
  resume(taskId: string): 'deferred' | 'queued' {
    if (this.activeRuns.has(taskId)) {
      this.resumeAfterRun.add(taskId)
      return 'deferred'
    }

    this.enqueue(taskId)
    return 'queued'
  }

  /** 删除任务：移除排队项；运行中的实例保留到 finally 释放槽位。 */
  cancel(taskId: string): TaskRunRequest | undefined {
    this.resumeAfterRun.delete(taskId)
    this.removeQueued(taskId)
    const activeRun = this.activeRuns.get(taskId)
    if (activeRun) {
      this.invalidatedRunIds.add(activeRun.runId)
    }
    return activeRun
  }

  /** 清除尚未启动的任务，并让当前运行实例停止向外写回。 */
  clearPending(): void {
    this.queue.length = 0
    this.queuedTaskIds.clear()
    this.resumeAfterRun.clear()
    for (const run of this.activeRuns.values()) {
      this.invalidatedRunIds.add(run.runId)
    }
  }

  finish(run: TaskRunRequest): TaskRunFinishResult {
    const activeRun = this.activeRuns.get(run.taskId)
    if (!activeRun || activeRun.runId !== run.runId) {
      return { accepted: false, resumeRequested: false }
    }

    this.activeRuns.delete(run.taskId)
    this.invalidatedRunIds.delete(run.runId)
    const resumeRequested = this.resumeAfterRun.delete(run.taskId)
    return { accepted: true, resumeRequested }
  }

  /** 当前运行实例仍然存在且尚未被暂停、删除或应用退出作废。 */
  isCurrent(run: TaskRunRequest): boolean {
    return (
      this.activeRuns.get(run.taskId)?.runId === run.runId &&
      !this.invalidatedRunIds.has(run.runId)
    )
  }

  hasPendingResume(taskId: string): boolean {
    return this.resumeAfterRun.has(taskId)
  }

  hasActive(taskId: string): boolean {
    return this.activeRuns.has(taskId)
  }

  get activeCount(): number {
    return this.activeRuns.size
  }

  get queuedCount(): number {
    return this.queue.length
  }

  private removeQueued(taskId: string): void {
    if (!this.queuedTaskIds.delete(taskId)) return

    for (let index = this.queue.length - 1; index >= 0; index--) {
      if (this.queue[index].taskId === taskId) {
        this.queue.splice(index, 1)
      }
    }
  }
}
