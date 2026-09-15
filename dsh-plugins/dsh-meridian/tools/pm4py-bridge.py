#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PM4Py 桥接 —— 用成熟流程挖掘内核做「流程发现 + 合规性检查 + 时间维度校验」。

本文件干什么：读 XES（由 scripts/dev-export-xes.ts 导出）→ 变体分析 / Inductive Miner 发现 /
对齐（alignments）合规性 / temporal profile 时间维度偏离。
本文件不干什么：**不自己实现任何流程挖掘算法**。对齐是同步积上的最短路搜索，
重写既不划算也不可靠；这里全部调用 PM4Py（AGPL v3，本地自用不分发，义务不触发）。

## 为什么用 PM4Py 而不是自研

- 对齐（alignments）与 token replay 是流程挖掘 20 年沉淀的核心算法，有已发表语义与参考实现；
- XES 是 IEEE 1849 标准交换格式，ProM / Apromore / Celonis 都能读，选它就不会被单一工具锁死；
- 我们自研的部分应当只放在**别人没有的那一段**：业务日志 → 代码级事实（类/方法/行）的抽取，
  以及把判定结果回填到人写的规格（脑图）上。

## 环境准备（本机已就绪）

PM4Py 装在独立目录，不污染系统 Python（无需 sudo）：

    python3 -m pip install --target=<工作区>/.pylibs pm4py
    PYTHONPATH=<工作区>/.pylibs python3 tools/pm4py-bridge.py <xes> [--business-only]

## 用法

    node --import tsx scripts/dev-export-xes.ts <日志> --out /tmp/x.xes
    PYTHONPATH=.pylibs python3 tools/pm4py-bridge.py /tmp/x.xes --business-only

`--business-only` 剔除可观测信封（请求进入/请求体/响应体/HTTP 状态），
与标尺判定的口径保持一致——信封对每个请求恒有各 1 条，判别力为零。

