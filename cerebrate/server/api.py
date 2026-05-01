"""Authoritative Cerebrate Brain Server API.

Clients submit observations and requests. The server alone writes group
memory, appends durable events, and controls memory promotion.
"""

from typing import Optional

from ..brain import CerebrateMind
from ..config import config
from ..decision import DecisionRouter
from ..llm import CerebrateLLM
from ..memory import EvolutionEngine, MemoryManager
from .events import EventLog


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
        return data

    def register_agent(self, payload: dict) -> dict:
        agent_id = payload.get("agent_id") or payload.get("id")
        if not agent_id:
            raise ValueError("agent_id is required")
        info = self.mm.register_agent(
            agent_id=agent_id,
            agent_type=payload.get("agent_type", payload.get("type", "http")),
            capabilities=payload.get("capabilities") or [],
            metadata=payload.get("metadata") or {},
        )
        self.events.append("agent.registered", agent_id, {"agent_id": agent_id})
        return info

    def query(self, payload: dict) -> dict:
        query = payload.get("query", "")
        if not query:
            raise ValueError("query is required")
        user_id = payload.get("user") or payload.get("user_id") or payload.get("agent_id") or "default"
        project_id = payload.get("project") or payload.get("project_id")
        decision = DecisionRouter(self.mm).decide(user_id, query, context={"project_id": project_id})
        best = decision.get("swarm_knowledge", {}).get("best_match")
        recommendation = "new_experience"
        if best:
            recommendation = "reuse" if best.get("score", 0) > 0.5 else "verify"
        data = {
            "query": query,
            "found": bool(best),
            "swarm_result": best,
            "policy_result": decision.get("policy_result"),
            "personal": decision.get("personal_tone", {}),
            "recommendation": recommendation,
        }
        self.events.append("memory.queried", payload.get("agent_id", user_id),
                           {"query": query, "recommendation": recommendation},
                           project_id or "")
        return data

    def propose_memory(self, payload: dict) -> dict:
        title = payload.get("title", "")
        content = payload.get("content", "")
        if not title or not content:
            raise ValueError("title and content are required")

        tags = payload.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]

        source_agent = payload.get("agent") or payload.get("agent_id") or "unknown"
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
                evidence = (evidence + "\n" if evidence else "") + f"server immune quarantine: {reason}"

        memory_id = self.mm.share_to_swarm(
            title=title,
            content=content,
            category=payload.get("category", "general"),
            tags=tags,
            source_agent=source_agent,
            problem_solved=payload.get("problem") or payload.get("problem_solved", ""),
            solution=payload.get("solution", ""),
            outcome=payload.get("outcome", "success"),
            project_id=project_id,
            life_stage=life_stage,
            nutrient_score=float(payload.get("nutrient_score", 1.0)),
            confidence=confidence,
            evidence=evidence,
            supersedes=payload.get("supersedes") or [],
        )
        data = {
            "memory_id": memory_id,
            "requested_life_stage": requested_stage,
            "life_stage": life_stage,
            "agent": source_agent,
            "validation": validation,
            "authority": "brain_server",
        }
        self.events.append("memory.proposed", source_agent, data, project_id)
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
        self.events.append("usage.started", agent_id, record, record.get("project_id", ""))
        return record

    def finish_usage(self, payload: dict) -> dict:
        usage_id = payload.get("usage_id")
        outcome = payload.get("outcome")
        if not usage_id or not outcome:
            raise ValueError("usage_id and outcome are required")
        record = self.mm.finish_memory_use(usage_id, outcome, payload.get("feedback", ""))
        self.events.append("usage.finished", record.get("agent_id", "unknown"),
                           record, record.get("project_id", ""))
        return record

    def consensus_vote(self, payload: dict) -> dict:
        memory_id = payload.get("memory_id")
        agent_id = payload.get("agent") or payload.get("agent_id")
        vote = payload.get("vote")
        if not memory_id or not agent_id or vote not in {"support", "oppose", "abstain"}:
            raise ValueError("memory_id, agent_id, and vote=support|oppose|abstain are required")
        event = self.events.append("consensus.vote", agent_id, {
            "memory_id": memory_id,
            "vote": vote,
            "evidence": payload.get("evidence", ""),
            "confidence": float(payload.get("confidence", 1.0)),
        }, payload.get("project") or payload.get("project_id", ""))
        self.mm.record_agent_action(agent_id, "consensus_vote",
                                    payload.get("project") or payload.get("project_id", ""),
                                    "success", event["payload"])
        return event

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

    def evolve(self) -> dict:
        result = EvolutionEngine(config.evolution_path, self.mm).evolve()
        self.events.append("brain.evolved", "brain-server", result)
        return result
