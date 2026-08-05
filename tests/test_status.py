"""服务状态调度信号测试 — GET /v1/status（2026-08-05）

需求：让 AI 感知脑虫状况（embedding/LLM 可用性、负载、查询缓存命中率、
建议调度模式 recommended=full|light|defer），从而综合调度查询时机——
记忆查询可先可后，与代码证据互相印证，不必机械强制先查记忆。
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def configure_temp_env(tmp_name):
    from cerebrate.config import config
    import cerebrate.core.embedding as embedding

    root = Path(tmp_name) / "memory"
    config.memory_root = root
    config.personal_path = root / "personal"
    config.swarm_path = root / "swarm"
    config.knowledge_path = root / "knowledge"
    config.evolution_path = root / "evolution"
    config.agents_path = root / "agents"
    config.events_path = root / "events"
    config.chroma_path = root / "chroma_data"
    config.docstore_path = root / "docstore"
    config.embedding_model = "not-a-real-local-model"
    config.embedding_allow_download = False
    config.embedding_max_length = 8192
    config.memory_min_tokens = 0
    embedding._engine = None
    # 重置查询缓存计数（避免跨用例污染）
    embedding._query_cache.clear()
    embedding._query_cache_hits = 0
    embedding._query_cache_misses = 0


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self.tmp.cleanup()

    def test_status_returns_scheduling_signal(self):
        data = self.api.status()
        # 结构完整
        self.assertIn("health", data)
        self.assertIn("embedding", data)
        self.assertIn("llm", data)
        self.assertIn("load", data)
        self.assertIn("query_cache", data)
        self.assertIn("counts", data)
        self.assertIn("recommended", data)
        # recommended 必须是合法调度模式之一
        self.assertIn(data["recommended"], ("full", "light", "defer"))
        # 轻量：不返回 recent_index 等重内容
        self.assertNotIn("recent_index", data)
        # embedding 字段结构
        self.assertIn("mode", data["embedding"])
        self.assertIn("fulltext", data["embedding"])
        # counts 有记忆条数
        self.assertIn("total_memories", data["counts"])
        self.assertIn("kb_docs", data["counts"])

    def test_status_light_when_embedding_hash(self):
        # 测试环境 embedding 是 hash 模式（无本地模型）→ recommended 应为 light
        data = self.api.status()
        self.assertEqual(data["embedding"]["mode"], "hash")
        self.assertEqual(data["recommended"], "light")

    def test_status_5s_ttl_cache(self):
        first = self.api.status()
        second = self.api.status()
        self.assertIs(first, second)  # 5s TTL 内命中同一缓存对象

    def test_query_cache_stats_counts_hits_and_misses(self):
        from cerebrate.core.embedding import (
            get_embedding_engine, query_cache_stats)
        engine = get_embedding_engine()
        # 两次相同查询 → 1 miss + 1 hit
        engine.encode_query("调度信号查询")
        engine.encode_query("调度信号查询")
        stats = query_cache_stats()
        self.assertEqual(stats["hits"], 1)
        self.assertEqual(stats["misses"], 1)
        self.assertEqual(stats["size"], 1)
        self.assertEqual(stats["hit_rate"], 0.5)
        self.assertEqual(stats["capacity"], 512)

    def test_help_registers_status_command(self):
        help_data = self.api.help()
        commands = {c["path"] for c in help_data["commands"]}
        self.assertIn("/v1/status", commands)


if __name__ == "__main__":
    unittest.main()
