/**
 * dsh-agiteam Client 面 —— 复用 taskboard 底座 UI（看板/详情/评论/附件/工作流）+ 新增「我的工作台」。
 *
 * 架构（taskboard 底座 + AGI 团队大脑）：
 *  - taskboard 的完整 UI（sidebar 按钮 + shell 页面）原样复用（src/taskboard/client）；
 *  - 新增「工作台」视图（Workbench）：待我审批 / 进行中 / 待办队列 / 已完成；
 *  - 审批权在人：只有 owner 能放行（accept），AI 只提交建议（in_review）。
 *
 * 本文件是薄壳：把 taskboard 的 client apply/inject 原样导出，
 * bundle 构建（tsdown.client.config.ts）会把 src/taskboard/client 一起打包。
 */
export { apply, inject } from '../taskboard/client/index.js';
