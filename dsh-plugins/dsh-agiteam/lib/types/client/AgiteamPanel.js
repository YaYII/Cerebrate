import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
import { useEffect, useMemo, useState } from 'react';
/** 快照轮询周期（ms）。 */
const POLL_MS = 1000;
/** host 状态快照路由。 */
const STATE_URL = '/plugins/agiteam/state';
/** 审计动作端点。 */
const AUDIT_URL = '/plugins/agiteam/audit';
/** 校验端点。 */
const VERIFY_URL = '/plugins/agiteam/verify';
/** 任务板端点。 */
const BOARD_URL = '/plugins/agiteam/tasks';
/** 侧栏展开时对话区让位（body 属性）。 */
const PANEL_DOCKED_ATTRIBUTE = 'data-agiteam-docked';
/** 任务状态中文名。 */
const TASK_STATUS_NAMES = {
    open: '待处理',
    claimed: '已认领',
    in_progress: '进行中',
    in_review: '待审批',
    paused: '已暂停',
    done: '已完成',
    failed: '失败',
    rejected: '已打回',
};
/** 任务状态 CSS 类。 */
function taskStatusClass(status) {
    return status;
}
/** 阶段中文名。 */
const STAGE_NAMES = {
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
};
/** 相对时间。 */
function relTime(ts) {
    if (!ts)
        return '';
    const diff = Date.now() - ts;
    if (diff < 60_000)
        return '刚刚';
    if (diff < 3600_000)
        return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000)
        return `${Math.floor(diff / 3600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
}
/** 阶段状态图标。 */
function stageIcon(stage) {
    if (stage === 'done')
        return '✓';
    if (stage === 'feature-accept' || stage === 'e2e-accept')
        return '🧪';
    if (stage.includes('review'))
        return '🔍';
    return '●';
}
/** 主面板。 */
export function AgiteamPanel({ openSession }) {
    const [snapshot, setSnapshot] = useState(null);
    const [projects, setProjects] = useState([]);
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState('projects');
    const [selected, setSelected] = useState('');
    const [verifyResult, setVerifyResult] = useState('');
    const [board, setBoard] = useState(null);
    // 轮询项目列表 + 选中项目快照 + 任务板
    useEffect(() => {
        let cancelled = false;
        let inFlight = false;
        const tick = async () => {
            if (inFlight || cancelled)
                return;
            inFlight = true;
            try {
                // 项目列表
                const listRes = await fetch(STATE_URL, { cache: 'no-store' });
                if (listRes.ok) {
                    const data = await listRes.json();
                    if (data.projects)
                        setProjects(data.projects);
                    // 默认选中第一个
                    if (!selected && data.projects?.length > 0) {
                        setSelected(data.projects[0].projectId);
                    }
                }
                // 选中项目快照
                if (selected) {
                    const res = await fetch(`${STATE_URL}?project=${encodeURIComponent(selected)}`, { cache: 'no-store' });
                    if (res.ok)
                        setSnapshot(await res.json());
                    // 任务板
                    const boardRes = await fetch(`${BOARD_URL}?project=${encodeURIComponent(selected)}`, { cache: 'no-store' });
                    if (boardRes.ok)
                        setBoard(await boardRes.json());
                }
            }
            catch {
                // host 重启中，保留上次快照
            }
            finally {
                inFlight = false;
            }
        };
        void tick();
        const timer = setInterval(() => { void tick(); }, POLL_MS);
        return () => { cancelled = true; clearInterval(timer); };
    }, [selected]);
    // 展开时对话区让位
    useEffect(() => {
        const root = document.documentElement;
        if (open)
            root.setAttribute(PANEL_DOCKED_ATTRIBUTE, '');
        else
            root.removeAttribute(PANEL_DOCKED_ATTRIBUTE);
        return () => { root.removeAttribute(PANEL_DOCKED_ATTRIBUTE); };
    }, [open]);
    // 触发多层校验
    const runVerify = async () => {
        if (!selected)
            return;
        try {
            const res = await fetch(`${VERIFY_URL}?project=${encodeURIComponent(selected)}`, { cache: 'no-store' });
            const data = await res.json();
            const v = data.verification;
            const passed = data.traceAllPassed ? '✅ 追溯矩阵全部通过' : '⚠️ 追溯矩阵未全部通过';
            setVerifyResult(`${passed}\n数学层: ${v.mathPass ? '✅' : '❌'} | 脚本层: ${v.scriptPass ? '✅' : '❌'} | 日志层: ${v.logPass ? '✅' : '❌'}`);
        }
        catch {
            setVerifyResult('校验请求失败');
        }
    };
    const busy = snapshot?.stage !== 'done' && snapshot !== null;
    const current = snapshot;
    return (_jsxs("div", { children: [_jsxs("button", { type: "button", className: "agiteam-pill", "data-open": open, onClick: () => setOpen(v => !v), "aria-label": "AGI \u56E2\u961F\u5F00\u53D1\u9762\u677F", title: open ? '收起面板' : '展开面板', children: [_jsx("span", { className: "agiteam-pill-dot", "data-busy": busy, "aria-hidden": "true" }), "AGI \u56E2\u961F"] }), open && (_jsxs("aside", { className: "agiteam-sidebar", children: [_jsxs("header", { className: "agiteam-head", children: [_jsxs("span", { className: "agiteam-title", children: ["AGI \u56E2\u961F\u5F00\u53D1", _jsx("span", { className: "agiteam-dot", "data-busy": busy, "aria-hidden": "true" })] }), _jsx("button", { type: "button", className: "agiteam-icon-btn", onClick: () => setOpen(false), "aria-label": "\u5173\u95ED", children: "\u2715" })] }), _jsxs("nav", { className: "agiteam-nav", "aria-label": "AGI \u56E2\u961F\u5F00\u53D1\u9762\u677F", children: [_jsx(NavItem, { active: tab === 'projects', icon: "\uD83D\uDCCB", label: "\u9879\u76EE", onClick: () => setTab('projects') }), _jsx(NavItem, { active: tab === 'board', icon: "\uD83D\uDDC2\uFE0F", label: "\u4EFB\u52A1\u677F", count: board?.tasks.filter(t => t.status === 'in_review').length ?? 0, onClick: () => setTab('board') }), _jsx(NavItem, { active: tab === 'matrix', icon: "\uD83D\uDD17", label: "\u8FFD\u6EAF\u77E9\u9635", onClick: () => setTab('matrix') }), _jsx(NavItem, { active: tab === 'audit', icon: "\uD83D\uDCDC", label: "\u5BA1\u8BA1\u65E5\u5FD7", count: current?.auditLog.length ?? 0, onClick: () => setTab('audit') }), _jsx(NavItem, { active: tab === 'verify', icon: "\uD83D\uDEE1\uFE0F", label: "\u6821\u9A8C", onClick: () => setTab('verify') })] }), _jsxs("div", { className: "agiteam-content", children: [tab === 'projects' && (_jsx(ProjectsView, { projects: projects, selected: selected, onSelect: setSelected, current: current })), tab === 'board' && (_jsx(BoardView, { board: board, selected: selected, onOpenSession: openSession })), tab === 'matrix' && current && (_jsx(MatrixView, { snapshot: current, onOpenSession: openSession })), tab === 'matrix' && !current && _jsx(EmptyState, { text: "\u8BF7\u5148\u5728\u300C\u9879\u76EE\u300D\u9875\u9009\u62E9\u9879\u76EE" }), tab === 'audit' && current && _jsx(AuditView, { snapshot: current }), tab === 'audit' && !current && _jsx(EmptyState, { text: "\u8BF7\u5148\u5728\u300C\u9879\u76EE\u300D\u9875\u9009\u62E9\u9879\u76EE" }), tab === 'verify' && (_jsx(VerifyView, { current: current, verifyResult: verifyResult, onVerify: runVerify }))] })] }))] }));
}
/** 竖向导航项。 */
function NavItem({ active, icon, label, count, onClick }) {
    return (_jsxs("button", { type: "button", className: "agiteam-nav-item", "data-active": active, onClick: onClick, title: label, children: [_jsx("span", { className: "agiteam-nav-icon", "aria-hidden": "true", children: icon }), _jsx("span", { className: "agiteam-nav-label", children: label }), count !== undefined && count > 0 && _jsx("span", { className: "agiteam-nav-count", children: count })] }));
}
/** 项目列表视图。 */
function ProjectsView({ projects, selected, onSelect, current }) {
    if (projects.length === 0)
        return _jsx(EmptyState, { text: "\u6682\u65E0\u56E2\u961F\u5F00\u53D1\u9879\u76EE\uFF08\u7528 agiteam_start \u542F\u52A8\uFF09" });
    return (_jsx("div", { className: "agiteam-view", children: projects.map(p => (_jsxs("button", { type: "button", className: "agiteam-project-card", "data-active": p.projectId === selected, onClick: () => onSelect(p.projectId), children: [_jsx("span", { className: "agiteam-card-title", children: p.projectName }), _jsx("span", { className: "agiteam-card-meta", children: p.projectId }), _jsxs("span", { className: "agiteam-card-stage", children: [stageIcon(p.stage), " ", STAGE_NAMES[p.stage] ?? p.stage] }), current?.projectId === p.projectId && (_jsx("span", { className: "agiteam-card-verify", "data-pass": current.verification.mathPass && current.verification.scriptPass && current.verification.logPass, children: current.verification.mathPass && current.verification.scriptPass && current.verification.logPass ? '✅ 校验通过' : '⚠️ 校验未过' }))] }, p.projectId))) }));
}
/** 追溯矩阵视图（核心：需求→功能→用例→单测→代码→验收脚本）。 */
function MatrixView({ snapshot, onOpenSession }) {
    const rows = snapshot.traceRows;
    if (rows.length === 0)
        return _jsx(EmptyState, { text: "\u8FFD\u6EAF\u77E9\u9635\u4E3A\u7A7A\uFF08\u9700\u5148\u5B8C\u6210\u9700\u6C42/\u529F\u80FD/\u7528\u4F8B\u767B\u8BB0\uFF09" });
    return (_jsxs("div", { className: "agiteam-view", children: [_jsx("div", { className: "agiteam-section-title", children: "\u8FFD\u6EAF\u77E9\u9635\uFF08\u9700\u6C42 \u2192 \u529F\u80FD \u2192 \u7528\u4F8B \u2192 \u5355\u6D4B \u2192 \u4EE3\u7801 \u2192 \u9A8C\u6536\u811A\u672C\uFF09" }), _jsx("div", { className: "agiteam-matrix", children: _jsxs("table", { className: "agiteam-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u9700\u6C42" }), _jsx("th", { children: "\u529F\u80FD" }), _jsx("th", { children: "\u7528\u4F8B" }), _jsx("th", { children: "\u5355\u6D4B" }), _jsx("th", { children: "\u4EE3\u7801" }), _jsx("th", { children: "\u9A8C\u6536\u811A\u672C" }), _jsx("th", { children: "\u72B6\u6001" })] }) }), _jsx("tbody", { children: rows.map((row, i) => (_jsxs("tr", { "data-status": row.status, children: [_jsxs("td", { title: row.requirementTitle, children: [row.requirementId, _jsx("span", { className: "agiteam-cell-sub", children: row.requirementTitle })] }), _jsxs("td", { children: [row.featureId, _jsx("span", { className: "agiteam-cell-sub", children: row.featureName })] }), _jsx("td", { children: row.testCaseIds.join(', ') || '-' }), _jsx("td", { children: row.unitTestIds.join(', ') || '-' }), _jsx("td", { children: _jsx("ul", { className: "agiteam-cell-list", children: row.codeFiles.map(f => _jsx("li", { title: f, children: basename(f) }, f)) }) }), _jsx("td", { children: _jsx("ul", { className: "agiteam-cell-list", children: row.acceptanceScripts.map(s => _jsx("li", { title: s, children: basename(s) }, s)) }) }), _jsx("td", { children: _jsx("span", { className: "agiteam-status", "data-status": row.status, children: row.status === 'passed' ? '✅' : row.status === 'failed' ? '❌' : '⏳' }) })] }, `${row.featureId}-${i}`))) })] }) }), _jsx("div", { className: "agiteam-section-title", children: "\u5173\u8054\u8BE6\u60C5" }), snapshot.features.map(f => {
                const cases = snapshot.testcases.filter(t => t.featureId === f.id);
                const units = snapshot.unitTests.filter(u => cases.some(c => c.id === u.testCaseId));
                const scripts = snapshot.acceptanceScripts.filter(s => s.featureId === f.id);
                return (_jsxs("details", { className: "agiteam-details", children: [_jsxs("summary", { children: [f.id, " ", f.name, "\uFF08\u5173\u8054\u9700\u6C42\uFF1A", f.requirementIds.join(', ') || '-', "\uFF09"] }), _jsxs("div", { className: "agiteam-details-body", children: [_jsxs("div", { children: ["\u6D4B\u8BD5\u7528\u4F8B\uFF1A", cases.map(c => `${c.id}(${c.kind})`).join('、') || '无'] }), _jsxs("div", { children: ["\u5355\u5143\u6D4B\u8BD5\uFF1A", units.map(u => `${u.id} [${u.status === 'passed' ? '✅' : '⏳'}] ${u.filePath}`).join('、') || '无'] }), _jsxs("div", { children: ["\u9A8C\u6536\u811A\u672C\uFF1A", scripts.map(s => `${s.id} [${s.status === 'passed' ? '✅' : '⏳'}] ${s.path}${s.logFile ? ` → 日志 ${s.logFile}` : ''}`).join('、') || '无'] })] })] }, f.id));
            })] }));
}
/** 审计日志视图（链式哈希防篡改）。 */
function AuditView({ snapshot }) {
    const entries = snapshot.auditLog;
    if (entries.length === 0)
        return _jsx(EmptyState, { text: "\u6682\u65E0\u5BA1\u8BA1\u65E5\u5FD7" });
    return (_jsxs("div", { className: "agiteam-view", children: [_jsxs("div", { className: "agiteam-section-title", children: ["\u5BA1\u8BA1\u65E5\u5FD7\uFF08", entries.length, " \u6761 \u00B7 \u94FE\u5F0F\u54C8\u5E0C\u9632\u7BE1\u6539\uFF09", _jsxs("span", { className: "agiteam-hash-note", children: ["\u672B\u6761 hash: ", entries[entries.length - 1]?.hash.slice(0, 12), "\u2026"] })] }), _jsx("div", { className: "agiteam-audit-list", children: entries.map(e => (_jsxs("div", { className: "agiteam-audit-entry", title: `hash: ${e.hash}`, children: [_jsxs("span", { className: "agiteam-audit-seq", children: ["#", e.seq] }), _jsx("span", { className: "agiteam-audit-time", children: new Date(e.time).toLocaleTimeString() }), _jsx("span", { className: "agiteam-audit-action", children: e.action }), _jsx("span", { className: "agiteam-audit-role", children: e.role }), _jsx("span", { className: "agiteam-audit-detail", children: e.detail.length > 80 ? `${e.detail.slice(0, 80)}…` : e.detail }), e.fingerprint && _jsxs("span", { className: "agiteam-audit-fp", title: e.fingerprint, children: ["\u6307\u7EB9 ", e.fingerprint.slice(0, 8), "\u2026"] })] }, e.seq))) })] }));
}
/** 多层校验视图。 */
function VerifyView({ current, verifyResult, onVerify }) {
    const v = current?.verification;
    return (_jsxs("div", { className: "agiteam-view", children: [_jsx("div", { className: "agiteam-section-title", children: "\u591A\u5C42\u6821\u9A8C\uFF08\u9632 AI \u5E7B\u89C9\uFF1A\u6570\u5B66/\u811A\u672C/\u65E5\u5FD7\u4E09\u5C42\uFF09" }), v && (_jsxs("div", { className: "agiteam-verify-grid", children: [_jsxs("div", { className: "agiteam-verify-item", "data-pass": v.mathPass, children: [_jsx("div", { className: "agiteam-verify-label", children: "\u6570\u5B66\u5C42\uFF08\u6570\u91CF\u5BF9\u8D26\uFF09" }), _jsx("div", { className: "agiteam-verify-value", children: v.mathPass ? '✅ 通过' : '❌ 未过' })] }), _jsxs("div", { className: "agiteam-verify-item", "data-pass": v.scriptPass, children: [_jsx("div", { className: "agiteam-verify-label", children: "\u811A\u672C\u5C42\uFF08\u5B58\u5728\u6027+\u8FD0\u884C\u8BB0\u5F55\uFF09" }), _jsx("div", { className: "agiteam-verify-value", children: v.scriptPass ? '✅ 通过' : '❌ 未过' })] }), _jsxs("div", { className: "agiteam-verify-item", "data-pass": v.logPass, children: [_jsx("div", { className: "agiteam-verify-label", children: "\u65E5\u5FD7\u5C42\uFF08\u94FE\u5B8C\u6574+\u771F\u5B9E\u65E5\u5FD7\uFF09" }), _jsx("div", { className: "agiteam-verify-value", children: v.logPass ? '✅ 通过' : '❌ 未过' })] })] })), v && v.details.length > 0 && (_jsx("div", { className: "agiteam-verify-details", children: v.details.map((d, i) => _jsx("div", { className: "agiteam-verify-detail", children: d }, i)) })), _jsx("button", { type: "button", className: "agiteam-action", onClick: onVerify, disabled: !current, children: "\u89E6\u53D1\u591A\u5C42\u6821\u9A8C" }), verifyResult && _jsx("pre", { className: "agiteam-verify-result", children: verifyResult })] }));
}
/** 空态。 */
function EmptyState({ text }) {
    return _jsx("div", { className: "agiteam-empty-state", children: text });
}
/** 任务板视图（taskboard 风格：列/卡片/审批状态）。 */
function BoardView({ board, selected, onOpenSession }) {
    if (!board)
        return _jsx(EmptyState, { text: "\u8BF7\u5148\u5728\u300C\u9879\u76EE\u300D\u9875\u9009\u62E9\u9879\u76EE" });
    const statuses = ['open', 'claimed', 'in_progress', 'in_review', 'paused', 'rejected', 'done', 'failed'];
    const tasks = board.tasks;
    const inReviewCount = tasks.filter(t => t.status === 'in_review').length;
    return (_jsxs("div", { className: "agiteam-view agiteam-board-view", children: [_jsxs("div", { className: "agiteam-section-title", children: ["\u4EFB\u52A1\u677F \u00B7 ", board.projectName, inReviewCount > 0 && _jsxs("span", { className: "agiteam-review-badge", children: ["\u23F3 ", inReviewCount, " \u5F85\u5BA1\u6279"] })] }), _jsx("div", { className: "agiteam-board-columns", children: statuses.map(status => {
                    const columnTasks = tasks.filter(t => t.status === status);
                    if (columnTasks.length === 0)
                        return null;
                    return (_jsxs("div", { className: "agiteam-board-column", "data-status": status, children: [_jsxs("div", { className: "agiteam-board-col-head", children: [TASK_STATUS_NAMES[status] ?? status, _jsx("span", { className: "agiteam-board-count", children: columnTasks.length })] }), columnTasks.map(task => (_jsxs("div", { className: "agiteam-board-card", "data-status": status, children: [_jsx("div", { className: "agiteam-board-card-title", children: task.title }), _jsxs("div", { className: "agiteam-board-card-meta", children: [_jsx("span", { className: "agiteam-board-role", children: task.role }), _jsx("span", { className: "agiteam-board-time", children: relTime(task.updatedAt) })] }), status === 'in_review' && (_jsx("div", { className: "agiteam-board-suggestion", children: task.approvalSuggestion ? `💡 ${task.approvalSuggestion.slice(0, 60)}` : '⏳ 等待审批' })), status === 'paused' && task.pauseReason && (_jsxs("div", { className: "agiteam-board-pause", children: ["\u23F8 ", task.pauseReason.slice(0, 50)] })), status === 'rejected' && task.reviewComment && (_jsxs("div", { className: "agiteam-board-reject", children: ["\u21A9\uFE0F ", task.reviewComment.slice(0, 50)] })), task.sessionId && (_jsx("button", { type: "button", className: "agiteam-board-session", onClick: () => { void onOpenSession(task.sessionId); }, children: "\u6253\u5F00\u4F1A\u8BDD \u2192" }))] }, task.id)))] }, status));
                }) }), tasks.length === 0 && _jsx(EmptyState, { text: "\u6682\u65E0\u4EFB\u52A1\uFF08\u9636\u6BB5\u6D41\u8F6C\u4F1A\u81EA\u52A8\u521B\u5EFA\uFF09" })] }));
}
/** 取路径 basename。 */
function basename(path) {
    return path.split('/').pop() ?? path;
}
