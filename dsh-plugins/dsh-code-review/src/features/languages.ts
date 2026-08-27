/**
 * 语言检测与按语言区分的工具链注册表。
 *
 * 借鉴 MegaLinter / Super-Linter 的聚合器思路：每种受支持的语言注册
 * lint/format/test/profile 命令模板，一条与语言无关的管线驱动它们。
 * 新增语言 = 新增一条注册表条目（或插件配置中的用户覆盖）。
 * @module @deepseek-ai/dsh-code-review
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 命令模板：可执行文件 + 参数。 */
export interface ToolCommand {
  bin: string
  args: string[]
}

/** 每种语言的剖析器规格。 */
export interface ProfileSpec {
  engine: 'v8-cpuprofile' | 'cprofile' | 'jfr' | 'xdebug' | 'pending'
  /** 产出剖析产物的包装命令（如适用）。 */
  command?: ToolCommand
}

/** 一种语言的完整工具链。 */
export interface Toolchain {
  language: string
  /** 标记该语言源文件的扩展名。 */
  extensions: string[]
  /** 项目根出现即代表该语言的标记文件。 */
  markers: string[]
  lint?: ToolCommand
  format?: ToolCommand
  test?: ToolCommand
  profile: ProfileSpec
}

/** 内置注册表。二进制通过 `resolveBin` 解析（项目本地优先）。 */
export const TOOLCHAINS: Toolchain[] = [
  {
    language: 'js-ts',
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'],
    markers: ['package.json'],
    lint: { bin: 'eslint', args: ['.', '--format', 'json', '--no-warn-ignored'] },
    format: { bin: 'prettier', args: ['--check', '.'] },
    test: { bin: 'vitest', args: ['run'] },
    profile: {
      engine: 'v8-cpuprofile',
      command: { bin: 'node', args: ['--cpu-prof', '--cpu-prof-dir=<profileDir>', '--cpu-prof-name=out.cpuprofile'] },
    },
  },
  {
    language: 'java',
    extensions: ['.java'],
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
    lint: { bin: 'checkstyle', args: ['-c', 'checkstyle.xml', '.'] },
    format: { bin: 'mvn', args: ['spotless:check'] },
    test: { bin: 'mvn', args: ['test'] },
    profile: {
      engine: 'jfr',
      command: { bin: 'java', args: ['-XX:StartFlightRecording=filename=<profileDir>/out.jfr,dumponexit=true,settings=profile'] },
    },
  },
  {
    language: 'python',
    extensions: ['.py'],
    markers: ['requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile'],
    lint: { bin: 'ruff', args: ['check', '.'] },
    format: { bin: 'black', args: ['--check', '.'] },
    test: { bin: 'pytest', args: ['-q'] },
    profile: {
      engine: 'cprofile',
      command: { bin: 'python3', args: ['-m', 'cProfile', '-o', '<profileDir>/out.prof'] },
    },
  },
  {
    language: 'php',
    extensions: ['.php'],
    markers: ['composer.json'],
    lint: { bin: 'phpcs', args: ['.'] },
    format: { bin: 'php-cs-fixer', args: ['fix', '--dry-run', '.'] },
    test: { bin: 'phpunit', args: ['--no-coverage'] },
    profile: {
      engine: 'xdebug',
      command: { bin: 'php', args: ['-d', 'xdebug.mode=profile', '-d', 'xdebug.output_dir=<profileDir>'] },
    },
  },
]

/** 一条工具链及其自身来源（内置 vs 用户覆盖）。 */
export interface ResolvedToolchain {
  toolchain: Toolchain
  /** 哪些工具在本项目实际解析为可运行的二进制。 */
  available: {
    lint: boolean
    format: boolean
    test: boolean
    profile: boolean
  }
}

/**
 * 探测项目说的是哪种语言，基于其根目录的标记文件。为每个匹配的语言
 * 返回内置工具链（一个项目可以是多语言的）。
 * @param projectDir - 项目根目录。
 * @returns 匹配到的工具链。
 */
export function detectToolchains(projectDir: string): Toolchain[] {
  const markers = safeReaddir(projectDir)
  const matched: Toolchain[] = []
  for (const chain of TOOLCHAINS) {
    if (chain.markers.some(marker => markers.includes(marker))) matched.push(chain)
  }
  return matched
}

/**
 * 解析可执行文件：优先项目本地 `node_modules/.bin/<bin>`，其次 PATH 上的
 * 任何 `bin`。用于让管线优先使用项目自己的 lint 工具版本。
 * @param projectDir - 项目根目录。
 * @param bin - 裸二进制名。
 * @returns 项目内找到时返回绝对路径，否则返回裸名。
 */
export function resolveBin(projectDir: string, bin: string): string {
  // .bin/vitest 是 #!/bin/sh shell 脚本：runCommand 直接 spawn 会把它当 JS 执行报错，
  // 必须解析到真实 JS 入口（vitest.mjs）——否则 vitest 输出为空、摘要解析必然失败。
  if (bin === 'vitest') {
    const mjs = join(projectDir, 'node_modules', 'vitest', 'vitest.mjs')
    if (existsSync(mjs)) return mjs
  }
  const local = join(projectDir, 'node_modules', '.bin', bin)
  if (existsSync(local)) return local
  return bin
}

/**
 * 检查工具链的哪些工具实际可运行：项目本地 `node_modules/.bin` 优先，
 * 其次 PATH 上的目录（系统工具如 `mvn`、`pytest` 或 `phpcs` 从不在
 * node_modules 里）。
 * @param projectDir - 项目根目录。
 * @param toolchain - 待探测的工具链。
 * @returns 可用性标志。
 */
export function probeToolchain(projectDir: string, toolchain: Toolchain): ResolvedToolchain['available'] {
  const onPath = (bin: string | undefined): boolean => {
    if (!bin) return false
    if (existsSync(join(projectDir, 'node_modules', '.bin', bin))) return true
    const pathDirs = (process.env.PATH ?? '').split(':')
    return pathDirs.some(dir => dir.length > 0 && existsSync(join(dir, bin)))
  }
  return {
    lint: onPath(toolchain.lint?.bin),
    format: onPath(toolchain.format?.bin),
    test: onPath(toolchain.test?.bin),
    profile: toolchain.profile.engine === 'v8-cpuprofile' || toolchain.profile.engine === 'cprofile',
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
