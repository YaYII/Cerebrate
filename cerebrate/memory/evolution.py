"""进化引擎 v5 — ChromaDB 持久化 + 服务端驱动的技能沉淀"""
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cerebrate.config import config
from cerebrate.core.decay import calculate_decay, should_archive
from cerebrate.brain.llm import CerebrateLLM


class EvolutionEngine:
    """记忆进化引擎：定期综合整理虫群经验，升级为高阶知识（信息密度只增不减）"""

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

        # ── 蒸馏窗口检查（v5.1.1）：默认仅本地 0:00-1:00（低谷 API 费用）运行 ──
        # force=True（管理员显式/测试）保留逃生门；自动调度严格走窗口。
        from cerebrate.config import in_evolution_window
        if not force:
            if not in_evolution_window():
                return {
                    "timestamp": now.isoformat(),
                    "actions": [],
                    "insights": ["蒸馏窗口未开放（默认本地 0:00-1:00），跳过执行"],
                    "stats": {"clustered": 0, "skills_created": 0, "doctrines_created": 0, "archived": 0, "conflicts": 0},
                    "skipped": True,
                    "reason": "outside_evolution_window",
                }
            if not self.should_evolve():
                return {
                    "timestamp": now.isoformat(),
                    "actions": [],
                    "insights": [f"距上次进化不足 {config.evolution_interval_hours}h，跳过"],
                    "stats": {"clustered": 0, "skills_created": 0, "doctrines_created": 0, "archived": 0, "conflicts": 0},
                    "skipped": True,
                    "reason": "too_soon",
                }

        result = {
            "timestamp": now.isoformat(),
            "actions": [],
            "insights": [],
            "stats": {"clustered": 0, "skills_created": 0, "doctrines_created": 0, "archived": 0, "conflicts": 0},
        }

        merged = self._cluster_semantic()
        result["stats"]["clustered"] = merged
        if merged > 0:
            result["actions"].append(f"标记了 {merged} 条记忆的聚类关联")

        skills = self._distill_and_persist()
        result["stats"]["skills_created"] = skills
        if skills > 0:
            result["actions"].append(f"整合了 {skills} 条技能记忆")

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

        # ── 写入运行日志 ──
        try:
            from cerebrate.brain.logger import get_logger
            log = get_logger()
            skipped = result.get("skipped", False)
            actions = result.get("actions", [])
            stats = result.get("stats", {})
            log.info(
                "evolution",
                "evolve" if not skipped else "evolve_skip",
                "; ".join(actions) if actions else ("跳过: " + result.get("reason", "")),
                details={
                    "skipped": skipped,
                    "reason": result.get("reason", ""),
                    "stats": stats,
                },
            )
        except Exception:
            pass

        return result

    def _cluster_semantic(self, threshold: float = 0.88) -> int:
        """语义聚类：发现相似记忆并标记为同一 cluster，不删除任何记忆。

        每条记忆独立保留、独立检索，通过 cluster_id 元数据关联同类解。
        检索时可通过 diversity_rerank 混合不同 cluster 的结果。
        """
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

        # 检查每条记忆是否已有 cluster_id
        clustered = 0
        processed = set()
        eids = list(embeddings.keys())

        # 当前已分配的 cluster_id 集合，从中选取一个新的偏移量
        existing_clusters: set[str] = set()
        for mem in memories.values():
            cid = mem.get("cluster_id", "")
            if cid:
                existing_clusters.add(cid)

        next_cluster_num = len(existing_clusters) + 1

        for i, mid1 in enumerate(eids):
            if mid1 in processed:
                continue
            emb1 = embeddings[mid1]
            mem1 = memories.get(mid1, {})
            cat1 = mem1.get("category", "")
            # 如果已有 cluster_id，跳过（已在某聚类中）
            if mem1.get("cluster_id"):
                continue

            # 收集该簇成员
            cluster_members = [mid1]
            for mid2 in eids[i + 1:]:
                if mid2 in processed:
                    continue
                mem2 = memories.get(mid2, {})
                if mem2.get("category", "") != cat1:
                    continue
                if mem2.get("cluster_id"):
                    continue  # 已在其他簇中
                emb2 = embeddings[mid2]
                sim = sum(a * b for a, b in zip(emb1, emb2))
                if sim >= threshold:
                    cluster_members.append(mid2)

            if len(cluster_members) < 2:
                processed.add(mid1)
                continue  # 单条记忆不成簇

            # 为该簇分配 cluster_id
            cid = f"cluster_{next_cluster_num}"
            next_cluster_num += 1

            for mid in cluster_members:
                mem = swarm._load_memory(mid)
                if mem:
                    mem["cluster_id"] = cid
                    mem["updated"] = datetime.now(timezone.utc).isoformat()
                    text = f"{mem.get('title', '')}\n{mem.get('content', '')}\n{mem.get('problem_solved', '')}\n{mem.get('solution', '')}"
                    swarm._store.upsert(mid, text, mem)
                processed.add(mid)

            clustered += len(cluster_members)

        return clustered

    def _distill_and_persist(self) -> int:
        swarm = self.manager.swarm
        created = 0

        # ── 收集所有活跃记忆，按主题(tags)分组（全量纳入、权重区分）──
        topic_groups: dict[str, list[dict]] = {}
        for mid in swarm.get_all_memory_ids():
            mem = swarm._load_memory(mid)
            if not mem or mem.get("life_stage") in {"quarantined", "archived"}:
                continue
            reuse = int(mem.get("reuse_count", 0))
            success = int(mem.get("success_count", 0))
            # 全量纳入：不设 reuse 门槛，低复用解以降权方式参与蒸馏
            # 低复用解（reuse<3）的置信度自动降低，但信息不丢失

            raw_tags = mem.get("tags", "")
            if isinstance(raw_tags, list):
                raw_tags = ",".join(raw_tags)
            tags_list = [t.strip() for t in raw_tags.split(",") if t.strip()]

            mem["memory_id"] = mid
            mem["reuse_count"] = reuse
            mem["success_count"] = success
            for tag in tags_list:
                topic_groups.setdefault(tag, []).append(mem)

        # ── 尝试 LLM 综合整合，失败则回退模板 ──
        llm = CerebrateLLM()
        for topic, mems in topic_groups.items():
            # ── 质量门控 ──
            # 全量纳入：至少 2 条即可蒸馏，复用次数低则置信度降权
            if len(mems) < 2:
                continue
            total_reuse = sum(m.get("reuse_count", 0) for m in mems)
            unique_agents = {m.get("source_agent", "") for m in mems if m.get("source_agent")}
            unique_agents.discard("")
            # 低复用组置信度自动降低，但信息不筛选、不丢弃
            confidence_penalty = min(1.0, total_reuse / 5.0)
            # 单代理 → 证据等级降为 B（缺乏交叉验证），但不影响信息完整性
            is_solo = len(unique_agents) < 2

            existing = swarm.query(
                f"distilled skill {topic}",
                category="distilled_skill", project_id=None, scope="all", limit=1,
            )
            if existing and existing[0].get("score", 0) > 0.5:
                continue

            # 收集所有 origin_ids 和 supersedes
            all_origin_ids = set()
            supersedes_ids = []
            for m in mems:
                _raw_oids = m.get("origin_ids") or []
                oids = (_raw_oids.split(",") if isinstance(_raw_oids, str)
                        else list(_raw_oids))
                all_origin_ids.update(o for o in oids if o)
                supersedes_ids.append(m.get("memory_id", ""))

            all_origin_ids.discard("")
            mem_origin_ids = list(all_origin_ids)

            # 尝试 LLM 综合整合
            doc = llm.distill_knowledge(mems, topic) if llm.is_available() else None

            # ── 处理 skip 标记 ──
            if doc and doc.get("skip"):
                continue  # 数据不足以形成知识，跳过

            if doc and doc.get("meta"):
                meta = doc["meta"]
                title = meta.get("title", f"[已验证技能] {topic}")
                confidence = meta.get("confidence", 0.85)
                # ── 构建完整论文级知识文档 ──
                content = self._build_knowledge_document(doc, topic)
                # ── 信息保险：追加原始数据附录，确保零丢失 ──
                content += "\n\n---\n" + self._build_source_appendix(mems)
            else:
                # LLM 不可用，回退模板拼接（呈现所有源方案，不筛选）
                title = f"[已验证技能] {topic}（{len(mems)} 种解法）"
                solution_parts = []
                for i, m in enumerate(mems):
                    ps = m.get("problem_solved", "").strip()
                    sol = m.get("solution", "").strip()
                    src = m.get("source_agent", "unknown")
                    tags = m.get("tags", "")
                    solution_parts.append(
                        f"### 解法 {i+1}（来自 {src} | 标签: {tags}）")
                    if ps:
                        solution_parts.append(f"**场景**: {ps}")
                    if sol:
                        solution_parts.append(f"**方案**: {sol}")
                    solution_parts.append("")
                solution_parts.append(
                    f"> 来源: {len(mems)} 条相关记忆, 总复用 {total_reuse} 次")
                content = "\n".join(solution_parts)
                confidence = 1.0 * max(confidence_penalty, 0.3)

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
                evidence=f"LLM综合整合: {len(mems)}条记忆, 总复用{total_reuse}次, 信息完整保留, {'单源验证(B级)' if is_solo else '交叉验证(A级)'}" if doc else f"模板整合: {len(mems)}条记忆, 总复用{total_reuse}次",
                supersedes=supersedes_ids,
                origin_ids=mem_origin_ids,
            )
            created += 1

        return created

    def _distill_doctrines(self) -> int:
        """跨项目知识综合整合：将已验证的技能综合为脑虫教条。
        信息密度只增不减——所有源记忆的完整内容保留在教条文档中。"""
        swarm = self.manager.swarm
        created = 0

        # ── 收集所有可用记忆，按 category 分组（全量纳入、权重区分）──
        cat_groups: dict[str, list[dict]] = {}
        for mid in swarm.get_all_memory_ids():
            mem = swarm._load_memory(mid)
            if not mem or mem.get("life_stage") not in {"verified_skill", "memory"}:
                continue
            reuse = int(mem.get("reuse_count", 0))
            success = int(mem.get("success_count", 0))
            # 不设 reuse 门槛，低复用解以降权方式参与教条固化
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
            total_reuse = sum(m.get("reuse_count", 0) for m in mems)
            # 教条置信度：复用次数越高的模式置信度越高，但不设硬门槛
            doctrine_confidence_penalty = min(1.0, total_reuse / 10.0)

            existing = swarm.query(
                f"doctrine {cat}", category="doctrine", project_id=None,
                scope="all", limit=1)
            if existing and existing[0].get("score", 0) > 0.5:
                continue

            # 收集 origin_ids
            all_origin_ids = set()
            supersedes_ids = []
            for m in mems:
                _raw_oids = m.get("origin_ids") or []
                oids = (_raw_oids.split(",") if isinstance(_raw_oids, str)
                        else list(_raw_oids))
                all_origin_ids.update(o for o in oids if o)
                supersedes_ids.append(m.get("memory_id", ""))
            all_origin_ids.discard("")
            mem_origin_ids = list(all_origin_ids)

            # 尝试 LLM 综合整合
            doc = llm.distill_knowledge(mems, cat) if llm.is_available() else None

            # ── 处理 skip 标记 ──
            if doc and doc.get("skip"):
                continue

            if doc and doc.get("meta"):
                meta = doc["meta"]
                title = meta.get("title", f"[脑虫教条] {cat}")
                confidence = meta.get("confidence", 0.9) * doctrine_confidence_penalty
                content = self._build_knowledge_document(doc, cat)
                # ── 信息保险：追加原始数据附录，确保零丢失 ──
                content += "\n\n---\n" + self._build_source_appendix(mems)
            else:
                title = f"[脑虫教条] {cat}（{len(mems)} 种经验）"
                content_parts = [f"## 跨项目稳定策略（{len(mems)} 条经验，{len(projects)} 个项目）"]
                for i, m in enumerate(mems):
                    ps = m.get("problem_solved", "").strip()
                    sol = m.get("solution", "").strip()
                    pid = m.get("project_id", "global") or "global"
                    content_parts.append(f"### 经验 {i+1}（项目: {pid}）")
                    if ps:
                        content_parts.append(f"**场景**: {ps}")
                    if sol:
                        content_parts.append(f"**方案**: {sol}")
                    content_parts.append("")
                content = "\n".join(content_parts)
                confidence = 1.0 * max(doctrine_confidence_penalty, 0.3)

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
                evidence=f"LLM综合整合: {len(mems)}条记忆, {len(projects)}个项目, 完整保留, 置信度{confidence:.0%}" if doc else f"覆盖项目: {', '.join(sorted(projects))}",
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

    def get_last_evolution_time(self) -> Optional[str]:
        if self._history:
            return self._history[-1].get("timestamp")
        return None

    @staticmethod
    def _build_source_appendix(mems: list[dict]) -> str:
        """构建原始数据附录：完整保留每条源记忆的原始内容，确保信息零丢失。"""
        parts = ["## 附录：原始数据全集"]
        parts.append("")
        for i, m in enumerate(mems):
            parts.append(f"### 记忆源 #{i+1}")
            parts.append(f"- **记忆ID**: {m.get('memory_id', '')}")
            parts.append(f"- **标题**: {m.get('title', '')}")
            parts.append(f"- **来源**: {m.get('source_agent', '')} | {m.get('physical_user', '')}")
            parts.append(f"- **标签**: {m.get('tags', '')}")
            parts.append(f"- **复用次数**: {m.get('reuse_count', 0)}")
            parts.append(f"- **成功率**: {m.get('success_count', 0)}/{m.get('reuse_count', 0)}")
            parts.append("")
            problem = m.get("problem_solved", "").strip()
            if problem:
                parts.append("**问题场景**:")
                parts.append(problem)
                parts.append("")
            solution = m.get("solution", "").strip()
            if solution:
                parts.append("**解决方案**:")
                parts.append(solution)
                parts.append("")
            content = m.get("content", "").strip()
            if content:
                parts.append("**完整内容**:")
                parts.append(content)
                parts.append("")
            parts.append("---")
            parts.append("")
        return "\n".join(parts)

    @staticmethod
    def _build_knowledge_document(doc: dict, topic: str) -> str:
        """将 LLM 综合整合返回的完整四级结构序列化为论文级 Markdown 文档。
        所有源记忆的原始内容保留在附录中，实现信息零丢失。"""
        parts = []

        meta = doc.get("meta", {})
        title = meta.get("title", topic)
        parts.append(f"# {title}")
        parts.append(f"> 版本: {meta.get('version','1.0.0')} | "
                      f"来源记忆: {meta.get('source_count',0)}条 | "
                      f"总复用: {meta.get('total_reuse',0)}次 | "
                      f"置信度: {meta.get('confidence',0):.0%}")
        parts.append("")

        abstract = doc.get("abstract", "")
        if abstract:
            parts.append("## 摘要")
            parts.append(abstract)
            parts.append("")

        # 概念层
        concept = doc.get("concept_layer", {})
        if concept.get("concepts"):
            parts.append("## 1. 核心概念")
            for c in concept["concepts"]:
                lvl = c.get("evidence_level", "B")
                refs = c.get("refs", [])
                ref_str = f" → [记忆源{','.join(str(r) for r in refs)}]" if refs else ""
                parts.append(f"### {c.get('term','')} [{lvl}级]{ref_str}")
                parts.append(c.get("definition", ""))
                parts.append("")

        # 原理层
        principle = doc.get("principle_layer", {})
        if principle.get("root_causes"):
            parts.append("## 2. 根因分析")
            for rc in principle["root_causes"]:
                lvl = rc.get("evidence_level", "B")
                refs = rc.get("refs", [])
                ref_str = f" [记忆源{','.join(str(r) for r in refs)}]" if refs else ""
                parts.append(f"### {rc.get('cause','')} [{lvl}级]{ref_str}")
                mech = rc.get("mechanism", "")
                if mech:
                    parts.append(f"触发机制: {mech}")
                parts.append("")

        # 方法论层
        meth = doc.get("methodology_layer", {})
        if meth.get("patterns"):
            parts.append(f"## 3. 多种解法（{len(meth['patterns'])} 种并行方案）")
            for i, p in enumerate(meth["patterns"]):
                lvl = p.get("evidence_level", "B")
                refs = p.get("refs", [])
                ref_str = f" [记忆源{','.join(str(r) for r in refs)}]" if refs else ""
                scenario = p.get("scenario", "") or p.get("preconditions", "")
                scenario_tag = f" — 适用场景: {scenario}" if scenario else ""
                parts.append(f"### 3.{i+1} {p.get('name','解法')} [{lvl}级]{ref_str}{scenario_tag}")
                pre = p.get("preconditions", "")
                if pre and not pre == scenario:
                    parts.append(f"**前置条件**: {pre}")
                steps = p.get("steps", [])
                if steps:
                    parts.append("**步骤**:")
                    for j, s in enumerate(steps):
                        parts.append(f"  {j+1}. {s}")
                outcome = p.get("expected_outcome", "")
                if outcome:
                    parts.append(f"**预期结果**: {outcome}")
                parts.append("")

        # 实践层
        practice = doc.get("practice_layer", {})
        if practice.get("guides"):
            parts.append(f"## 4. 场景操作指南（{len(practice['guides'])} 种场景）")
            for g in practice["guides"]:
                lvl = g.get("evidence_level", "B")
                refs = g.get("refs", [])
                ref_str = f" [记忆源{','.join(str(r) for r in refs)}]" if refs else ""
                parts.append(f"### {g.get('scenario','')} [{lvl}级]{ref_str}")
                cmds = g.get("commands", [])
                if cmds:
                    parts.append("```bash")
                    for cmd in cmds:
                        parts.append(cmd)
                    parts.append("```")
                verify = g.get("verification", "")
                if verify:
                    parts.append(f"**验证**: {verify}")
                rollback = g.get("rollback", "")
                if rollback:
                    parts.append(f"**回滚**: {rollback}")
                parts.append("")

        # 陷阱
        pits = doc.get("pitfalls_and_edge_cases", [])
        if pits:
            parts.append("## 5. 注意事项与边界情况")
            for p in pits:
                refs = p.get("refs", [])
                ref_str = f" [记忆源{','.join(str(r) for r in refs)}]" if refs else ""
                parts.append(f"### ⚠ {p.get('description','')}{ref_str}")
                cons = p.get("consequence", "")
                if cons:
                    parts.append(f"**后果**: {cons}")
                mit = p.get("mitigation", "")
                if mit:
                    parts.append(f"**缓解**: {mit}")
                parts.append("")

        # 知识图谱
        graph = doc.get("knowledge_graph", {})
        if graph:
            prereqs = graph.get("prerequisites", [])
            related = graph.get("related_topics", [])
            conflicts = graph.get("conflicts", [])
            if prereqs or related or conflicts:
                parts.append("## 6. 知识关联")
                if prereqs:
                    parts.append(f"**前置知识**: {', '.join(prereqs)}")
                if related:
                    parts.append(f"**相关主题**: {', '.join(related)}")
                if conflicts:
                    parts.append("**已知矛盾**:")
                    for c in conflicts:
                        parts.append(f"  - {c}")
                parts.append("")

        # 参考文献
        refs = doc.get("references", [])
        if refs:
            parts.append("## 7. 参考文献")
            for r in refs:
                parts.append(f"- [{r.get('index','?')}] {r.get('title','')} "
                             f"({r.get('memory_id','')}): {r.get('contribution','')}")
            parts.append("")

        # 可复现性
        repro = doc.get("reproducibility", {})
        if repro:
            parts.append("## 8. 可复现性")
            parts.append(f"- 可复现: {'是' if repro.get('can_reproduce') else '否'}")
            parts.append(f"- 预估耗时: {repro.get('estimated_time','未知')}")
            parts.append(f"- 所需环境: {repro.get('required_env','未知')}")
            parts.append("")

        return "\n".join(parts)

    def should_evolve(self, interval_hours: int = 24) -> bool:
        last = self.get_last_evolution_time()
        if not last:
            return True
        try:
            last_time = datetime.fromisoformat(last)
            return (datetime.now(timezone.utc) - last_time.replace(tzinfo=timezone.utc)).total_seconds() > interval_hours * 3600
        except (ValueError, TypeError):
            return True
