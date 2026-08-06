#!/usr/bin/env python3
"""全面进化（多线程版）：并行蒸馏所有未处理的 memory 分类。

每个分类独立成一线程，最大并发 3 防止 API 限流。
每完成一个分类立即写入虫群，互不等待。
"""
import sys
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from cerebrate.config import config
from cerebrate.memory.manager import MemoryManager
from cerebrate.memory.evolution import EvolutionEngine
from cerebrate.brain.llm import CerebrateLLM

logging.basicConfig(level=logging.INFO, format="%(message)s",
                    filename="/tmp/evolution_parallel.log", filemode="w")
log = logging.getLogger("evolution")

# 写锁：swarm.share（Chromadb）不是完全线程安全的
_write_lock = threading.Lock()


def distill_category(cat: str, mems: list[dict]) -> dict:
    """蒸馏单个分类（在线程池中执行）。"""
    from cerebrate.config import config
    from cerebrate.memory.manager import MemoryManager
    from cerebrate.memory.evolution import EvolutionEngine
    from cerebrate.brain.llm import CerebrateLLM
    import logging as _log

    _log.basicConfig(level=_log.INFO, format="%(message)s")
    log_inner = _log.getLogger(f"distill.{cat}")

    total_reuse = sum(m.get("reuse_count", 0) for m in mems)
    log_inner.info(f"📦 [{cat}] {len(mems)} 条记忆, 总复用 {total_reuse}")

    llm = CerebrateLLM()
    log_inner.info(f"  🚀 开始链式蒸馏 ({len(mems)}条)...")
    doc = llm.chain_distill_knowledge(mems, cat)

    if doc is None:
        return {"cat": cat, "status": "error", "reason": "LLM 不可用"}
    if doc.get("skip"):
        return {"cat": cat, "status": "skip", "reason": doc.get("reason", "")}

    meta = doc.get("meta", {})
    title = meta.get("title", f"[{cat}] 工程实战知识体系")
    total_reuse_all = sum(m.get("reuse_count", 0) for m in mems)
    unique_agents = {m.get("source_agent", "") for m in mems if m.get("source_agent")}
    unique_agents.discard("")
    confidence_penalty = min(1.0, total_reuse_all / 5.0)
    confidence = meta.get("confidence", 0.85) * confidence_penalty

    content = EvolutionEngine._build_knowledge_document(doc, cat)
    content += "\n\n---\n" + EvolutionEngine._build_source_appendix(mems)

    all_tags = {"verified_skill", cat}
    for m in mems:
        rt = m.get("tags", "")
        if isinstance(rt, str):
            all_tags.update(t for t in rt.split(",") if t)

    all_origin_ids = set()
    supersedes_ids = []
    for m in mems:
        oids_raw = m.get("origin_ids") or ""
        if isinstance(oids_raw, list):
            oids_list = oids_raw
        elif isinstance(oids_raw, str):
            oids_list = oids_raw.split(",")
        else:
            oids_list = []
        all_origin_ids.update(o for o in oids_list if o and o.strip())
        supersedes_ids.append(m.get("memory_id", ""))
    all_origin_ids.discard("")

    # 写入虫群（加锁）
    mm = MemoryManager(config.personal_path, config.swarm_path, config.knowledge_path)
    with _write_lock:
        memory_id = mm.swarm.share(
            title=title, content=content, category="distilled_skill",
            tags=list(all_tags), source_agent="cerebrate-evolution",
            problem_solved=f"{cat} 领域工程实战经验与最佳实践",
            solution=f"综合自 {len(mems)} 条实战经验",
            outcome="success", project_id="", life_stage="verified_skill",
            confidence=confidence,
            evidence=f"LLM多线程链式整合: {len(mems)}条记忆, 完整保留, 置信度{confidence:.0%}",
            supersedes=supersedes_ids, origin_ids=sorted(all_origin_ids),
        )

    return {
        "cat": cat,
        "status": "success",
        "memory_id": memory_id[:12],
        "title": title,
        "confidence": f"{confidence:.0%}",
        "source_count": len(mems),
    }


def main():
    mm = MemoryManager(config.personal_path, config.swarm_path, config.knowledge_path)
    swarm = mm.swarm

    # 收集所有 memory
    cat_groups: dict[str, list[dict]] = {}
    for mid in swarm.get_all_memory_ids():
        mem = swarm._load_memory(mid)
        if not mem:
            continue
        if mem.get("life_stage") not in {"memory"}:
            continue
        cat = mem.get("category", "general")
        mem["memory_id"] = mid
        cat_groups.setdefault(cat, []).append(mem)

    sorted_cats = sorted(cat_groups.items(), key=lambda x: -len(x[1]))
    candidates = [(cat, mems) for cat, mems in sorted_cats if len(mems) >= 2]

    log.info(f"=== 全面进化（多线程）启动 ===")
    log.info(f"可进化分类: {len(candidates)} 个")
    log.info(f"并发数: 3（防止 API 限流）")
    log.info("")

    # 检查已有蒸馏结果，跳过已存在的
    to_process = []
    for cat, mems in candidates:
        existing = swarm.query(f"distilled {cat}", category="distilled_skill",
                                project_id=None, limit=1)
        if existing and existing[0].get("score", 0) > 0.5:
            log.info(f"⏭️  [{cat}] 已有蒸馏结果 (score={existing[0].get('score',0):.2f})，跳过")
            continue
        to_process.append((cat, mems))

    log.info(f"需处理: {len(to_process)} 个分类")
    log.info("")

    if not to_process:
        log.info("🎉 全部已蒸馏，无事可做")
        return

    results = []
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(distill_category, cat, mems): cat
            for cat, mems in to_process
        }
        for future in as_completed(futures):
            cat = futures[future]
            try:
                result = future.result()
                results.append(result)
                if result["status"] == "success":
                    log.info(f"✅ [{cat}] {result['title'][:40]} → {result['memory_id']} (置信度{result['confidence']})")
                elif result["status"] == "skip":
                    log.info(f"⏭️  [{cat}] LLM 跳过: {result.get('reason','')}")
                else:
                    log.info(f"❌ [{cat}] 失败: {result.get('reason','')}")
            except Exception as e:
                log.info(f"❌ [{cat}] 异常: {e}")
                results.append({"cat": cat, "status": "error", "reason": str(e)})

    log.info("")
    log.info(f"=== 全面进化结束 ===")
    successes = [r for r in results if r["status"] == "success"]
    log.info(f"成功: {len(successes)} / {len(to_process)}")
    for r in successes:
        log.info(f"  ✅ {r['cat']}: {r['title'][:40]}")

    print(f"DONE:{len(successes)}/{len(to_process)}", flush=True)


if __name__ == "__main__":
    main()
