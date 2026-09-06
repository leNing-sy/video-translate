import { describe, expect, it } from 'vitest'
import { TaskRunCoordinator } from './task-run-coordinator'

describe('TaskRunCoordinator', () => {
  it('最多同时占用三个并发槽位，并在完成后补位', () => {
    const coordinator = new TaskRunCoordinator(3)
    for (const taskId of ['a', 'b', 'c', 'd', 'e']) {
      expect(coordinator.enqueue(taskId)).toBeDefined()
    }

    const first = coordinator.takeNext()
    const second = coordinator.takeNext()
    const third = coordinator.takeNext()

    expect([first?.taskId, second?.taskId, third?.taskId]).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(coordinator.activeCount).toBe(3)
    expect(coordinator.queuedCount).toBe(2)
    expect(coordinator.takeNext()).toBeUndefined()

    expect(coordinator.finish(second!)).toEqual({
      accepted: true,
      resumeRequested: false,
    })
    expect(coordinator.takeNext()?.taskId).toBe('d')
    expect(coordinator.activeCount).toBe(3)
  })

  it('失败实例释放槽位后也会补位', () => {
    const coordinator = new TaskRunCoordinator(1)
    const first = coordinator.enqueue('first')!
    const second = coordinator.enqueue('second')!
    expect(coordinator.takeNext()).toEqual(first)
    expect(coordinator.queuedCount).toBe(1)

    expect(coordinator.finish(first)).toEqual({
      accepted: true,
      resumeRequested: false,
    })
    expect(coordinator.takeNext()).toEqual(second)
  })

  it('同一任务在运行或排队时不会重复入队', () => {
    const coordinator = new TaskRunCoordinator(2)
    const first = coordinator.enqueue('same')
    expect(coordinator.enqueue('same')).toBeUndefined()
    expect(coordinator.takeNext()).toEqual(first)
    expect(coordinator.enqueue('same')).toBeUndefined()
    expect(coordinator.activeCount).toBe(1)
    expect(coordinator.queuedCount).toBe(0)
  })

  it('暂停排队任务后不会启动，恢复时才重新入队', () => {
    const coordinator = new TaskRunCoordinator(1)
    const running = coordinator.enqueue('running')!
    coordinator.enqueue('queued')
    coordinator.takeNext()

    expect(coordinator.pause('queued')).toBeUndefined()
    expect(coordinator.takeNext()).toBeUndefined()

    expect(coordinator.resume('queued')).toBe('queued')
    coordinator.finish(running)
    expect(coordinator.takeNext()?.taskId).toBe('queued')
  })

  it('运行任务暂停后立即恢复，会等待旧实例结束再启动一个新实例', () => {
    const coordinator = new TaskRunCoordinator(1)
    const first = coordinator.enqueue('same')!
    expect(coordinator.takeNext()).toEqual(first)

    expect(coordinator.pause('same')).toEqual(first)
    expect(coordinator.isCurrent(first)).toBe(false)
    expect(coordinator.resume('same')).toBe('deferred')
    expect(coordinator.takeNext()).toBeUndefined()

    expect(coordinator.finish(first)).toEqual({
      accepted: true,
      resumeRequested: true,
    })
    const second = coordinator.enqueue('same')!
    expect(second.runId).not.toBe(first.runId)
    expect(coordinator.takeNext()).toEqual(second)
    expect(coordinator.isCurrent(second)).toBe(true)
  })

  it('删除运行任务后旧实例不能再写回，也不会触发恢复', () => {
    const coordinator = new TaskRunCoordinator(1)
    const run = coordinator.enqueue('deleted')!
    expect(coordinator.takeNext()).toEqual(run)

    expect(coordinator.cancel('deleted')).toEqual(run)
    expect(coordinator.isCurrent(run)).toBe(false)
    expect(coordinator.finish(run)).toEqual({
      accepted: true,
      resumeRequested: false,
    })
    expect(coordinator.takeNext()).toBeUndefined()
  })

  it('旧实例的重复 finish 不会影响新实例', () => {
    const coordinator = new TaskRunCoordinator(1)
    const first = coordinator.enqueue('same')!
    expect(coordinator.takeNext()).toEqual(first)
    expect(coordinator.finish(first).accepted).toBe(true)

    const second = coordinator.enqueue('same')!
    expect(coordinator.takeNext()).toEqual(second)
    expect(coordinator.finish(first)).toEqual({
      accepted: false,
      resumeRequested: false,
    })
    expect(coordinator.isCurrent(second)).toBe(true)
  })

  it('清理时清空排队任务并让运行实例失去写回资格', () => {
    const coordinator = new TaskRunCoordinator(2)
    const running = coordinator.enqueue('running')!
    coordinator.enqueue('queued')
    expect(coordinator.takeNext()).toEqual(running)

    coordinator.clearPending()
    expect(coordinator.queuedCount).toBe(0)
    expect(coordinator.isCurrent(running)).toBe(false)
  })
})
