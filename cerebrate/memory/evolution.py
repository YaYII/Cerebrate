"""进化引擎 v5 — ChromaDB 持久化 + 服务端驱动的技能沉淀"""
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cerebrate.config import config
from cerebrate.core.decay import calculate_decay, should_archive
from cerebrate.brain.llm import CerebrateLLM


class EvolutionEngine:
    """记忆进化引擎：定期提炼虫群经验，升级为高阶知识"""

    EVO_LOG_DOC = "evolution_log"

    def __init__(self, evolution_path: Path, manager):
        self.evolution_path = evolution_path
        self.manager = manager
        self._store = None
        self._history: list[dict] = []
        self._load_history()

    def _get_store(self):
        if self._store is not None:
            return self._store
        from cerebrate.core.embedding import get_embedding_engine
        from cerebrate.core.storage import ChromaStore
        engine = get_embedding_engine(
            config.embedding_model, config.embedding_device)
        self._store = ChromaStore(config.chroma_path, "evolution_logs", engine)
        return self._store

    def _load_history(self):
        store = self._get_store()
        item = store.get(self.EVO_LOG_DOC)
        if item:
            history_str = item["metadata"].get("history", "[]")
            try:
                self._history = json.loads(history_str)
            except json.JSONDecodeError:
                self._history = []

    def _save_history(self):
        store = self._get_store()
        meta = {
            "history": json.dumps(self._history, ensure_ascii=False),
            "updated": datetime.now(timezone.utc).isoformat(),
            "count": len(self._history),
        }
        store.upsert(self.EVO_LOG_DOC, "evolution history log", meta)

    def evolve(self, force: bool = False) -> dict:
        now = datetime.now(timezone.utc)

        # ── 时间窗口检查：仅在 21:00-09:00 (晚9到早9) 之间运行 ──
        if not force:
            hour = now.hour
            in_window = (hour >= 21 or hour < 9)
            if not in_window:
                return {
                    "timestamp": now.isoformat(),
                    "actions": [],
                    "insights": ["进化窗口未开放（21:00-09:00），跳过执行"],
                    "stats": {"merged": 0, "skills_created": 0, "doctrines_created": 0, "archived": 0, "conflicts": 0},
                    "skipped": True,
                    "reason": "outside_evolution_window",
                }
            if not self.should_evolve():
                return {
                    "timestamp": now.isoformat(),
                    "actions": [],
                    "insights": [f"距上次进化不足 {config.evolution_interval_hours}h，跳过"],
                    "stats": {"merged": 0, "skills_created": 0, "doctrines_created": 0, "archived": 0, "conflicts": 0},
                    "skipped": True,
                    "reason": "too_soon",
                }

        result = {
            "timestamp": now.isoformat(),
            "actions": [],
            "insights": [],
            "stats": {"merged": 0, "skills_created": 0, "doctrines_created": 0, "archived": 0, "conflicts": 0},
        }

        merged = self._deduplicate_semantic()
        result["stats"]["merged"] = merged
        if merged > 0:
            result["actions"].append(f"合并了 {merged} 条语义相似的虫群记忆")

        skills = self._distill_and_persist()
        result["stats"]["skills_created"] = skills
        if skills > 0:
            result["actions"].append(f"提炼出 {skills} 条技能记忆")

        doctrines = self._distill_doctrines()
        result["stats"]["doctrines_created"] = doctrines
        if doctrines > 0:
            result["actions"].append(f"固化了 {doctrines} 条脑虫教条")

        archived = self._decay_cleanup()
        result["stats"]["archived"] = archived
        if archived > 0:
            result["actions"].append(f"归档了 {archived} 条过期记忆")

        conflicts = self._check_knowledge_conflicts()
        result["stats"]["conflicts"] = len(conflicts)
        if conflicts:
            result["actions"].append(f"发现 {len(conflicts)} 处知识库冲突")

        self._history.append(result)
        if len(self._history) > 500:
            self._history = self._history[-200:]
        self._save_history()
        return result

    def _deduplicate_semantic(self, threshold: float = 0.88) -> int:
        swarm = self.manager.swarm
        mids = swarm.get_all_memory_ids()
        if len(mids) < 2:
            return 0

        embeddings: dict[str, list[float]] = {}
        memories: dict[str, dict] = {}
        for mid in mids:
            item = swarm._store.get(mid)
            if item and item.get("embedding") is not None:
                embeddings[mid] = item["embedding"]
                memories[mid] = item["metadata"]
                memories[mid]["memory_id"] = mid

        if len(embeddings) < 2:
            return 0

        merged = 0
        processed = set()
        eids = list(embeddings.keys())

        for i, mid1 in enumerate(eids):
            if mid1 in processed:
                continue
            emb1 = embeddings[mid1]
            mem1 = memories.get(mid1, {})
            cat1 = mem1.get("category", "")

            for mid2 in eids[i + 1:]:
                if mid2 in processed:
                    continue
                mem2 = memories.get(mid2, {})
                if mem2.get("category", "") != cat1:
                    continue

                emb2 = embeddings[mid2]
                sim = sum(a * b for a, b in zip(emb1, emb2))

                if sim < threshold:
                    continue

                if mem1.get("reuse_count", 0) >= mem2.get("reuse_count", 0):
                    keeper, victim = mid1, mid2
                else:
                    keeper, victim = mid2, mid1

                keeper_mem = swarm._load_memory(keeper)
                victim_mem = swarm._load_memory(victim)
                if keeper_mem and victim_mem:
                    keeper_mem["reuse_count"] = keeper_mem.get(
                        "reuse_count", 0) + victim_mem.get("reuse_count", 0)
                    keeper_mem["success_count"] = keeper_mem.get(
                        "success_count", 0) + victim_mem.get("success_count", 0)
                    # ── 合并 origin_ids：保留者吸收被合并者的原始来源 ──
                    keeper_origins = set((keeper_mem.get("origin_ids") or "").split(","))
                    victim_origins = set((victim_mem.get("origin_ids") or "").split(","))
                    keeper_origins.discard("")
                    victim_origins.discard("")
                    all_origins = keeper_origins | victim_origins
                    keeper_mem["origin_ids"] = ",".join(sorted(all_origins))
                    keeper_mem["updated"] = datetime.now(
                        timezone.utc).isoformat()
                    text = f"{keeper_mem.get('title', '')}\n{keeper_mem.get('content', '')}\n{keeper_mem.get('problem_solved', '')}\n{keeper_mem.get('solution', '')}"
                    swarm._store.upsert(keeper, text, keeper_mem)

                swarm.delete_memory(victim)
                processed.add(victim)
                merged += 1

        return merged

    def _distill_and_persist(self) -> int:
        swarm = self.manager.swarm
        created = 0

        # ── 收集高复用记忆，按主题(tags)分组 ──
        topic_groups: dict[str, list[dict]] = {}
        for mid in swarm.get_all_memory_ids():
            mem = swarm._load_memory(mid)
            if not mem or mem.get("life_stage") in {"quarantined", "archived"}:
                continue
            reuse = int(mem.get("reuse_count", 0))
            success = int(mem.get("success_count", 0))
            if reuse < 3 or success / max(reuse, 1) < 0.7:
                continue

            raw_tags = mem.get("tags", "")
            if isinstance(raw_tags, list):
                raw_tags = ",".join(raw_tags)
            tags_list = [t.strip() for t in raw_tags.split(",") if t.strip()]

            mem["memory_id"] = mid
            mem["reuse_count"] = reuse
            mem["success_count"] = success
            for tag in tags_list:
                topic_groups.setdefault(tag, []).append(mem)

        # ── 尝试 LLM 蒸馏，失败则回退模板 ──
        llm = CerebrateLLM()
        for topic, mems in topic_groups.items():
            # ── 质量门控：记忆数量、复用次数、代理多样性 ──
            if len(mems) < 3:
                continue
            total_reuse = sum(m.get("reuse_count", 0) for m in mems)
            if total_reuse < 5:
                continue
            unique_agents = {m.get("source_agent", "") for m in mems if m.get("source_agent")}
            unique_agents.discard("")
            if len(unique_agents) < 2:
                continue

            existing = swarm.query(
                f"distilled skill {topic}",
                category="distilled_skill", project_id=None, limit=1,
            )
            if existing and existing[0].get("score", 0) > 0.5:
                continue

            # 收集所有 origin_ids 和 supersedes
            all_origin_ids = set()
            supersedes_ids = []
            for m in mems:
                oids = (m.get("origin_ids") or "").split(",")
                all_origin_ids.update(o for o in oids if o)
                supersedes_ids.append(m.get("memory_id", ""))

            all_origin_ids.discard("")
            mem_origin_ids = list(all_origin_ids)

            # 尝试 LLM 蒸馏
            doc = llm.distill_knowledge(mems, topic) if llm.is_available() else None

            # ── 处理 skip 标记 ──
            if doc and doc.get("skip"):
                continue  # 数据不足以形成知识，跳过

            if doc and doc.get("meta"):
                meta = doc["meta"]
                title = meta.get("title", f"[已验证技能] {topic}")
                abstract = doc.get("abstract", "")
                content_parts = [abstract] if abstract else []
                # 方法论
                meth = doc.get("methodology_layer", {})
                for p in meth.get("patterns", []):
                    steps = "\n".join(f"  {i+1}. {s}" for i, s in enumerate(p.get("steps", [])))
                    content_parts.append(f"## {p.get('name', '模式')} [{p.get('evidence_level','B')}级]")
                    content_parts.append(steps)
                # 陷阱
                pits = doc.get("pitfalls_and_edge_cases", [])
                if pits:
                    content_parts.append("## 注意事项")
                    for p in pits:
                        content_parts.append(f"- ⚠ {p.get('description','')}: {p.get('mitigation','')}")
                content = "\n\n".join(content_parts) or abstract or f"蒸馏主题: {topic}"
                confidence = meta.get("confidence", 0.85)
            else:
                # LLM 不可用，回退模板拼接
                best = mems[0]
                title = f"[已验证技能] {topic}"
                content = f"问题: {best.get('problem_solved', best.get('content',''))}\n方案: {best.get('solution', best.get('content',''))}\n来源: {len(mems)} 条相关记忆, 总复用 {total_reuse} 次"
                confidence = 1.0

            # 收集 tags
            all_tags = {"verified_skill", topic}
            for m in mems:
                rt = m.get("tags", "")
                if isinstance(rt, str):
                    all_tags.update(t for t in rt.split(",") if t)

            swarm.share(
                title=title, content=content,
                category="distilled_skill",
                tags=list(all_tags),
                source_agent="cerebrate-evolution",
                problem_solved=mems[0].get("problem_solved", ""),
                solution=mems[0].get("solution", ""),
                outcome="success",
                project_id="",
                life_stage="verified_skill",
                confidence=confidence,
                evidence=f"LLM蒸馏: {len(mems)}条记忆, 总复用{total_reuse}次" if doc else f"模板蒸馏: {len(mems)}条记忆",
                supersedes=supersedes_ids,
                origin_ids=mem_origin_ids,
            )
            created += 1

        return created

    def _distill_doctrines(self) -> int:
        swarm = self.manager.swarm
        created = 0

        # ── 收集高复用记忆，按 category 分组 ──
        cat_groups: dict[str, list[dict]] = {}
        for mid in swarm.get_all_memory_ids():
            mem = swarm._load_memory(mid)
            if not mem or mem.get("life_stage") not in {"verified_skill", "memory"}:
                continue
            reuse = int(mem.get("reuse_count", 0))
            success = int(mem.get("success_count", 0))
            if reuse < 3 or success / max(reuse, 1) < 0.8:
                continue
            cat = mem.get("category", "general")
            mem["memory_id"] = mid
            mem["reuse_count"] = reuse
            mem["success_count"] = success
            cat_groups.setdefault(cat, []).append(mem)

        llm = CerebrateLLM()
        for cat, mems in cat_groups.items():
            projects = {m.get("project_id", "") or "global" for m in mems}
            if len(projects) < 2:
                continue

            existing = swarm.query(
                f"doctrine {cat}", category="doctrine", project_id=None, limit=1)
            if existing and existing[0].get("score", 0) > 0.5:
                continue

            # 收集 origin_ids
            all_origin_ids = set()
            supersedes_ids = []
            for m in mems:
                oids = (m.get("origin_ids") or "").split(",")
                all_origin_ids.update(o for o in oids if o)
                supersedes_ids.append(m.get("memory_id", ""))
            all_origin_ids.discard("")
            mem_origin_ids = list(all_origin_ids)

            # 尝试 LLM 蒸馏
            doc = llm.distill_knowledge(mems, cat) if llm.is_available() else None

            # ── 处理 skip 标记 ──
            if doc and doc.get("skip"):
                continue

            if doc and doc.get("meta"):
                meta = doc["meta"]
                title = meta.get("title", f"[脑虫教条] {cat}")
                abstract = doc.get("abstract", "")
                content_parts = [abstract] if abstract else []
                principle = doc.get("principle_layer", {})
                for rc in principle.get("root_causes", []):
                    content_parts.append(f"- 根因: {rc.get('cause','')} [{rc.get('evidence_level','B')}级]")
                meth = doc.get("methodology_layer", {})
                for p in meth.get("patterns", []):
                    steps = "\n".join(f"  {i+1}. {s}" for i, s in enumerate(p.get("steps", [])))
                    content_parts.append(f"## {p.get('name','方案')}\n{steps}")
                content = "\n\n".join(content_parts) or abstract or f"跨项目稳定策略: {mems[0].get('solution','')}"
                confidence = meta.get("confidence", 0.9)
            else:
                best = mems[0]
                title = f"[脑虫教条] {cat}"
                content = f"跨项目稳定策略: {best.get('solution') or best.get('content')}\n来源: {len(mems)}条记忆, {len(projects)}个项目"
                confidence = 1.0

            swarm.share(
                title=title, content=content,
                category="doctrine",
                tags=["doctrine", cat],
                source_agent="cerebrate-evolution",
                problem_solved=mems[0].get("problem_solved", ""),
                solution=mems[0].get("solution", ""),
                outcome="success",
                project_id="",
                life_stage="doctrine",
                confidence=confidence,
                evidence=f"LLM蒸馏: {len(mems)}条记忆, {len(projects)}个项目" if doc else f"覆盖项目: {', '.join(sorted(projects))}",
                supersedes=supersedes_ids,
                origin_ids=mem_origin_ids,
            )
            # ── 同步写入权威知识库 ──
            self.manager.knowledge.store(
                title=title,
                content=content,
                source="cerebrate-evolution",
                topics=["doctrine", cat],
                is_policy=True,
                policy_name=cat,
                version="1.0",
                author="cerebrate-evolution",
                project_id="",
            )
            created += 1
        return created

    def _decay_cleanup(self, threshold: float = 0.08) -> int:
        swarm = self.manager.swarm
        archived = 0

        for mid in list(swarm.get_all_memory_ids()):
            mem = swarm._load_memory(mid)
            if not mem:
                continue

            decay = calculate_decay(
                created_at=mem.get("created", ""),
                reuse_count=mem.get("reuse_count", 0),
                success_count=mem.get("success_count", 0),
                half_life_days=config.decay_half_life_days,
                outcome=mem.get("outcome", "success"),
            )

            if should_archive(decay, threshold) and mem.get("life_stage") not in {"verified_skill", "doctrine"}:
                mem["score"] = 0.01
                mem["deprecated"] = "True"
                mem["life_stage"] = "archived"
                text = f"{mem.get('title', '')}\n{mem.get('content', '')}\n{mem.get('problem_solved', '')}\n{mem.get('solution', '')}"
                swarm._store.upsert(mid, text, mem)
                archived += 1

        return archived

    def _check_knowledge_conflicts(self) -> list[dict]:
        conflicts = []
        kb = self.manager.knowledge
        policies: dict[str, str] = {}

        for did in kb._store.get_all_ids():
            item = kb._store.get(did)
            if item and item["metadata"].get("is_policy") == "True":
                pname = item["metadata"].get("policy_name", "")
                if pname:
                    if pname.lower() in {k.lower() for k in policies}:
                        conflicts.append({
                            "type": "duplicate_policy",
                            "name": pname,
                            "docs": [policies.get(pname.lower(), ""), did],
                        })
                    policies[pname.lower()] = did

        return conflicts

    def get_history(self, limit: int = 10) -> list[dict]:
        return self._history[-limit:]

    def get_last_evolution_time(self) -> Optional[str]:
        if self._history:
            return self._history[-1].get("timestamp")
        return None

    def should_evolve(self, interval_hours: int = 24) -> bool:
        last = self.get_last_evolution_time()
        if not last:
            return True
        try:
            last_time = datetime.fromisoformat(last)
            return (datetime.now(timezone.utc) - last_time.replace(tzinfo=timezone.utc)).total_seconds() > interval_hours * 3600
        except (ValueError, TypeError):
            return True
