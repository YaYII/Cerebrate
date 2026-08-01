"""决策路由器 - AI 三层决策逻辑

决策流程:
0. 查询重写 → 多角度检索
1. 先查虫群共享记忆 → 看前人怎么干
2. 若涉及政策细节 → 查知识库核对
3. 用个人记忆套上用户熟悉的语气
"""
import logging
from typing import Optional

from cerebrate.config import config

logger = logging.getLogger(__name__)


class DecisionRouter:
    """虫群决策路由器 - 实现三层优先级查询逻辑"""

    def __init__(self, memory_manager):
        self.mm = memory_manager

    def decide(self, user_id: str, query: str, context: Optional[dict] = None) -> dict:
        """执行完整的三层决策流程"""
        context = context or {}
        result = {
            "user_id": user_id,
            "query": query,
            "route": [],
            "swarm_knowledge": {},
            "policy_result": None,
            "personal_tone": {},
            "final_response": "",
        }

        # 步骤 0: 查询重写（多角度检索）
        rewritten = [query]
        if config.query_rewrite_enabled:
            try:
                from cerebrate.brain.rewriter import rewrite_query
                rewritten = rewrite_query(
                    query,
                    max_variations=config.query_rewrite_max_variations,
                    enabled=True,
                )
                if len(rewritten) > 1:
                    result["rewritten_queries"] = rewritten
                    self.mm.log_query(user_id, query, "rewritten",
                                      len(rewritten))
            except Exception as e:
                logger.warning(f"查询重写失败: {e}")
                rewritten = [query]

        # 步骤 1: 先查虫群共享记忆（多角度）
        swarm_results = self.mm.query_swarm(
            query_text=query,
            query_texts=rewritten,
            category=context.get("category"),
            tags=context.get("tags"),
            limit=5,
            project_id=context.get("project_id"),
            scope=context.get("scope"),
        )
        if swarm_results:
            result["route"].append("swarm")
            result["swarm_knowledge"] = {
                "best_match": swarm_results[0] if swarm_results else None,
                "related": swarm_results[1:],
            }
            self.mm.log_query(user_id, query, "swarm_hit", len(swarm_results))
        else:
            self.mm.log_query(user_id, query, "swarm_miss", 0)

        # 步骤 2: 若涉及政策/规则细节，查知识库核对
        if self._is_policy_query(query, context):
            kb_results = self.mm.lookup_knowledge(
                query=query,
                exact_policy=context.get("exact_policy", False),
                project_id=context.get("project_id"),
                scope=context.get("scope"),
            )
            if kb_results:
                result["route"].append("knowledge_base")
                result["policy_result"] = kb_results[0]
                self.mm.log_query(user_id, query, "kb_hit", len(kb_results))
            else:
                self.mm.log_query(user_id, query, "kb_miss", 0)

        # 步骤 3: 用个人记忆套上用户熟悉的语气
        tone = self.mm.get_user_tone(user_id)
        profile = self.mm.get_user_profile(user_id)
        result["personal_tone"] = {
            "tone": tone,
            "language": profile.get("preferences", {}).get("language", "简体中文"),
            "name": profile.get("facts", {}).get("name", ""),
        }

        return result

    def quick_query(self, user_id: str, query: str) -> str:
        """快速查询 - 直接获取最佳答案"""
        result = self.decide(user_id, query)

        parts = []

        # 虫群经验
        best = result["swarm_knowledge"].get("best_match")
        if best:
            parts.append(f"【虫群经验】{best.get('solution', best.get('content', ''))[:500]}"
                         f"\n(来源: {best.get('source_agent', '虫群')}, "
                         f"复用: {best.get('reuse_count', 0)}次, "
                         f"结果: {best.get('outcome', 'unknown')})")

        # 权威知识
        if result["policy_result"]:
            parts.append(f"【权威依据】{result['policy_result']['content'][:500]}"
                         f"\n(来源: {result['policy_result']['source']})")

        # 个性化包装
        tone_info = result["personal_tone"]
        greeting = ""
        if tone_info.get("name"):
            greeting = f"{tone_info['name']}，"

        response = f"{greeting}{' '.join(parts)}" if parts else "未找到相关记忆，这是新领域。"

        self.mm.log_query(user_id, query, "quick", len(parts))
        return response

    def _is_policy_query(self, query: str, context: dict) -> bool:
        """判断是否涉及政策/规则查询"""
        policy_keywords = [
            "政策", "规则", "规定", "policy", "rule", "条款",
            "退货", "退款", "保证", "保修", "协议", "合同",
            "条件", "标准", "合规", "compliance",
        ]
        query_lower = query.lower()
        if any(kw in query_lower for kw in policy_keywords):
            return True
        if context.get("exact_policy"):
            return True
        if context.get("require_authoritative"):
            return True
        return False
