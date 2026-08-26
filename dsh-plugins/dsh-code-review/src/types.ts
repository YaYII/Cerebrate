/**
 * Shared data shapes for the dsh-code-review pipeline.
 *
 * Every tool emits these shapes and the report engine aggregates them, so the
 * whole pipeline is language-agnostic: the toolchain registry translates each
 * language's CLI output into these shapes (SARIF-inspired normalization).
 * @module @deepseek-ai/dsh-code-review
 */

/** Severity ladder: P0 blocks the gate outright, P1 blocks too, P2/P3 advisory. */
export type Severity = 'P0' | 'P1' | 'P2' | 'P3'

/** One normalized static-analysis finding. */
export interface Finding {
  /** Tool that produced the finding, e.g. `eslint`, `tsc`, `phpcs`. */
  tool: string
  severity: Severity
  /** Project-relative file path. */
  file: string
  line?: number
  column?: number
  /** Rule / diagnostic id, when the tool reports one. */
  rule?: string
  message: string
}

/** One benchmark sample. */
export interface BenchSample {
  run: number
  durationMs: number
  /** First sample is the cold start (module load / JIT warm-up) and is kept but excluded from aggregates. */
  coldStart?: boolean
}

/** Aggregated program-level benchmark result. */
export interface BenchResult {
  /** The command that was benchmarked, as invoked. */
  command: string
  /** Working directory the command ran in. */
  cwd: string
  iterations: number
  samples: BenchSample[]
  meanMs: number
  p50Ms: number
  p90Ms: number
  minMs: number
  maxMs: number
  /** Peak RSS across all runs, MB (Linux only; undefined elsewhere). */
  peakRssMb?: number
  /** Present when the command failed entirely. */
  error?: string
}

/** One hot function from a CPU profile. */
export interface ProfileEntry {
  functionName: string
  /** File URL or path the function lives in. */
  url: string
  line: number
  /** Self time (ms) — time spent inside this function, excluding callees. */
  selfMs: number
  selfPct: number
  /** Total time (ms) — self plus everything it calls. */
  totalMs: number
  totalPct: number
  calls: number
}

/** Function-level CPU profile result. */
export interface ProfileResult {
  /** Profile engine: `v8-cpuprofile`, `cprofile`, or `pending` (toolchain template ready, parser not wired). */
  engine: 'v8-cpuprofile' | 'cprofile' | 'pending'
  totalMs: number
  entries: ProfileEntry[]
  /** Human-readable note, e.g. the raw profiler command. */
  note?: string
}

/** Test-suite result. */
export interface TestResult {
  tool: string
  total: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  /** Statement/line coverage percentage when the runner reports it. */
  coveragePct?: number
  error?: string
}

/** One quality-gate check. */
export interface GateCheck {
  name: string
  pass: boolean
  detail: string
}

/** Quality-gate verdict. */
export interface GateResult {
  pass: boolean
  checks: GateCheck[]
}

/** A performance delta against the previous round's baseline. */
export interface PerfDelta {
  command: string
  prevP50Ms?: number
  nowP50Ms?: number
  /** Relative change in percent; positive = slower. */
  deltaPct?: number
}

/** The full aggregated report consumed by the report engine. */
export interface ReviewAggregate {
  round: number
  /** Project directory the review ran against (absolute). */
  project: string
  findings: Finding[]
  bench?: BenchResult
  profile?: ProfileResult
  test?: TestResult
  /** AI-assigned elegance score 0-100 (advisory, supplied by the preset). */
  eleganceScore?: number
  perfDeltas: PerfDelta[]
  gate: GateResult
  /** Human summary the AI attaches to the report. */
  summary?: string
}

/** Quality-gate thresholds. */
export interface GateThresholds {
  /** Minimum required pass rate for tests (0-1). */
  testPassRate: number
  /** Minimum coverage percent; 0 disables the check. */
  coverageThreshold: number
  /** Maximum allowed p50 regression vs baseline, percent. */
  perfRegressThresholdPct: number
  /** Minimum elegance score; 0 disables the check. */
  eleganceThreshold: number
}
