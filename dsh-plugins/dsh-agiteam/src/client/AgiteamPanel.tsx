/**
 * dsh-agiteam 控制面板 —— 右下角胶囊开关 + 右侧全高侧栏。
 *
 * 视图：
 *  1. 项目列表（各项目阶段/进度）
 *  2. 追溯矩阵（需求→功能→用例→单测→代码→验收脚本 一行式追溯）
 *  3. 审计日志（追加式链式哈希，防篡改）
 *  4. 多层校验（数学/脚本/日志 三层结果）
 *  5. 阶段进度（9 阶段状态机可视化）
 *
 * 数据：1s 轮询 host /plugins/agiteam/state（cache:no-store）。
 * 原则：UI 只管显示，功能内核实现。
 */

import { useEffect, useMemo, useState } from 'react'

/** 快照轮询周期（ms）。 */
const POLL_MS = 1000
/** host 状态快照路由。 */
const STATE_URL = '/plugins/agiteam/state'
/** 审计动作端点。 */
const AUDIT_URL = '/plugins/agiteam/audit'
/** 校验端点。 */
const VERIFY_URL = '/plugins/agiteam/verify'
/** 任务板端点。 */
const BOARD_URL = '/plugins/agiteam/tasks'

/** 侧栏展开时对话区让位（body 属性）。 */
const PANEL_DOCKED_ATTRIBUTE = 'data-agiteam-docked'

/** 追溯矩阵行（与 host 快照对齐）。 */
interface TraceRowView {
  requirementId: string
  requirementTitle: string
  featureId: string
  featureName: string
  testCaseIds: string[]
  unitTestIds: string[]
  codeFiles: string[]
  acceptanceScripts: string[]
  status: 'passed' | 'failed' | 'pending'
}

/** 审计条目视图。 */
interface AuditEntryView {
  seq: number
  time: number
  action: string
  role: string
  stage: string
  detail: string
  fingerprint?: string
  hash: string
}

/** 项目追溯快照（host /state 返回）。 */
interface TraceSnapshot {
  projectId: string
  projectName: string
  stage: string
  requirements: Array<{ id: string; title: string; priority: string }>
  features: Array<{ id: string; name: string; requirementIds: string[] }>
  testcases: Array<{ id: string; featureId: string; title: string; kind: string }>
  unitTests: Array<{ id: string; testCaseId: string; title: string; filePath: string; status: string }>
  codeFiles: Array<{ id: string; featureId: string; path: string }>
  acceptanceScripts: Array<{ id: string; featureId: string; path: string; kind: string; status: string; logFile?: string }>
  traceRows: TraceRowView[]
  auditLog: AuditEntryView[]
  verification: {
    mathPass: boolean
    scriptPass: boolean
    logPass: boolean
    details: string[]
  }
  reviewComments: Record<string, string[]>
  updatedAt: number
}

/** 项目列表项。 */
interface ProjectItem {
  projectId: string
  projectName: string
  stage: string
}

/** 任务板条目。 */
interface BoardTaskView {
  id: string
  stage: string
  title: string
  role: string
  status: string
  sessionId: string
  approvalSuggestion: string
  reviewComment: string
  pausedByHuman: boolean
  pauseReason: string
  result: string
  updatedAt: number
}

/** 任务板快照。 */
interface BoardSnapshot {
  projectId: string
  projectName: string
  stage: string
  tasks: BoardTaskView[]
}

/** 任务状态中文名。 */
const TASK_STATUS_NAMES: Record<string, string> = {
  open: '待处理',
  claimed: '已认领',
  in_progress: '进行中',
  in_review: '待审批',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  rejected: '已打回',
}

/** 任务状态 CSS 类。 */
function taskStatusClass(status: string): string {
  return status
}

/** 阶段中文名。 */
const STAGE_NAMES: Record<string, string> = {
  requirement: '需求分析',
  'req-review': '需求评审',
  product: '产品设计',
  'product-review': '产品评审',
  testcase: '测试用例设计',
  'testcase-review': '测试用例评审',
  develop: '正式开发',
  'feature-accept': '逐功能验收',
  'e2e-accept': '端到端验收',
  done: '交付',
}

