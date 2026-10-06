/**
 * 执行 agent 上下文继承的种子提取 —— 从主管（发起）会话取已完成回合前缀。
 *
 * 纯函数、仅类型依赖：便于独立单测，也避免拖入 execution 的运行时依赖链。
 */
/**
 * 取发起会话（主管/指挥会话）已完成回合的事件前缀，作为执行 agent 的 fork seed。
 *
 * 语义与 subagent-fork-in-process 的 completedTurnPrefix 完全一致：截到最后一个
 * `turn/end`（含），seq 从 0 连续 → 是合法的 Session.create seed。执行 agent 由此
 * 继承主对话上下文（用户要求：执行会话应继承主管对话，无需重复阅读理解）。
 * 主管正在进行的回合未结束，不能作为合法子会话回放，故排除。
 * @param parent - 发起（主管）Agent，其 session.events 是权威事件日志。
 * @returns 连续 seed 前缀；无任何已完成回合时返回 undefined（保持无种子创建）。
 */
export function completedTurnPrefixOf(parent) {
    // Session.events 已在 dsh 0.1.5 移除，改用等价的 snapshotEvents() 全量快照
    const events = parent.session.snapshotEvents();
    const lastEnd = events.findLast(event => event.type === 'turn/end');
    if (lastEnd === undefined)
        return undefined;
    // seq 与数组下标一致（追加契约），因此 slice 到含最后一个 turn/end 即完整前缀。
    return events.slice(0, lastEnd.seq + 1);
}
