/**
 * Language detection and per-language toolchain registry.
 *
 * Modeled after MegaLinter / Super-Linter's aggregator idea: every supported
 * language registers lint/format/test/profile command templates, and one
 * language-agnostic pipeline drives them. Adding a language = adding one
 * registry entry (or a user-supplied override in plugin config).
 * @module @deepseek-ai/dsh-code-review
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** A command template: executable + arguments. */
export interface ToolCommand {
  bin: string
  args: string[]
}

/** Profiler spec per language. */
export interface ProfileSpec {
  engine: 'v8-cpuprofile' | 'cprofile' | 'jfr' | 'xdebug' | 'pending'
  /** Wrapper command that produces a profile artifact, when applicable. */
  command?: ToolCommand
}

/** Full toolchain for one language. */
export interface Toolchain {
  language: string
  /** File extensions that mark source files of this language. */
  extensions: string[]
  /** Marker files whose presence in the project root signals this language. */
  markers: string[]
  lint?: ToolCommand
  format?: ToolCommand
  test?: ToolCommand
  profile: ProfileSpec
}

/** Built-in registry. Binaries resolve through `resolveBin` (project-local first). */
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

/** A toolchain with its own source (built-in vs user override). */
export interface ResolvedToolchain {
  toolchain: Toolchain
  /** Which tools actually resolve to a runnable binary in this project. */
  available: {
    lint: boolean
    format: boolean
    test: boolean
    profile: boolean
  }
}

/**
 * Detect which language(s) a project speaks, based on marker files in its
 * root. Returns built-in toolchains for every matched language (a project can
 * be polyglot).
 * @param projectDir - project root directory.
 * @returns matched toolchains.
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
 * Resolve an executable: project-local `node_modules/.bin/<bin>` first, then
 * any `bin` on PATH. Used so the pipeline prefers the project's own linter
 * versions.
 * @param projectDir - project root.
 * @param bin - bare binary name.
 * @returns absolute path when found in the project, otherwise the bare name.
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
 * Check which tools of a toolchain are actually runnable: project-local
 * `node_modules/.bin` first, then any directory on PATH (system tools like
 * `mvn`, `pytest` or `phpcs` never live in node_modules).
 * @param projectDir - project root.
 * @param toolchain - the toolchain to probe.
 * @returns availability flags.
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
