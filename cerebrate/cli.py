#!/usr/bin/env python3
"""Cerebrate CLI v4 — AI 智能体通信协议

所有命令默认输出 JSON。使用 --human 获取人类可读格式。
退出码: 0=成功, 1=错误
"""
import argparse
import json
import os
import sys
from pathlib import Path

from cerebrate.config import config
from cerebrate.memory import MemoryManager, EvolutionEngine
from cerebrate.decision import DecisionRouter
from cerebrate.brain import CerebrateMind, Metacognition
from cerebrate.ipc import BatchProcessor

PROTOCOL_VERSION = "v4"


class CerebrateArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        _out(_err(message, code=400))


def _ok(data=None, **kwargs):
    """构造成功响应"""
    payload = data if data is not None else kwargs
    return {"status": "ok", "data": payload, "meta": {"protocol": PROTOCOL_VERSION}}


def _err(msg, code=1, details=None, **kwargs):
    """构造错误响应"""
    error = {"code": code, "message": msg, "details": details or {}}
    if kwargs:
        error["details"].update(kwargs)
    return {"status": "error", "error": error, "meta": {"protocol": PROTOCOL_VERSION}}


def _out(result, human=None):
    """输出: 默认 JSON，--human 时用 human 函数渲染"""
    if human:
        human()
    else:
        print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("status") == "ok" else 1)


def get_manager():
    return MemoryManager(config.personal_path, config.swarm_path, config.knowledge_path)


# ==================== stats ====================

def cmd_stats(args):
    mm = get_manager()
    mind = CerebrateMind(mm)
    meta = Metacognition(mm)
    stats = mm.get_all_stats()
    sense = mind.sense()
    assess = meta.assess()

    result = _ok(stats=stats, sense=sense, assessment=assess)

    def human():
        print("=" * 55)
        print("  Cerebrate 虫群记忆系统 v3.1")
        print("=" * 55)
        print(f"  健康: {sense['health']}  |  世代: {mind.generation}")
        print(f"  虫群记忆: {sense['total_memories']} 条")
        print(f"  注册智能体: {sense['total_agents']} 个 — {', '.join(sense.get('agent_ids', [])) or '无'}")
        print(f"  语义索引: swarm={stats['semantic']['swarm_docs']} kb={stats['semantic']['kb_docs']}")
        print(f"  查询命中率: {assess['hit_rate']:.0%}")
        print(f"  半衰期: {config.decay_half_life_days} 天")
        if sense["warnings"]:
            for w in sense["warnings"]:
                print(f"  ⚠ {w}")

    _out(result, human if args.human else None)


# ==================== remember / recall ====================

def cmd_remember(args):
    mm = get_manager()
    mm.remember_user(args.user, args.key, args.value, project_id=args.project or "")
    result = _ok(user=args.user, key=args.key, remembered=True)
    def human():
        if not args.quiet:
            print(f"已记住 {args.user}.{args.key}")
    _out(result, human if args.human else None)


def cmd_recall(args):
    mm = get_manager()
    if args.project:
        profile = mm.get_user_profile(args.user, project_id=args.project)
        data = profile.get("project_contexts", {}).get(args.project, {})
    elif args.key:
        data = mm.recall_user(args.user, args.key)
    else:
        data = mm.recall_user(args.user)

    result = _ok(user=args.user, memories=data)

    def human():
        if not data:
            print("无记忆")
        for k, v in data.items():
            print(f"  {k}: {v}")

    _out(result, human if args.human else None)


# ==================== share ====================

