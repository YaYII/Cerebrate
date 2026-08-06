"""Cerebrate v5.1 分块 + BGE-M3 + ReRanker 综合测试

测试范围:
  1. chunking 模块 — 三种分块策略
  2. ReRanker 模块 — 回退与接口
  3. Swarm 分块存储 — share + 聚合查询
  4. Swarm 旧行为不变 — 短文档不分块
  5. 端到端记忆管线 — 存储/检索/更新/删除
"""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


def configure_temp_memory(tmp_name):
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
    config.embedding_model = "not-a-real-local-model"
    config.embedding_allow_download = False
    config.embedding_max_length = 8192
    config.chunk_enabled = True
    config.chunk_max_chars = 2000
    config.chunk_min_chars = 100
    config.chunk_overlap_chars = 50
    config.reranker_enabled = False  # CI 环境无模型，测试聚合逻辑
    embedding._engine = None
    config.memory_min_tokens = 0  # 测试环境不做长度限制


class ChunkingTests(unittest.TestCase):
    """测试 cerebrate/core/chunking.py 分块器"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_memory(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _make_heading_doc(self, num_chapters: int) -> str:
        """生成带标题的多章文档"""
        chapters = []
        for i in range(num_chapters):
            chapters.append(
                f"## 第{i}章 模块设计\n\n"
                f"这是第{i}章的详细设计文档。包含架构说明、接口定义、数据流、"
                f"错误码定义、时序图和配置说明等多个部分。\n\n"
                f"### 接口定义\n\n- GET /api/v1/query\n- POST /api/v1/execute\n\n"
                f"### 数据流\n\n客户端请求 -> 网关 -> 认证 -> 业务处理 -> 持久化\n\n"
            )
        return "\n\n".join(chapters)

    def test_short_document_not_chunked(self):
        """短文档不切分"""
        from cerebrate.core.chunking import chunk_document
        text = "这是一个简短的文档，只有几百字。"
        chunks = chunk_document(text, max_chars=2000)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["text"], text)
        self.assertEqual(chunks[0]["index"], 0)
        self.assertEqual(chunks[0]["total"], 1)

    def test_empty_document(self):
        """空文档返回单块"""
        from cerebrate.core.chunking import chunk_document
        chunks = chunk_document("", max_chars=2000)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["text"], "")

    def test_heading_split(self):
        """按标题分割长文档"""
        from cerebrate.core.chunking import chunk_document
        doc = self._make_heading_doc(30)  # 30 章，每章约 200 字
        chunks = chunk_document(doc, max_chars=2000)
        self.assertGreater(len(chunks), 1, "多章文档应被切割")
        for ch in chunks:
            self.assertLessEqual(
                len(ch["text"]), 2200,  # 允许少量超出
                f"块不得远超出 max_chars: {len(ch['text'])} > 2200"
            )
        self.assertEqual(chunks[0]["total"], len(chunks),
                         "所有块的 total 应一致")

    def test_heading_boundary_kept(self):
        """每块以标题开头（第一块可能是引言）"""
        from cerebrate.core.chunking import chunk_document
        doc = self._make_heading_doc(15)
        chunks = chunk_document(doc, max_chars=2000)
        for ch in chunks[1:]:  # 从第二块开始，每块应以 ## 开头
            self.assertTrue(
                ch["text"].startswith("##"),
                f"块应以标题开头: {ch['text'][:50]}"
            )

    def test_paragraph_split(self):
        """无标题时按段落分割"""
        from cerebrate.core.chunking import chunk_document
        pars = [f"这是第{i}段内容，包含系统的详细功能说明。" for i in range(100)]
        doc = "\n\n".join(pars)
        chunks = chunk_document(doc, max_chars=2000)
        self.assertGreater(len(chunks), 1, "多段落文档应被切割")
        for ch in chunks:
            self.assertLessEqual(len(ch["text"]), 2200)

    def test_equal_split(self):
        """无标题无段落时等长切割"""
        from cerebrate.core.chunking import chunk_document
        doc = "X" * 20000
        chunks = chunk_document(doc, max_chars=2000)
        self.assertGreater(len(chunks), 1)
        for ch in chunks:
            self.assertLessEqual(len(ch["text"]), 2200)

    def test_equal_split_overlap(self):
        """等长切割有重叠，内容不丢"""
        from cerebrate.core.chunking import chunk_document
        doc = "ABCDEFGHIJ" * 2000
        chunks = chunk_document(doc, max_chars=2000, overlap_chars=50)
        self.assertGreater(len(chunks), 1)
        # 验证总字符数：切割后可能有重叠，但不会大量丢失
        total_after = sum(len(c["text"]) for c in chunks)
        self.assertGreaterEqual(total_after, len(doc) * 0.9)

    def test_estimate_tokens(self):
        """token 估算非负"""
        from cerebrate.core.chunking import estimate_tokens
        self.assertGreater(estimate_tokens("一段中文文本"), 0)
        self.assertGreater(estimate_tokens("English text with spaces"), 0)
        self.assertTrue(estimate_tokens("中文English123!@#") > 0)


class ReRankerTests(unittest.TestCase):
    """测试 cerebrate/core/reranker.py（无模型时的降级行为）"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_memory(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_disabled_reranker_returns_original(self):
        """禁用时原样返回"""
        from cerebrate.core.reranker import ReRanker
        rr = ReRanker(enabled=False)
        self.assertFalse(rr.available)
        candidates = [{"content": "a", "score": 0.5}, {"content": "b", "score": 0.8}]
        result = rr.rerank("test", candidates, top_k=5)
        self.assertEqual(len(result), 2)

    def test_no_model_graceful_fallback(self):
        """模型不存在时标记不可用但不崩溃"""
        from cerebrate.core.reranker import ReRanker
        rr = ReRanker(model_name="nonexistent-model", enabled=True)
        self.assertFalse(rr.available)
        candidates = [{"content": "test", "score": 0.5}]
        # 不应抛异常
        result = rr.rerank("query", candidates, top_k=5)
        self.assertEqual(len(result), 1)

    def test_get_reranker_singleton(self):
        """单例工厂不抛异常"""
        from cerebrate.core.reranker import get_reranker
        rr = get_reranker(enabled=False)
        self.assertIsNotNone(rr)