/** 相对时间。 */
function relTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 阶段状态图标。 */
function stageIcon(stage: string): string {
  if (stage === 'done') return '✓'
  if (stage === 'feature-accept' || stage === 'e2e-accept') return '🧪'
  if (stage.includes('review')) return '🔍'
  return '●'
}

/** 主面板。 */
export function AgiteamPanel({ openSession }: { openSession: (id: string) => Promise<void> }) {
  const [snapshot, setSnapshot] = useState<TraceSnapshot | null>(null)
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'projects' | 'board' | 'matrix' | 'audit' | 'verify'>('projects')
  const [selected, setSelected] = useState<string>('')
  const [verifyResult, setVerifyResult] = useState<string>('')
  const [board, setBoard] = useState<BoardSnapshot | null>(null)

  // 轮询项目列表 + 选中项目快照 + 任务板
  useEffect(() => {
    let cancelled = false
    let inFlight = false
    const tick = async () => {
      if (inFlight || cancelled) return
      inFlight = true
      try {
        // 项目列表
        const listRes = await fetch(STATE_URL, { cache: 'no-store' })
        if (listRes.ok) {
          const data = await listRes.json()
          if (data.projects) setProjects(data.projects)
          // 默认选中第一个
          if (!selected && data.projects?.length > 0) {
            setSelected(data.projects[0].projectId)
          }
        }
        // 选中项目快照
        if (selected) {
          const res = await fetch(`${STATE_URL}?project=${encodeURIComponent(selected)}`, { cache: 'no-store' })
          if (res.ok) setSnapshot(await res.json())
          // 任务板
          const boardRes = await fetch(`${BOARD_URL}?project=${encodeURIComponent(selected)}`, { cache: 'no-store' })
          if (boardRes.ok) setBoard(await boardRes.json())
        }
      } catch {
        // host 重启中，保留上次快照
      } finally {
        inFlight = false
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [selected])

  // 展开时对话区让位
  useEffect(() => {
    const root = document.documentElement
    if (open) root.setAttribute(PANEL_DOCKED_ATTRIBUTE, '')
    else root.removeAttribute(PANEL_DOCKED_ATTRIBUTE)
    return () => { root.removeAttribute(PANEL_DOCKED_ATTRIBUTE) }
  }, [open])

  // 触发多层校验
  const runVerify = async () => {
    if (!selected) return
    try {
      const res = await fetch(`${VERIFY_URL}?project=${encodeURIComponent(selected)}`, { cache: 'no-store' })
      const data = await res.json()
      const v = data.verification
      const passed = data.traceAllPassed ? '✅ 追溯矩阵全部通过' : '⚠️ 追溯矩阵未全部通过'
      setVerifyResult(`${passed}\n数学层: ${v.mathPass ? '✅' : '❌'} | 脚本层: ${v.scriptPass ? '✅' : '❌'} | 日志层: ${v.logPass ? '✅' : '❌'}`)
    } catch {
      setVerifyResult('校验请求失败')
    }
  }

  const busy = snapshot?.stage !== 'done' && snapshot !== null
  const current = snapshot

  return (
    <div>
      <button
        type="button"
        className="agiteam-pill"
        data-open={open}
        onClick={() => setOpen(v => !v)}
        aria-label="AGI 团队开发面板"
        title={open ? '收起面板' : '展开面板'}
      >
        <span className="agiteam-pill-dot" data-busy={busy} aria-hidden="true" />
        AGI 团队
      </button>
      {open && (
        <aside className="agiteam-sidebar">
          <header className="agiteam-head">
            <span className="agiteam-title">
              AGI 团队开发
              <span className="agiteam-dot" data-busy={busy} aria-hidden="true" />
            </span>
            <button type="button" className="agiteam-icon-btn" onClick={() => setOpen(false)} aria-label="关闭">✕</button>
          </header>

          <nav className="agiteam-nav" aria-label="AGI 团队开发面板">
            <NavItem active={tab === 'projects'} icon="📋" label="项目" onClick={() => setTab('projects')} />
            <NavItem active={tab === 'board'} icon="🗂️" label="任务板" count={board?.tasks.filter(t => t.status === 'in_review').length ?? 0} onClick={() => setTab('board')} />
            <NavItem active={tab === 'matrix'} icon="🔗" label="追溯矩阵" onClick={() => setTab('matrix')} />
            <NavItem active={tab === 'audit'} icon="📜" label="审计日志" count={current?.auditLog.length ?? 0} onClick={() => setTab('audit')} />
            <NavItem active={tab === 'verify'} icon="🛡️" label="校验" onClick={() => setTab('verify')} />
          </nav>

          <div className="agiteam-content">
            {tab === 'projects' && (
              <ProjectsView projects={projects} selected={selected} onSelect={setSelected} current={current} />
            )}
            {tab === 'board' && (
              <BoardView board={board} selected={selected} onOpenSession={openSession} />
            )}
            {tab === 'matrix' && current && (
              <MatrixView snapshot={current} onOpenSession={openSession} />
            )}
            {tab === 'matrix' && !current && <EmptyState text="请先在「项目」页选择项目" />}
            {tab === 'audit' && current && <AuditView snapshot={current} />}
            {tab === 'audit' && !current && <EmptyState text="请先在「项目」页选择项目" />}
            {tab === 'verify' && (
              <VerifyView current={current} verifyResult={verifyResult} onVerify={runVerify} />
            )}
          </div>
        </aside>
      )}
    </div>
  )
}

/** 竖向导航项。 */
function NavItem({ active, icon, label, count, onClick }: {
  active: boolean
  icon: string
  label: string
  count?: number
  onClick: () => void
}) {
  return (
    <button type="button" className="agiteam-nav-item" data-active={active} onClick={onClick} title={label}>
      <span className="agiteam-nav-icon" aria-hidden="true">{icon}</span>
      <span className="agiteam-nav-label">{label}</span>
      {count !== undefined && count > 0 && <span className="agiteam-nav-count">{count}</span>}
    </button>
  )
}

/** 项目列表视图。 */
function ProjectsView({ projects, selected, onSelect, current }: {
  projects: ProjectItem[]
  selected: string
  onSelect: (id: string) => void
  current: TraceSnapshot | null
}) {
  if (projects.length === 0) return <EmptyState text="暂无团队开发项目（用 agiteam_start 启动）" />
  return (
    <div className="agiteam-view">
      {projects.map(p => (
        <button
          key={p.projectId}
          type="button"
          className="agiteam-project-card"
          data-active={p.projectId === selected}
          onClick={() => onSelect(p.projectId)}
        >
          <span className="agiteam-card-title">{p.projectName}</span>
          <span className="agiteam-card-meta">{p.projectId}</span>
          <span className="agiteam-card-stage">
            {stageIcon(p.stage)} {STAGE_NAMES[p.stage] ?? p.stage}
          </span>
          {current?.projectId === p.projectId && (
            <span className="agiteam-card-verify" data-pass={current.verification.mathPass && current.verification.scriptPass && current.verification.logPass}>
              {current.verification.mathPass && current.verification.scriptPass && current.verification.logPass ? '✅ 校验通过' : '⚠️ 校验未过'}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

/** 追溯矩阵视图（核心：需求→功能→用例→单测→代码→验收脚本）。 */
function MatrixView({ snapshot, onOpenSession }: {
  snapshot: TraceSnapshot
  onOpenSession: (id: string) => Promise<void>
}) {
  const rows = snapshot.traceRows
  if (rows.length === 0) return <EmptyState text="追溯矩阵为空（需先完成需求/功能/用例登记）" />
  return (
    <div className="agiteam-view">
      <div className="agiteam-section-title">追溯矩阵（需求 → 功能 → 用例 → 单测 → 代码 → 验收脚本）</div>
      <div className="agiteam-matrix">
        <table className="agiteam-table">
          <thead>
            <tr>
              <th>需求</th>
              <th>功能</th>
              <th>用例</th>
              <th>单测</th>
              <th>代码</th>
              <th>验收脚本</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row.featureId}-${i}`} data-status={row.status}>
                <td title={row.requirementTitle}>
                  {row.requirementId}
                  <span className="agiteam-cell-sub">{row.requirementTitle}</span>
                </td>
                <td>
                  {row.featureId}
                  <span className="agiteam-cell-sub">{row.featureName}</span>
                </td>
                <td>
                  {row.testCaseIds.join(', ') || '-'}
                </td>
                <td>
                  {row.unitTestIds.join(', ') || '-'}
                </td>
                <td>
                  <ul className="agiteam-cell-list">
                    {row.codeFiles.map(f => <li key={f} title={f}>{basename(f)}</li>)}
                  </ul>
                </td>
                <td>
                  <ul className="agiteam-cell-list">
                    {row.acceptanceScripts.map(s => <li key={s} title={s}>{basename(s)}</li>)}
                  </ul>
                </td>
                <td>
                  <span className="agiteam-status" data-status={row.status}>
                    {row.status === 'passed' ? '✅' : row.status === 'failed' ? '❌' : '⏳'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="agiteam-section-title">关联详情</div>
      {snapshot.features.map(f => {
        const cases = snapshot.testcases.filter(t => t.featureId === f.id)
        const units = snapshot.unitTests.filter(u => cases.some(c => c.id === u.testCaseId))
        const scripts = snapshot.acceptanceScripts.filter(s => s.featureId === f.id)
        return (
          <details key={f.id} className="agiteam-details">
            <summary>{f.id} {f.name}（关联需求：{f.requirementIds.join(', ') || '-'}）</summary>
            <div className="agiteam-details-body">
              <div>测试用例：{cases.map(c => `${c.id}(${c.kind})`).join('、') || '无'}</div>
              <div>单元测试：{units.map(u => `${u.id} [${u.status === 'passed' ? '✅' : '⏳'}] ${u.filePath}`).join('、') || '无'}</div>
              <div>验收脚本：{scripts.map(s => `${s.id} [${s.status === 'passed' ? '✅' : '⏳'}] ${s.path}${s.logFile ? ` → 日志 ${s.logFile}` : ''}`).join('、') || '无'}</div>
            </div>
          </details>
        )
      })}
    </div>
  )
}

/** 审计日志视图（链式哈希防篡改）。 */
function AuditView({ snapshot }: { snapshot: TraceSnapshot }) {
  const entries = snapshot.auditLog
  if (entries.length === 0) return <EmptyState text="暂无审计日志" />
  return (
    <div className="agiteam-view">
      <div className="agiteam-section-title">
        审计日志（{entries.length} 条 · 链式哈希防篡改）
        <span className="agiteam-hash-note">末条 hash: {entries[entries.length - 1]?.hash.slice(0, 12)}…</span>
      </div>
      <div className="agiteam-audit-list">
        {entries.map(e => (
          <div key={e.seq} className="agiteam-audit-entry" title={`hash: ${e.hash}`}>
            <span className="agiteam-audit-seq">#{e.seq}</span>
            <span className="agiteam-audit-time">{new Date(e.time).toLocaleTimeString()}</span>
            <span className="agiteam-audit-action">{e.action}</span>
            <span className="agiteam-audit-role">{e.role}</span>
            <span className="agiteam-audit-detail">{e.detail.length > 80 ? `${e.detail.slice(0, 80)}…` : e.detail}</span>
            {e.fingerprint && <span className="agiteam-audit-fp" title={e.fingerprint}>指纹 {e.fingerprint.slice(0, 8)}…</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 多层校验视图。 */
function VerifyView({ current, verifyResult, onVerify }: {
  current: TraceSnapshot | null
  verifyResult: string
  onVerify: () => void
}) {
  const v = current?.verification
  return (
    <div className="agiteam-view">
      <div className="agiteam-section-title">多层校验（防 AI 幻觉：数学/脚本/日志三层）</div>
      {v && (
        <div className="agiteam-verify-grid">
          <div className="agiteam-verify-item" data-pass={v.mathPass}>
            <div className="agiteam-verify-label">数学层（数量对账）</div>
            <div className="agiteam-verify-value">{v.mathPass ? '✅ 通过' : '❌ 未过'}</div>
          </div>
          <div className="agiteam-verify-item" data-pass={v.scriptPass}>
            <div className="agiteam-verify-label">脚本层（存在性+运行记录）</div>
            <div className="agiteam-verify-value">{v.scriptPass ? '✅ 通过' : '❌ 未过'}</div>
          </div>
          <div className="agiteam-verify-item" data-pass={v.logPass}>
            <div className="agiteam-verify-label">日志层（链完整+真实日志）</div>
            <div className="agiteam-verify-value">{v.logPass ? '✅ 通过' : '❌ 未过'}</div>
          </div>
        </div>
      )}
      {v && v.details.length > 0 && (
        <div className="agiteam-verify-details">
          {v.details.map((d, i) => <div key={i} className="agiteam-verify-detail">{d}</div>)}
        </div>
      )}
      <button type="button" className="agiteam-action" onClick={onVerify} disabled={!current}>
        触发多层校验
      </button>
      {verifyResult && <pre className="agiteam-verify-result">{verifyResult}</pre>}
    </div>
  )
}

/** 空态。 */
function EmptyState({ text }: { text: string }) {
  return <div className="agiteam-empty-state">{text}</div>
}

/** 任务板视图（taskboard 风格：列/卡片/审批状态）。 */
function BoardView({ board, selected, onOpenSession }: {
  board: BoardSnapshot | null
  selected: string
  onOpenSession: (id: string) => Promise<void>
}) {
  if (!board) return <EmptyState text="请先在「项目」页选择项目" />
  const statuses = ['open', 'claimed', 'in_progress', 'in_review', 'paused', 'rejected', 'done', 'failed']
  const tasks = board.tasks
  const inReviewCount = tasks.filter(t => t.status === 'in_review').length

  return (
    <div className="agiteam-view agiteam-board-view">
      <div className="agiteam-section-title">
        任务板 · {board.projectName}
        {inReviewCount > 0 && <span className="agiteam-review-badge">⏳ {inReviewCount} 待审批</span>}
      </div>
      <div className="agiteam-board-columns">
        {statuses.map(status => {
          const columnTasks = tasks.filter(t => t.status === status)
          if (columnTasks.length === 0) return null
          return (
            <div key={status} className="agiteam-board-column" data-status={status}>
              <div className="agiteam-board-col-head">
                {TASK_STATUS_NAMES[status] ?? status}
                <span className="agiteam-board-count">{columnTasks.length}</span>
              </div>
              {columnTasks.map(task => (
                <div key={task.id} className="agiteam-board-card" data-status={status}>
                  <div className="agiteam-board-card-title">{task.title}</div>
                  <div className="agiteam-board-card-meta">
                    <span className="agiteam-board-role">{task.role}</span>
                    <span className="agiteam-board-time">{relTime(task.updatedAt)}</span>
                  </div>
                  {status === 'in_review' && (
                    <div className="agiteam-board-suggestion">
                      {task.approvalSuggestion ? `💡 ${task.approvalSuggestion.slice(0, 60)}` : '⏳ 等待审批'}
                    </div>
                  )}
                  {status === 'paused' && task.pauseReason && (
                    <div className="agiteam-board-pause">⏸ {task.pauseReason.slice(0, 50)}</div>
                  )}
                  {status === 'rejected' && task.reviewComment && (
                    <div className="agiteam-board-reject">↩️ {task.reviewComment.slice(0, 50)}</div>
                  )}
                  {task.sessionId && (
                    <button
                      type="button"
                      className="agiteam-board-session"
                      onClick={() => { void onOpenSession(task.sessionId) }}
                    >
                      打开会话 →
                    </button>
                  )}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {tasks.length === 0 && <EmptyState text="暂无任务（阶段流转会自动创建）" />}
    </div>
  )
}

/** 取路径 basename。 */
function basename(path: string): string {
  return path.split('/').pop() ?? path
}
