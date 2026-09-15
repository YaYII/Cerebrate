import { jsx as _jsx } from "react/jsx-runtime";
/**
 * dsh-agiteam Client 面 —— 浏览器入口。
 *
 * UI 只管显示，功能内核实现：所有数据来自 host `/plugins/agiteam/state`
 * 快照，所有动作转发给 host（POST /audit 审计、/verify 校验）。
 *
 * 面板：右下角胶囊开关 → 右侧全高侧栏（项目列表 / 追溯矩阵 / 审计日志 /
 * 多层校验 / 阶段进度）。借鉴 pipeline-kernel 的 body portal 方案。
 */
import { createRoot } from 'react-dom/client';
import { AgiteamPanel } from './AgiteamPanel';
import './agiteam.css?inline';
/** 必需服务：会话导航（跳角色会话）+ 工作区目录选择器。 */
export const inject = ['sessions', 'workspaces'];
/** 面板宿主元素标记（调试/样式定位）。 */
const HOST_ATTRIBUTE = 'data-agiteam-host';
/**
 * 挂载活动面板（body portal，照 pipeline-kernel：web shell 无右上角 slot）。
 * 面板由 /state 快照轮询驱动，点会话节点用 sessions.open 跳转。
 */
export function apply(ctx) {
    const host = document.createElement('div');
    host.dataset.agiteamHost = '';
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(_jsx(AgiteamPanel, { openSession: async (id) => {
            // 会话可能刚创建未入列表：轮询列表快照直到出现再 open
            const deadline = Date.now() + 6000;
            for (;;) {
                const state = ctx.sessions.list.getSnapshot();
                if (state.ids.includes(id)) {
                    ctx.sessions.open(id);
                    return;
                }
                if (Date.now() >= deadline)
                    return;
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        } }));
    ctx.effect(() => () => {
        root.unmount();
        host.remove();
    }, 'dsh-agiteam: panel');
}
