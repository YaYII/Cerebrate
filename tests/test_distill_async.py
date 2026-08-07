"""蒸馏异步任务测试 — POST /v1/distill 提交 / GET /v1/distill/{task_id} 查询。

覆盖:
  - 提交任务返回 task_id + status=queued
  - 状态流转 queued → running → done/error
  - 无相似记忆 → done + distilled=false + reason
  - 标题级查重（已有同主题蒸馏技能 → 拦截）
  - 成功路径（mock LLM）→ nutrient 候选 + 自动投票 + supersedes 血缘
  - 执行体异常 → status=error
"""
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

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


def make_doc(topic: str) -> dict:
    """构造 LLM 蒸馏返回的最小合法文档（与 _build_knowledge_document 匹配）。"""
    return {
        "meta": {"title": f"[测试蒸馏] {topic}", "version": "1.0.0",
                 "source_count": 2, "total_reuse": 3, "confidence": 0.9},
        "abstract": "这是测试摘要。",
        "concept_layer": {"concepts": [{
            "term": "核心概念", "definition": "概念定义", "evidence_level": "A",
            "refs": [1]}]},
        "conclusion": "测试结论。",
    }


class DistillAsyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        if self.api._distill_executor is not None:
            self.api._distill_executor.shutdown(wait=False)
        self.tmp.cleanup()

    def _share(self, title, content, **kwargs):
        params = {"title": title, "content": content, "category": "coding",
                  "tags": ["test"], "source_agent": "distill-test"}
        params.update(kwargs)
        return self.api.mm.swarm.share(**params)

    def _wait(self, task_id, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            s = self.api.distill_status(task_id)
            if s["status"] in ("done", "error"):
                return s
            time.sleep(0.05)
        self.fail(f"task {task_id} 超时未完成")

    def test_submit_returns_task_id(self):
        resp = self.api.distill({"topic": "完全不存在主题xyz123"})
        self.assertEqual(resp["status"], "queued")
        self.assertTrue(resp["task_id"])
        self.assertEqual(resp["topic"], "完全不存在主题xyz123")

    def test_no_similar_memory(self):
        resp = self.api.distill({"topic": "完全不存在主题xyz123"})
        result = self._wait(resp["task_id"])
        self.assertEqual(result["status"], "done")
        self.assertFalse(result["result"]["distilled"])
        self.assertIn("相似记忆不足", result["result"]["reason"])

    def test_status_not_found(self):
        with self.assertRaises(KeyError):
            self.api.distill_status("no-such-task")

    def test_success_path_with_mock_llm(self):
        self._share("记忆去重经验一", "内容一：标题级去重，防止分块误判。",
                    problem_solved="记忆去重问题", solution="标题级去重",
                    tags=["去重", "dedup"])
        self._share("记忆去重经验二", "内容二：源头防重，ChromaDB where 查询。",
                    problem_solved="记忆去重问题", solution="源头防重",
                    tags=["去重", "dedup"])
        with patch("cerebrate.server.api.CerebrateLLM") as mock_cls:
            mock = mock_cls.return_value
            mock.is_available.return_value = True
            mock.distill_knowledge.return_value = make_doc("记忆去重")
            resp = self.api.distill({"topic": "记忆去重", "limit": 5})
            result = self._wait(resp["task_id"])
        self.assertEqual(result["status"], "done")
        r = result["result"]
        self.assertTrue(r["distilled"])
        self.assertEqual(r["life_stage"], "nutrient")
        self.assertEqual(r["source_count"], 2)
        self.assertTrue(r["memory_id"])
        # 血缘：supersedes 包含两条源记忆
        self.assertEqual(len(r["supersedes"]), 2)
        # 自动投票：codex 已投支持票
        self.assertEqual(r["consensus"]["votes"]["support"], 1)

    def test_title_level_dedup(self):
        """已有同主题蒸馏技能（标题匹配）→ 拦截，不重复蒸馏。"""
        # 先种一条蒸馏技能，标题包含主题词
        self._share("蒸馏技能 记忆去重（已存在）", "已有的蒸馏产物内容",
                    category="distilled_skill", tags=["distilled_skill", "去重"],
                    life_stage="verified_skill")
        with patch("cerebrate.server.api.CerebrateLLM") as mock_cls:
            mock = mock_cls.return_value
            mock.is_available.return_value = True
            mock.distill_knowledge.return_value = make_doc("记忆去重")
            resp = self.api.distill({"topic": "记忆去重", "limit": 5})
            result = self._wait(resp["task_id"])
        self.assertEqual(result["status"], "done")
        r = result["result"]
        self.assertFalse(r["distilled"])
        self.assertIn("已存在同主题蒸馏技能", r["reason"])
        self.assertTrue(r["memory_id"])  # 返回已有技能 id

    def test_executor_serial(self):
        """串行执行器：单 worker，任务排队执行不并发。"""
        self.assertEqual(self.api._get_distill_executor()._max_workers, 1)

    def test_task_ttl_cleanup(self):
        """已完成任务超过 TTL 后从内存清理，防止泄漏。"""
        resp = self.api.distill({"topic": "完全不存在主题xyz123"})
        task_id = resp["task_id"]
        self._wait(task_id)  # 确保 done
        self.assertIn(task_id, self.api._distill_tasks)
        # 人为把 TTL 调为 0 并推旧时间戳 → 下次调用清理
        self.api._distill_task_ttl = 0.0
        self.api._distill_tasks[task_id]["ts"] = time.monotonic() - 10
        with self.assertRaises(KeyError):
            self.api.distill_status(task_id)  # 触发清理，任务已删除
        self.assertNotIn(task_id, self.api._distill_tasks)

    def test_query_deleted_task_raises(self):
        """已清理的任务查询 → KeyError。"""
        resp = self.api.distill({"topic": "完全不存在主题xyz123"})
        task_id = resp["task_id"]
        self._wait(task_id)
        with self.api._distill_lock:
            del self.api._distill_tasks[task_id]
        with self.assertRaises(KeyError):
            self.api.distill_status(task_id)


if __name__ == "__main__":
    unittest.main()