def cmd_share(args):
    mm = get_manager()
    tags = [t.strip() for t in args.tags.split(",")] if args.tags else []

    validation = None
    life_stage = args.life_stage or "memory"
    confidence = args.confidence
    evidence = args.evidence or ""
    if args.validate:
        from cerebrate.llm import CerebrateLLM
        llm = CerebrateLLM()
        validation = llm.validate_memory(args.content, args.agent)
        if validation.get("suggested_tags") and not args.tags:
            tags = validation["suggested_tags"]
        if not validation["safe"] and not args.force:
            life_stage = "quarantined"
            confidence = min(confidence, validation.get("quality", 0.1))
            evidence = (evidence + "\n" if evidence else "") + "免疫系统隔离: " + "; ".join(validation.get("issues", []))

    mid = mm.share_to_swarm(
        title=args.title, content=args.content, category=args.category,
        tags=tags, source_agent=args.agent,
        problem_solved=args.problem or "", solution=args.solution or "",
        outcome=args.outcome or "success", project_id=args.project or "",
        life_stage=life_stage, nutrient_score=args.nutrient_score,
        confidence=confidence, evidence=evidence,
        supersedes=[s.strip() for s in args.supersedes.split(",") if s.strip()],
    )
    result = _ok(memory_id=mid, agent=args.agent, category=args.category,
                tags=tags, validated=args.validate,
                validation=validation, life_stage=life_stage,
                confidence=confidence)

    def share_human():
        if not args.quiet:
            print(f"已分享: {mid}")
    _out(result, share_human if args.human else None)


# ==================== query ====================

def cmd_query(args):
    mm = get_manager()
    router = DecisionRouter(mm)

    decision = router.decide(
        args.user or config.current_project_id or "default",
        args.query,
        context={"project_id": args.project},
    )

    best = decision.get("swarm_knowledge", {}).get("best_match")
    policy = decision.get("policy_result")
    tone = decision.get("personal_tone", {})

    recommendation = "new_experience"
    if best:
        recommendation = "reuse" if best.get("score", 0) > 0.5 else "verify"

    result = _ok(
        query=args.query,
        found=bool(best),
        swarm_result=best,
        policy_result=policy,
        personal=tone,
        recommendation=recommendation,
    )

    def human():
        if best:
            print(f"\n【虫群经验】{best['title']} ({best.get('category','')})")
            print(f"  {best.get('solution', best.get('content', ''))[:300]}")
            r, s, d = best.get('reuse_count', 0), best.get('semantic_score', 0), best.get('decay', 1)
            print(f"  来源:{best.get('source_agent','?')} 复用:{r} 语义分:{s:.3f} 衰减:{d:.3f}")
        else:
            print("虫群无匹配")
        if policy:
            print(f"\n【权威依据】{policy['title']}\n  {policy['content'][:300]}")
        if tone.get("name"):
            print(f"\n[对 {tone['name']} 使用 {tone['tone']} 语气]")

    _out(result, human if args.human else None)


# ==================== knowledge ====================

def cmd_store_kb(args):
    mm = get_manager()
    topics = [t.strip() for t in args.topics.split(",")] if args.topics else []
    did = mm.store_knowledge(
        title=args.title, content=args.content, source=args.source,
        topics=topics, is_policy=args.policy, policy_name=args.policy_name or "",
        version=args.version or "1.0", project_id=args.project or "",
    )
    result = _ok(doc_id=did, title=args.title, is_policy=args.policy)
    def k_human():
        if not args.quiet:
            print(f"已存入: {did}")
    _out(result, k_human if args.human else None)


# ==================== evolve ====================


def cmd_evolve(args):
    mm = get_manager()
    engine = EvolutionEngine(config.evolution_path, mm)
    evolution = engine.evolve()
    mind = CerebrateMind(mm)
    mind.evolve()
    result = _ok(generation=mind.generation, evolution=evolution)
    def evo_human():
        print(f"第 {mind.generation} 代进化完成")
        for a in evolution.get("actions", []):
            print(f"  {a}")
    _out(result, evo_human if args.human else None)


def cmd_migrate(args):
    from cerebrate.migrate import export_seeds, migrate_all, migrate_swarm, reindex_from_seeds

    if args.export_seeds:
        result_data = export_seeds()
        result = _ok(result_data)
        _out(result)
        return
    if args.reindex:
        result_data = reindex_from_seeds(dry_run=args.dry_run)
        result = _ok(result_data)
        _out(result)
        return
    if args.swarm_only:
        results = {"swarm": migrate_swarm(dry_run=args.dry_run)}
        total = results["swarm"]
    else:
        results = migrate_all(dry_run=args.dry_run)
        total = sum(results.values())

    result = _ok(migrated=total, dry_run=args.dry_run, details=results)
    def mig_human():
        action = "预览" if args.dry_run else "迁移"
        print(f"{action}完成: 共 {total} 条")
        for k, v in results.items():
            if v:
                print(f"  {k}: {v} 条")
    _out(result, mig_human if args.human else None)


