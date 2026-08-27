/**
 * dsh-code-review 管线的共享数据形状。
 *
 * 每个工具都产出这些形状，报告引擎聚合它们，因此整条管线与语言无关：
 * 工具链注册表把每种语言的 CLI 输出归一化为这些形状（灵感来自 SARIF 归一化）。
 * @module @deepseek-ai/dsh-code-review
 */

/** 严重度阶梯：P0 直接阻塞门禁，P1 同样阻塞，P2/P3 为建议级。 */
export type Severity = 'P0' | 'P1' | 'P2' | 'P3'

/** 一条归一化的静态分析发现。 */
export interface Finding {
  /** 产出该发现的工具，如 `eslint`、`tsc`、`phpcs`。 */
  tool: string
  severity: Severity
  /** 相对项目的文件路径。 */
  file: string
  line?: number
  column?: number
  /** 工具报告的规则/诊断编号。 */
  rule?: string
  message: string
}

/** 一次基准采样。 */
export interface BenchSample {
  run: number
  durationMs: number
  /** 首个样本是冷启动（模块加载/JIT 预热），保留但不参与聚合。 */
  coldStart?: boolean
}

/** 聚合后的程序级基准结果。 */
export interface BenchResult {
  /** 被基准的命令（按调用时的写法）。 */
  command: string
  /** 命令运行的工作目录。 */
  cwd: string
  iterations: number
  samples: BenchSample[]
  meanMs: number
  p50Ms: number
  p90Ms: number
  minMs: number
  maxMs: number
  /** 全部运行中的内存峰值 RSS，MB（仅 Linux；其他平台无）。 */
  peakRssMb?: number
  /** 命令整体失败时携带原因。 */
  error?: string
}

/** CPU 剖析中的一个热点函数。 */
export interface ProfileEntry {
  functionName: string
  /** 函数所在的文件 URL 或路径。 */
  url: string
  line: number
  /** 自耗时（ms）——花在该函数内部（不含被调函数）的时间。 */
  selfMs: number
  selfPct: number
  /** 总耗时（ms）——自耗时加上它调用的所有东西。 */
  totalMs: number
  totalPct: number
  calls: number
}

/** 函数级 CPU 剖析结果。 */
export interface ProfileResult {
  /** 剖析引擎：`v8-cpuprofile`、`cprofile` 或 `pending`（工具链模板就绪但解析器未接）。 */
  engine: 'v8-cpuprofile' | 'cprofile' | 'pending'
  totalMs: number
  entries: ProfileEntry[]
  /** 人类可读备注，如原始剖析命令。 */
  note?: string
}

/** 测试套件结果。 */
export interface TestResult {
  tool: string
  total: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  /** 运行器报告语句/行覆盖率百分比时携带。 */
  coveragePct?: number
  error?: string
}

/** 一条质量门禁检查项。 */
export interface GateCheck {
  name: string
  pass: boolean
  detail: string
}

/** 质量门禁裁决。 */
export interface GateResult {
  pass: boolean
  checks: GateCheck[]
}

/** 与上一轮基线相比的性能增量。 */
export interface PerfDelta {
  command: string
  prevP50Ms?: number
  nowP50Ms?: number
  /** 相对变化百分比；正数 = 变慢。 */
  deltaPct?: number
}

/** 报告引擎消费的完整聚合结果。 */
export interface ReviewAggregate {
  round: number
  /** 审查所针对的项目目录（绝对路径）。 */
  project: string
  findings: Finding[]
  bench?: BenchResult
  profile?: ProfileResult
  test?: TestResult
  /** AI 评定的优雅性分数 0-100（建议级，由预设提供）。 */
  eleganceScore?: number
  perfDeltas: PerfDelta[]
  gate: GateResult
  /** AI 附加到报告的人类摘要。 */
  summary?: string
}

/** 质量门禁阈值。 */
export interface GateThresholds {
  /** 测试最低通过率（0-1）。 */
  testPassRate: number
  /** 最低覆盖率百分比；0 表示关闭该检查。 */
  coverageThreshold: number
  /** 相对基线允许的最大 p50 回归百分比。 */
  perfRegressThresholdPct: number
  /** 最低优雅性分数；0 表示关闭该检查。 */
  eleganceThreshold: number
}
