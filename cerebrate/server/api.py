"""Authoritative Cerebrate Brain Server API.

Clients submit observations and requests. The server alone writes group
memory, appends durable events, and controls memory promotion.
"""

import logging
import time
from datetime import datetime, timezone
from typing import Optional

from cerebrate.brain.mind import CerebrateMind, Metacognition
from cerebrate.brain.decision import DecisionRouter
from cerebrate.brain.llm import CerebrateLLM
from cerebrate.brain.events import EventLog
from cerebrate.config import config
from cerebrate.memory import EvolutionEngine, MemoryManager

logger = logging.getLogger(__name__)


def get_manager() -> MemoryManager:
    return MemoryManager(config.personal_path, config.swarm_path, config.knowledge_path)


class BrainAPI:
    """Application service behind HTTP and tests."""

    CLIENT_LIFE_STAGES = {"nutrient", "memory"}

    def __init__(self, manager: Optional[MemoryManager] = None,
                 events: Optional[EventLog] = None):
        self.mm = manager or get_manager()
        self.events = events or EventLog(config.events_path)
        # 人人为我：已自动提取经验的 usage_id 集合，避免重复提取
        self._auto_extracted_usages: set[str] = set()
        # 会话开始高频读接口 TTL 缓存（sense/doctrines 全库统计慢，
        # 团队并发会话开始会排队；缓存后 10 并发几乎即时命中）
        self._sense_cache: Optional[dict] = None
        self._sense_cache_ts: float = 0.0
        self._sense_ttl: float = 60.0
        # 轻量服务状态缓存（调度信号）：5s TTL，无全库统计，AI 感知脑虫状况用
        self._status_cache: Optional[dict] = None
        self._status_cache_ts: float = 0.0
        self._status_ttl: float = 5.0
        self._doctrines_cache: Optional[dict] = None
        self._doctrines_cache_ts: float = 0.0
        self._doctrines_ttl: float = 10.0

    def sense(self) -> dict:
        now = time.monotonic()
        if self._sense_cache is not None and now - self._sense_cache_ts < self._sense_ttl:
            return self._sense_cache
        mind = CerebrateMind(self.mm)
        data = mind.sense()
        data["latest_event_id"] = self.events.latest_id()
        data["server_role"] = "authoritative_brain"
        data["llm"] = CerebrateLLM().status()
        data["consensus"] = self.consensus_overview()
        self._sense_cache = data
        self._sense_cache_ts = now
        return data

    def status(self) -> dict:
        """轻量服务状态（调度信号）：AI 据此决定查询时机与方式。

        与 sense 的区别：不返回 recent_index 等重内容，5 秒 TTL 缓存；
        供 AI「感知脑虫状况 → 综合调度」——可先查代码再查记忆交叉印证，
        不必每次都机械强制先查记忆。
        """
        now = time.monotonic()
        if self._status_cache is not None and now - self._status_cache_ts < self._status_ttl:
            return self._status_cache
        stats = self.mm.get_all_stats()
        swarm = stats.get("swarm", {})
        vector = stats.get("vector", {})
        llm = CerebrateLLM().status()
        embed_mode = vector.get("embedding_mode", "unknown")
        fulltext = bool(config.fulltext_enabled)
        llm_ok = bool(llm.get("available"))
        # 负载信号（O(1) count，不做全量扫描，保持接口轻量）
        try:
            usage_count = self.mm._usage_store().count()
        except Exception:
            usage_count = 0
        try:
            active_agents = len(self.mm.agents.list_active())
        except Exception:
            active_agents = 0
        # 查询向量缓存统计（高频查询复用度）
        try:
            from cerebrate.core.embedding import query_cache_stats
            qcache = query_cache_stats()
        except Exception:
            qcache = {}
        # 建议调度模式（规则驱动，不依赖 LLM）：
        #   full  = bge + LLM 可用 + 无积压 → 可全力查询（先代码后记忆/先记忆后代码都行）
        #   light = embedding 退化 hash 或 FTS 关闭或 LLM 不可用 → 轻量精确检索
        #   defer = 历史使用记录多且并发活跃高 → 先做本地代码调研，记忆查询延后
        if embed_mode == "hash" or not fulltext:
            recommended = "light"
        elif not llm_ok:
            recommended = "light"
        elif usage_count > 2000 and active_agents > 10:
            recommended = "defer"
        else:
            recommended = "full"
        data = {
            "health": "healthy",
            "embedding": {"mode": embed_mode, "fulltext": fulltext},
            "llm": {
                "available": llm_ok,
                "provider": llm.get("provider", ""),
                "immune_enabled": bool(llm.get("immune_enabled")),
            },
            "load": {
                "usage_records": usage_count,
                "active_agents": active_agents,
            },
            "query_cache": qcache,
            "counts": {
                "total_memories": swarm.get("total", 0),
                "kb_docs": vector.get("kb_docs", 0),
            },
            "recommended": recommended,
        }
        self._status_cache = data
        self._status_cache_ts = now
        return data

    def assess(self) -> dict:
        assessment = Metacognition(self.mm).assess()
        assessment["llm"] = CerebrateLLM().status()
        assessment["consensus"] = self.consensus_overview()
        return assessment

    def llm_status(self) -> dict:
        return CerebrateLLM().status()

    def register_agent(self, payload: dict) -> dict:
        agent_id = payload.get("agent_id") or payload.get("id")
        if not agent_id:
            raise ValueError("agent_id is required")
        physical_user = payload.get("physical_user", "")
        info = self.mm.register_agent(
            agent_id=agent_id,
            agent_type=payload.get("agent_type", payload.get("type", "http")),
            capabilities=payload.get("capabilities") or [],
            metadata=payload.get("metadata") or {},
            physical_user=physical_user,
        )
        self.events.append("agent.registered", agent_id,
                           {"agent_id": agent_id,
                            "physical_user": physical_user})
        return info

    def query(self, payload: dict) -> dict:
        query = payload.get("query", "")
        if not query:
            raise ValueError("query is required")
        user_id = payload.get("user") or payload.get(
            "user_id") or payload.get("agent_id") or "default"
        project_id = payload.get("project") or payload.get("project_id")
        scope = payload.get("scope")
        agent_id = payload.get("agent_id", user_id)
        # 渐进式披露：detail 默认 True（向后兼容，返回完整内容 + 决策）；
        # detail=false 时进入索引模式（只返回紧凑索引，token 更省）。
        # 索引层主入口是 POST /v1/search；query 保留"决策 + 全文"的既有契约。
        detail = bool(payload.get("detail", True))
        index_only = not detail
        decision = DecisionRouter(self.mm).decide(
            user_id, query,
            context={"project_id": project_id, "scope": scope,
                     "index_only": index_only})
        swarm = decision.get("swarm_knowledge", {})
        best = swarm.get("best_match")
        related = swarm.get("related", [])
        # ── 构建全量匹配列表，让 AI 智能体能看到所有检索结果 ──
        all_matches = []
        if best:
            all_matches.append(best)
        all_matches.extend(related)
        recommendation = "new_experience"
        task = None
        if best:
            score = best.get("score", 0)
            memory_id = best.get("memory_id") or best.get("id", "")
            if score > 0.5:
                recommendation = "reuse"
                task = self._build_task(
                    "reuse_memory", memory_id, agent_id, query, all_matches,
                    index_only=index_only)
            elif score > 0.2:
                recommendation = "verify"
                task = self._build_task(
                    "verify_reference", memory_id, agent_id, query, all_matches,
                    index_only=index_only)
        if task is None:
            task = self._build_task(
                "solve_fresh", "", agent_id, query, all_matches,
                index_only=index_only)
        if decision.get("policy_result"):
            recommendation = "cite_policy"
            task = {
                "action": "cite_policy",
                "description": "引用权威政策作为参考",
                "policy": decision["policy_result"],
                "instructions": [
                    "1. 仔细阅读政策内容",
                    "2. 将政策作为权威参考应用于当前问题",
                    "3. 解决方案必须符合政策要求"
                ]
            }
        data = {
            "query": query,
            "found": bool(best),
            "swarm_result": best,
            "swarm_results": all_matches,
            "total_matches": len(all_matches),
            "retrieval": {
                "mode": "detail" if detail else "index",
                "layer": 3 if detail else 1,
                "description": (
                    "完整详情模式（默认）：已包含全文内容 + 决策建议。"
                    "若想省 token，请改用 POST /v1/search（索引层）→ "
                    "POST /v1/timeline（上下文层）→ GET /v1/memories/{id}（详情层）。"
                    if detail else
                    "索引模式（detail=false）：只返回紧凑索引，"
                    "完整内容请调用 GET /v1/memories/{memory_id}。"
                ),
            },
            "policy_result": decision.get("policy_result"),
            "personal": decision.get("personal_tone", {}),
            "recommendation": recommendation,
            "task": task,
        }
        self.events.append("memory.queried", payload.get("agent_id", user_id),
                           {"query": query, "recommendation": recommendation,
                            "matches": len(all_matches)},
                           project_id or "")
        return data

    def search(self, payload: dict) -> dict:
        """渐进式披露第 1 层：紧凑索引（不加载全文）。

        对齐 claude-mem search 工具：只返回 memory_id/标题/类型/时间/评分/token成本，
        让 agent 先扫描"存在什么 + 取它要花多少 token"，再决定取哪几条详情。

        mode 参数（Phase 3 混合检索）:
          - hybrid（默认）: FTS5 精确关键词命中优先 + 向量语义召回
          - fts: 仅 FTS5 全文检索（精确关键词，如错误码/命令/函数名）
          - vector: 仅向量语义检索（ChromaDB）
        """
        query = payload.get("query", "")
        if not query:
            raise ValueError("query is required")
        project_id = payload.get("project") or payload.get("project_id")
        scope = payload.get("scope")
        category = payload.get("category")
        tags = payload.get("tags")
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        try:
            limit = min(int(payload.get("limit", 20)), 100)
        except (TypeError, ValueError):
            limit = 20
        agent_id = payload.get("agent_id") or payload.get("user") or "default"
        mode = payload.get("mode", "hybrid")
        if mode not in ("hybrid", "fts", "vector"):
            mode = "hybrid"

        fts_results: list = []
        vec_results: list = []
        if mode in ("hybrid", "fts"):
            fts_results = self.mm.fulltext_query_swarm(
                query_text=query, limit=limit,
                project_id=project_id, scope=scope, category=category)
        if mode in ("hybrid", "vector"):
            vec_results = self.mm.query_swarm(
                query_text=query, category=category, tags=tags, limit=limit,
                project_id=project_id, scope=scope, index_only=True)

        if mode == "hybrid":
            index: list = []
            seen: set[str] = set()
            for r in fts_results:
                mid = r.get("memory_id", "")
                if mid and mid not in seen:
                    seen.add(mid)
                    r["source"] = "fulltext"
                    index.append(r)
            for r in vec_results:
                mid = r.get("memory_id", "")
                if mid and mid not in seen:
                    seen.add(mid)
                    r["source"] = "vector"
                    index.append(r)
            if not index:
                index = vec_results
        elif mode == "fts":
            index = fts_results
        else:
            index = vec_results

        self.events.append("memory.searched", agent_id,
                           {"query": query, "matches": len(index)},
                           project_id or "")
        return {
            "query": query,
            "count": len(index),
            "index": index,
            "retrieval": {
                "mode": "index",
                "layer": 1,
                "search_mode": mode,
                "sources": {
                    "fulltext": len(fts_results),
                    "vector": len(vec_results),
                },
                "next": (
                    "POST /v1/timeline (layer 2, 时序上下文) 或 "
                    "GET /v1/memories/{memory_id} (layer 3, 完整详情)"
                ),
            },
        }

    def rebuild_fulltext(self) -> dict:
        """全量重建 FTS5 全文索引（从 DocStore + ChromaDB）。"""
        result = self.mm.rebuild_fulltext()
        return {
            "status": result.get("status", "ok"),
            "indexed": result.get("indexed", 0),
            "failed": result.get("failed", 0),
            "total": result.get("total", 0),
            "note": "重建后新写入的记忆会自动双写 FTS5；旧记忆通过本命令补齐。",
        }

    def timeline(self, payload: dict) -> dict:
        """渐进式披露第 2 层：围绕 anchor 记忆的时序上下文。

        基于 EventLog 事件流构建"这个方案的前因后果"，
        对齐 claude-mem timeline 工具（anchor + depth_before/depth_after）。
        """
        anchor = payload.get("anchor") or payload.get("memory_id") or ""
        query = payload.get("query", "")
        try:
            depth_before = max(0, min(int(payload.get("depth_before", 3)), 50))
        except (TypeError, ValueError):
            depth_before = 3
        try:
            depth_after = max(0, min(int(payload.get("depth_after", 3)), 50))
        except (TypeError, ValueError):
            depth_after = 3
        project_id = payload.get("project") or payload.get("project_id") or ""
        scope = payload.get("scope", "")

        # 1. 解析 anchor 元信息
        anchor_meta = None
        if anchor:
            anchor_meta = self.mm.get_swarm_memory(anchor)
        elif query:
            idx = self.mm.query_swarm(
                query_text=query, limit=1,
                project_id=project_id or None, scope=scope or None,
                index_only=True)
            if idx:
                anchor = idx[0]["memory_id"]
                anchor_meta = self.mm.get_swarm_memory(anchor)
        if not anchor_meta:
            return {
                "anchor": anchor, "query": query, "found": False,
                "events": [],
                "note": "anchor 记忆不存在，无法构建时间线",
            }

        anchor_created = anchor_meta.get("created", "")
        anchor_project = anchor_meta.get("project_id", "") or project_id
        anchor_scope = anchor_meta.get("scope", "general")
        anchor_title = anchor_meta.get("title", "")

        # 2. 读取最近事件流
        recent = self.events.list_recent(limit=5000)

        # 3. scope 隔离：通用 timeline 只看通用事件；项目 timeline 看同项目 + 通用事件
        relevant = []
        for ev in recent:
            ev_pid = ev.get("project_id", "")
            if anchor_scope == "general":
                if ev_pid not in ("", anchor_project):
                    continue
            else:
                if ev_pid not in ("", anchor_project):
                    continue
            relevant.append(ev)

        # 4. 构建时间线条目
        timeline_events = []
        anchor_pos = -1
        for ev in relevant:
            p = ev["payload"] or {}
            mid = p.get("memory_id") or p.get("id") or ""
            entry = {
                "event_id": ev["event_id"],
                "timestamp": ev["timestamp"],
                "event_type": ev["event_type"],
                "source_agent": ev["source_agent"],
                "project_id": ev["project_id"],
            }
            if mid:
                entry["memory_id"] = mid
            if p.get("title"):
                entry["title"] = p["title"]
            if p.get("query"):
                entry["query"] = p["query"]
            if p.get("recommendation"):
                entry["recommendation"] = p["recommendation"]
            if mid == anchor:
                anchor_pos = len(timeline_events)
            timeline_events.append(entry)

        # 5. 以 anchor 为中心切片窗口
        if anchor_pos < 0:
            start, end = 0, min(len(timeline_events),
                                depth_before + depth_after + 1)
        else:
            start = max(0, anchor_pos - depth_before)
            end = min(len(timeline_events), anchor_pos + depth_after + 1)
        window = timeline_events[start:end]

        return {
            "anchor": anchor,
            "anchor_title": anchor_title,
            "anchor_created": anchor_created,
            "found": True,
            "depth_before": depth_before,
            "depth_after": depth_after,
            "events": window,
            "retrieval": {
                "mode": "timeline",
                "layer": 2,
                "next": "GET /v1/memories/{memory_id} 或 POST /v1/memories/detail 获取完整详情",
            },
        }

    def _link_to_knowledge(self, memory_id: str, title: str, content: str,
                           category: str, tags: list, source_agent: str,
                           physical_user: str, project_id: str):
        """检查新记忆与已有知识库的关联，自动增量追加入库。"""
        try:
            kb_results = self.mm.lookup_knowledge(
                f"{title} {content[:200]}", project_id=project_id)
            if not kb_results or kb_results[0].get("score", 0) < 0.6:
                return  # 无强关联，不更新

            best = kb_results[0]
            doc_id = best.get("doc_id", "")
            if not doc_id:
                return

            # 追加新内容到已有知识文档
            existing_content = best.get("content", "")
            append_text = (
                f"\n\n---\n"
                f"## 增量更新 (来源: {source_agent} | {physical_user})\n"
                f"**场景**: {title}\n"
                f"**补充内容**: {content[:800]}\n"
                f"**关联记忆**: {memory_id}\n"
            )
            updated_content = existing_content + append_text

            # 更新知识库文档（同步 ChromaDB + Markdown 文件）
            self.mm.knowledge.update_document(
                doc_id=doc_id,
                title=best.get("title", title),
                content=updated_content,
                metadata={"source": f"{best.get('source','')},{source_agent}",
                          "author": best.get("author", source_agent)},
            )
        except Exception:
            pass  # 知识关联非关键路径

    @staticmethod
    def _generate_memory_id(title: str, category: str) -> str:
        """预生成 memory_id，与 swarm.share() 中默认逻辑一致。"""
        import hashlib
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        return hashlib.sha256(
            f"{title}{category}{now}".encode()
        ).hexdigest()[:16]

    @staticmethod
    def _build_task(action: str, memory_id: str, agent_id: str, problem: str,
                    all_matches: list = None, index_only: bool = False) -> dict:
        # ── 多结果警告：当虫群返回多条匹配时，在 instructions 开头列出其余匹配 ──
        other_matches_hint = ""
        if all_matches and len(all_matches) > 1:
            others = [m for m in all_matches if (m.get("memory_id") or m.get("id")) != memory_id]
            if others:
                lines = ["虫群返回了多条匹配（共 {} 条），除最佳匹配外还有：".format(len(all_matches))]
                for m in others[:10]:
                    mid = m.get("memory_id") or m.get("id", "?")
                    title = m.get("title", "无标题")
                    sc = m.get("score", 0)
                    lines.append(f"  - [{mid}] {title} (评分:{sc:.3f})")
                other_matches_hint = "\n".join(lines)

        if action == "reuse_memory":
            if index_only:
                inst = [
                    f"1. 调用 GET /v1/memories/{memory_id} 获取完整记忆内容"
                    "（当前为渐进式披露索引层，只返回了标题/评分/token成本）",
                    "2. 读取完整内容作为解决方案",
                ]
            else:
                inst = ["1. 读取记忆内容作为解决方案"]
            if other_matches_hint:
                inst.insert(0, "0. 【多结果警告】" + other_matches_hint)
            inst.extend([
                "3. 执行解决方案中的步骤",
                f"4. 完成后调用 POST /v1/usages/start 记录复用 (memory_id={memory_id}, agent={agent_id})",
                "5. 完成后调用 POST /v1/usages/finish 报告结果"
            ])
            return {
                "action": "reuse_memory",
                "description": "直接复用虫群记忆中的方案",
                "memory_id": memory_id,
                "instructions": inst,
                "next_commands": [
                    {"command": "use start", "method": "POST", "path": "/v1/usages/start",
                     "params": {"memory_id": memory_id, "agent": agent_id, "problem": problem}},
                    {"command": "use finish", "method": "POST", "path": "/v1/usages/finish",
                     "params": {"usage_id": "<from_start_response>", "outcome": "success|partial|failure",
                                "feedback": "<notes>"}},
                ]
            }
        elif action == "verify_reference":
            if index_only:
                inst = [
                    f"1. 调用 GET /v1/memories/{memory_id} 获取完整记忆内容"
                    "（当前为渐进式披露索引层）",
                    "2. 读取完整内容作为参考",
                    "3. 独立验证方案的可行性",
                ]
            else:
                inst = [
                    "1. 读取记忆内容作为参考",
                    "2. 独立验证方案的可行性",
                ]
            if other_matches_hint:
                inst.insert(0, "0. 【多结果警告】" + other_matches_hint)
            inst.extend([
                "4. 根据验证结果调整并执行",
                f"5. 完成后调用 POST /v1/memories/propose 提交新记忆",
                f"6. 可选: 调用 POST /v1/usages/start 记录参考 (memory_id={memory_id}, agent={agent_id})"
            ])
            return {
                "action": "verify_reference",
                "description": "参考虫群记忆，但需独立验证",
                "memory_id": memory_id,
                "instructions": inst,
                "next_commands": [
                    {"command": "memory get", "method": "GET", "path": f"/v1/memories/{memory_id}",
                     "params": {}},
                    {"command": "use start", "method": "POST", "path": "/v1/usages/start",
                     "params": {"memory_id": memory_id, "agent": agent_id, "problem": problem}},
                    {"command": "propose", "method": "POST", "path": "/v1/memories/propose",
                     "params": {"title": "<...>", "content": "<...>", "category": "<...>",
                                "agent_id": agent_id, "problem": problem, "solution": "<...>"}},
                ]
            }
        else:
            return {
                "action": "solve_fresh",
                "description": "新问题，解决后提交新记忆",
                "instructions": [
                    "1. 这是虫群未见过的新问题",
                    "2. 独立分析并解决问题",
                    "3. 完成后调用 POST /v1/memories/propose 提交记忆"
                ],
                "next_commands": [
                    {"command": "propose", "method": "POST", "path": "/v1/memories/propose",
                     "params": {"title": "<...>", "content": "<...>", "category": "<...>",
                                "agent_id": agent_id, "problem": problem, "solution": "<...>"}},
                ]
            }

    def read_logs(self, lines: int = 50, level: str = "",
                   module: str = "") -> dict:
        """读取虫群运行日志。"""
        try:
            from cerebrate.brain.logger import get_logger
            log = get_logger()
            entries = log.read_tail(lines=lines, level=level or None,
                                    module=module or None)
            return {
                "entries": entries,
                "total": len(entries),
                "filters": {
                    "level": level or None,
                    "module": module or None,
                },
            }
        except Exception as e:
            return {"entries": [], "total": 0, "error": str(e)}

    def help(self) -> dict:
        return {
            "server": "Cerebrate Brain Server v5",
            "description": "Memory hub for AI coding agents",
            "protocol": "v5",
            "session_lifecycle": {
                "on_start": ["sense", "doctrines"],
                "on_problem": ["query"],
                "on_solution": ["propose", "use start", "use finish"],
                "on_end": ["evolve"]
            },
            "decision_matrix": {
                "reuse": "score > 0.5 → 直接复用，执行 task.instructions 中的步骤",
                "verify": "score 0.2-0.5 → 参考验证，独立核实后执行",
                "new_experience": "score < 0.2 或 not found → 从头解决，完成后提交新记忆"
            },
            "commands": [
                {
                    "command": "brain assess",
                    "method": "GET",
                    "path": "/v1/brain/assess",
                    "description": "脑虫元认知评估，返回偏见、类别健康、智能体贡献和改进建议",
                    "params": {},
                    "returns": {"hit_rate": 0.0, "recommendations": [], "biases_detected": []}
                },
                {
                    "command": "llm status",
                    "method": "GET",
                    "path": "/v1/llm/status",
                    "description": "查看内置 LLM/免疫系统是否启用以及当前回退模式",
                    "params": {},
                    "returns": {"mode": "rule-only|llm-assisted", "available": False}
                },
                {
                    "command": "sense",
                    "method": "GET",
                    "path": "/v1/sense",
                    "description": "健康检查，获取脑状态",
                    "params": {},
                    "returns": {"health": "ok|degraded", "warnings": [], "total_memories": 0, "total_agents": 0,
                                "latest_event_id": 0, "server_role": "authoritative_brain"}
                },
                {
                    "command": "status",
                    "method": "GET",
                    "path": "/v1/status",
                    "description": "轻量服务状态（调度信号）：embedding/LLM 可用性、负载、查询缓存命中率、建议调度模式 recommended=full|light|defer",
                    "params": {},
                    "returns": {"health": "healthy",
                                "embedding": {"mode": "bge", "fulltext": True},
                                "llm": {"available": True, "provider": "deepseek", "immune_enabled": True},
                                "load": {"usage_records": 0, "active_agents": 0},
                                "query_cache": {"size": 0, "capacity": 512, "hits": 0, "misses": 0, "hit_rate": 0.0},
                                "counts": {"total_memories": 0, "kb_docs": 0},
                                "recommended": "full|light|defer"}
                },
                {
                    "command": "doctrines",
                    "method": "GET",
                    "path": "/v1/doctrines",
                    "description": "获取权威教条",
                    "params": {},
                    "returns": {"doctrines": [], "count": 0}
                },
                {
                    "command": "query",
                    "method": "POST",
                    "path": "/v1/query",
                    "description": "搜索虫群记忆",
                    "params": {"query": "string (required)", "user": "string", "agent_id": "string",
                               "project_id": "string", "scope": "general|project|all（默认按 project_id 推断，未传只查通用记忆）"},
                    "returns": {"found": False, "swarm_result": None, "policy_result": None,
                                "personal": {}, "recommendation": "new_experience|reuse|verify|cite_policy",
                                "task": {"action": "...", "instructions": [], "next_commands": []}}
                },
                {
                    "command": "propose",
                    "method": "POST",
                    "path": "/v1/memories/propose",
                    "description": "提交候选记忆",
                    "params": {"title": "string (required)", "content": "string (required)",
                               "category": "coding|debugging|architecture|devops|performance|security|testing|config",
                               "tags": "comma,separated,tags", "agent_id": "string",
                               "problem": "string", "solution": "string", "project_id": "string",
                               "scope": "general|project（默认按 project_id 推断）",
                               "life_stage": "nutrient|memory", "confidence": 1.0, "evidence": "", "validate": True},
                    "returns": {"memory_id": "string", "life_stage": "string", "agent": "string"}
                },
                {
                    "command": "use start",
                    "method": "POST",
                    "path": "/v1/usages/start",
                    "description": "开始跟踪记忆复用",
                    "params": {"memory_id": "string (required)", "agent": "string (required)",
                               "problem": "string (required)", "project_id": "string"},
                    "returns": {"usage_id": "string"}
                },
                {
                    "command": "use finish",
                    "method": "POST",
                    "path": "/v1/usages/finish",
                    "description": "完成记忆复用跟踪",
                    "params": {"usage_id": "string (required)", "outcome": "success|partial|failure (required)",
                               "feedback": "string"},
                    "returns": {"usage_id": "string", "outcome": "string"}
                },
                {
                    "command": "vote",
                    "method": "POST",
                    "path": "/v1/consensus/vote",
                    "description": "提交共识投票",
                    "params": {"memory_id": "string (required)", "agent": "string (required)",
                               "vote": "support|oppose|abstain (required)",
                               "evidence": "", "confidence": 1.0, "project_id": ""},
                    "returns": {"event_id": 0}
                },
                {
                    "command": "events",
                    "method": "GET",
                    "path": "/v1/events",
                    "description": "读取事件日志",
                    "params": {"cursor": 0, "limit": 100},
                    "returns": {"events": []}
                },
                {
                    "command": "memory get",
                    "method": "GET",
                    "path": "/v1/memories/{memory_id}",
                    "description": "读取指定记忆",
                    "params": {},
                    "returns": {"memory_id": "string", "title": "string", "content": "string"}
                },
                {
                    "command": "consensus",
                    "method": "GET",
                    "path": "/v1/consensus/{memory_id}",
                    "description": "读取某条记忆的共识快照；投票只产生事件，服务端按权重和法定人数裁决",
                    "params": {},
                    "returns": {"decision": "pending|accepted|rejected|split", "votes": {}}
                },
                {
                    "command": "evolve",
                    "method": "POST",
                    "path": "/v1/evolve",
                    "description": "触发脑进化",
                    "params": {},
                    "returns": {"actions": [], "summary": "string"}
                },
                {
                    "command": "register",
                    "method": "POST",
                    "path": "/v1/agents/register",
                    "description": "注册 AI 智能体",
                    "params": {"agent_id": "string (required)", "agent_type": "string",
                               "capabilities": [], "metadata": {}},
                    "returns": {"agent_id": "string"}
                },
                {
                    "command": "personal get",
                    "method": "GET",
                    "path": "/v1/personal",
                    "description": "读取所有用户的个人偏好",
                    "params": {},
                    "returns": {"users": {}}
                },
                {
                    "command": "personal set",
                    "method": "POST",
                    "path": "/v1/personal",
                    "description": "写入用户个人偏好",
                    "params": {"user": "string (required)", "key": "string (required)",
                               "value": "string (required)", "confidence": 1.0},
                    "returns": {"user_id": "string", "key": "string", "stored": True}
                },
                {
                    "command": "batch process",
                    "method": "POST",
                    "path": "/v1/batch/process",
                    "description": "批量处理内存队列",
                    "params": {"limit": 50, "dry_run": False},
                    "returns": {"processed": 0, "limit": 50}
                },
                {
                    "command": "events stream",
                    "method": "GET",
                    "path": "/v1/events/stream",
                    "description": "SSE 事件流广播",
                    "params": {"cursor": 0, "limit": 100, "once": False},
                    "returns": {"event_stream": "text/event-stream"}
                },
            ]
        }

    def propose_memory(self, payload: dict) -> dict:
        title = payload.get("title", "")
        content = payload.get("content", "")
        if not title or not content:
            raise ValueError("title and content are required")

        # ── 记忆质量：内容必须 ≥500 token ──
        from cerebrate.core.chunking import estimate_tokens
        token_count = estimate_tokens(content)
        if token_count < config.memory_min_tokens:
            raise ValueError(
                f"记忆内容不足 {config.memory_min_tokens} token "
                f"（当前 {token_count} token），"
                f"请提供更详细的记忆总结（建议至少 {config.memory_min_tokens} token）"
            )

        tags = payload.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]

        source_agent = payload.get("agent") or payload.get(
            "agent_id") or "unknown"
        # ── 安全溯源：从 agent 注册表获取物理用户身份 ──
        physical_user = payload.get("physical_user") or self.mm.agents.get_physical_user(source_agent) or ""
        if not physical_user:
            raise ValueError("physical_user is required for security traceability; memory write rejected")
        # ── 血缘关系：处理 supersedes 参数（字符串或列表） ──
        supersedes_raw = payload.get("supersedes") or []
        if isinstance(supersedes_raw, str):
            supersedes_raw = [s.strip() for s in supersedes_raw.split(",") if s.strip()]
        project_id = payload.get("project") or payload.get("project_id", "")
        scope = payload.get("scope", "")
        knowledge_type = payload.get("knowledge_type", "")
        requested_stage = payload.get("life_stage", "memory")
        life_stage = requested_stage if requested_stage in self.CLIENT_LIFE_STAGES else "memory"
        confidence = float(payload.get("confidence", 1.0))
        evidence = payload.get("evidence", "")
        validation = None

        if payload.get("validate", True):
            validation = CerebrateLLM().validate_memory(content, source_agent)
            if validation.get("suggested_tags") and not tags:
                tags = validation["suggested_tags"]
            if not validation.get("safe", True):
                life_stage = "quarantined"
                confidence = min(confidence, validation.get("quality", 0.1))
                reason = "; ".join(validation.get("issues", []))
                evidence = (evidence + "\n" if evidence else "") + \
                    f"server immune quarantine: {reason}"

        # ── 结构化字段增强（Phase 4，可选 LLM） ──
        # 规则提取（observation_type/concepts/facts）在 swarm.share 内始终生效；
        # 以下 LLM 增强默认关闭（写路径零额外延迟），开启后压缩标题/提取结构化字段
        observation_type = payload.get("observation_type", "")
        facts = payload.get("facts")
        concepts = payload.get("concepts")
        if isinstance(facts, str):
            facts = [f.strip() for f in facts.split(",") if f.strip()]
        if isinstance(concepts, str):
            concepts = [c.strip() for c in concepts.split(",") if c.strip()]
        if config.title_compress_enabled or config.structured_enrich_enabled:
            try:
                llm = CerebrateLLM()
                if config.title_compress_enabled:
                    title = llm.compress_title(title, content)
                if config.structured_enrich_enabled:
                    enriched = llm.extract_facts_concepts(
                        content,
                        solution=payload.get("solution", ""),
                        problem_solved=payload.get("problem", ""),
                        tags=tags, category=payload.get("category", "general"))
                    if not facts and enriched.get("facts"):
                        facts = enriched["facts"]
                    if not concepts and enriched.get("concepts"):
                        concepts = enriched["concepts"]
            except Exception as e:
                logger.warning(f"结构化字段增强失败（{e}），使用规则提取")

        # ── 预生成 memory_id，先写不可变原始记忆日志 ──
        pre_memory_id = self._generate_memory_id(title, payload.get("category", "general"))
        origin_id = self.mm.origin.add(pre_memory_id, payload)
        origin_ids = [origin_id]

        memory_id = self.mm.share_to_swarm(
            title=title,
            content=content,
            category=payload.get("category", "general"),
            tags=tags,
            source_agent=source_agent,
            problem_solved=payload.get(
                "problem") or payload.get("problem_solved", ""),
            solution=payload.get("solution", ""),
            outcome=payload.get("outcome", "success"),
            project_id=project_id,
            scope=scope,
            life_stage=life_stage,
            nutrient_score=float(payload.get("nutrient_score", 1.0)),
            confidence=confidence,
            evidence=evidence,
            supersedes=supersedes_raw,
            origin_ids=origin_ids,
            physical_user=physical_user,
            memory_id=pre_memory_id,
            observation_type=observation_type,
            facts=facts,
            concepts=concepts,
            knowledge_type=knowledge_type,
        )
        data = {
            "memory_id": memory_id,
            "origin_id": origin_id,
            "requested_life_stage": requested_stage,
            "life_stage": life_stage,
            "agent": source_agent,
            "validation": validation,
            "authority": "brain_server",
        }
        self.events.append("memory.proposed", source_agent, data, project_id)

        # ── 自动关联：新记忆与已有知识库关联时增量追加入库 ──
        _cat = payload.get("category", "general")
        self._link_to_knowledge(memory_id, title, content, _cat, tags,
                                source_agent, physical_user, project_id)

        return data

    def start_usage(self, payload: dict) -> dict:
        memory_id = payload.get("memory_id")
        agent_id = payload.get("agent") or payload.get("agent_id")
        problem = payload.get("problem", "")
        if not memory_id or not agent_id or not problem:
            raise ValueError("memory_id, agent_id, and problem are required")
        record = self.mm.start_memory_use(
            memory_id, agent_id, problem,
            project_id=payload.get("project") or payload.get("project_id", ""),
        )
        self.events.append("usage.started", agent_id, record,
                           record.get("project_id", ""))
        return record

    def finish_usage(self, payload: dict) -> dict:
        usage_id = payload.get("usage_id")
        outcome = payload.get("outcome")
        if not usage_id or not outcome:
            raise ValueError("usage_id and outcome are required")
        record = self.mm.finish_memory_use(
            usage_id, outcome, payload.get("feedback", ""))
        self.events.append("usage.finished", record.get("agent_id", "unknown"),
                           record, record.get("project_id", ""))

        # ── 人人为我：自动从使用经验中提取教训并同步到虫群 ──
        try:
            lesson = self._auto_extract_and_propose(record)
            if lesson:
                record["auto_lesson_memory_id"] = lesson["memory_id"]
                record["auto_lesson_title"] = lesson["title"]
        except Exception as e:
            # 自动提取失败不应影响主流程
            import logging
            logging.getLogger("cerebrate.api").warning(
                "自动经验提取异常 (usage=%s): %s", usage_id, e)

        return record

    def _auto_extract_and_propose(self, usage_record: dict) -> Optional[dict]:
        """人人为我核心：从一次记忆复用中自动提取经验教训并同步到虫群。

        热路径——在 finish_usage 完成后立即执行。
        - 获取原始记忆和 usage 上下文
        - 用 LLM 提取完整经验
        - 自动 propose 到虫群
        - 返回新 memory_id
        """
        memory_id = usage_record.get("memory_id", "")
        agent_id = usage_record.get("agent_id", "")
        problem = usage_record.get("problem", "")
        outcome = usage_record.get("outcome", "partial")
        feedback = usage_record.get("feedback", "")
        usage_id = usage_record.get("usage_id", "")

        # 避免重复提取
        if usage_id in self._auto_extracted_usages:
            return None

        # 没有 problem 说明用法记录不完整，无法提取
        if not problem:
            return None

        # 记录为已处理
        if usage_id:
            self._auto_extracted_usages.add(usage_id)

        # 问题级去重：同标题的 [自动经验] 已存在（非 archived）则跳过。
        # 根因：不同 usage（usage_id 不同）引用相同 problem 时会重复提取同 title 经验，
        # usage 级去重无法拦截；这里在 propose 前做标题去重，从源头防重复。
        title = lesson.get("title", f"[自动经验] {problem[:60]}")
        if self._auto_lesson_exists(title):
            logger.info(
                "自动经验去重跳过 (title=%s): 同标题经验已存在", title[:60])
            return None

        # 获取被复用的原始记忆
        original_memory = None
        try:
            original_memory = self.mm.get_swarm_memory(memory_id)
        except Exception:
            pass  # 记忆可能已被删除

        # LLM 提取经验
        from cerebrate.brain.llm import CerebrateLLM
        lesson = CerebrateLLM().extract_lesson_from_usage(
            problem, original_memory, outcome, feedback, agent_id
        )
        if not lesson or not lesson.get("content"):
            return None
        # 自动 propose：用系统账户提交，但 credit 归原 agent
        physical_user = ""
        try:
            physical_user = self.mm.agents.get_physical_user(agent_id) or "cerebrate-system"
        except Exception:
            physical_user = "cerebrate-system"

        # 检查是否至少有基本内容
        from cerebrate.core.chunking import estimate_tokens
        content = lesson["content"]
        # 如果 LLM 产出内容不足 500 token，用规则模板补全
        if estimate_tokens(content) < config.memory_min_tokens:
            content = self._augment_lesson_content(content, usage_record, original_memory)

        propose_payload = {
            "title": title,
            "content": content,
            "category": lesson.get("category", usage_record.get("category", "coding")),
            "tags": lesson.get("tags", ["auto-extracted", outcome]),
            "agent": "cerebrate-system",
            "problem_solved": lesson.get("problem_solved", problem),
            "solution": lesson.get("solution", ""),
            "outcome": outcome,
            "project_id": usage_record.get("project_id", ""),
            "life_stage": "memory",
            "validate": True,
            "physical_user": physical_user,
            # 血缘：credit 归原始智能体
            "origin_ids": [memory_id] if memory_id else [],
        }
        try:
            result = self.propose_memory(propose_payload)
            result["from_agent"] = agent_id
            return result
        except ValueError as e:
            # 内容质量不足，记录但不阻塞流程
            import logging
            logging.getLogger("cerebrate.api").info(
                "自动经验提取被质量门控拒绝 (usage=%s): %s",
                usage_record.get("usage_id", ""), e)
            return None

    def _auto_lesson_exists(self, title: str) -> bool:
        """检查同标题的 [自动经验] 是否已存在（排除 archived）。

        用 ChromaDB metadata 精确匹配 title，避免每次 finish_usage 全库遍历。
        失败时保守返回 False（不拦截提取，保证主流程可用）。
        """
        if not title:
            return False
        try:
            items = self.mm.swarm._store.get_items_by_where(
                {"title": title}, limit=1000)
            # ChromaDB where 组合限制（顶层多条件需 $and 且版本差异），
            # 这里查 title 后 Python 层过滤 archived，兼容所有版本
            return any(
                it.get("metadata", {}).get("life_stage") != "archived"
                for it in items)
        except Exception as e:
            logger.warning("自动经验去重检查失败 (%s): %s", title[:40], e)
            return False

    @staticmethod
    def _augment_lesson_content(content: str, usage_record: dict,
                                 original_memory: Optional[dict]) -> str:
        """当 LLM 产出内容不足质量门槛时，用原始数据补全以确保信息完整性。"""
        parts = [content]
        parts.append("\n\n## 补充上下文\n")
        problem = usage_record.get("problem", "")
        if problem:
            parts.append(f"### 原始问题\n{problem}\n")
        feedback = usage_record.get("feedback", "")
        if feedback:
            parts.append(f"### 反馈\n{feedback}\n")
        if original_memory:
            parts.append("### 被复用的记忆源\n")
            o_title = original_memory.get("title", "")
            o_content = original_memory.get("content", "")
            if o_title:
                parts.append(f"标题: {o_title}\n")
            if o_content:
                parts.append(o_content)
        return "\n".join(parts)

    def process_pending_usages(self, limit: int = 20) -> dict:
        """冷路径：扫描已完成的 usage 记录，对未自动提取经验的进行兜底处理。

        scheduler 每 10 分钟调用一次，作为热路径的补充。
        通过检查 usage 是否已有 auto_lesson_memory_id 来避免重复处理。
        """
        processed = 0
        skipped = 0
        errors = 0

        try:
            store = self.mm._usage_store()
            # 获取所有 usage 记录（含 ids 和 metadatas）
            all_ids = store.get_all_ids()
            all_metas = store.get_all_metadata()
        except Exception:
            return {"processed": 0, "skipped": 0, "errors": 0, "note": "usage store unavailable"}

        for idx, meta in enumerate(all_metas):
            if processed >= limit:
                break
            doc_id = all_ids[idx] if idx < len(all_ids) else ""
            # 只处理已完成的记录
            if meta.get("status") != "finished":
                skipped += 1
                continue
            usage_id = meta.get("usage_id", "").replace("usage:", "")
            if not usage_id:
                usage_id = doc_id.replace("usage:", "")
            # 跳过已在热路径中处理过的
            if usage_id in self._auto_extracted_usages:
                skipped += 1
                continue
            problem = meta.get("problem", "")
            if not problem:
                skipped += 1
                continue

            record = {k: v for k, v in meta.items()}
            record["usage_id"] = usage_id

            try:
                result = self._auto_extract_and_propose(record)
                if result:
                    processed += 1
                else:
                    skipped += 1
            except Exception:
                errors += 1

        return {
            "processed": processed,
            "skipped": skipped,
            "errors": errors,
        }

    def consensus_vote(self, payload: dict) -> dict:
        memory_id = payload.get("memory_id")
        agent_id = payload.get("agent") or payload.get("agent_id")
        vote = payload.get("vote")
        if not memory_id or not agent_id or vote not in {"support", "oppose", "abstain"}:
            raise ValueError(
                "memory_id, agent_id, and vote=support|oppose|abstain are required")
        event = self.events.append("consensus.vote", agent_id, {
            "memory_id": memory_id,
            "vote": vote,
            "evidence": payload.get("evidence", ""),
            "confidence": float(payload.get("confidence", 1.0)),
        }, payload.get("project") or payload.get("project_id", ""))
        self.mm.record_agent_action(agent_id, "consensus_vote",
                                    payload.get("project") or payload.get(
                                        "project_id", ""),
                                    "success", event["payload"])
        snapshot = self.consensus_snapshot(memory_id, apply=True)
        event["consensus"] = snapshot
        return event

    def consensus_overview(self) -> dict:
        snapshots = {}
        for event in self._consensus_vote_events():
            mid = event.get("payload", {}).get("memory_id")
            if mid:
                try:
                    snapshots[mid] = self.consensus_snapshot(mid, apply=False)
                except KeyError:
                    continue  # 记忆已被删除，跳过
        decisions = {"pending": 0, "accepted": 0, "rejected": 0, "split": 0}
        for snapshot in snapshots.values():
            decision = snapshot.get("decision", "pending")
            decisions[decision] = decisions.get(decision, 0) + 1
        return {
            "tracked_memories": len(snapshots),
            "decisions": decisions,
        }

    def consensus_snapshot(self, memory_id: str, apply: bool = False) -> dict:
        memory = self.mm.get_swarm_memory(memory_id)
        if not memory:
            raise KeyError(f"memory not found: {memory_id}")

        latest_votes: dict[str, dict] = {}
        last_event_id = 0
        for event in self._consensus_vote_events():
            payload = event.get("payload", {})
            if payload.get("memory_id") != memory_id:
                continue
            agent = event.get("source_agent", "")
            if not agent:
                continue
            latest_votes[agent] = {
                "agent_id": agent,
                "vote": payload.get("vote", "abstain"),
                "evidence": payload.get("evidence", ""),
                "confidence": float(payload.get("confidence", 1.0)),
                "event_id": event.get("event_id", 0),
                "timestamp": event.get("timestamp", ""),
                "weight": self._vote_weight(agent, payload),
            }
            last_event_id = max(last_event_id, int(event.get("event_id", 0)))

        weighted = {"support": 0.0, "oppose": 0.0, "abstain": 0.0}
        votes = {"support": 0, "oppose": 0, "abstain": 0}
        for vote in latest_votes.values():
            choice = vote.get("vote", "abstain")
            if choice not in votes:
                choice = "abstain"
            votes[choice] += 1
            weighted[choice] += vote.get("weight", 0.0)

        for key in weighted:
            weighted[key] = round(weighted[key], 3)

        decisive = weighted["support"] + weighted["oppose"]
        support_ratio = weighted["support"] / decisive if decisive else 0.0
        oppose_ratio = weighted["oppose"] / decisive if decisive else 0.0
        active_agents = len(self.mm.agents.list_active())
        quorum = max(2, min(3, active_agents if active_agents else 2))
        quorum_met = votes["support"] + votes["oppose"] >= quorum

        decision = "pending"
        if quorum_met and votes["support"] >= quorum and support_ratio >= 0.7 and weighted["support"] >= 1.5 and weighted["oppose"] < 0.75:
            decision = "accepted"
        elif quorum_met and votes["oppose"] >= quorum and oppose_ratio >= 0.6 and weighted["oppose"] >= 1.2:
            decision = "rejected"
        elif weighted["support"] > 0 and weighted["oppose"] > 0:
            decision = "split"

        snapshot = {
            "memory_id": memory_id,
            "life_stage": memory.get("life_stage", "memory"),
            "decision": decision,
            "votes": votes,
            "weighted": weighted,
            "support_ratio": round(support_ratio, 3),
            "oppose_ratio": round(oppose_ratio, 3),
            "unique_voters": len(latest_votes),
            "quorum": quorum,
            "quorum_met": quorum_met,
            "latest_event_id": last_event_id,
            "voters": sorted(latest_votes.values(), key=lambda item: item["agent_id"]),
            "thresholds": {
                "accept": "quorum met, >=70% support weight, support weight >=1.5, oppose weight <0.75",
                "reject": "quorum met, >=60% oppose weight, oppose weight >=1.2",
            },
        }
        if apply:
            self._apply_consensus_decision(memory_id, memory, snapshot)
        return snapshot

    def _consensus_vote_events(self) -> list[dict]:
        events = []
        cursor = 0
        while True:
            batch = self.events.read_after(cursor, 500)
            if not batch:
                break
            for event in batch:
                cursor = max(cursor, int(event.get("event_id", 0)))
                if event.get("event_type") == "consensus.vote":
                    events.append(event)
            if len(batch) < 500:
                break
        return events

    def _vote_weight(self, agent_id: str, payload: dict) -> float:
        confidence = max(0.0, min(float(payload.get("confidence", 1.0)), 1.0))
        stats = self.mm.agents.get_stats(agent_id) or {}
        success_rate = max(
            0.0, min(float(stats.get("success_rate", 0.0)), 1.0))
        reliability = 0.75 + success_rate * 0.5
        evidence = payload.get("evidence", "") or ""
        evidence_bonus = 0.15 if len(evidence.strip()) >= 12 else 0.0
        return round(max(0.1, confidence * reliability + evidence_bonus), 3)

    def _apply_consensus_decision(self, memory_id: str, memory: dict, snapshot: dict):
        current_stage = memory.get("life_stage", "memory")
        if snapshot["decision"] == "accepted" and current_stage in {"nutrient", "memory"}:
            changed = self.mm.swarm.update_lifecycle(
                memory_id,
                "verified_skill",
                confidence=max(
                    float(memory.get("confidence", 0.0) or 0.0), 0.85),
                evidence=f"server consensus accepted: {snapshot['votes']} votes, weighted={snapshot['weighted']}",
            )
            if changed:
                snapshot["applied_life_stage"] = "verified_skill"
                self.events.append("consensus.applied", "brain-server", {
                    "memory_id": memory_id,
                    "decision": snapshot["decision"],
                    "life_stage": "verified_skill",
                    "weighted": snapshot["weighted"],
                }, memory.get("project_id", ""))
        elif snapshot["decision"] == "rejected" and current_stage not in {"doctrine", "archived"}:
            changed = self.mm.swarm.update_lifecycle(
                memory_id,
                "quarantined",
                confidence=min(
                    float(memory.get("confidence", 1.0) or 1.0), 0.2),
                evidence=f"server consensus rejected: {snapshot['votes']} votes, weighted={snapshot['weighted']}",
            )
            if changed:
                snapshot["applied_life_stage"] = "quarantined"
                self.events.append("consensus.applied", "brain-server", {
                    "memory_id": memory_id,
                    "decision": snapshot["decision"],
                    "life_stage": "quarantined",
                    "weighted": snapshot["weighted"],
                }, memory.get("project_id", ""))

    def get_origin(self, origin_id: str) -> dict:
        """读取不可变原始记忆完整内容。"""
        origin = self.mm.origin.get(origin_id)
        if not origin:
            raise KeyError(f"原始记忆不存在: {origin_id}")
        return origin

    def get_memory_origins(self, memory_id: str) -> dict:
        """查询共享记忆的原始来源列表。"""
        memory = self.mm.get_swarm_memory(memory_id)
        if not memory:
            raise KeyError(f"共享记忆不存在: {memory_id}")
        origin_ids = memory.get("origin_ids", [])
        origins = []
        for oid in origin_ids:
            o = self.mm.origin.get(oid)
            if o:
                origins.append(o)
        return {
            "memory_id": memory_id,
            "origin_ids": origin_ids,
            "origins": origins,
        }

    def get_memory(self, memory_id: str) -> dict:
        memory = self.mm.get_swarm_memory(memory_id)
        if not memory:
            raise KeyError(f"memory not found: {memory_id}")
        return memory

    def memory_detail(self, payload: dict) -> dict:
        """渐进式披露第 3 层：按 ids 批量取完整详情。

        对齐 claude-mem get_observations（POST /api/observations/batch）。
        """
        ids_raw = payload.get("ids", [])
        if isinstance(ids_raw, str):
            ids_raw = [i.strip() for i in ids_raw.split(",") if i.strip()]
        if not ids_raw:
            raise ValueError("ids is required")
        memories: list = []
        missing: list = []
        for mid in ids_raw:
            try:
                memories.append(self.get_memory(mid))
            except KeyError:
                missing.append(mid)
        return {
            "ids": ids_raw,
            "memories": memories,
            "missing": missing,
            "retrieval": {
                "mode": "detail",
                "layer": 3,
                "description": "完整详情（含 content/facts/concepts/evidence）。",
            },
        }

    def doctrines(self) -> dict:
        now = time.monotonic()
        if self._doctrines_cache is not None and now - self._doctrines_cache_ts < self._doctrines_ttl:
            return self._doctrines_cache
        doctrines = []
        for mid in self.mm.swarm.get_all_memory_ids():
            memory = self.mm.get_swarm_memory(mid)
            if memory and memory.get("life_stage") == "doctrine":
                doctrines.append(memory)
        result = {"doctrines": doctrines, "count": len(doctrines)}
        self._doctrines_cache = result
        self._doctrines_cache_ts = now
        return result

    def soul_set(self, payload: dict) -> dict:
        """写入虫群灵魂（服务端权威操作，绕过客户端白名单限制）。

        灵魂 = 工程化思维行为准则（life_stage=doctrine, scope=general，
        跨项目对每个接入虫群的 AI 生效）。客户端 propose 不能提交 doctrine，
        本接口是服务端专属通道。
        """
        content = (payload.get("content") or "").strip()
        if not content:
            raise ValueError("soul content is required")
        title = (payload.get("title") or "工程化思维灵魂（Engineering Soul）").strip()
        source_agent = payload.get("agent") or payload.get("agent_id") or "cerebrate-system"
        physical_user = payload.get("physical_user", "")
        category = "doctrine"
        life_stage = "doctrine"
        scope = "general"  # 灵魂跨项目共享
        project_id = ""
        tags = ["soul", "engineering", "doctrine", "灵魂", "工程化思维", "行为准则"]

        # 自动归档旧灵魂 + supersedes 血缘（去重：doctrines/soul_get 只保留当前版本）
        supersedes_raw = []
        stale_soul_ids = []
        try:
            for d in self.doctrines().get("doctrines", []):
                d_tags = d.get("tags") or []
                d_title = d.get("title") or ""
                if "soul" in d_tags or "灵魂" in d_title or "Engineering Soul" in d_title:
                    supersedes_raw.append(d.get("memory_id"))
                    stale_soul_ids.append(d.get("memory_id"))
        except Exception:
            pass

        pre_memory_id = self._generate_memory_id(title, category)
        origin_id = self.mm.origin.add(pre_memory_id, payload)
        origin_ids = [origin_id]

        memory_id = self.mm.share_to_swarm(
            title=title,
            content=content,
            category=category,
            tags=tags,
            source_agent=source_agent,
            problem_solved="",
            solution="",
            outcome="success",
            project_id=project_id,
            scope=scope,
            life_stage=life_stage,
            confidence=1.0,
            origin_ids=origin_ids,
            supersedes=supersedes_raw or None,
            physical_user=physical_user,
            memory_id=pre_memory_id,
            observation_type="decision",
            knowledge_type="tech",
        )
        data = {
            "memory_id": memory_id,
            "title": title,
            "life_stage": life_stage,
            "scope": scope,
            "agent": source_agent,
            "authority": "brain_server",
        }
        # 归档旧灵魂（物理去重）：life_stage=doctrine → archived，doctrines/soul_get 不再返回
        archived = []
        for old_id in stale_soul_ids:
            if old_id and old_id != memory_id:
                try:
                    self.mm.swarm.update_lifecycle(
                        old_id, "archived", confidence=0.0,
                        evidence=f"superseded by soul {memory_id}")
                    archived.append(old_id)
                except Exception:
                    pass
        if archived:
            data["archived_previous"] = archived
        # 清 doctrines 缓存（灵魂是权威变更，立即可见）
        self._doctrines_cache = None
        self.events.append("soul.set", source_agent, data, project_id)
        return data

    def soul_get(self) -> dict:
        """读取虫群灵魂（权威教条中标记为 soul 的 doctrine）。"""
        souls = []
        for d in self.doctrines().get("doctrines", []):
            tags = d.get("tags") or []
            title = d.get("title") or ""
            if "soul" in tags or "灵魂" in title or "Engineering Soul" in title:
                souls.append(d)
        # 按创建时间降序：最新为当前灵魂（hook 取 souls[0] 即最新版）
        souls.sort(key=lambda m: m.get("created") or "", reverse=True)
        return {
            "souls": souls,
            "count": len(souls),
            "current": souls[0] if souls else None,
        }

    def dedup_check(self, payload: Optional[dict] = None) -> dict:
        """记忆去重检查（只读，安全）：

        按「独立文档」维度统计同标题重复——分块（doc_group_id 关联、id 以 _cN 结尾）
        不算独立文档；只有同一标题存在 >1 个独立文档（父文档或普通记忆）才算重复。
        避免把长文档分块误判为重复（v1 教训：verified_skill 分块 30-143 个是正常结构）。
        """
        from collections import defaultdict
        limit = int((payload or {}).get("limit", 50))
        independent: list[dict] = []
        chunk_items = 0
        for mid in self.mm.swarm.get_all_memory_ids():
            if "_c" in mid and mid[mid.rfind("_c") + 2:].isdigit():
                chunk_items += 1
                continue
            mem = self.mm.get_swarm_memory(mid)
            if mem and mem.get("life_stage") != "archived":
                independent.append(mem)
        by_title: dict[str, list[dict]] = defaultdict(list)
        for m in independent:
            by_title[(m.get("title") or "")].append(m)
        dup = {t: v for t, v in by_title.items() if len(v) > 1}
        redundant = sum(len(v) - 1 for v in dup.values())
        groups = []
        for t, v in sorted(dup.items(), key=lambda kv: -len(kv[1]))[:limit]:
            groups.append({
                "title": t[:120],
                "count": len(v),
                "redundant": len(v) - 1,
                "life_stages": sorted({m.get("life_stage", "?") for m in v}),
                "memory_ids": [m.get("memory_id", "") for m in v][:10],
            })
        return {
            "independent_documents": len(independent),
            "chunk_items": chunk_items,
            "duplicate_groups": len(dup),
            "redundant": redundant,
            "groups": groups,
            "note": "独立文档维度（分块不算重复）；redundant=可去重冗余条数。",
        }

    def get_personal(self) -> dict:
        """Get personal preferences, equivalent to v3 recall."""
        users = self.mm.personal.list_users()
        result = {"users": {}}
        for user_id in users:
            profile = self.mm.personal.recall(user_id)
            if profile:
                result["users"][user_id] = profile
        return result

    def set_personal(self, payload: dict) -> dict:
        """Set personal preferences."""
        user_id = payload.get("user") or payload.get("user_id")
        key = payload.get("key")
        value = payload.get("value")
        if not user_id or not key or value is None:
            raise ValueError("user/user_id, key, and value are required")
        project_id = payload.get("project") or payload.get("project_id", "")
        conf = float(payload.get("confidence", 1.0))
        self.mm.remember_user(user_id, key, value,
                              confidence=conf, project_id=project_id)
        return {"user_id": user_id, "key": key, "stored": True}

    def batch_process(self, payload: dict) -> dict:
        """Batch process pending memory queue items — rescores and flushes."""
        limit = int(payload.get("limit", 50))
        dry_run = payload.get("dry_run", False)
        ids = self.mm.swarm.get_all_memory_ids()
        processed = 0
        for mid in ids[:limit]:
            mem = self.mm.get_swarm_memory(mid)
            if not mem:
                continue
            if not dry_run:
                # re-index through swarm's public API
                self.mm.swarm.mark_reused(
                    mid, success=None, feedback="batch-rescore")
            processed += 1
        if not dry_run:
            self.mm.flush_all()
        return {"processed": processed, "limit": limit, "dry_run": dry_run}

    def evolve(self, force: bool = False) -> dict:
        result = EvolutionEngine(config.evolution_path, self.mm).evolve(force=force)
        self.events.append("brain.evolved", "brain-server", result)
        # 运行日志由 EvolutionEngine.evolve() 内部写入
        return result

    def answer(self, payload: dict) -> dict:
        """生成带引用标注的回答

        流程:
          1. 完整检索管线（重写→搜索→扩展→过滤→重排序）
          2. LLM 基于检索结果生成带 [doc:xxx] 引用的回答
          3. 返回回答 + 引用来源列表

        Payload:
          {
            "query": "问题",
            "agent_id": "...",
            "user": "...",
            "project_id": "...",
          }
        """
        query = payload.get("query", "")
        if not query:
            raise ValueError("query is required")

        agent_id = payload.get("agent_id", "")
        user_id = payload.get("user") or agent_id or "default"
        project_id = payload.get("project") or payload.get("project_id")

        # ── 1. 检索 ──
        decision = DecisionRouter(self.mm).decide(
            user_id, query, context={"project_id": project_id})
        swarm = decision.get("swarm_knowledge", {})
        best = swarm.get("best_match")
        related = swarm.get("related", [])

        # ── 2. 构建上下文 ──
        contexts = []
        sources = {}
        if best:
            content = best.get("_expanded_context") or best.get("content", "")
            if content:
                doc_id = best.get("memory_id", "") or best.get("doc_group_id", "")
                src = best.get("_source_range", {})
                ref = f"[doc:{src.get('document', doc_id)[:8]}]" if src else f"[doc:{doc_id[:8]}]"
                contexts.append(f"{ref}\n{content}")
                sources[ref] = {
                    "document_id": doc_id,
                    "title": best.get("title", ""),
                    "score": best.get("score", 0),
                    "relevance_score": best.get("_relevance", best.get("score", 0)),
                }

        for i, r in enumerate(related):
            if len(contexts) >= 5:
                break
            content = r.get("_expanded_context") or r.get("content", "")
            if content and content not in [c.split("\n", 1)[-1] for c in contexts]:
                doc_id = r.get("memory_id", "")
                src = r.get("_source_range", {})
                ref = f"[doc:{src.get('document', doc_id)[:8]}]" if src else f"[doc:{doc_id[:8]}]"
                contexts.append(f"{ref}\n{content}")
                sources[ref] = {
                    "document_id": doc_id,
                    "title": r.get("title", ""),
                    "score": r.get("score", 0),
                    "relevance_score": r.get("_relevance", r.get("score", 0)),
                }

        # ── 3. LLM 生成回答 —─
        from cerebrate.brain.llm import CerebrateLLM
        llm = CerebrateLLM()
        answer = ""
        if llm.is_available() and llm._sdk_ready():
            context_block = "\n\n---\n\n".join(contexts)
            prompt = f"""你是一名技术助手。请基于以下检索到的文档内容回答用户问题。

用户问题: {query}

检索到的相关文档:
{context_block}

要求:
1. 仅基于上述文档内容回答，不要编造信息
2. 每个事实后标注来源引用，如 [doc:abc12345]
3. 如果文档中没有相关信息，明确说"文档中未找到相关信息"
4. 回答结束后，列出所有引用的来源文档

回答:"""
            client = llm._get_client()
            if client:
                try:
                    kwargs = {
                        "model": llm._model,
                        "max_tokens": 2000,
                        "temperature": 0.3,
                        "messages": [{"role": "user", "content": prompt}],
                    }
                    if llm._provider == "anthropic":
                        response = client.messages.create(**kwargs)
                        answer = response.content[0].text if response.content else ""
                    else:
                        response = client.chat.completions.create(**kwargs)
                        answer = response.choices[0].message.content if response.choices else ""
                except Exception as e:
                    logger.warning(f"回答生成失败: {e}")
                    answer = ""

        if not answer:
            # 降级：无 LLM 时返回检索结果摘要
            answer = f"找到 {len(contexts)} 条相关文档。请使用 GET /v1/query 查看详情。"

        self.events.append("memory.answered", agent_id or user_id,
                           {"query": query, "sources": len(sources)})
        return {
            "query": query,
            "answer": answer,
            "sources": list(sources.values()),
            "total_sources": len(sources),
        }

    # ── 权威知识库 ──────────────────────────────────────

    def search_knowledge(self, query: str, topic: str = "",
                         project_id: str = "", scope: str = "") -> list[dict]:
        """向量语义搜索权威知识库。"""
        t = topic.strip() if topic else None
        pid = project_id.strip() if project_id else None
        s = scope.strip() if scope else None
        return self.mm.lookup_knowledge(query, topic=t, project_id=pid, scope=s)

    def store_knowledge(self, payload: dict) -> dict:
        """手动写入权威知识库。"""
        title = payload.get("title", "")
        content = payload.get("content", "")
        if not title or not content:
            raise ValueError("title and content are required")
        topics = payload.get("topics", [])
        if isinstance(topics, str):
            topics = [t.strip() for t in topics.split(",") if t.strip()]
        doc_id = self.mm.store_knowledge(
            title=title,
            content=content,
            source=payload.get("source", "manual"),
            topics=topics,
            is_policy=payload.get("is_policy", False),
            policy_name=payload.get("policy_name", ""),
            version=payload.get("version", "1.0"),
            author=payload.get("author", ""),
            project_id=payload.get("project_id", ""),
            scope=payload.get("scope", ""),
        )
        self.events.append("knowledge.stored", payload.get("agent_id", "manual"),
                           {"doc_id": doc_id, "title": title})
        return {"doc_id": doc_id}

    def project_context(self, payload: dict) -> dict:
        """生成/读取项目级上下文文件（Phase 5 第 2 项）。

        action:
          - build（默认）: 聚合项目记忆生成浓缩上下文文件
          - read: 读取已生成文件（未生成返回 found=False）
          - list: 列出已有上下文项目
        """
        from cerebrate.tools.project_context import ProjectContext
        ctx = ProjectContext(self.mm)
        action = payload.get("action", "build")
        project_id = payload.get("project") or payload.get("project_id") or ""
        if action == "read":
            if not project_id:
                raise ValueError("project_id is required for read")
            data = ctx.read(project_id)
            if not data:
                return {"found": False, "project_id": project_id}
            return {"found": True, **data}
        if action == "list":
            return {"projects": ctx.list_projects()}
        try:
            limit = min(int(payload.get("limit", 50)), 200)
        except (TypeError, ValueError):
            limit = 50
        return ctx.build(project_id, limit=limit)

    def project_profile(self, payload: dict) -> dict:
        """业务画像（数据世界）：项目的领域树 + 实体关系 + 依赖导航。

        action:
          - read（默认）: 读取已确认画像（未生成返回 found=False）
          - list: 列出已有画像项目
          - draft: 从业务记忆构建画像草稿（规则骨架；llm_refine=True 时 LLM 精炼）
          - save: 保存人工确认版画像（body.profile），version+1 并渲染 Markdown
          - attach: 把业务记忆挂到画像节点（node_path + memory_id）
        """
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.mm)
        action = payload.get("action", "read")
        project_id = payload.get("project") or payload.get("project_id") or ""
        if action == "list":
            return {"projects": store.list_projects()}
        if not project_id:
            raise ValueError("project_id is required")
        if action == "read":
            level = payload.get("level", "detail")
            if level not in ("summary", "graph", "detail"):
                raise ValueError("level must be summary|graph|detail")
            p = store.read(project_id, level=level)
            if not p:
                return {"found": False, "project_id": project_id}
            return {"found": True, **p}
        if action == "read_draft":
            p = store.read_draft(project_id)
            if not p:
                return {"found": False, "project_id": project_id,
                        "hint": "暂无草稿（code-sync 自动生成或 action=save_draft）"}
            return {"found": True, **p}
        if action == "save_draft":
            profile = payload.get("profile") or {}
            if not isinstance(profile, dict) or not profile:
                raise ValueError("profile is required for save_draft")
            return store.save_draft(project_id, profile)
        if action == "promote":
            return store.promote(project_id)
        if action == "verify":
            return store.verify(project_id, branch=payload.get("branch", ""))
        if action == "branches":
            from cerebrate.tools.code_sync import list_branches
            return list_branches(project_id)
        if action == "fix_hints":
            return store.fix_drifted_hints(
                project_id, branch=payload.get("branch", ""))
        if action == "draft":
            try:
                limit = min(int(payload.get("limit", 200)), 500)
            except (TypeError, ValueError):
                limit = 200
            llm_refine = payload.get("llm_refine")
            harvest = None
            if payload.get("use_harvest"):
                from cerebrate.tools.code_harvest import load_harvest
                harvest = load_harvest(project_id)
                if not harvest:
                    return {
                        "project_id": project_id,
                        "error": "harvest_not_found",
                        "hint": "请先 POST /v1/project/harvest 生成代码结构",
                    }
            draft = store.build_draft(project_id, limit=limit,
                                      llm_refine=llm_refine,
                                      harvest=harvest)
            return {
                "project_id": project_id,
                "status": draft.get("status", "draft"),
                "domain_count": len(draft.get("domains", [])),
                "harvest_source": bool(harvest),
                "business_memories": len(
                    store._collect_memories(project_id, limit=limit)["business"]),
                "draft": draft,
            }
        if action == "save":
            profile = payload.get("profile") or {}
            if not isinstance(profile, dict) or not profile:
                raise ValueError("profile is required for save")
            profile["project_id"] = project_id
            result = store.save(project_id, profile)
            self.events.append(
                "profile_saved", source_agent="brain-server",
                payload={"project_id": project_id,
                         "version": result["version"]})
            return result
        if action == "attach":
            node_path = payload.get("node_path") or payload.get("node") or ""
            memory_id = payload.get("memory_id") or ""
            if not node_path or not memory_id:
                raise ValueError("node_path and memory_id are required for attach")
            return store.attach_memory(project_id, node_path, memory_id)
        raise ValueError(f"unknown action: {action}")

    def project_harvest(self, payload: dict) -> dict:
        """代码结构养料收割（真实代码 AST → 结构图谱）。

        - dir 必传：扫描该目录生成代码结构（存 {memory_root}/harvest/{project_id}.json）
        - 不传 dir：读取已生成的代码结构
        """
        from cerebrate.tools.code_harvest import (
            harvest_project, save_harvest, load_harvest)
        project_id = payload.get("project") or payload.get("project_id") or ""
        if not project_id:
            raise ValueError("project_id is required")
        dir_raw = payload.get("dir") or ""
        if not dir_raw:
            h = load_harvest(project_id)
            if not h:
                # 兼容分支版：结构 push 存 harvest/{project_id}/{branch}.json，
                # 无 dir 回读时解析默认/最近同步分支
                try:
                    from cerebrate.tools.code_sync import list_branches
                    info = list_branches(project_id)
                    candidates = []
                    if info.get("default_branch"):
                        candidates.append(info["default_branch"])
                    for b in info.get("branches", []):
                        candidates.append(b["branch"])
                    for branch in dict.fromkeys(candidates):
                        h = load_harvest(project_id, branch=branch)
                        if h:
                            break
                except Exception:
                    h = None
            if not h:
                return {"found": False, "project_id": project_id,
                        "hint": "请传 dir 扫描代码目录"}
            return {"found": True, **h}
        from pathlib import Path
        root = Path(dir_raw).resolve()
        if not root.is_dir():
            raise ValueError(f"目录不存在: {root}")
        exts = tuple(payload.get("exts")) if payload.get("exts") else None
        h = harvest_project(root, project_id=project_id, exts=exts)
        result = save_harvest(h)
        self.events.append("harvest_ok", source_agent="brain-server",
                           payload={"project_id": project_id,
                                    "stats": h.get("stats", {})})
        return result

    def code_sync(self, payload: dict) -> dict:
        """代码同步：接收本地项目代码包（含增量删除清单），解压到代码仓，
        自动 harvest；auto_profile=True 时自动生成画像草稿（不覆盖人工确认版）。"""
        from cerebrate.tools.code_sync import receive_package
        project_id = payload.get("project") or payload.get("project_id") or ""
        package_b64 = payload.get("package_b64") or ""
        branch = payload.get("branch", "")
        if not project_id or not package_b64:
            raise ValueError("project_id and package_b64 are required")
        auto_harvest = payload.get("auto_harvest", True)
        result = receive_package(project_id, package_b64, branch=branch,
                                 delete_list=payload.get("delete_list") or [],
                                 auto_harvest=auto_harvest)
        if (payload.get("auto_profile", True) and result.get("harvest")
                and (result.get("files_written", 0) > 0
                     or result.get("files_removed", 0) > 0)):
            try:
                from cerebrate.tools.project_profile import ProfileStore
                from cerebrate.tools.code_harvest import load_harvest
                h = load_harvest(project_id, branch=result.get("branch", ""))
                store = ProfileStore(self.mm)
                draft = store.build_draft(
                    project_id, harvest=h, llm_refine=True)
                draft_res = store.save_draft(project_id, draft)
                result["profile_draft"] = draft_res
            except Exception as e:
                result["profile_draft_error"] = str(e)
        self.events.append("code_sync_ok", source_agent="brain-server",
                           payload={"project_id": project_id,
                                    "files_written": result["files_written"],
                                    "files_removed": result.get("files_removed", 0)})
        return result

    def harvest_push(self, payload: dict) -> dict:
        """结构 push（代码不离开本地）：接收本地 AST 分析结果（harvest 结构），
        存 harvest/{project_id}/{branch}.json，供画像构建/校验使用。

        服务端只接收「结构元数据」（类名/函数名/端点路径/字段），不接收源代码。
        """
        from cerebrate.tools.code_harvest import (
            save_harvest, load_harvest, _safe_branch)
        from cerebrate.tools.code_sync import (
            _load_meta, _save_meta, SYNC_MAX_BRANCHES)
        from datetime import datetime, timezone as _tz
        project_id = payload.get("project") or payload.get("project_id") or ""
        harvest = payload.get("harvest") or {}
        branch = _safe_branch(payload.get("branch", ""))
        if not project_id:
            raise ValueError("project_id is required")
        if not isinstance(harvest, dict) or "modules" not in harvest:
            raise ValueError("harvest 结构缺失 modules（请先本地 harvest_project）")
        harvest["project_id"] = project_id
        if branch:
            harvest["branch"] = branch
        # 结构是否变化（避免无意义重建画像）
        prev = load_harvest(project_id, branch=branch)
        changed = True
        if prev and prev.get("modules") == harvest.get("modules"):
            changed = False
        result = save_harvest(harvest, branch=branch)
        result["branch"] = branch or "default"
        # 更新分支登记 meta
        meta = _load_meta(project_id)
        if not meta.get("default_branch"):
            meta["default_branch"] = branch or "default"
        meta["branches"][branch or "default"] = {
            "last_synced": datetime.now(_tz.utc).isoformat(),
            "files": len(harvest.get("modules", [])),
            "harvest": harvest.get("stats", {}),
            "source": "local_push",
        }
        _save_meta(project_id, meta)
        result["changed"] = changed
        result["branches"] = sorted(meta["branches"].keys())
        result["default_branch"] = meta.get("default_branch", "default")
        # 自动画像草稿（结构变化才重建）
        if (payload.get("auto_profile", True) and changed):
            try:
                from cerebrate.tools.project_profile import ProfileStore
                store = ProfileStore(self.mm)
                draft = store.build_draft(project_id, harvest=harvest,
                                          llm_refine=True)
                result["profile_draft"] = store.save_draft(project_id, draft)
            except Exception as e:
                result["profile_draft_error"] = str(e)
        self.events.append("harvest_push_ok", source_agent="brain-server",
                           payload={"project_id": project_id,
                                    "branch": branch,
                                    "modules": len(harvest.get("modules", []))})
        return result

    def project_work(self, payload: dict) -> dict:
        """多人协作感知：工作声明（谁在处理哪个功能）+ 冲突检测。

        action:
          - claim: 声明正在处理某模块（返回冲突检测）
          - release: 释放声明
          - list: 列出项目活跃工作（按分支）
        """
        from cerebrate.tools.work_claims import (
            claim, release, list_active)
        action = payload.get("action", "list")
        project_id = payload.get("project") or payload.get("project_id") or ""
        if not project_id:
            raise ValueError("project_id is required")
        if action == "claim":
            return claim(
                project_id,
                agent_id=payload.get("agent_id")
                or payload.get("agent") or "unknown",
                branch=payload.get("branch", ""),
                module=payload.get("module", ""),
                intent=payload.get("intent", ""),
                session_id=payload.get("session_id", ""))
        if action == "release":
            return release(
                project_id,
                agent_id=payload.get("agent_id")
                or payload.get("agent") or "unknown",
                module=payload.get("module", ""),
                claim_id=payload.get("claim_id", ""))
        if action == "list":
            return list_active(project_id)
        raise ValueError(f"unknown action: {action}")

    def branch_diff(self, payload: dict) -> dict:
        """分支差异感知：比较两分支代码结构（harvest），告知冲突点。"""
        from cerebrate.tools.code_harvest import load_harvest
        project_id = payload.get("project") or payload.get("project_id") or ""
        from_b = payload.get("from_branch") or payload.get("from") or ""
        to_b = payload.get("to_branch") or payload.get("to") or ""
        if not project_id or not from_b or not to_b:
            raise ValueError("project_id, from_branch, to_branch are required")
        ha = load_harvest(project_id, branch=from_b)
        hb = load_harvest(project_id, branch=to_b)
        if not ha or not hb:
            return {"ok": False, "reason": "branch_harvest_missing",
                    "from": from_b, "to": to_b,
                    "hint": "请先对两个分支执行 harvest-push"}
        mods_a = {m["path"] for m in ha.get("modules", [])}
        mods_b = {m["path"] for m in hb.get("modules", [])}
        only_a = sorted(mods_a - mods_b)
        only_b = sorted(mods_b - mods_a)
        eps_a = {ep.get("path") for ep in ha.get("endpoints", [])}
        eps_b = {ep.get("path") for ep in hb.get("endpoints", [])}
        return {
            "ok": True,
            "project_id": project_id,
            "from_branch": from_b,
            "to_branch": to_b,
            "conflict_points": {
                "modules_only_in_from": only_a[:30],
                "modules_only_in_to": only_b[:30],
                "endpoints_only_in_from": sorted(eps_a - eps_b)[:30],
                "endpoints_only_in_to": sorted(eps_b - eps_a)[:30],
            },
            "summary": {
                "modules_from": len(mods_a), "modules_to": len(mods_b),
                "only_in_from": len(only_a), "only_in_to": len(only_b),
            },
        }

    def project_navigate(self, payload: dict) -> dict:
        """在业务画像中定位目标域/实体（导航），返回路径 + 挂载记忆 + 依赖。"""
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.mm)
        project_id = payload.get("project") or payload.get("project_id") or ""
        target = payload.get("target") or payload.get("query") or ""
        branch = payload.get("branch", "")
        if not project_id or not target:
            raise ValueError("project_id and target are required")
        return store.navigate(project_id, target, branch=branch)

    def list_all_knowledge(self) -> list[dict]:
        """列出知识库所有文档摘要。"""
        docs = []
        for did in self.mm.knowledge._store.get_all_ids():
            item = self.mm.knowledge._store.get(did)
            if item:
                m = item["metadata"]
                docs.append({
                    "doc_id": item["id"],
                    "title": m.get("title", ""),
                    "topics": (m.get("topics") or "").split(","),
                    "is_policy": m.get("is_policy") == "True",
                    "updated": m.get("updated", ""),
                })
        return docs

    def distill_knowledge_on_demand(self, payload: dict) -> dict:
        """按需蒸馏：根据 topic 搜索记忆，LLM 生成知识文档并入库。"""
        topic = payload.get("topic", "").strip()
        if not topic:
            raise ValueError("topic is required")

        # 搜索相关记忆
        # 蒸馏需要跨项目全量记忆（不受 scope 隔离影响）
        memories = self.mm.query_swarm(topic, limit=20, scope="all")
        if len(memories) < 2:
            return {"distilled": False, "reason": f"相关记忆不足（当前{len(memories)}条，至少需要2条）。请先积累更多相关经验后再蒸馏。"}

        # 补充完整数据
        full_memories = []
        for m in memories:
            mem = self.mm.get_swarm_memory(m.get("memory_id", ""))
            if mem:
                full_memories.append(mem)

        if len(full_memories) < 2:
            return {"distilled": False, "reason": "无法加载完整记忆数据"}

        # 调用 LLM 蒸馏
        from cerebrate.brain.llm import CerebrateLLM
        llm = CerebrateLLM()
        if not llm.is_available():
            return {"distilled": False, "reason": "LLM 不可用，请配置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY"}

        doc = llm.distill_knowledge(full_memories, topic)
        if not doc or doc.get("skip"):
            reason = doc.get("reason", "数据不足") if doc else "LLM 蒸馏失败"
            return {"distilled": False, "reason": f"蒸馏跳过: {reason}。请提供更丰富的记忆数据。"}

        # 构建完整文档并入库
        from cerebrate.memory.evolution import EvolutionEngine
        meta = doc.get("meta", {})
        title = meta.get("title", topic)
        content = EvolutionEngine._build_knowledge_document(doc, topic)
        confidence = meta.get("confidence", 0.85)

        doc_id = self.mm.store_knowledge(
            title=title, content=content,
            source="cerebrate-evolution",
            topics=[topic],
            is_policy=True,
            policy_name=topic,
            version="1.0",
            author="cerebrate-evolution",
            project_id=payload.get("project_id", ""),
            scope=payload.get("scope", ""),
        )
        self.events.append("knowledge.distilled", "on-demand",
                           {"doc_id": doc_id, "topic": topic, "source_count": len(full_memories)})
        return {"distilled": True, "doc_id": doc_id, "title": title,
                "source_count": len(full_memories), "confidence": confidence}

    def distill_and_vote(self, payload: dict) -> dict:
        """按需蒸馏 + 自动投票（端到端）。

        把相似记忆蒸馏为一个细节完整的新记忆/技能候选（营养池），自动发起支持投票，
        返回共识快照；信息不足以形成完整技能时跳过（LLM skip 判断）。

        payload:
          topic      必填，蒸馏主题
          limit      相似记忆检索上限（默认 20）
          vote       是否自动发起投票（默认 true）
          agent      发起投票的 agent（默认 cerebrate-evolution）
          force      已有同主题蒸馏技能时是否强制重新蒸馏（默认 false）
          scope      检索范围 all|general|project（默认 all，跨项目找相似）
          project_id 蒸馏技能归属项目（缺省=通用技能 scope=general）
        """
        topic = payload.get("topic", "").strip()
        if not topic:
            raise ValueError("topic is required")
        limit = int(payload.get("limit", 20) or 20)
        vote = payload.get("vote", True)
        agent = payload.get("agent") or "cerebrate-evolution"
        force = payload.get("force", False)
        scope = payload.get("scope") or "all"
        project_id = payload.get("project_id") or payload.get("project", "")

        # 1. 查重：同主题已存在活跃蒸馏技能 → 不重复蒸馏，可对其投票
        if not force:
            try:
                existing = self.mm.query_swarm(
                    f"distilled skill {topic}", category="distilled_skill",
                    project_id=None, scope="all", limit=10, index_only=True)
            except Exception:
                existing = []
            # 标题级查重：只有「标题包含主题关键词」的蒸馏技能才算同主题。
            # 防止大而全的综合知识库（tags 含一切、语义相似度对任意主题都高）误拦截新蒸馏。
            import re as _re
            tokens = [t for t in _re.split(r"[\s,，、/]+", topic) if len(t) >= 2]
            for ex in existing:
                ex_title = ex.get("title", "")
                if not ex_title:
                    continue
                if any(tok.lower() in ex_title.lower() for tok in tokens):
                    ex_id = ex.get("memory_id", "")
                    ex_mem = self.mm.get_swarm_memory(ex_id) if ex_id else None
                    if ex_mem and ex_mem.get("life_stage") not in {"archived", "quarantined"}:
                        snap = self.consensus_snapshot(ex_id, apply=False)
                        return {
                            "distilled": False,
                            "reason": f"已存在同主题蒸馏技能（{ex_mem.get('title', ex_id)}），未重复蒸馏；可对其投票。",
                            "memory_id": ex_id,
                            "consensus": snap,
                        }
                    break

        # 2. 搜索相似记忆（默认跨项目全量，index_only 只查索引元数据，快）
        memories = self.mm.query_swarm(
            topic, limit=limit, scope=scope, index_only=True)
        if len(memories) < 2:
            return {"distilled": False,
                    "reason": f"相似记忆不足（当前{len(memories)}条，至少需要2条）。请先积累更多相关经验后再蒸馏。"}

        # 3. 补充完整数据
        full_memories = []
        for m in memories:
            mem = self.mm.get_swarm_memory(m.get("memory_id", ""))
            if mem:
                full_memories.append(mem)
        if len(full_memories) < 2:
            return {"distilled": False, "reason": "无法加载完整记忆数据"}

        # 4. LLM 蒸馏（skip=当前信息不足以形成完整技能）
        llm = CerebrateLLM()
        if not llm.is_available():
            return {"distilled": False, "reason": "LLM 不可用"}
        doc = llm.distill_knowledge(full_memories, topic)
        if not doc or doc.get("skip"):
            reason = doc.get("reason", "数据不足") if doc else "LLM 蒸馏失败"
            return {"distilled": False,
                    "reason": f"当前信息不足以形成完整技能：{reason}。"}

        # 5. 构建完整文档（论文级四层架构 + 原始数据附录，信息零丢失）
        meta = doc.get("meta", {})
        title = meta.get("title", f"[蒸馏技能] {topic}")
        confidence = meta.get("confidence", 0.85)
        content = EvolutionEngine._build_knowledge_document(doc, topic)
        content += "\n\n---\n" + EvolutionEngine._build_source_appendix(full_memories)

        # 6. 血缘：supersedes=源记忆；origin_ids=全部原始来源；tags 合并
        supersedes_ids = []
        all_origin_ids: set[str] = set()
        all_tags = {"distilled_skill", topic}
        total_reuse = 0
        for m in full_memories:
            mid = m.get("memory_id", "")
            supersedes_ids.append(mid)
            all_origin_ids.add(mid)
            oids_raw = m.get("origin_ids") or []
            if isinstance(oids_raw, str):
                oids = [o.strip() for o in oids_raw.split(",") if o.strip()]
            else:
                oids = [str(o) for o in oids_raw if str(o).strip()]
            all_origin_ids.update(oids)
            rt = m.get("tags", "")
            if isinstance(rt, str):
                all_tags.update(t for t in rt.split(",") if t)
            total_reuse += int(m.get("reuse_count", 0) or 0)
        all_origin_ids.discard("")
        evidence = (f"按需蒸馏: {len(full_memories)}条相似记忆整合, 总复用{total_reuse}次, "
                    f"LLM四层知识架构, 原始数据附录保留(信息零丢失)")

        # 7. 候选入营养池（life_stage=nutrient，等共识投票晋升）
        memory_id = self.mm.swarm.share(
            title=title, content=content,
            category="distilled_skill",
            tags=list(all_tags),
            source_agent="cerebrate-evolution",
            problem_solved=full_memories[0].get("problem_solved", ""),
            solution=full_memories[0].get("solution", ""),
            outcome="success",
            project_id=project_id,
            scope="general" if not project_id else "",
            life_stage="nutrient",
            confidence=confidence,
            evidence=evidence,
            supersedes=supersedes_ids,
            origin_ids=list(all_origin_ids),
        )
        self.events.append("knowledge.distilled", "on-demand",
                           {"memory_id": memory_id, "topic": topic,
                            "source_count": len(full_memories),
                            "life_stage": "nutrient", "vote": bool(vote)})

        result = {
            "distilled": True,
            "memory_id": memory_id,
            "title": title,
            "source_count": len(full_memories),
            "confidence": confidence,
            "life_stage": "nutrient",
            "supersedes": supersedes_ids,
        }
        # 8. 自动发起支持投票；共识达成则自动晋升 verified_skill
        if vote:
            ev = self.consensus_vote({
                "memory_id": memory_id,
                "agent": agent,
                "vote": "support",
                "evidence": evidence,
                "confidence": 0.9,
            })
            snap = ev.get("consensus", {})
            result["consensus"] = snap
            result["life_stage"] = snap.get("applied_life_stage", "nutrient")
        else:
            result["consensus"] = self.consensus_snapshot(memory_id, apply=False)
        return result

    def list_knowledge_topics(self) -> dict:
        """列出知识库所有主题。"""
        return {"topics": self.mm.knowledge.list_topics(),
                "policies": self.mm.knowledge.list_policies()}

    def list_all_knowledge(self) -> list[dict]:
        """列出知识库全部文档（含完整内容），用于导出/人工浏览。"""
        kb = self.mm.knowledge
        docs = []
        for did in kb._store.get_all_ids():
            item = kb._store.get(did)
            if not item:
                continue
            m = item["metadata"]
            docs.append({
                "doc_id": did,
                "title": m.get("title", ""),
                "content": m.get("content", ""),
                "topics": [t for t in (m.get("topics") or "").split(",") if t],
                "source": m.get("source", ""),
                "is_policy": m.get("is_policy") == "True",
                "policy_name": m.get("policy_name", ""),
                "version": m.get("version", ""),
                "author": m.get("author", ""),
                "verified": m.get("verified") == "True",
                "deprecated": m.get("deprecated") == "True",
                "project_id": m.get("project_id", ""),
                "created": m.get("created", ""),
                "updated": m.get("updated", ""),
            })
        docs.sort(key=lambda d: d.get("updated", ""), reverse=True)
        return docs

    def cleanup_expired_origins(self, days: int = 365,
                                backup_dir: str = "/data/origin_backups") -> dict:
        """清理超过保留期的原始记忆：先备份再删除。"""
        result = self.mm.origin.cleanup_expired(days=days, backup_dir=backup_dir)
        self.events.append("origin.cleanup", "brain-server",
                           {"cleaned": result["deleted"],
                            "backed_up": result["backed_up"],
                            "backup_file": result["backup_file"]})
        return result