@module tools/pm4py-bridge
"""

import argparse
import sys
import warnings

warnings.filterwarnings("ignore")

import pm4py  # noqa: E402

# 可观测信封的活动名前缀（与 ruler 的相位跳过口径一致）
ENVELOPE_PREFIXES = ("请求进入", "请求体", "响应体", "HTTP ")


def load(path: str):
    """读 XES；PM4Py 2.x 默认返回 DataFrame（事件表），这是它的推荐入口。"""
    df = pm4py.read_xes(path)
    return df


def business_view(df):
    """只保留业务相位的事件，剔除框架信封。"""
    phases = ["call", "return", "log", "step", "exception"]
    kept = df[df["lifecycle:transition"].isin(phases)]
    kept = kept[~kept["concept:name"].astype(str).str.startswith(ENVELOPE_PREFIXES)]
    return kept


def count_tree_nodes(tree) -> int:
    """递归统计 process tree 节点数。

    ProcessTree 未实现 `__len__`，直接 `len(tree)` 会抛 TypeError（实测踩过）。
    """
    children = list(getattr(tree, "children", []) or [])
    return 1 + sum(count_tree_nodes(child) for child in children)


def classify_move(move):
    """判定一个对齐步属于哪种 move。

    元组顺序是 **(日志侧, 模型侧)**，依据 PM4Py 源码：
    - `variants/discounted_a_star.py:548` —— `(trace[...], ">>")` 造出「日志侧有、模型侧跳过」的步；
    - `variants/discounted_a_star.py:535` —— `(">>", t)` 造出「模型侧有、日志侧跳过」的步。

    因此：
    - `(日志, ">>")` = **move on log**（日志有·模型无 = 越权/额外路径）
    - `(">>", 模型)` = **move on model**（模型有·日志无 = 漏做环节）
    - 两侧都是真实标签 = sync（正常执行）
    - 两侧都是跳过标记 = 静默步（不可见变迁，不构成偏离）

    ⚠️ 早期实现把两侧判反了，于是「日志里明明存在的活动」被误报成「漏做环节」——
    语义报错比不报更危险，因为人读到的是反的结论。

    @returns (kind, activity)：kind ∈ {sync, silent, move-on-log, move-on-model}
    """
    log_activity, model_activity = move[0], move[1]
    log_skipped = log_activity is None or log_activity == ">>"
    model_skipped = model_activity is None or model_activity == ">>"
    if log_skipped and model_skipped:
        return "silent", None
    if log_skipped:
        return "move-on-model", model_activity
    if model_skipped:
        return "move-on-log", log_activity
    return "sync", log_activity


def report_variants(df, title: str) -> None:
    """变体分析：把「毛线球」压成可读的少数几条路径。"""
    variants = pm4py.get_variants(df)
    print(f"\n── {title} ──")
    print(f"  trace {df['case:concept:name'].nunique()} 条 ｜ event {len(df)} 条 ｜ 活动种类 {df['concept:name'].nunique()} 种")
    print(f"  变体数 = {len(variants)}（变体数≈trace 数说明活动粒度没选对，模型会失去意义）")
    ranked = sorted(variants.items(), key=lambda item: -item[1])
    for index, (variant, count) in enumerate(ranked[:5], 1):
        steps = " → ".join(str(a)[:30] for a in variant[:6])
        more = " …" if len(variant) > 6 else ""
        print(f"    变体{index}: {count} 条 trace ｜ {len(variant)} 步")
        print(f"            {steps}{more}")


def main() -> int:
    parser = argparse.ArgumentParser(description="PM4Py 桥接：发现 + 合规性 + 时间维度")
    parser.add_argument("xes", help="XES 事件日志路径（被检查的执行）")
    parser.add_argument(
        "--baseline",
        help="基线 XES：从它发现模型，再拿主日志对齐。"
        "**这是本工具的正式用法**——从同一份日志发现模型再检查自己属于自我拟合，"
        "fitness 必然接近 1，不构成任何证据。",
    )
    parser.add_argument("--business-only", action="store_true", help="剔除可观测信封后分析")
    parser.add_argument("--top", type=int, default=10, help="偏离明细展示条数")
    args = parser.parse_args()

    df = load(args.xes)
    report_variants(df, "全量视图（含可观测信封）")

    target = business_view(df) if args.business_only else df
    if target.empty:
        print("\n业务视图为空：请检查相位过滤条件", file=sys.stderr)
        return 1
    report_variants(target, "业务视图" if args.business_only else "全量视图")

    # ── 发现模型的来源：优先基线（正式用法），否则自我拟合（仅供看模型形状，不能当证据）
    if args.baseline:
        baseline_raw = load(args.baseline)
        baseline = business_view(baseline_raw) if args.business_only else baseline_raw
        origin = f"基线 {args.baseline}"
    else:
        baseline = target
        origin = "同一份日志（⚠ 自我拟合，fitness 不构成证据）"

    # ── 流程发现（Inductive Miner：保证 soundness，不会发现出死锁模型）
    tree = pm4py.discover_process_tree_inductive(baseline)
    net, initial_marking, final_marking = pm4py.convert_to_petri_net(tree)
    print("\n── 流程发现（Inductive Miner）──")
    print(f"  模型来源：{origin}")
    print(f"  process tree 节点 {count_tree_nodes(tree)} ｜ Petri net 库所 {len(net.places)} 变迁 {len(net.transitions)}")
    print("  （这棵 process tree 就是「事实 → 脑图草案」的原料：树形结构天然对应脑图层级）")

    # ── 合规性检查：对齐（这就是「系统是否符合声明」的形式化判定）
    print("\n── 合规性检查（alignments）──")
    fitness = pm4py.fitness_alignments(target, net, initial_marking, final_marking)
    for key, value in fitness.items():
        if isinstance(value, float):
            print(f"  {key} = {value:.4f}")
        else:
            print(f"  {key} = {value}")
    print("  口径：log_fitness = 1 - 对齐代价/最坏代价；percentage_of_fitting_traces = 完全对齐的 trace 占比")

    # ── 逐 case 偏离明细：回答「哪一次执行偏离了、怎么偏的」
    diagnostics = pm4py.conformance_diagnostics_alignments(target, net, initial_marking, final_marking)
    case_names = list(dict.fromkeys(target["case:concept:name"].tolist()))
    deviated = []
    for case_name, diag in zip(case_names, diagnostics):
        if diag.get("fitness", 1.0) < 1.0:
            deviated.append((case_name, diag))
    print(f"\n  偏离的 trace：{len(deviated)}/{len(case_names)} 条")
    for case_name, diag in deviated[: args.top]:
        print(f"    ✗ {case_name} ｜ trace_fitness={diag.get('fitness', 0):.4f}")
        shown = 0
        for move in diag.get("alignment", []):
            kind, activity = classify_move(move)
            if kind == "sync" or kind == "silent":
                continue
            shown += 1
            if shown > 6:
                print("        …（其余偏离略）")
                break
            label = "日志有·模型无（越权/额外路径 → move on log）" if kind == "move-on-log" else "模型有·日志无（漏做环节 → move on model）"
            print(f"        [{kind}] {label}：{activity}")

    # ── 时间维度合规性（temporal profile）：不只比「走了哪些步」，还比「步间耗时是否符合历史分布」
    try:
        from pm4py.algo.conformance.temporal_profile import algorithm as temporal_profile
        from pm4py.algo.discovery.temporal_profile import algorithm as temporal_discovery

        profile = temporal_discovery.apply(target)
        # zeta 通过 parameters 传（2.x 的 apply 签名为 (log, profile, parameters)，
        # 直接传 zeta= 会 TypeError —— 实测踩过）
        deviations = temporal_profile.apply(target, profile, parameters={"zeta": 2.0})
        flagged = [d for d in deviations if len(d) > 0]
        print("\n── 时间维度合规性（temporal profile, zeta=2.0）──")
        print(f"  有耗时偏离的 trace：{len(flagged)}/{target['case:concept:name'].nunique()} 条")
        for item in flagged[: args.top]:
            for dev in item:
                print(f"    {dev}")
        if not flagged:
            print("  无耗时偏离")
    except Exception as error:  # noqa: BLE001 - 时间维度是加分项，失败不应中断主分析
        print(f"\n── 时间维度合规性：跳过（{type(error).__name__}: {error}）──")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
