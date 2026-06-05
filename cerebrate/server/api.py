"""Authoritative Cerebrate Brain Server API.

Clients submit observations and requests. The server alone writes group
memory, appends durable events, and controls memory promotion.
"""

from datetime import datetime, timezone
from typing import Optional

from cerebrate.brain.mind import CerebrateMind, Metacognition
from cerebrate.brain.decision import DecisionRouter
from cerebrate.brain.llm import CerebrateLLM
from cerebrate.brain.events import EventLog
from cerebrate.config import config
from cerebrate.memory import EvolutionEngine, MemoryManager


def get_manager() -> MemoryManager:
    return MemoryManager(config.personal_path, config.swarm_path, config.knowledge_path)


class BrainAPI:
    """Application service behind HTTP and tests."""

    CLIENT_LIFE_STAGES = {"nutrient", "memory"}

    def __init__(self, manager: Optional[MemoryManager] = None,
                 events: Optional[EventLog] = None):
        self.mm = manager or get_manager()
        self.events = events or EventLog(config.events_path)

    def sense(self) -> dict:
        mind = CerebrateMind(self.mm)
        data = mind.sense()
        data["latest_event_id"] = self.events.latest_id()
        data["server_role"] = "authoritative_brain"
        data["llm"] = CerebrateLLM().status()
        data["consensus"] = self.consensus_overview()
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
        agent_id = payload.get("agent_id", user_id)
        decision = DecisionRouter(self.mm).decide(
            user_id, query, context={"project_id": project_id})
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
                    "reuse_memory", memory_id, agent_id, query, all_matches)
            elif score > 0.2:
                recommendation = "verify"
                task = self._build_task(
                    "verify_reference", memory_id, agent_id, query, all_matches)
        if task is None:
            task = self._build_task("solve_fresh", "", agent_id, query, all_matches)
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

            # 更新知识库文档（直接 upsert 到已有 doc_id，绕过哈希去重）
            now = datetime.now(timezone.utc).isoformat()
            meta = {
                "title": best.get("title", title),
                "content": updated_content,
                "source": f"{best.get('source','')},{source_agent}",
                "topics": ",".join(best.get("topics", [])),
                "is_policy": str(best.get("is_policy", False)),
                "policy_name": best.get("policy_name", ""),
                "version": best.get("version", "1.0"),
                "author": best.get("author", source_agent),
                "project_id": project_id,
                "updated": now,
            }
            search_text = f"{best.get('title', title)}\n{updated_content[:500]}"
            self.mm.knowledge._store.upsert(doc_id, search_text, meta)
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
    def _build_task(action: str, memory_id: str, agent_id: str, problem: str, all_matches: list = None) -> dict:
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
            inst = ["1. 读取记忆内容作为解决方案"]
            if other_matches_hint:
                inst.insert(0, "0. 【多结果警告】" + other_matches_hint)
            inst.extend([
                "2. 执行解决方案中的步骤",
                f"3. 完成后调用 POST /v1/usages/start 记录复用 (memory_id={memory_id}, agent={agent_id})",
                "4. 完成后调用 POST /v1/usages/finish 报告结果"
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
            inst = [
                "1. 读取记忆内容作为参考",
                "2. 独立验证方案的可行性",
            ]
            if other_matches_hint:
                inst.insert(0, "0. 【多结果警告】" + other_matches_hint)
            inst.extend([
                "3. 根据验证结果调整并执行",
                f"4. 完成后调用 POST /v1/memories/propose 提交新记忆",
                f"5. 可选: 调用 POST /v1/usages/start 记录参考 (memory_id={memory_id}, agent={agent_id})"
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
                               "project_id": "string"},
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
            life_stage=life_stage,
            nutrient_score=float(payload.get("nutrient_score", 1.0)),
            confidence=confidence,
            evidence=evidence,
            supersedes=supersedes_raw,
            origin_ids=origin_ids,
            physical_user=physical_user,
            memory_id=pre_memory_id,
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
        return record

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

    def doctrines(self) -> dict:
        doctrines = []
        for mid in self.mm.swarm.get_all_memory_ids():
            memory = self.mm.get_swarm_memory(mid)
            if memory and memory.get("life_stage") == "doctrine":
                doctrines.append(memory)
        return {"doctrines": doctrines, "count": len(doctrines)}

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
        return result

    # ── 权威知识库 ──────────────────────────────────────

    def search_knowledge(self, query: str, topic: str = "",
                         project_id: str = "") -> list[dict]:
        """向量语义搜索权威知识库。"""
        t = topic.strip() if topic else None
        pid = project_id.strip() if project_id else None
        return self.mm.lookup_knowledge(query, topic=t, project_id=pid)

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
        )
        self.events.append("knowledge.stored", payload.get("agent_id", "manual"),
                           {"doc_id": doc_id, "title": title})
        return {"doc_id": doc_id}

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