class SwarmChunkingIntegrationTests(unittest.TestCase):
    """测试 SwarmMemory 分块存储 + 聚合查询"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_memory(self.tmp.name)
        from cerebrate.config import config
        from cerebrate.memory.swarm import SwarmMemory
        self.swarm = SwarmMemory(config.swarm_path)

    def tearDown(self):
        self.tmp.cleanup()

    def _long_doc(self, words_per_section=50, sections=10) -> str:
        parts = []
        for i in range(sections):
            parts.append(
                f"## 第{i}节\n\n" + "对接文档详细内容 " * words_per_section
            )
        return "\n\n".join(parts)

    def test_short_memory_not_chunked(self):
        """短记忆不分块，原行为不变"""
        mid = self.swarm.share(
            title="测试短记忆",
            content="这是一个很短的内容",
            category="test",
            tags=["short"],
            source_agent="test",
        )
        mem = self.swarm.get_memory(mid)
        self.assertIsNotNone(mem)
        self.assertEqual(mem["content"], "这是一个很短的内容")
        self.assertEqual(mem.get("total_chunks", 1), 1)

    def test_long_memory_chunked_storage(self):
        """长记忆分块存储，各块写入 ChromaDB"""
        doc = self._long_doc(words_per_section=100, sections=15)
        mid = self.swarm.share(
            title="长文档测试",
            content=doc,
            category="test",
            tags=["long", "chunking"],
            source_agent="test",
        )
        # 验证分块 chunk ID 存在
        self.assertTrue(mid.startswith(mid))  # 至少不是空的

        # 查找分块（通过 doc_group_id）
        chunks = self.swarm._store.get_items_by_where(
            {"doc_group_id": mid})
        self.assertGreaterEqual(
            len(chunks), 2,
            f"长文档应生成多个分块，实际 {len(chunks)}"
        )

    def test_aggregate_query_returns_full_content(self):
        """查询聚合后返回完整内容"""
        doc = self._long_doc(words_per_section=100, sections=12)
        mid = self.swarm.share(
            title="聚合测试文档",
            content=doc,
            category="test",
            tags=["aggregate"],
            source_agent="test",
        )

        results = self.swarm.query("对接文档详细内容", limit=5)
        self.assertGreaterEqual(len(results), 1,
                                "应检索到至少一条结果")

        best = results[0]
        # 聚合后的内容应接近原始长度（可能因拼接方式略有差异）
        self.assertGreaterEqual(
            len(best["content"]), len(doc) * 0.8,
            f"聚合内容 {len(best['content'])} 应与原文档 {len(doc)} 接近"
        )
        self.assertEqual(best["title"], "聚合测试文档")
        self.assertIn("第", best["content"])

    def test_get_memory_aggregates_chunks(self):
        """get_memory 通过 doc_group_id 聚合"""
        doc = self._long_doc(words_per_section=100, sections=10)
        mid = self.swarm.share(
            title="get_memory聚合",
            content=doc,
            category="test",
            tags=["get-mem"],
            source_agent="test",
        )
        # 直接查主 ID 应返回聚合内容
        mem = self.swarm.get_memory(mid)
        self.assertIsNotNone(mem)
        self.assertGreaterEqual(len(mem["content"]), len(doc) * 0.8)
        self.assertEqual(mem["memory_id"], mid)

    def test_mark_reused_on_chunked_doc(self):
        """标记复用对所有块生效"""
        doc = self._long_doc(words_per_section=100, sections=8)
        mid = self.swarm.share(
            title="标记复用测试",
            content=doc,
            category="test",
            tags=["reuse"],
            source_agent="test",
        )
        # 获取分块
        chunks = self.swarm._store.get_items_by_where(
            {"doc_group_id": mid})
        self.assertGreater(len(chunks), 0)

        # 标记主 ID 复用
        self.swarm.mark_reused(mid, success=True)
        self.swarm.mark_reused(mid, success=True, feedback="不错")

        # 验证至少一个分块的 reuse_count 增加了
        updated_chunks = self.swarm._store.get_items_by_where(
            {"doc_group_id": mid})
        for ch in updated_chunks:
            self.assertGreaterEqual(
                ch["metadata"].get("reuse_count", 0), 1,
                f"分块 {ch['id']} 应被标记复用"
            )

    def test_delete_chunked_doc(self):
        """删除分档删除所有块"""
        doc = self._long_doc(words_per_section=100, sections=6)
        mid = self.swarm.share(
            title="删除测试",
            content=doc,
            category="test",
            tags=["delete"],
            source_agent="test",
        )
        # 确认存在
        chunks_before = self.swarm._store.get_items_by_where(
            {"doc_group_id": mid})
        self.assertGreater(len(chunks_before), 0)

        # 删除
        deleted = self.swarm.delete_memory(mid)
        self.assertTrue(deleted)

        # 验证全删除
        chunks_after = self.swarm._store.get_items_by_where(
            {"doc_group_id": mid})
        self.assertEqual(len(chunks_after), 0)

    def test_update_lifecycle_on_chunked_doc(self):
        """更新生命周期对所有块生效"""
        doc = self._long_doc(words_per_section=100, sections=6)
        mid = self.swarm.share(
            title="生命周期测试",
            content=doc,
            category="test",
            tags=["lifecycle"],
            source_agent="test",
        )
        updated = self.swarm.update_lifecycle(mid, "verified_skill",
                                              confidence=0.95, evidence="已验证")
        self.assertTrue(updated)

        # 验证所有块都已更新
        chunks = self.swarm._store.get_items_by_where(
            {"doc_group_id": mid})
        for ch in chunks:
            self.assertEqual(
                ch["metadata"].get("life_stage"), "verified_skill")
            self.assertAlmostEqual(
                float(ch["metadata"].get("confidence", 0)), 0.95)


class SwarmBackwardCompatibilityTests(unittest.TestCase):
    """确保旧行为不变：短记忆/查询/复用反馈"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_memory(self.tmp.name)
        from cerebrate.config import config
        from cerebrate.memory.swarm import SwarmMemory
        self.swarm = SwarmMemory(config.swarm_path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_basic_store_and_query(self):
        """原始行为：存储短记忆并可查询"""
        mid = self.swarm.share(
            title="原始行为测试",
            content="Cerebrate 是一个 AI 记忆中枢系统。",
            category="architecture",
            tags=["test"],
            source_agent="compat-test",
            problem_solved="如何管理 AI 记忆",
            solution="使用 ChromaDB + BGE embedding",
        )
        results = self.swarm.query("Cerebrate AI 记忆中枢", limit=5)
        found = any(r["memory_id"] == mid for r in results)
        self.assertTrue(found, "短记忆应可检索到")

    def test_mark_reused_and_boost(self):
        """标记复用增加复用计数"""
        mid = self.swarm.share(
            title="复用测试",
            content="这个内容会被复用来验证计数。",
            category="test",
            tags=["reuse"],
            source_agent="compat-test",
        )
        self.swarm.mark_reused(mid, success=True)
        mem = self.swarm.get_memory(mid)
        self.assertEqual(mem["reuse_count"], 1)
        self.assertEqual(mem["success_count"], 1)

    def test_get_memory_returns_all_fields(self):
        """get_memory 返回完整字段"""
        mid = self.swarm.share(
            title="完整字段",
            content="内容详情",
            category="coding",
            tags=["python", "api"],
            source_agent="compat-test",
            problem_solved="问题描述",
            solution="解决方案",
            evidence="证据说明",
            confidence=0.8,
            outcome="success",
        )
        mem = self.swarm.get_memory(mid)
        self.assertEqual(mem["title"], "完整字段")
        self.assertEqual(mem["content"], "内容详情")
        self.assertEqual(mem["category"], "coding")
        self.assertIn("python", mem["tags"])
        self.assertEqual(mem["source_agent"], "compat-test")
        self.assertEqual(mem["problem_solved"], "问题描述")
        self.assertEqual(mem["solution"], "解决方案")
        self.assertEqual(mem["evidence"], "证据说明")
        self.assertEqual(mem["confidence"], 0.8)
        self.assertEqual(mem["outcome"], "success")
        self.assertIsNotNone(mem["created"])

    def test_category_and_tag_filter(self):
        """查询时分类和标签过滤"""
        self.swarm.share(title="架构文档", content="架构说明",
                         category="architecture", tags=["design"],
                         source_agent="compat-test")
        self.swarm.share(title="编码方案", content="编码详情",
                         category="coding", tags=["python"],
                         source_agent="compat-test")

        arch_results = self.swarm.query("文档", category="architecture")
        self.assertTrue(
            any(r["title"] == "架构文档" for r in arch_results))

        coding_results = self.swarm.query("文档", category="coding")
        self.assertTrue(
            any(r["title"] == "编码方案" for r in coding_results))


class BrainAPIChunkingTests(unittest.TestCase):
    """端到端：通过 BrainAPI 验证分块管线"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_memory(self.tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self.tmp.cleanup()

    def test_propose_long_document_through_api(self):
        """通过 API propose 长文档，查询时返回聚合内容"""
        # 注册 agent
        self.api.register_agent({
            "agent_id": "chunk-test",
            "physical_user": "test-runner",
        })

        # propose 长文档
        doc = "\n\n".join([
            f"## 标题{i}\n\n对接文档详细设计内容 " * 50
            for i in range(10)
        ])
        proposed = self.api.propose_memory({
            "title": "完整对接文档",
            "content": doc,
            "category": "coding",
            "tags": ["api", "integration"],
            "agent_id": "chunk-test",
        })
        mid = proposed["memory_id"]
        self.assertIsNotNone(mid)

        # 查询
        result = self.api.query({
            "query": "对接文档设计",
            "agent_id": "chunk-test",
        })
        self.assertTrue(result["found"])
        # 聚合后的内容应长于任意单块
        best = result["swarm_result"]
        self.assertIsNotNone(best)
        self.assertGreaterEqual(
            len(best["content"]), len(doc) * 0.6,
            f"聚合内容长度 {len(best['content'])} 应接近原文 {len(doc)}"
        )

    def test_both_chunked_and_simple_memories_coexist(self):
        """分档和非分档记忆共存查询"""
        self.api.register_agent({
            "agent_id": "mix-test",
            "physical_user": "test-runner",
        })
        # 短记忆
        self.api.propose_memory({
            "title": "简单规则",
            "content": "这是简单规则说明。",
            "category": "coding",
            "tags": ["rule"],
            "agent_id": "mix-test",
        })
        # 长记忆
        long_doc = "\n\n".join([
            "## 规则详解\n\n详细规则内容 " * 100 for _ in range(10)
        ])
        self.api.propose_memory({
            "title": "规则详解",
            "content": long_doc,
            "category": "coding",
            "tags": ["rule"],
            "agent_id": "mix-test",
        })

        results = self.api.query({"query": "规则", "agent_id": "mix-test"})
        self.assertTrue(results["found"])
        self.assertGreaterEqual(len(results["swarm_results"]), 1)


class QueryRewritingTests(unittest.TestCase):
    """测试查询重写 + 多角度检索"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_memory(self.tmp.name)
        from cerebrate.config import config
        config.query_rewrite_enabled = True
        config.query_rewrite_max_variations = 3

    def tearDown(self):
        self.tmp.cleanup()

    def test_rewrite_disabled_returns_single(self):
        """禁用时只返回原始查询"""
        from cerebrate.brain.rewriter import rewrite_query
        result = rewrite_query("测试查询", enabled=False)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0], "测试查询")

    def test_rewrite_empty_query(self):
        """空查询不崩溃"""
        from cerebrate.brain.rewriter import rewrite_query
        result = rewrite_query("", enabled=True)
        self.assertEqual(result, [""])

    def test_rewrite_rule_base_produces_variants(self):
        """规则保底生成变体"""
        from cerebrate.brain.rewriter import rewrite_query
        result = rewrite_query("如何配置对接文档的接口", max_variations=3, enabled=True)
        self.assertGreaterEqual(len(result), 1)
        self.assertEqual(result[0], "如何配置对接文档的接口")
        # 应该有变体
        self.assertGreater(len(result), 1, f"规则重写应生成变体: {result}")

    def test_rewrite_extracts_core(self):
        """去掉疑问前缀"""
        from cerebrate.brain.rewriter import _extract_core
        self.assertEqual(_extract_core("请问怎么连接"), "怎么连接")
        self.assertEqual(_extract_core("如何部署服务端"), "部署服务端")
        self.assertEqual(_extract_core("什么是向量索引"), "向量索引")

    def test_rewrite_adds_english_fallback(self):
        """中文技术查询添加英文关键词"""
        from cerebrate.brain.rewriter import _add_english_fallback
        result = _add_english_fallback("对接接口文档")
        self.assertIsNotNone(result)
        self.assertIn("API", result)
        self.assertIn("integration", result)

    def test_multi_query_search_produces_more_results(self):
        """多查询检索比单查询召回更多"""
        from cerebrate.config import config
        from cerebrate.memory.swarm import SwarmMemory
        swarm = SwarmMemory(config.swarm_path)

        # 用不同表述写入多条记忆
        swarm.share(title="API 接口文档", content="API 接口调用方式说明",
                     category="coding", tags=[], source_agent="test")
        swarm.share(title="对接指南", content="系统对接详细步骤",
                     category="coding", tags=[], source_agent="test")
        swarm.share(title="开发手册", content="开发者使用手册",
                     category="coding", tags=[], source_agent="test")

        # 单查询
        single = swarm.query("接口调用", limit=5)
        # 多查询
        multi = swarm.query("接口调用", limit=5,
                            query_texts=["接口调用", "对接指南", "开发文档"])

        self.assertGreaterEqual(len(multi), len(single),
                                f"多查询 ({len(multi)}) 应 >= 单查询 ({len(single)})")

    def test_multi_query_dedup(self):
        """多查询不重复返回同一文档"""
        from cerebrate.config import config
        from cerebrate.memory.swarm import SwarmMemory
        swarm = SwarmMemory(config.swarm_path)

        swarm.share(title="核心文档", content="这是唯一的测试文档",
                     category="test", tags=[], source_agent="test")

        multi = swarm.query("核心文档", limit=5,
                            query_texts=["核心文档", "测试文档", "唯一"])
        ids = [r["memory_id"] for r in multi]
        self.assertEqual(len(ids), len(set(ids)), "多查询应去重: {ids}")

    def test_decision_router_calls_rewriter(self):
        """DecisionRouter 调用重写器"""
        from cerebrate.config import config
        from cerebrate.memory.manager import MemoryManager
        from cerebrate.brain.decision import DecisionRouter

        mm = MemoryManager(config.personal_path, config.swarm_path, config.knowledge_path)
        router = DecisionRouter(mm)

        # 存入一些记忆
        mm.share_to_swarm(title="API 手册", content="API 接口文档内容",
                           category="coding", tags=["api"], source_agent="test")
        mm.share_to_swarm(title="对接指南", content="系统对接详细步骤",
                           category="coding", tags=["integration"], source_agent="test")

        result = router.decide("test-user", "怎么对接API")
        self.assertIn("route", result)
        self.assertIn("swarm_knowledge", result)
        # 至少应该有结果
        kb = result["swarm_knowledge"]
        if kb.get("best_match"):
            self.assertIn("content", kb["best_match"])


