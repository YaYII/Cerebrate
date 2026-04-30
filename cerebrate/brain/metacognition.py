"""元认知系统 v3.0 — 质量分析 + 偏见检测 + 改进建议"""
from typing import Optional


class Metacognition:
    """元认知：反思自身思维过程，检测偏见，提出改进"""

    def __init__(self, memory_manager):
        self.mm = memory_manager
        self.assessment_history: list[dict] = []

    def assess(self) -> dict:
        """评估当前认知状态 — 质量分析而非仅统计"""
        stats = self.mm.get_all_stats()
        swarm = stats.get("swarm", {})

        total = swarm.get("total", 0)
        total_queries = swarm.get("total_queries", 0)
        total_successes = swarm.get("total_successes", 0)

        hit_rate = total_successes / max(total_queries, 1)
        efficiency = "high" if hit_rate > 0.7 else "medium" if hit_rate > 0.3 else "low"

        # 按类别分析
        category_health = self._analyze_categories()

        # 按智能体分析
        agent_health = self._analyze_agents()

        # 按项目分析
        project_health = self._analyze_projects()

        recommendations = []
        if total < 10:
            recommendations.append("虫群经验不足 (<10)，建议从更多战斗中收集经验")
        if hit_rate < 0.3:
            recommendations.append("语义查询命中率低 (<30%)，建议丰富记忆标签和分类")
        if not self.mm.knowledge.list_policies():
            recommendations.append("知识库无策略文档，建议导入团队规范和编码标准")
        for cat, health in category_health.items():
            if health.get("stale_ratio", 0) > 0.5:
                recommendations.append(f"类别 '{cat}' 中超过 50% 记忆可能过时")

        assessment = {
            "hit_rate": round(hit_rate, 3),
            "efficiency": efficiency,
            "total_memories": total,
            "total_queries": total_queries,
            "category_health": category_health,
            "agent_health": agent_health,
            "project_health": project_health,
            "recommendations": recommendations,
            "biases_detected": self.detect_biases(),
        }
        self.assessment_history.append(assessment)
        if len(self.assessment_history) > 200:
            self.assessment_history = self.assessment_history[-100:]
        return assessment

    def _analyze_categories(self) -> dict:
        """按类别分析记忆质量"""
        health = {}
        swarm = self.mm.swarm
        from ..memory.decay import calculate_decay
        # 按 category 分组统计
        cat_counts: dict[str, int] = {}
        cat_samples: dict[str, list[dict]] = {}
        mids = swarm.get_all_memory_ids()
        for mid in mids[:200]:  # 限制扫描量
            mem = swarm._load_memory(mid)
            if not mem:
                continue
            cat = mem.get("category", "uncategorized")
            cat_counts[cat] = cat_counts.get(cat, 0) + 1
            if len(cat_samples.get(cat, [])) < 10:
                cat_samples.setdefault(cat, []).append(mem)

        for cat, total in cat_counts.items():
            stale = 0
            for mem in cat_samples.get(cat, []):
                d = calculate_decay(mem.get("created", ""),
                                   reuse_count=mem.get("reuse_count", 0),
                                   success_count=mem.get("success_count", 0))
                if d < 0.15:
                    stale += 1
            sample = cat_samples.get(cat, [])
            health[cat] = {
                "total": total,
                "sample_size": len(sample),
                "stale_count": stale,
                "stale_ratio": round(stale / max(len(sample), 1), 2),
            }
        return health

    def _analyze_agents(self) -> dict:
        """分析不同智能体的贡献"""
        health = {}
        swarm = self.mm.swarm
        agent_counts: dict[str, int] = {}
        agent_success: dict[str, int] = {}
        for mid in swarm.get_all_memory_ids():
            mem = swarm._load_memory(mid)
            if mem:
                agent = mem.get("source_agent", "unknown")
                agent_counts[agent] = agent_counts.get(agent, 0) + 1
                if mem.get("outcome") == "success":
                    agent_success[agent] = agent_success.get(agent, 0) + 1
        for agent, count in agent_counts.items():
            health[agent] = {
                "contributions": count,
                "success_rate": round(agent_success.get(agent, 0) / max(count, 1), 2),
            }
        return health

    def _analyze_projects(self) -> dict:
        """按项目分析记忆分布"""
        health = {}
        swarm = self.mm.swarm
        proj_counts: dict[str, int] = {}
        for mid in swarm.get_all_memory_ids()[:500]:
            mem = swarm._load_memory(mid)
            if mem:
                pid = mem.get("project_id", "") or "全局"
                proj_counts[pid] = proj_counts.get(pid, 0) + 1
        for proj, count in proj_counts.items():
            health[proj] = {"memories": count}
        return health

    def detect_biases(self) -> list[str]:
        """检测虫群的认知偏见"""
        biases = []
        swarm = self.mm.swarm
        cats = swarm.list_categories()
        if len(set(cats)) <= 1 and cats:
            biases.append(f"虫群经验类别单一: {cats}")
        topics = self.mm.knowledge.list_topics()
        if len(set(topics)) <= 1 and topics:
            biases.append(f"知识库主题单一: {topics}")

        # 检查智能体分布
        agents = self._analyze_agents()
        if len(agents) <= 1:
            biases.append("只有单一智能体贡献记忆，虫群多样性不足")
        total = sum(a["contributions"] for a in agents.values())
        for agent, info in agents.items():
            if total > 10 and info["contributions"] / max(total, 1) > 0.8:
                biases.append(f"智能体 '{agent}' 贡献了 {info['contributions']/max(total,1):.0%} 的记忆，存在单一来源偏见")

        return biases

    def suggest_improvement(self) -> str:
        assessment = self.assess()
        if assessment["recommendations"]:
            return assessment["recommendations"][0]
        return "系统运行良好，继续积累战斗经验"
