"""进化引擎 v5 — 服务端驱动的技能持久化与教条沉淀"""
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..config import config
from ..storage.atomic import atomic_write_json
from .decay import calculate_decay, should_archive


class EvolutionEngine:
    """记忆进化引擎：定期提炼虫群经验，升级为高阶知识"""

    def __init__(self, evolution_path: Path, manager):
        self.evolution_path = evolution_path
        self.evolution_path.mkdir(parents=True, exist_ok=True)
        self.manager = manager
        self._history: list[dict] = []
        self._load_history()

    def _history_path(self) -> Path:
        return self.evolution_path / "_evolution_log.json"

    def _load_history(self):
        hp = self._history_path()
        if hp.exists():
            self._history = json.loads(hp.read_text())

    def _save_history(self):
        atomic_write_json(self._history_path(), self._history)

    def evolve(self) -> dict:
        """执行一轮完整进化"""
        result = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
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

    # ==================== 语义去重 ====================

    def _deduplicate_semantic(self, threshold: float = 0.88) -> int:
        """使用向量余弦相似度合并重复记忆"""
        swarm = self.manager.swarm
        mids = swarm.get_all_memory_ids()
        if len(mids) < 2:
            return 0

        # 构建内存缓存：加载所有记忆的 embedding
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

                # 向量余弦相似度（向量已归一化，点积即余弦）
                emb2 = embeddings[mid2]
                sim = sum(a * b for a, b in zip(emb1, emb2))

                if sim < threshold:
                    continue

                # 合并：保留复用次数高的
                if mem1.get("reuse_count", 0) >= mem2.get("reuse_count", 0):
                    keeper, victim = mid1, mid2
                else:
                    keeper, victim = mid2, mid1

                keeper_mem = swarm._load_memory(keeper)
                victim_mem = swarm._load_memory(victim)
                if keeper_mem and victim_mem:
                    keeper_mem["reuse_count"] = keeper_mem.get("reuse_count", 0) + victim_mem.get("reuse_count", 0)
                    keeper_mem["success_count"] = keeper_mem.get("success_count", 0) + victim_mem.get("success_count", 0)
                    keeper_mem["updated"] = datetime.now(timezone.utc).isoformat()
                    # 更新 ChromaDB
                    text = f"{keeper_mem.get('title','')}\n{keeper_mem.get('content','')}\n{keeper_mem.get('problem_solved','')}\n{keeper_mem.get('solution','')}"
                    swarm._store.upsert(keeper, text, keeper_mem)

                swarm.delete_memory(victim)
                processed.add(victim)
                merged += 1

        return merged

    # ==================== 技能持久化 ====================

    def _distill_and_persist(self) -> int:
        """从高频复用经验中提炼技能并写回存储"""
        swarm = self.manager.swarm
        created = 0

        for mid in swarm.get_all_memory_ids():
            mem = swarm._load_memory(mid)
            if not mem:
                continue
            if mem.get("life_stage") in {"quarantined", "archived"}:
                continue
            reuse = mem.get("reuse_count", 0)
            success = mem.get("success_count", 0)

            if reuse < 3 or success / max(reuse, 1) < 0.7:
                continue

            # 检查是否已提炼
            existing = swarm.query(
                f"distilled skill {mem.get('title','')}",
                category="distilled_skill",
                project_id=None,
                limit=1,
            )
            if existing and existing[0].get("score", 0) > 0.5:
                continue

            skill_title = f"[已验证技能] {mem.get('title','')}"
            skill_content = (
                f"问题: {mem.get('problem_solved', mem.get('content',''))}\n"
                f"方案: {mem.get('solution', mem.get('content',''))}\n"
                f"验证: 复用 {reuse} 次, 成功率 {success / reuse:.0%}"
            )
            raw_tags = mem.get("tags", [])
            if isinstance(raw_tags, str):
                raw_tags = [t for t in raw_tags.split(",") if t]
            swarm.share(
                title=skill_title,
                content=skill_content,
                category="distilled_skill",
                tags=raw_tags + ["verified_skill"],
                source_agent="cerebrate-evolution",
                problem_solved=mem.get("problem_solved", ""),
                solution=mem.get("solution", ""),
                outcome="success",
                project_id=mem.get("project_id", ""),
                life_stage="verified_skill",
                confidence=1.0,
                evidence=f"复用 {reuse} 次, 成功率 {success / reuse:.0%}",
                supersedes=[mid],
            )
            created += 1

        return created

    def _distill_doctrines(self) -> int:
        """把跨项目稳定技能固化为脑虫教条。"""
        swarm = self.manager.swarm
        created = 0
        categories: dict[str, set[str]] = {}
        samples: dict[str, dict] = {}
        for mid in swarm.get_all_memory_ids():
            mem = swarm._load_memory(mid)
            if not mem or mem.get("life_stage") not in {"verified_skill", "memory"}:
                continue
            reuse = mem.get("reuse_count", 0)
            success = mem.get("success_count", 0)
            if reuse < 3 or success / max(reuse, 1) < 0.8:
                continue
            cat = mem.get("category", "general")
            categories.setdefault(cat, set()).add(mem.get("project_id", "") or "global")
            samples.setdefault(cat, mem)

        for cat, projects in categories.items():
            if len(projects) < 2:
                continue
            existing = swarm.query(f"doctrine {cat}", category="doctrine", project_id=None, limit=1)
            if existing and existing[0].get("score", 0) > 0.5:
                continue
            sample = samples[cat]
            swarm.share(
                title=f"[脑虫教条] {cat}",
                content=f"跨项目稳定策略: {sample.get('solution') or sample.get('content')}",
                category="doctrine",
                tags=["doctrine", cat],
                source_agent="cerebrate-evolution",
                problem_solved=sample.get("problem_solved", ""),
                solution=sample.get("solution", ""),
                outcome="success",
                project_id="",
                life_stage="doctrine",
                confidence=1.0,
                evidence=f"覆盖项目: {', '.join(sorted(projects))}",
                supersedes=[sample.get("memory_id", "")],
            )
            created += 1
        return created

    # ==================== 衰减清理 ====================

    def _decay_cleanup(self, threshold: float = 0.08) -> int:
        """归档衰减过低的记忆"""
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
                # 标记为已归档（保留在 ChromaDB 但降低分数）
                mem["score"] = 0.01
                mem["deprecated"] = "True"
                mem["life_stage"] = "archived"
                text = f"{mem.get('title','')}\n{mem.get('content','')}\n{mem.get('problem_solved','')}\n{mem.get('solution','')}"
                swarm._store.upsert(mid, text, mem)
                archived += 1

        return archived

    # ==================== 冲突检测 ====================

    def _check_knowledge_conflicts(self) -> list[dict]:
        """检查知识库内部冲突"""
        conflicts = []
        kb = self.manager.knowledge
        policies: dict[str, str] = {}

        for did in kb._store.get_all_ids():
            item = kb._store.get(did)
            if item and item["metadata"].get("is_policy") == "True":
                pname = item["metadata"].get("policy_name", "")
                if pname:
                    if pname.lower() in (k.lower() for k in policies):
                        conflicts.append({
                            "type": "duplicate_policy",
                            "name": pname,
                            "docs": [policies.get(pname.lower(), ""), did],
                        })
                    policies[pname.lower()] = did

        return conflicts

    # ==================== 历史 ====================

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