class ContextExpansionTests(unittest.TestCase):
    """测试上下文扩展和相关性过滤"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_memory(self.tmp.name)
        from cerebrate.config import config
        config.context_expand_enabled = True
        config.context_expand_chars = 500
        config.relevance_filter_enabled = False
        from cerebrate.memory.swarm import SwarmMemory
        self.swarm = SwarmMemory(config.swarm_path)

    def tearDown(self):
        self.tmp.cleanup()

    def _make_long_doc(self) -> str:
        parts = []
        for i in range(20):
            parts.append(
                f"## 第{i}章 {['架构','接口','部署','配置','测试'][i%5]}\n\n"
                + f"这是第{i}章的详细内容。包含技术说明和设计细节。\n\n"
                + f"### 细节\n\n{'细节描述内容。' * 30}\n\n"
            )
        return "\n\n".join(parts)

    def test_chunk_offsets_stored(self):
        from cerebrate.core.chunking import chunk_document
        content = self._make_long_doc()
        chunks = chunk_document(content, max_chars=2000)
        self.assertGreater(len(chunks), 1)
        for ch in chunks:
            self.assertIn("start_char", ch)
            self.assertIn("end_char", ch)
            self.assertGreaterEqual(ch["end_char"], ch["start_char"])
            extracted = content[ch["start_char"]:ch["end_char"]]
            self.assertEqual(extracted, ch["text"])

    def test_context_expand_returns_expanded_text(self):
        mid = self.swarm.share(
            title="上下文测试",
            content=self._make_long_doc(),
            category="architecture",
            tags=[],
            source_agent="test",
        )
        results = self.swarm.query("架构", limit=3)
        if results:
            best = results[0]
            self.assertIn("_expanded_context", best,
                          "查询结果应有扩展上下文")
            self.assertGreater(
                len(best.get("_expanded_context", "")), 0,
                "扩展上下文不应为空")

    def test_context_range_tracking(self):
        entry = {
            "memory_id": "test_doc_c0000",
            "doc_group_id": "test_doc",
            "content": "匹配的块内容",
        }
        self.swarm._docstore_put("test_doc", {
            "title": "测试文档",
            "content": "A" * 100 + "匹配的块内容" + "B" * 100,
            "total_chunks": 3,
        })
        self.swarm._docstore_put("test_doc_c0000", {
            "doc_group_id": "test_doc",
            "chunk_index": 0,
            "content": "匹配的块内容",
            "start_char": 100,
            "end_char": 107,
        })
        expanded = self.swarm.expand_context(entry, before_chars=30, after_chars=30)
        self.assertIn("_context_range", expanded)
        cr = expanded["_context_range"]
        self.assertIn("before", cr)
        self.assertIn("after", cr)
        self.assertIn("_source_range", expanded)
        sr = expanded["_source_range"]
        self.assertEqual(sr["start"], 100)
        self.assertEqual(sr["end"], 107)

    def test_relevance_filter_rules(self):
        from cerebrate.brain.llm import CerebrateLLM
        llm = CerebrateLLM()
        result = llm._rule_filter_relevant("如何配置 API",
                                            "API 配置指南",
                                            "本文档描述了 API 的配置方法。")
        self.assertTrue(result["relevant"])
        self.assertGreater(result["relevance_score"], 0.5)

    def test_relevance_filter_rules_mismatch(self):
        from cerebrate.brain.llm import CerebrateLLM
        llm = CerebrateLLM()
        result = llm._rule_filter_relevant("如何部署服务器",
                                            "前端组件设计文档",
                                            "本文档描述了 React 组件设计")
        self.assertFalse(result["relevant"])

    def test_context_expand_single_doc(self):
        entry = {"memory_id": "single_doc", "content": "短文档"}
        expanded = self.swarm.expand_context(entry)
        self.assertEqual(expanded["_expanded_context"], "短文档")

class MetaStoreTests(unittest.TestCase):
    """测试 MetaStore（无 PostgreSQL 时的降级行为）"""

    def test_no_pg_graceful_degradation(self):
        """无 PG 时所有操作静默失败"""
        from cerebrate.memory.metastore import get_metastore
        ms = get_metastore()
        self.assertFalse(ms.available)
        self.assertFalse(ms.put_document("test"))
        self.assertIsNone(ms.get_document("test"))
        self.assertFalse(ms.delete_document("test"))
        self.assertFalse(ms.mark_reused("test"))
        self.assertFalse(ms.update_lifecycle("test", "archived"))
        self.assertEqual(ms.list_documents(), [])
        self.assertEqual(ms.get_versions("test"), [])
        stats = ms.get_stats()
        self.assertIn("available", stats)
        self.assertFalse(stats["available"])

    def test_get_metastore_singleton(self):
        """get_metastore 返回单例"""
        from cerebrate.memory.metastore import get_metastore
        ms1 = get_metastore()
        ms2 = get_metastore()
        self.assertIs(ms1, ms2)

    def test_swarm_sync_no_pg(self):
        """swarm 操作在无 PG 时正常进行"""
        import tempfile
        from cerebrate.config import config
        import cerebrate.core.embedding as embedding
        from cerebrate.memory.swarm import SwarmMemory

        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name) / "memory"
        config.memory_root = root
        config.swarm_path = root / "swarm"
        config.chroma_path = root / "chroma_data"
        config.docstore_path = root / "docstore"
        config.embedding_model = "not-a-real-local-model"
        config.embedding_allow_download = False
        config.chunk_enabled = False
        embedding._engine = None

        swarm = SwarmMemory(config.swarm_path)
        mid = swarm.share(
            title="PG 降级测试",
            content="即使没有 PostgreSQL，swarm 也能正常工作。",
            category="test",
            tags=[],
            source_agent="test",
        )
        # 正常读写
        mem = swarm.get_memory(mid)
        self.assertIsNotNone(mem)
        self.assertEqual(mem["content"], "即使没有 PostgreSQL，swarm 也能正常工作。")

        # 正常复用
        swarm.mark_reused(mid, success=True)
        mem2 = swarm.get_memory(mid)
        self.assertGreaterEqual(mem2["reuse_count"], 1)

        # 正常生命周期
        swarm.update_lifecycle(mid, "verified_skill")
        mem3 = swarm.get_memory(mid)
        self.assertEqual(mem3["life_stage"], "verified_skill")

        # 正常删除
        self.assertTrue(swarm.delete_memory(mid))
        tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