def cmd_sense(args):
    mm = get_manager()
    mind = CerebrateMind(mm)
    sense = mind.sense()
    result = _ok(**sense)
    def sense_human():
        print(f"  健康:{sense['health']} 记忆:{sense['total_memories']} 智能体:{sense['total_agents']}")
    _out(result, sense_human if args.human else None)


# ==================== agent ====================

def cmd_agent_register(args):
    mm = get_manager()
    caps = [c.strip() for c in args.capabilities.split(",")] if args.capabilities else []
    info = mm.register_agent(args.id, args.type, caps, {"project": args.project or config.current_project_id})
    result = _ok(agent_id=args.id, agent_type=args.type, capabilities=caps)
    def reg_human():
        print(f"已注册智能体 {args.id} ({args.type})")
    _out(result, reg_human if args.human else None)


def cmd_agent_list(args):
    mm = get_manager()
    agents = mm.agents.list_details()
    result = _ok(agents=agents, count=len(agents))
    def list_human():
        for a in agents:
            print(f"  {a['agent_id']} ({a['agent_type']}) 操作:{a['total_actions']} 成功率:{a['success_rate']:.0%}")
    _out(result, list_human if args.human else None)


def cmd_agent_stats(args):
    mm = get_manager()
    stats = mm.agents.get_stats(args.id)
    if stats:
        result = _ok(**stats)
    else:
        result = _err(f"智能体 {args.id} 未注册", code=404)
    def astats_human():
        for k, v in (stats or {}).items():
            print(f"  {k}: {v}")
    _out(result, astats_human if args.human else None)


# ==================== batch ====================

def cmd_batch_process(args):
    mm = get_manager()
    processor = BatchProcessor(mm)
    count = processor.process_pending(limit=args.limit)
    if args.clean:
        processor.clean_processed()
    result = _ok(processed=count)
    def bp_human():
        if not args.quiet:
            print(f"处理 {count} 请求")
    _out(result, bp_human if args.human else None)


def cmd_batch_submit(args):
    mm = get_manager()
    processor = BatchProcessor(mm)
    try:
        params = json.loads(args.params) if args.params else {}
    except json.JSONDecodeError:
        result = _err("--params 不是有效 JSON", code=400)
        _out(result)
        return
    rid = processor.submit(args.agent, args.cmd, params, args.project or "")
    result = _ok(request_id=rid)
    def sub_human():
        print(f"已提交: {rid}")
    _out(result, sub_human if args.human else None)


def cmd_batch_result(args):
    mm = get_manager()
    processor = BatchProcessor(mm)
    result_data = processor.get_result(args.id)
    if result_data:
        result = _ok(data=result_data)
    else:
        result = _err(f"结果 {args.id} 未就绪", code=404)
    _out(result)


# ==================== use ====================

def cmd_use_start(args):
    mm = get_manager()
    record = mm.start_memory_use(args.memory_id, args.agent, args.problem,
                                 project_id=args.project or "")
    result = _ok(record)
    def use_human():
        print(f"已开始复用记忆: {record['usage_id']}")
    _out(result, use_human if args.human else None)


def cmd_use_finish(args):
    mm = get_manager()
    record = mm.finish_memory_use(args.usage_id, args.outcome, args.feedback or "")
    result = _ok(record)
    def use_human():
        print(f"已完成复用记录: {record['usage_id']} ({record['outcome']})")
    _out(result, use_human if args.human else None)


# ==================== llm ====================

def cmd_llm_status(args):
    from cerebrate.llm import CerebrateLLM
    llm = CerebrateLLM()
    result = _ok(
        available=llm.is_available(),
        sdk_ready=llm._sdk_ready(),
        provider=config.llm_provider,
        model=config.llm_model,
        immune_enabled=config.immune_enabled,
        immune_threshold=config.immune_threshold,
    )
    def ls_human():
        print(f"  LLM:{llm.is_available()} SDK:{llm._sdk_ready()} 免疫:{config.immune_enabled}")
    _out(result, ls_human if args.human else None)


