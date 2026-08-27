/**
 * Obsidian 自愈启动器：REST API 不可达时拉起本地 Obsidian 实例。
 *
 * 本插件自持依赖——不依赖手动配置的 systemd 服务或会话终端（重启可能
 * 杀掉它们）。子进程 detached（独立进程组），父进程最多等待
 * launchTimeoutMs 让 API 就绪；任何失败降级为警告（绝不崩溃），插件仍能
 * 为 Brain 知识工具正常加载。
 * @module @deepseek-ai/dsh-obsidian
 */

import os from 'node:os'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { probeObsidian } from './obsidian'
import type { ClientConfig } from './rest'

/**
 * 判断本机是否已有 Obsidian 实例在运行。Electron 按用户数据目录
 * 单实例——已存在时再拉起第二个主进程是浪费（还可能留下多进程竞争）。
 * 检测途径：(a) 匹配的主进程命令行；(b) Electron 落在用户数据目录的
 * SingletonLock 文件。任一存在 => 实例存在。
 * @param binPath - Obsidian 可执行文件路径。
 * @returns 实例已存在时为 true。
 */
export function obsidianProcessExists(binPath: string): boolean {
  try {
    const list = readdirSync('/proc').filter(n => /^\d+$/.test(n))
    if (list.includes(String(process.pid))) list.splice(list.indexOf(String(process.pid)), 1)
    for (const pid of list) {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
        // 精确匹配主进程：可执行文件自己的 argv[0] 是我们的 obsidian 二进制
        // （独立 token/路径），而不是命令行里任意提及 "obsidian" 的地方
        // （例如恰好引用该路径的 node 脚本）。Electron 子渲染进程带 --type=
        // 会被跳过；只有根主进程是单实例持有者。
        const argv0 = cmd.split(' ')[0] ?? ''
        const isMain = !cmd.includes('--type=')
        const exact = argv0 === binPath || argv0 === binPath.split('/').pop()
        if (exact && isMain) return true
      } catch { /* 进程已消失 */ }
    }
  } catch { /* procfs 不可用 */ }
  return false
}

/**
 * 检查 Obsidian 落在用户数据目录的 Electron 单实例标记。
 * 锁名内嵌主机名；按 Singleton 前缀匹配。
 */
export function obsidianSingletonLockExists(): boolean {
  const conf = `${os.homedir()}/.config/obsidian`
  try {
    return readdirSync(conf).some(n => n.startsWith('Singleton'))
  } catch {
    return false
  }
}

/**
 * 自愈入口：REST API 不可达时拉起本地 Obsidian，让团队知识库文件层保持
 * 可用。插件 apply 时调用；fire-and-forget，工具注册从不被慢启动阻塞。
 * @param config - 连接配置（baseUrl/autoStart/obsidianBin/launchTimeoutMs）。
 */
export async function ensureObsidianRunning(config: ClientConfig & { autoStart: boolean; obsidianBin: string; launchTimeoutMs: number }): Promise<void> {
  if (!config.autoStart) return
  // 快路径：REST 已可达。
  if (await probeObsidian(config)) return
  // Obsidian 主进程（或其 Electron 单实例锁）已存在：绝不拉起第二个实例——
  // 等待现有实例服务 API。
  const instanceExists = obsidianProcessExists(config.obsidianBin) || obsidianSingletonLockExists()
  if (instanceExists) {
    console.log('[dsh-obsidian] Obsidian instance already present; waiting for REST API (no new spawn)')
    const waiting = Date.now() + config.launchTimeoutMs
    while (Date.now() < waiting) {
      await new Promise(r => setTimeout(r, 1500))
      if (await probeObsidian(config)) {
        console.log('[dsh-obsidian] Obsidian REST API is up')
        return
      }
    }
    console.warn('[dsh-obsidian] existing Obsidian instance did not serve the API within', config.launchTimeoutMs, 'ms')
    return
  }
  if (!existsSync(config.obsidianBin)) {
    console.warn('[dsh-obsidian] Obsidian unreachable and binary not found:', config.obsidianBin)
    return
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPLAY: process.env.DISPLAY ?? ':0',
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? 'wayland-0',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${os.userInfo().uid ?? ''}`,
    HOME: os.homedir(),
  }
  // 解析正在运行的 Wayland/Xorg 会话中的 X11 认证 cookie。
  const runDir = `/run/user/${os.userInfo().uid ?? ''}`
  let xauth = process.env.XAUTHORITY ?? ''
  if (!xauth || !existsSync(xauth)) {
    try {
      const match = readdirSync(runDir).find(n => n.startsWith('.mutter-Xwaylandauth'))
      if (match) xauth = `${runDir}/${match}`
    } catch { /* 无运行目录 */ }
  }
  if (!xauth) {
    console.warn('[dsh-obsidian] no XAUTHORITY found; launching headless is not possible')
    return
  }
  env.XAUTHORITY = xauth
  console.log('[dsh-obsidian] starting Obsidian:', config.obsidianBin)
  const child = spawn(config.obsidianBin, ['--no-sandbox'], {
    env,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  // 等待 REST API 就绪。
  const deadline = Date.now() + config.launchTimeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500))
    if (await probeObsidian(config)) {
      console.log('[dsh-obsidian] Obsidian REST API is up')
      return
    }
  }
  console.warn('[dsh-obsidian] Obsidian did not serve the API within', config.launchTimeoutMs, 'ms')
}
