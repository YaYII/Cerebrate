"""删除分块记忆回归测试（v5.2.2）。

背景（2026-08-11 清理事故）:
  delete_memory 调用 get_items_by_where（默认 limit=100）删除分块，
  超大文档（>100 块）只删前 100 块 → 残留孤儿 chunk。
  修复：改用 get_ids_by_where（limit=100000，轻量只取 id）。

覆盖:
  - 120+ 块文档 delete_memory 后 chunk 全部删除（无残留）
  - 主条目删除
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def configure_temp_env(tmp_name):
    import cerebrate.core.embedding as embedding
    from cerebrate.config import config

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
    config.embedding_summary_chars = 1000
    config.chunk_enabled = True
    config.chunk_max_chars = 2000
    config.chunk_min_chars = 100
    config.chunk_overlap_chars = 50
    config.context_expand_enabled = False
    config.relevance_filter_enabled = False
    config.reranker_enabled = False
    config.query_rewrite_enabled = False
    config.memory_min_tokens = 0
    embedding._engine = None


class DeleteMemoryChunksTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.config import config
        # 小块化：让 20KB 内容产生 120+ 块（超过旧 limit=100）
        config.chunk_max_chars = 150
        config.chunk_min_chars = 80
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self.tmp.cleanup()

    def test_delete_memory_removes_all_chunks(self):
        """120+ 块文档删除后 chunk 全部清除（防漏删回归）。"""
        # 构造 120+ 块的内容（每块 ~150 字符）
        block = "测试分块内容测试分块内容测试分块内容测试分块内容。"  # ~28 字符
        content = block * 700  # ~19600 字符 → 约 130 块
        mid = self.api.mm.swarm.share(
            title="超大分块文档删除测试", content=content,
            category="coding", tags=["delete-test"],
            source_agent="delete-test")

        store = self.api.mm.swarm._store
        # 确认分块数量超过旧 limit=100
        item = store.get(mid)
        self.assertTrue(item, "parent 记录应存在")
        total = int(item["metadata"].get("total_chunks", 0))
        self.assertGreater(total, 100, f"测试需构造 >100 块文档，实际 {total}")

        # 执行删除
        ok = self.api.mm.swarm.delete_memory(mid)
        self.assertTrue(ok)

        # 主条目与全部分块都应清除
        self.assertIsNone(store.get(mid))
        self.assertEqual(
            len(store.get_ids_by_where({"doc_group_id": mid})), 0,
            "delete_memory 后不应残留孤儿 chunk")


if __name__ == "__main__":
    unittest.main()