def cmd_llm_validate(args):
    from cerebrate.llm import CerebrateLLM
    llm = CerebrateLLM()
    content = args.content or sys.stdin.read().strip()
    if not content:
        result = _err("需要 --content 或 stdin", code=400)
        _out(result)
        return
    validation = llm.validate_memory(content, args.agent or "unknown")
    result = _ok(**validation)
    def lv_human():
        print(f"  安全:{validation['safe']} 质量:{validation['quality']:.2f} 免疫:{validation['immune_active']}")
    _out(result, lv_human if args.human else None)


# ==================== main ====================

def _add_common(p):
    p.add_argument("--human", action="store_true", help="人类可读输出（默认 JSON）")


def main():
    parser = CerebrateArgumentParser(description="Cerebrate v4 - 脑虫记忆 / AI Agent 协议")
    sub = parser.add_subparsers(dest="command")

    # stats
    p = sub.add_parser("stats", help="虫群统计 [→ JSON]")
    _add_common(p)

    # remember
    p = sub.add_parser("remember", help="记住用户信息 [→ JSON]")
    p.add_argument("--user", "-u", required=True)
    p.add_argument("--key", "-k", required=True)
    p.add_argument("--value", "-v", required=True)
    p.add_argument("--project", "-p", default="")
    p.add_argument("--quiet", "-q", action="store_true")
    _add_common(p)

    # recall
    p = sub.add_parser("recall", help="回忆用户信息 [→ JSON]")
    p.add_argument("--user", "-u", required=True)
    p.add_argument("--key", "-k", default=None)
    p.add_argument("--project", "-p", default="")
    _add_common(p)

    # share
    p = sub.add_parser("share", help="分享经验到虫群 [→ JSON]")
    p.add_argument("--title", "-t", required=True)
    p.add_argument("--content", "-c", required=True)
    p.add_argument("--category", "-C", required=True)
    p.add_argument("--tags", default="")
    p.add_argument("--agent", "-a", default="unknown")
    p.add_argument("--problem", default="")
    p.add_argument("--solution", "-s", default="")
    p.add_argument("--outcome", "-o", default="success")
    p.add_argument("--project", "-p", default="")
    p.add_argument("--validate", action="store_true")
    p.add_argument("--force", action="store_true")
    p.add_argument("--life-stage", default="memory",
                   choices=["nutrient", "memory", "verified_skill", "doctrine", "quarantined", "archived"])
    p.add_argument("--nutrient-score", type=float, default=1.0)
    p.add_argument("--confidence", type=float, default=1.0)
    p.add_argument("--evidence", default="")
    p.add_argument("--supersedes", default="")
    p.add_argument("--quiet", "-q", action="store_true")
    _add_common(p)

    # query
    p = sub.add_parser("query", help="查询虫群经验 [→ JSON]")
    p.add_argument("query")
    p.add_argument("--user", "-u", default=None)
    p.add_argument("--project", "-p", default=None)
    _add_common(p)

    # store-kb
    p = sub.add_parser("store-kb", help="存入知识库 [→ JSON]")
    p.add_argument("--title", "-t", required=True)
    p.add_argument("--content", "-c", required=True)
    p.add_argument("--source", "-s", required=True)
    p.add_argument("--topics", default="")
    p.add_argument("--policy", action="store_true")
    p.add_argument("--policy-name", default="")
    p.add_argument("--version", default="1.0")
    p.add_argument("--project", "-p", default="")
    p.add_argument("--quiet", "-q", action="store_true")
    _add_common(p)

    # evolve
    p = sub.add_parser("evolve", help="触发进化 [→ JSON]")
    _add_common(p)

    # migrate
    p = sub.add_parser("migrate", help="迁移 JSON → ChromaDB [→ JSON]")
    p.add_argument("--dry-run", action="store_true", help="预览不执行")
    p.add_argument("--swarm-only", action="store_true", help="仅迁移虫群")
    p.add_argument("--reindex", action="store_true", help="从种子/旧集合重建当前 embedding 模式索引")
    p.add_argument("--export-seeds", action="store_true", help="导出现有 Chroma 记忆为 JSONL 养分种子")
    _add_common(p)

    # sense
    p = sub.add_parser("sense", help="感知状态 [→ JSON]")
    _add_common(p)

    # agent
    p_agent = sub.add_parser("agent", help="智能体管理 [→ JSON]")
    a_sub = p_agent.add_subparsers(dest="agent_cmd")
    a1 = a_sub.add_parser("register", help="注册智能体")
    a1.add_argument("--id", required=True)
    a1.add_argument("--type", default="cli")
    a1.add_argument("--capabilities", default="")
    a1.add_argument("--project", "-p", default="")
    _add_common(a1)
    a2 = a_sub.add_parser("list", help="列出智能体")
    _add_common(a2)
    a3 = a_sub.add_parser("stats", help="智能体统计")
    a3.add_argument("--id", required=True)
    _add_common(a3)

    # batch
    p_batch = sub.add_parser("batch", help="IPC 批处理 [→ JSON]")
    b_sub = p_batch.add_subparsers(dest="batch_cmd")
    b1 = b_sub.add_parser("process", help="处理请求队列")
    b1.add_argument("--limit", type=int, default=50)
    b1.add_argument("--clean", action="store_true")
    b1.add_argument("--quiet", "-q", action="store_true")
    _add_common(b1)
    b2 = b_sub.add_parser("submit", help="提交请求")
    b2.add_argument("--agent", "-a", required=True)
    b2.add_argument("--cmd", required=True)
    b2.add_argument("--params", default="{}")
    b2.add_argument("--project", "-p", default="")
    _add_common(b2)
    b3 = b_sub.add_parser("result", help="获取结果")
    b3.add_argument("--id", required=True)
    _add_common(b3)

    # use
    p_use = sub.add_parser("use", help="记忆复用反馈 [→ JSON]")
    u_sub = p_use.add_subparsers(dest="use_cmd")
    u1 = u_sub.add_parser("start", help="开始复用一条记忆")
    u1.add_argument("--memory-id", required=True)
    u1.add_argument("--agent", "-a", required=True)
    u1.add_argument("--problem", required=True)
    u1.add_argument("--project", "-p", default="")
    _add_common(u1)
    u2 = u_sub.add_parser("finish", help="完成复用反馈")
    u2.add_argument("--usage-id", required=True)
    u2.add_argument("--outcome", required=True, choices=["success", "partial", "failure"])
    u2.add_argument("--feedback", default="")
    _add_common(u2)

    # llm
    p_llm = sub.add_parser("llm", help="LLM/免疫操作 [→ JSON]")
    l_sub = p_llm.add_subparsers(dest="llm_cmd")
    l1 = l_sub.add_parser("status", help="LLM 状态")
    _add_common(l1)
    l2 = l_sub.add_parser("validate", help="验证内容安全性")
    l2.add_argument("--content", "-c", default=None)
    l2.add_argument("--agent", "-a", default="unknown")
    _add_common(l2)

    args = parser.parse_args()

    dispatch = {
        "stats": cmd_stats, "remember": cmd_remember, "recall": cmd_recall,
        "share": cmd_share, "query": cmd_query, "store-kb": cmd_store_kb,
        "evolve": cmd_evolve, "sense": cmd_sense, "migrate": cmd_migrate,
    }

    try:
        if args.command in dispatch:
            dispatch[args.command](args)
        elif args.command == "agent":
            ad = {"register": cmd_agent_register, "list": cmd_agent_list, "stats": cmd_agent_stats}
            if args.agent_cmd in ad:
                ad[args.agent_cmd](args)
            else:
                _out(_err("缺少 agent 子命令", code=400))
        elif args.command == "batch":
            bd = {"process": cmd_batch_process, "submit": cmd_batch_submit, "result": cmd_batch_result}
            if args.batch_cmd in bd:
                bd[args.batch_cmd](args)
            else:
                _out(_err("缺少 batch 子命令", code=400))
        elif args.command == "use":
            ud = {"start": cmd_use_start, "finish": cmd_use_finish}
            if args.use_cmd in ud:
                ud[args.use_cmd](args)
            else:
                _out(_err("缺少 use 子命令", code=400))
        elif args.command == "llm":
            ld = {"status": cmd_llm_status, "validate": cmd_llm_validate}
            if args.llm_cmd in ld:
                ld[args.llm_cmd](args)
            else:
                _out(_err("缺少 llm 子命令", code=400))
        else:
            _out(_err("缺少命令", code=400))
    except SystemExit:
        raise
    except Exception as e:
        _out(_err(str(e), code=500, exception=e.__class__.__name__))


if __name__ == "__main__":
    main()
