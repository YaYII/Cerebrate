/**
 * 状态存储砖块测试：纯状态变换 + 磁盘往返 + 损坏文件容错。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addContact,
  clearFailure,
  emptyState,
  indexMessage,
  isProcessed,
  loadState,
  markProcessed,
  MAX_DELIVERY_ATTEMPTS,
  recordFailure,
  saveState,
  upsertThread,
} from '../src/features/store'
import type { ThreadBinding } from '../src/features/thread'

/** 构造一条线程绑定。 */
function binding(patch: Partial<ThreadBinding> = {}): ThreadBinding {
  return {
    tag: 's7f3a',
    sessionId: 'mail-1',
    peer: 'a@b.com',
    subjectBase: '报价单',
    lastMessageId: '<tip@qq.com>',
    references: ['<tip@qq.com>'],
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    ...patch,
  }
}

/** 用例产生的临时目录，用后即删。 */
const temporaryDirs: string[] = []
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('纯状态变换', () => {
  it('写入线程时同步建立 Message-ID 索引（线程头兜底路由的依据）', () => {
    const state = emptyState()
    upsertThread(state, binding())
    expect(state.threads.s7f3a?.peer).toBe('a@b.com')
    expect(state.messageIndex['<tip@qq.com>']).toBe('s7f3a')
  })

  it('空 Message-ID 不建索引（避免污染路由表）', () => {
    const state = emptyState()
    indexMessage(state, '', 's7f3a')
    expect(Object.keys(state.messageIndex)).toHaveLength(0)
  })

  it('联系人去重且大小写不敏感', () => {
    const state = emptyState()
    addContact(state, 'Client@Corp.com')
    addContact(state, 'client@corp.com')
    expect(state.contacts).toEqual(['client@corp.com'])
  })

  it('UID 水位单调推进且去重', () => {
    const state = emptyState()
    markProcessed(state, 5)
    markProcessed(state, 3)
    markProcessed(state, 5)
    expect(state.lastUid).toBe(5)
    expect(state.processedUids).toEqual([5, 3])
    expect(isProcessed(state, 5)).toBe(true)
    expect(isProcessed(state, 4)).toBe(false)
  })
})

describe('磁盘往返', () => {
  it('保存后可原样读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-bridge-'))
    temporaryDirs.push(dir)
    const path = join(dir, 'nested', 'state.json')
    const state = emptyState()
    upsertThread(state, binding())
    addContact(state, 'client@corp.com')
    markProcessed(state, 12)
    saveState(path, state)

    const loaded = loadState(path)
    expect(loaded.threads.s7f3a?.sessionId).toBe('mail-1')
    expect(loaded.contacts).toEqual(['client@corp.com'])
    expect(loaded.lastUid).toBe(12)
  })

  it('文件缺失时返回空状态（不阻断插件启动）', () => {
    expect(loadState('/tmp/绝对不存在的路径/state.json').threads).toEqual({})
  })

  it('文件损坏时返回空状态而不是抛异常', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-bridge-'))
    temporaryDirs.push(dir)
    const path = join(dir, 'state.json')
    writeFileSync(path, '{ 这不是合法 JSON', 'utf8')
    expect(loadState(path).lastUid).toBe(0)
  })
})

describe('失败重试记录', () => {
  it('累计失败次数，达到上限后由调用方决定放弃', () => {
    const state = emptyState()
    expect(recordFailure(state, 42)).toBe(1)
    expect(recordFailure(state, 42)).toBe(2)
    expect(recordFailure(state, 42)).toBe(MAX_DELIVERY_ATTEMPTS)
  })

  it('处理成功后清除失败记录', () => {
    const state = emptyState()
    recordFailure(state, 42)
    clearFailure(state, 42)
    expect(recordFailure(state, 42)).toBe(1)
  })

  it('不同 UID 的失败记录互不影响', () => {
    const state = emptyState()
    recordFailure(state, 1)
    recordFailure(state, 1)
    expect(recordFailure(state, 2)).toBe(1)
  })
})
