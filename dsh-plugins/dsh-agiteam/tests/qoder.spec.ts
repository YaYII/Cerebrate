/**
 * qoder-runner 单元测试 —— Qoder CLI 执行器。
 */

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { runQoderTask } from '../src/features/qoder-runner'

describe('qoder-runner（Qoder CLI 执行器）', () => {
  // 真实执行测试较慢（约 50s），默认跳过（设 QODER_E2E=1 时启用）
  const e2e = process.env.QODER_E2E === '1'
  it.skipIf(!e2e)('真实执行 qodercli 非交互任务（返回退出码与输出）', async () => {
    const run = await runQoderTask('只回复 OK 两个字', {
      cwd: '/tmp',
      timeoutMs: 120_000,
    })
    // qodercli 应成功执行（本机已安装）；退出码 0 且输出含 OK
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('OK')
    expect(run.timedOut).toBe(false)
    expect(run.durationMs).toBeGreaterThan(0)
  }, 150_000)

  // 超时强杀需要 qodercli 真实存在（1ms 超时 = 启动后立刻 SIGKILL 验证强杀路径）；
  // 本机未装 qodercli 时 spawn 即 ENOENT，超时语义无法验证，跳过（与 e2e 同条件）。
  const qoderAvailable = (() => {
    try {
      return spawnSync('qodercli', ['--version'], { stdio: 'ignore', timeout: 3000 }).status !== null
    } catch {
      return false
    }
  })()
  it.skipIf(!qoderAvailable)('超时强杀：任务超过 timeoutMs 返回 timedOut=true', async () => {
    const run = await runQoderTask('请写一篇 5000 字的文章', {
      cwd: '/tmp',
      timeoutMs: 1, // 1ms 必超时
    })
    expect(run.timedOut).toBe(true)
    expect(run.exitCode).toBeNull()
  }, 15_000)

  it('工作目录不存在时返回 spawn 错误（不抛异常）', async () => {
    const run = await runQoderTask('测试', {
      cwd: '/nonexistent-dir-xyz',
      timeoutMs: 5_000,
    })
    // spawn ENOENT 或 qodercli 自身报错，都应有退出码/错误信息而非抛异常
    expect(run.exitCode).not.toBe(0)
    expect(run.stderr.length > 0 || run.exitCode !== null).toBe(true)
  }, 15_000)
})
