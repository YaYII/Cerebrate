import importlib.util
import tempfile
import unittest
from pathlib import Path


def configure_temp_memory(tmp_name):
    import cerebrate.core.embedding as embedding
    from cerebrate.config import config

    root = Path(tmp_name) / "memory"
    config.memory_root = root
    config.personal_path = root / "personal"
    config.swarm_path = root / "swarm"
    config.knowledge_path = root / "knowledge"
    config.evolution_path = root / "evolution"
    config.agents_path = root / "agents"
    # config.archive_path removed (v6 chroma-only) ".archived"
    # config.seeds_path removed (v6 chroma-only) "seeds"
    # config.usage_path removed (v6 chroma-only) "usage"
    config.events_path = root / "events"
    config.chroma_path = root / "chroma_data"
    config.embedding_model = "not-a-real-local-model"
    config.embedding_allow_download = False
    embedding._engine = None
    config.memory_min_tokens = 0  # 测试环境不做长度限制


class MemoryVectorKernelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_memory(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_memory_layers_use_hash_vector_collections(self):
        from cerebrate.config import config
        from cerebrate.memory.manager import MemoryManager

        mm = MemoryManager(config.personal_path, config.swarm_path, config.knowledge_path)

        self.assertEqual(mm.swarm._store.embedding_mode, "hash")
        self.assertEqual(mm.knowledge._store.embedding_mode, "hash")
        self.assertEqual(mm.personal._store.embedding_mode, "hash")
        self.assertEqual(mm.swarm._store.collection_name, "swarm_memories_hash")
        self.assertEqual(mm.knowledge._store.collection_name, "knowledge_base_hash")
        self.assertEqual(mm.personal._store.collection_name, "personal_memories_hash")

        memory_id = mm.share_to_swarm(
            title="向量记忆内核",
            content="Cerebrate v5 使用 ChromaStore 和本地 hash embedding 查询虫群记忆。",
            category="architecture",
            tags=["vector", "chroma", "hash"],
            source_agent="kernel-test",
            problem_solved="无网络时如何保持群体记忆可查询",
            solution="服务端使用确定性 hash 向量写入 Chroma collection",
        )
        hits = mm.query_swarm("Chroma hash 向量 虫群记忆 查询", limit=3)
        self.assertTrue(any(hit["memory_id"] == memory_id for hit in hits))

        doc_id = mm.store_knowledge(
            title="脑虫服务端权威边界",
            content="服务端负责记忆写入、共识投票、隔离和 doctrine 输出。",
            source="unit-test",
            topics=["server", "memory"],
        )
        knowledge_hits = mm.lookup_knowledge("服务端 记忆 写入 共识 隔离 doctrine")
        self.assertTrue(any(hit["doc_id"] == doc_id for hit in knowledge_hits))

        mm.remember_user("unit-user", "pref_language", "简体中文")
        self.assertEqual(mm.recall_user("unit-user", "pref_language"), {
            "pref_language": "简体中文",
        })

        stats = mm.get_all_stats()
        self.assertEqual(stats["vector"]["embedding_mode"], "hash")
        self.assertEqual(stats["vector"]["swarm_docs"], 1)
        self.assertEqual(stats["vector"]["kb_docs"], 1)

    def test_legacy_semantic_index_code_is_not_exposed(self):
        from cerebrate.config import config

        # find_spec 对不存在的顶级包会抛 ModuleNotFoundError 而非返回 None
        try:
            spec = importlib.util.find_spec("memory.semantic")
        except ModuleNotFoundError:
            spec = None
        self.assertIsNone(spec)
        self.assertFalse(hasattr(config, "semantic_index_path"))

    def test_brain_sense_reports_vector_index(self):
        from cerebrate.server.api import BrainAPI

        api = BrainAPI()
        sense = api.sense()

        self.assertIn("vector_index", sense)
        self.assertNotIn("semantic_index", sense)
        self.assertEqual(sense["embedding_mode"], "hash")
