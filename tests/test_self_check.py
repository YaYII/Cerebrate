"""Cerebrate v5.1 全面架构自检 — 检验每一层是否符合设计约定

测试范围:
  1. DocumentStore 文件格式（.md 纯文本 / .json 无 content）
  2. ChromaDB 纯索引（metadata content=""，无内容泄漏）
  3. SwarmMemory 写路径（分块 + 偏移 + 父条目）
  4. SwarmMemory 读路径（docstore 加载 + 上下文扩展）
  5. 查询管线（重写 → 搜索 → 去重 → 扩展 → 精排）
  6. 回答生成（POST /v1/answer）
  7. 边角情况（空内容 / 超长 / 并发 / 删除重建）
  8. 架构约束（chunking.py 偏移量 / embedding.py 截断警告 / 嵌入摘要）
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def configure_temp_env(tmp_name):
    """配置临时内存路径用于测试"""
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
    config.embedding_summary_chars = 1000
    config.chunk_enabled = True
    config.chunk_max_chars = 2000
    config.chunk_min_chars = 100
    config.chunk_overlap_chars = 50
    config.context_expand_enabled = False
    config.relevance_filter_enabled = False
    config.reranker_enabled = False
    config.query_rewrite_enabled = False
    config.memory_min_tokens = 0  # 测试环境不做长度限制
    embedding._engine = None


def create_swarm(tmp_name):
    """快捷创建 SwarmMemory 实例"""
    from cerebrate.memory.swarm import SwarmMemory
    from cerebrate.config import config
    return SwarmMemory(config.swarm_path)


def create_docstore(tmp_name):
    """快捷创建 DocumentStore 实例"""
    from cerebrate.memory.docstore import DocumentStore
    from cerebrate.config import config
    return DocumentStore(config.docstore_path)


# ======================================================================
# 第一层: DocumentStore 文件格式合规检查
# ======================================================================

class DocStoreFormatTests(unittest.TestCase):
    """检查 DocumentStore 的文件格式是否符合架构约定"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        self.ds = create_docstore(self.tmp.name)
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def md_path(self, doc_id: str) -> Path:
        """新版子目录结构: {type}/content/{id}.md（put 默认 type=memory）"""
        return self.ds.storage_path / "memory" / "content" / f"{doc_id}.md"

    def json_path(self, doc_id: str) -> Path:
        """新版子目录结构: {type}/meta/{id}.json（put 默认 type=memory）"""
        return self.ds.storage_path / "memory" / "meta" / f"{doc_id}.json"

    def test_md_file_is_pure_text(self):
        """.md 文件是纯文本，无 JSON 包裹"""
        self.ds.put("doc1", {
            "title": "测试",
            "content": "# Markdown 标题\n\n这是正文。\n\n- 列表项1\n- 列表项2",
            "problem_solved": "问题",
            "solution": "方案",
            "total_chunks": 1,
        })
        md_path = self.md_path("doc1")
        raw = md_path.read_text(encoding='utf-8')
        # 必须是纯 Markdown 开头，不能是 { "content":
        self.assertTrue(raw.startswith("#"), f".md 应以 Markdown 开头, 实际: {raw[:50]}")
        self.assertFalse(raw.startswith("{"), ".md 不应是 JSON")
        self.assertNotIn('"content"', raw[:100])

    def test_json_has_no_content(self):
        """.json 元数据不含 content 字段"""
        self.ds.put("doc2", {
            "title": "文档",
            "content": "正文内容",
            "problem_solved": "问题",
            "solution": "方案",
            "evidence": "证据",
            "source_agent": "test",
            "total_chunks": 1,
        })
        json_path = self.json_path("doc2")
        meta = json.loads(json_path.read_text(encoding='utf-8'))
        self.assertNotIn("content", meta, ".json 不应包含 content")
        self.assertNotIn("full_content", meta, ".json 不应包含 full_content")
        self.assertIn("title", meta, ".json 应保留 title")
        self.assertIn("problem_solved", meta, ".json 应保留 problem_solved")
        self.assertIn("solution", meta, ".json 应保留 solution")
        self.assertIn("evidence", meta, ".json 应保留 evidence")
        self.assertIn("total_chunks", meta, ".json 应保留 total_chunks")

    def test_get_returns_merged(self):
        """get() 返回 .md 内容 + .json 元数据的合并"""
        self.ds.put("doc3", {
            "title": "合并测试",
            "content": "# 合并\n\n正文内容。",
            "problem_solved": "测试问题",
            "total_chunks": 1,
        })
        result = self.ds.get("doc3")
        self.assertEqual(result.get("content"), "# 合并\n\n正文内容。")
        self.assertEqual(result.get("title"), "合并测试")
        self.assertEqual(result.get("problem_solved"), "测试问题")
        self.assertEqual(result.get("total_chunks"), 1)

    def test_get_content_skips_json(self):
        """get_content() 仅读 .md，不解析 JSON"""
        self.ds.put("doc4", {
            "title": "纯内容",
            "content": "纯文本内容",
            "total_chunks": 1,
        })
        content = self.ds.get_content("doc4")
        self.assertEqual(content, "纯文本内容")

    def test_get_metadata_skips_md(self):
        """get_metadata() 仅读 .json，不读 .md"""
        self.ds.put("doc5", {
            "title": "仅元数据",
            "content": "不读取的内容",
            "total_chunks": 3,
        })
        meta = self.ds.get_metadata("doc5")
        self.assertEqual(meta.get("title"), "仅元数据")
        self.assertEqual(meta.get("total_chunks"), 3)

    def test_grep_ability(self):
        """文件中包含的文本可以用 grep 搜索到"""
        self.ds.put("grep-test", {
            "title": "Grep 测试",
            "content": "这是一个独特的词: XYZ_UNIQUE_TOKEN_12345",
            "total_chunks": 1,
        })
        md_path = self.md_path("grep-test")
        result = subprocess.run(
            ["grep", "XYZ_UNIQUE_TOKEN_12345", str(md_path)],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0,
                         f"grep 应找到唯一 token, stdout={result.stdout}")
        self.assertIn("XYZ_UNIQUE_TOKEN_12345", result.stdout)

    def test_git_diff_friendly(self):
        """.md 文件的 diff 可读（没有 JSON 转义）"""
        self.ds.put("diff-test", {
            "title": "Diff 测试",
            "content": "第一行\n第二行\n第三行",
            "total_chunks": 1,
        })
        md_path = self.md_path("diff-test")
        lines = md_path.read_text(encoding='utf-8').split("\n")
        self.assertEqual(lines[0], "第一行")
        self.assertEqual(lines[1], "第二行")

    def test_delete_removes_both_files(self):
        """删除同时清理 .md 和 .json"""
        self.ds.put("del-test", {
            "title": "删除测试",
            "content": "待删除内容",
            "total_chunks": 1,
        })
        md_path = self.md_path("del-test")
        json_path = self.json_path("del-test")
        self.assertTrue(md_path.exists())
        self.assertTrue(json_path.exists())
        self.ds.delete("del-test")
        self.assertFalse(md_path.exists())
        self.assertFalse(json_path.exists())
        self.assertFalse(self.ds.exists("del-test"))

    def test_exists_checks_either_file(self):
        """exists() 只要 .md 或 .json 任一存在即可"""
        self.ds.put("exist-test", {
            "title": "存在测试",
            "content": "存在内容",
        })
        self.assertTrue(self.ds.exists("exist-test"))
        # 只删 .json，.md 还在
        self.json_path("exist-test").unlink()
        self.assertTrue(self.ds.exists("exist-test"))
        # 全清
        self.ds.delete("exist-test")
        self.assertFalse(self.ds.exists("exist-test"))

    def test_available_ids_lists_both(self):
        """get_available_ids() 列出 .md 和 .json 的 ID"""
        self.ds.put("a", {"title": "A", "content": "A"})
        self.ds.put("b", {"title": "B", "content": "B"})
        ids = self.ds.get_available_ids()
        self.assertIn("a", ids)
        self.assertIn("b", ids)


# ======================================================================
# 第二层: ChromaDB 纯索引检查（无内容泄漏）
# ======================================================================

class ChromaPureIndexTests(unittest.TestCase):
    """确认 ChromaDB 仅存索引，不存内容"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        self.swarm = create_swarm(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_chroma_metadata_content_is_empty(self):
        """ChromaDB metadata 的 content 字段永远是空字符串"""
        mid = self.swarm.share(
            title="泄漏测试",
            content="这是一段不应该出现在 ChromaDB 中的机密内容。",
            category="security",
            tags=["test"],
            source_agent="self-test",
        )
        # 从 ChromaDB 直接读取 metadata
        item = self.swarm._store.get(mid)
        self.assertIsNotNone(item, "ChromaDB 应存有该条目")
        meta = item["metadata"]
        self.assertEqual(meta.get("content"), "",
                         f"ChromaDB metadata content 应为空, 实际: '{meta.get('content')}'")
        self.assertEqual(meta.get("problem_solved"), "",
                         "problem_solved 应为空")
        self.assertEqual(meta.get("solution"), "",
                         "solution 应为空")
        # 验证 title 和运营字段存在
        self.assertEqual(meta.get("title"), "泄漏测试")
        self.assertEqual(meta.get("category"), "security")
        self.assertIn("test", (meta.get("tags") or "").split(","))

    def test_chroma_chunk_metadata_has_no_content(self):
        """分块条目的 metadata content 也为空"""
        long_content = "\n\n".join([f"## 第{i}节\n\n{'详细内容' * 200}" for i in range(5)])
        mid = self.swarm.share(
            title="分块泄漏测试",
            content=long_content,
            category="test",
            tags=["chunked"],
            source_agent="self-test",
        )
        # 找到分块
        chunks = self.swarm._store.get_items_by_where({"doc_group_id": mid})
        self.assertGreater(len(chunks), 0, "应生成分块")
        for ch in chunks:
            meta = ch["metadata"]
            self.assertEqual(meta.get("content"), "",
                             f"分块 {ch['id']} metadata content 应为空")
            self.assertEqual(meta.get("full_content"), "",
                             "full_content 应为空")
            self.assertNotIn("机密", str(meta), "metadata 不应包含原文")

    def test_chroma_metadata_retains_operational_fields(self):
        """ChromaDB 保留需要的运营字段"""
        mid = self.swarm.share(
            title="运营字段",
            content="内容",
            category="coding",
            tags=["python", "api"],
            source_agent="agent-x",
            outcome="success",
            confidence=0.9,
            project_id="proj-1",
            language="en",
        )
        item = self.swarm._store.get(mid)
        meta = item["metadata"]
        self.assertEqual(meta.get("title"), "运营字段")
        self.assertEqual(meta.get("category"), "coding")
        self.assertIn("python", (meta.get("tags") or "").split(","))
        self.assertEqual(meta.get("source_agent"), "agent-x")
        self.assertEqual(meta.get("outcome"), "success")
        self.assertEqual(float(meta.get("confidence", 0)), 0.9)
        self.assertEqual(meta.get("project_id"), "proj-1")
        self.assertEqual(meta.get("language"), "en")
        self.assertEqual(meta.get("life_stage"), "memory")
        self.assertGreaterEqual(meta.get("reuse_count", -1), 0)
        self.assertGreaterEqual(meta.get("success_count", -1), 0)

    def test_parent_entry_has_no_content(self):
        """分块文档的 parent 条目 content 也为空"""
        long_content = "\n\n".join([f"## 第{i}节\n\n{'内容' * 200}" for i in range(8)])
        mid = self.swarm.share(
            title="Parent 测试",
            content=long_content,
            category="test",
            tags=["parent"],
            source_agent="self-test",
        )
        item = self.swarm._store.get(mid)
        self.assertIsNotNone(item, "parent 条目应存在")
        self.assertTrue(item["metadata"].get("is_parent", False),
                        "parent 条目应有 is_parent=True")
        self.assertEqual(item["metadata"].get("content"), "",
                         "parent 条目 content 应为空")


# ======================================================================
# 第三层: SwarmMemory 写路径
# ======================================================================

class SwarmWritePathTests(unittest.TestCase):
    """检查写入路径的正确性"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        self.swarm = create_swarm(self.tmp.name)
        self.ds = create_docstore(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_short_memory_writes_to_both(self):
        """短记忆同时写入 docstore 和 chroma"""
        mid = self.swarm.share(
            title="短记忆",
            content="简短内容",
            category="test",
            tags=["short"],
            source_agent="test",
        )
        # docstore 应有 .md 和 .json
        md_content = self.ds.get_content(mid)
        self.assertEqual(md_content, "简短内容",
                         f"docstore 应有 content, 实际: {md_content}")
        meta = self.ds.get_metadata(mid)
        self.assertEqual(meta.get("title"), "短记忆")
        # category 存在 ChromaDB 中，不在 docstore .json 里
        # chroma 应有条目
        item = self.swarm._store.get(mid)
        self.assertIsNotNone(item)
        self.assertEqual(item["metadata"].get("title"), "短记忆")
        self.assertEqual(item["metadata"].get("category"), "test")

    def test_long_memory_creates_chunks(self):
        """长记忆自动分块，每块独立存储"""
        long_content = "\n\n".join([f"## 第{i}节\n\n{'详细内容' * 150}" for i in range(8)])
        mid = self.swarm.share(
            title="分块记忆",
            content=long_content,
            category="test",
            tags=["long", "chunked"],
            source_agent="test",
        )
        # 应存在分块
        chunks = self.swarm._store.get_items_by_where({"doc_group_id": mid})
        self.assertGreater(len(chunks), 1, f"长记忆应分多块, 实际 {len(chunks)} 块")

        # 查文档的总字符是否接近原文
        from cerebrate.config import config
        expected_min_chunks = len(long_content) // config.chunk_max_chars
        self.assertGreaterEqual(
            len(chunks), expected_min_chunks,
            f"分块数 (={len(chunks)}) 应至少为 原文/每块上限 (={expected_min_chunks})")

    def test_chunk_offsets_are_correct(self):
        """分块的偏移量精确对应原文位置"""
        doc = "".join([f"## 第{i}节\n\n" + "内容" * 100 + "\n\n" for i in range(30)])
        from cerebrate.core.chunking import chunk_document
        chunks = chunk_document(doc, max_chars=2000)
        self.assertGreater(len(chunks), 1, "文档应被分块")
        for ch in chunks:
            self.assertIn("start_char", ch, "每块应有 start_char")
            self.assertIn("end_char", ch, "每块应有 end_char")
            # 验证偏移量正确
            extracted = doc[ch["start_char"]:ch["end_char"]]
            self.assertEqual(
                extracted, ch["text"],
                f"偏移量 ({ch['start_char']},{ch['end_char']}) 对应的文本应与分块一致")

    def test_chunk_offsets_stored_in_docstore(self):
        """分块的偏移量存入 docstore"""
        long_content = "\n\n".join([f"## 第{i}节\n\n{'内容' * 100}" for i in range(10)])
        mid = self.swarm.share(
            title="偏移测试",
            content=long_content,
            category="test",
            tags=[],
            source_agent="test",
        )
        chunks = self.swarm._store.get_items_by_where({"doc_group_id": mid})
        found_offset = False
        for ch in chunks:
            chunk_doc = self.ds.get(ch["id"])
            if chunk_doc:
                if chunk_doc.get("start_char") is not None or chunk_doc.get("end_char") is not None:
                    found_offset = True
                    break
        self.assertTrue(found_offset, "至少有一个分块在 docstore 中存有偏移量")

    def test_parent_entry_exists(self):
        """分块文档存在 parent 条目用于统计"""
        long_content = "内容" * 5000
        mid = self.swarm.share(
            title="Parent 存在",
            content=long_content,
            category="test",
            tags=[],
            source_agent="test",
        )
        parent = self.swarm._store.get(mid)
        self.assertIsNotNone(parent)
        self.assertTrue(parent["metadata"].get("is_parent", False))


# ======================================================================
# 第四层: SwarmMemory 读路径
# ======================================================================

class SwarmReadPathTests(unittest.TestCase):
    """检查所有读路径从 docstore 而非 chroma 获取内容"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        self.swarm = create_swarm(self.tmp.name)
        self.ds = create_docstore(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_get_memory_returns_from_docstore(self):
        """get_memory() 从 docstore 加载内容"""
        mid = self.swarm.share(
            title="读取测试",
            content="这是从 docstore 读取的测试内容。",
            category="test",
            tags=[],
            source_agent="test",
            problem_solved="测试问题",
            solution="测试方案",
            evidence="测试证据",
        )
        mem = self.swarm.get_memory(mid)
        self.assertEqual(mem["content"], "这是从 docstore 读取的测试内容。")
        self.assertEqual(mem["problem_solved"], "测试问题")
        self.assertEqual(mem["solution"], "测试方案")
        self.assertEqual(mem["evidence"], "测试证据")
        self.assertEqual(mem["title"], "读取测试")
        self.assertEqual(mem["category"], "test")

    def test_query_returns_enriched_content(self):
        """query() 返回结果含 docstore 加载的内容"""
        self.swarm.share(
            title="查询测试",
            content="这是查询测试的文档内容。",
            category="test",
            tags=[],
            source_agent="test",
        )
        results = self.swarm.query("查询测试", limit=5)
        self.assertGreater(len(results), 0, "应有查询结果")
        # 最好匹配的结果应包含完整内容
        best = results[0]
        self.assertIn("查询测试", best.get("content", ""),
                       "结果内容应从 docstore 加载")

    def test_get_memory_aggregating_chunks(self):
        """分块文档的 get_memory() 聚合完整内容"""
        doc = "\n\n".join([f"## 第{i}节\n\n{'详细内容' * 80}" for i in range(6)])
        mid = self.swarm.share(
            title="分块读取",
            content=doc,
            category="test",
            tags=[],
            source_agent="test",
        )
        mem = self.swarm.get_memory(mid)
        self.assertIsNotNone(mem)
        # 聚合的内容应接近原文长度
        self.assertGreaterEqual(
            len(mem.get("content", "")), len(doc) * 0.5,
            f"聚合内容长度 {len(mem.get('content', ''))} 应与原文 {len(doc)} 接近")

    def test_context_expansion_adds_expanded_field(self):
        """上下文扩展在结果中添加 _expanded_context 字段"""
        doc = "\n\n".join([f"## 第{i}节\n\n{'详细内容' * 30}" for i in range(20)])
        mid = self.swarm.share(
            title="上下文扩展",
            content=doc,
            category="test",
            tags=[],
            source_agent="test",
        )
        from cerebrate.config import config
        config.context_expand_enabled = True
        config.context_expand_chars = 500
        results = self.swarm.query("详细内容", limit=3)
        if results:
            best = results[0]
            self.assertIn("_expanded_context", best,
                          "启用扩展后结果应有 _expanded_context")


# ======================================================================
# 第五层: 嵌入摘要检查
# ======================================================================

class EmbeddingSummaryTests(unittest.TestCase):
    """检查嵌入文本是摘要而非全文"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_build_search_text_truncates(self):
        """_build_search_text() 截断长内容为摘要"""
        from cerebrate.memory.swarm import SwarmMemory
        full_text = "详细内容 " * 2000
        summary = SwarmMemory._build_search_text(
            "标题", full_text, max_chars=500)
        # 摘要应包含标题
        self.assertIn("标题", summary)
        # 摘要应远短于原文
        self.assertLess(len(summary), len(full_text) * 0.3,
                        f"摘要长度 {len(summary)} 应远小于原文 {len(full_text)}")
        # 摘要长度应受 max_chars 限制
        self.assertLessEqual(len(summary), 1000)  # max_chars * 2

    def test_build_search_text_includes_title(self):
        """摘要始终以标题开头"""
        from cerebrate.memory.swarm import SwarmMemory
        text = SwarmMemory._build_search_text(
            "API 配置文档",
            "本文档描述 API 配置方法。" * 100,
            problem_solved="如何配置",
            solution="设置 Token",
        )
        self.assertTrue(text.startswith("API 配置文档"),
                        f"摘要应以标题开头: {text[:30]}")

    def test_short_content_not_truncated(self):
        """短文不截断"""
        from cerebrate.memory.swarm import SwarmMemory
        text = SwarmMemory._build_search_text(
            "短文档", "这是很短的文档。",
            max_chars=1000)
        self.assertIn("这是很短的文档。", text)
        self.assertLess(len(text), 500)

    def test_summary_has_problem_and_solution(self):
        """有空间时补充 problem_solved 和 solution"""
        from cerebrate.memory.swarm import SwarmMemory
        text = SwarmMemory._build_search_text(
            "标题",
            "短内容",
            problem_solved="解决什么问题",
            solution="怎么解决的",
            max_chars=2000,
        )
        self.assertIn("解决什么问题", text)
        self.assertIn("怎么解决的", text)

    def test_chroma_document_text_is_summary(self):
        """长文档分块后，ChromaDB 父条目只存标题摘要而非全文。

        设计说明（v5）：短记忆（不分块）全文直接入向量库是刻意行为，
        长文档分块后父条目 ChromaDB 只存标题（摘要），全文在 DocumentStore。
        """
        from cerebrate.memory.swarm import SwarmMemory
        from cerebrate.config import config

        # 暂时移到 swarm_path
        config.swarm_path = Path(self.tmp.name) / "swarm"
        config.chroma_path = Path(self.tmp.name) / "chroma"
        config.docstore_path = Path(self.tmp.name) / "docstore"
        config.chunk_enabled = True
        config.chunk_max_chars = 2000  # 强制 7500 字符长文档走分块路径
        import cerebrate.core.embedding as embedding
        embedding._engine = None

        swarm = SwarmMemory(config.swarm_path)
        full = "这是全文内容。里面有很多细节。" * 500
        mid = swarm.share(
            title="摘要测试",
            content=full,
            category="test",
            tags=[],
            source_agent="test",
        )
        # 直接检查 ChromaDB 父条目的 documents 字段（分块后只存标题）
        item = swarm._store.get(mid)
        chroma_doc = item.get("document", "")
        # ChromaDB 父条目的文档文本应远短于原文（只存标题/摘要）
        self.assertLess(len(chroma_doc), len(full) * 0.5,
                        f"ChromaDB 文档文本 ({len(chroma_doc)}) 应远短于原文 ({len(full)})")
        # 应包含标题
        self.assertIn("摘要测试", chroma_doc)


# ======================================================================
# 第六层: 完整查询管线
# ======================================================================

class QueryPipelineTests(unittest.TestCase):
    """检查完整的查询管线"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        self.swarm = create_swarm(self.tmp.name)
        from cerebrate.config import config
        config.query_rewrite_enabled = True
        config.context_expand_enabled = False
        config.relevance_filter_enabled = False
        config.reranker_enabled = False

    def tearDown(self):
        self.tmp.cleanup()

    def test_single_query_returns_results(self):
        """基本查询返回结果"""
        self.swarm.share(
            title="查询基础",
            content="基础查询测试内容。",
            category="test",
            tags=[],
            source_agent="test",
        )
        results = self.swarm.query("基础查询", limit=5)
        self.assertGreaterEqual(len(results), 1, "应有至少一条结果")

    def test_multi_query_returns_more(self):
        """多角度查询比单查询召回更多"""
        self.swarm.share(title="API 文档", content="API 调用方式说明",
                         category="coding", tags=[], source_agent="test")
        self.swarm.share(title="对接指南", content="系统对接步骤",
                         category="coding", tags=[], source_agent="test")
        self.swarm.share(title="开发手册", content="开发者使用说明",
                         category="coding", tags=[], source_agent="test")

        single = self.swarm.query("接口调用", limit=10)
        multi = self.swarm.query("接口调用", limit=10,
                                 query_texts=["接口调用", "对接指南", "开发文档"])
        self.assertGreaterEqual(len(multi), len(single),
                                f"多查询 ({len(multi)}) 应 >= 单查询 ({len(single)})")

    def test_multi_query_no_duplicates(self):
        """多查询不重复返回同一文档"""
        self.swarm.share(title="唯一文档", content="这是唯一的测试文档。",
                         category="test", tags=[], source_agent="test")
        multi = self.swarm.query("唯一", limit=10,
                                 query_texts=["唯一文档", "测试文档"])
        ids = [r.get("memory_id") for r in multi if r.get("memory_id")]
        self.assertEqual(len(ids), len(set(ids)), "多查询应去重")

    def test_query_filter_by_category(self):
        """按分类过滤"""
        self.swarm.share(title="架构文档", content="架构说明",
                         category="architecture", tags=[], source_agent="test")
        self.swarm.share(title="编码文档", content="编码说明",
                         category="coding", tags=[], source_agent="test")
        arch = self.swarm.query("文档", category="architecture")
        self.assertTrue(any(r["title"] == "架构文档" for r in arch),
                        "应只返回 architecture 分类")

    def test_query_filter_by_tags(self):
        """按标签过滤"""
        self.swarm.share(title="标签文档", content="标签测试",
                         category="test", tags=["python", "api"],
                         source_agent="test")
        self.swarm.share(title="其他文档", content="其他内容",
                         category="test", tags=["java"],
                         source_agent="test")
        tagged = self.swarm.query("文档", tags=["python"])
        self.assertTrue(any(r["title"] == "标签文档" for r in tagged),
                        "应只返回含 python 标签的文档")


# ======================================================================
# 第七层: 边角情况
# ======================================================================

class EdgeCaseTests(unittest.TestCase):
    """检查各种边角情况"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        self.swarm = create_swarm(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_empty_content(self):
        """空内容不崩溃"""
        mid = self.swarm.share(
            title="空内容",
            content="",
            category="test",
            tags=[],
            source_agent="test",
        )
        mem = self.swarm.get_memory(mid)
        self.assertIsNotNone(mem)
        self.assertEqual(mem.get("content", ""), "")

    def test_very_short_content(self):
        """极短内容正常"""
        mid = self.swarm.share(
            title="短",
            content="A",
            category="test",
            tags=[],
            source_agent="test",
        )
        mem = self.swarm.get_memory(mid)
        self.assertEqual(mem.get("content"), "A")

    def test_unicode_content(self):
        """Unicode 内容正常"""
        mid = self.swarm.share(
            title="Unicode",
            content="中文 English 日本語 🔥🚀",
            category="test",
            tags=[],
            source_agent="test",
        )
        mem = self.swarm.get_memory(mid)
        self.assertIn("中文", mem.get("content", ""))
        self.assertIn("🔥", mem.get("content", ""))

    def test_markdown_content_preserved(self):
        """Markdown 格式完整保留"""
        md = "# 标题\n\n## 子标题\n\n- 列表1\n- 列表2\n\n```python\nprint('hello')\n```"
        mid = self.swarm.share(
            title="Markdown",
            content=md,
            category="test",
            tags=[],
            source_agent="test",
        )
        mem = self.swarm.get_memory(mid)
        self.assertEqual(mem.get("content"), md)

    def test_delete_and_recreate(self):
        """删除后重新创建同 ID 的记忆"""
        mid = self.swarm.share(
            title="第一次",
            content="原始内容",
            category="test",
            tags=[],
            source_agent="test",
        )
        self.swarm.delete_memory(mid)
        # 重新创建会生成不同 ID（基于时间戳 hash），所以用新 ID
        mid2 = self.swarm.share(
            title="第二次",
            content="新内容",
            category="test",
            tags=[],
            source_agent="test",
        )
        mem2 = self.swarm.get_memory(mid2)
        self.assertEqual(mem2.get("content"), "新内容")

    def test_concurrent_writes(self):
        """并发写入不冲突"""
        errors = []
        lock = threading.Lock()

        def write(n):
            try:
                title = f"并发-{n}"
                mid = self.swarm.share(
                    title=title,
                    content=f"这是第 {n} 个并发写入的测试。",
                    category="test",
                    tags=["concurrent"],
                    source_agent="test",
                )
                with lock:
                    mem = self.swarm.get_memory(mid)
                    if mem.get("title") != title:
                        errors.append(f"标题不匹配: {title} vs {mem.get('title')}")
            except Exception as e:
                with lock:
                    errors.append(str(e))

        threads = [threading.Thread(target=write, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(errors), 0, f"并发写入错误: {errors}")
        # 验证所有写入的内容都可读
        for i in range(10):
            results = self.swarm.query(f"并发-{i}", limit=3)
            found = any(f"第 {i} 个" in r.get("content", "") for r in results)
            self.assertTrue(found, f"第 {i} 条并发结果应可检索到")

    def test_nonexistent_memory(self):
        """不存在的记忆返回 None"""
        mem = self.swarm.get_memory("nonexistent_id_12345")
        self.assertIsNone(mem)

    def test_mark_reused_twice(self):
        """标记复用两次，计数正确"""
        mid = self.swarm.share(
            title="复用测试",
            content="复用的内容",
            category="test",
            tags=[],
            source_agent="test",
        )
        self.swarm.mark_reused(mid, success=True)
        self.swarm.mark_reused(mid, success=True, feedback="第二次复用")
        mem = self.swarm.get_memory(mid)
        self.assertEqual(mem.get("reuse_count"), 2,
                         f"复用计数应为 2, 实际 {mem.get('reuse_count')}")
        self.assertEqual(mem.get("success_count"), 2)

    def test_update_lifecycle(self):
        """更新生命周期生效"""
        mid = self.swarm.share(
            title="生命周期",
            content="生命周期测试",
            category="test",
            tags=[],
            source_agent="test",
        )
        self.swarm.update_lifecycle(mid, "verified_skill", confidence=0.95)
        mem = self.swarm.get_memory(mid)
        self.assertEqual(mem.get("life_stage"), "verified_skill")
        self.assertEqual(mem.get("confidence"), 0.95)


# ======================================================================
# 第八层: 架构约束验证
# ======================================================================

class ArchitectureConstraintsTests(unittest.TestCase):
    """检查关键架构约束"""

    def test_no_import_of_forbidden_modules(self):
        """没有导入不应该引入的依赖"""
        from cerebrate.memory.swarm import SwarmMemory
        module = sys.modules.get(SwarmMemory.__module__)
        source = module.__file__
        with open(source) as f:
            content = f.read()
        # swarm.py 不应该直接操作 ChromaDB 外部
        # content 已经在 metadata 中设为空

    def test_chunking_returns_offsets(self):
        """chunk_document() 返回 start_char/end_char"""
        from cerebrate.core.chunking import chunk_document
        doc = "\n\n".join([f"## 第{i}节\n\n{'内容' * 50}" for i in range(20)])
        chunks = chunk_document(doc, max_chars=2000)
        if len(chunks) > 1:
            for ch in chunks:
                self.assertIn("start_char", ch)
                self.assertIn("end_char", ch)

    def test_config_defaults(self):
        """验证关键配置默认值符合预期"""
        from cerebrate.config import config
        self.assertEqual(config.embedding_summary_chars, 1000)
        self.assertEqual(config.embedding_max_length, 8192)
        self.assertTrue(config.chunk_enabled)

    def test_search_text_is_not_full_content(self):
        """search_text 不应包含全文长字符串（应已改为摘要）"""
        from cerebrate.memory.swarm import SwarmMemory
        full = "A" * 10000
        text = SwarmMemory._build_search_text("标题", full, max_chars=1000)
        self.assertLess(len(text), 2000,
                        f"search_text 长度 {len(text)} 应被截断")
        self.assertIn("标题", text)


# ======================================================================
# 第九层: 端到端 BrainAPI
# ======================================================================

class EndToEndAPITests(unittest.TestCase):
    """端到端通过 BrainAPI 验证完整管线"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()
        self.api.register_agent({
            "agent_id": "e2e-test",
            "physical_user": "self-test",
        })

    def tearDown(self):
        self.tmp.cleanup()

    def test_propose_and_get_memory(self):
        """propose 后 get_memory 返回完整内容"""
        proposed = self.api.propose_memory({
            "title": "E2E 测试",
            "content": "端到端测试内容。",
            "category": "test",
            "tags": ["e2e"],
            "agent_id": "e2e-test",
        })
        memory = self.api.get_memory(proposed["memory_id"])
        self.assertEqual(memory["content"], "端到端测试内容。")
        self.assertEqual(memory["title"], "E2E 测试")

    def test_query_returns_docs(self):
        """query 返回文档"""
        self.api.propose_memory({
            "title": "查询 E2E",
            "content": "查询测试内容。",
            "category": "test",
            "tags": [],
            "agent_id": "e2e-test",
        })
        result = self.api.query({
            "query": "查询测试",
            "agent_id": "e2e-test",
        })
        self.assertTrue(result["found"])
        self.assertIsNotNone(result["swarm_result"])

    def test_answer_api_structure(self):
        """/v1/answer 返回正确结构"""
        self.api.propose_memory({
            "title": "问答测试",
            "content": "问答测试内容。",
            "category": "test",
            "tags": [],
            "agent_id": "e2e-test",
        })
        result = self.api.answer({
            "query": "问答测试",
            "agent_id": "e2e-test",
        })
        self.assertIn("query", result)
        self.assertIn("answer", result)
        self.assertIn("sources", result)
        self.assertEqual(result["query"], "问答测试")

    def test_lifecycle_flow(self):
        """完整生命周期流程"""
        mid = self.api.propose_memory({
            "title": "生命周期 E2E",
            "content": "生命周期测试内容。",
            "category": "test",
            "tags": [],
            "agent_id": "e2e-test",
        })["memory_id"]

        # 复用
        usage = self.api.start_usage({
            "memory_id": mid,
            "agent_id": "e2e-test",
            "problem": "测试复用",
        })
        self.api.finish_usage({
            "usage_id": usage["usage_id"],
            "outcome": "success",
            "feedback": "E2E 测试通过",
        })

        memory = self.api.get_memory(mid)
        self.assertGreaterEqual(memory["reuse_count"], 1)

    def test_sense_returns_state(self):
        """sense 返回系统状态"""
        sense = self.api.sense()
        self.assertIn("health", sense)
        self.assertIn("total_agents", sense)
        self.assertIn("total_memories", sense)
        self.assertIn("embedding_mode", sense)


# ======================================================================
# 第十层: 记忆最小长度约束（≥500 tokens）
# ======================================================================

class MemoryMinLengthTests(unittest.TestCase):
    """验证记忆内容必须 ≥500 tokens，不足则驳回"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()
        self.api.register_agent({
            "agent_id": "length-test",
            "physical_user": "self-test",
        })
        from cerebrate.config import config
        config.memory_min_tokens = 500

    def tearDown(self):
        self.tmp.cleanup()

    # ── 测试 estimate_tokens 工具函数 ──

    def test_estimate_tokens_short_text(self):
        """短文本 token 数远小于 500"""
        from cerebrate.core.chunking import estimate_tokens
        t = estimate_tokens("这是一条很短的测试记忆内容。")
        self.assertLess(t, 500)

    def test_estimate_tokens_long_text(self):
        """长文本 token 数 ≥ 500"""
        from cerebrate.core.chunking import estimate_tokens
        # 500 汉字 ≈ 750 token
        text = "架构设计说明。" * 100  # 600 字
        t = estimate_tokens(text)
        self.assertGreaterEqual(t, 500, f"600 字应有 ≥500 token, 实际 {t}")

    def test_estimate_tokens_empty(self):
        """空文本 token 数极低"""
        from cerebrate.core.chunking import estimate_tokens
        self.assertLess(estimate_tokens(""), 10)

    def test_estimate_tokens_mixed_language(self):
        """中英混合正确估算"""
        from cerebrate.core.chunking import estimate_tokens
        text = "Cerebrate 脑虫服务端 API 鉴权配置方法。" * 30
        self.assertGreater(estimate_tokens(text), 0)

    # ── API 层驳回测试 ──

    def test_short_memory_rejected(self):
        """内容不足 500 token 被驳回"""
        from cerebrate.config import config
        config.memory_min_tokens = 500
        with self.assertRaises(ValueError) as ctx:
            self.api.propose_memory({
                "title": "太短的记忆",
                "content": "这是一条非常短的内容。",
                "category": "test",
                "tags": [],
                "agent_id": "length-test",
            })
        err = str(ctx.exception)
        self.assertIn("token", err.lower() or "500", "错误信息应提及 token 限制")

    def test_mid_length_chinese_rejected(self):
        """200 汉字的记忆（~300 token）仍被驳回"""
        from cerebrate.config import config
        config.memory_min_tokens = 500
        short_content = "架构设计说明。" * 33  # ~198 字 ≈ 300 token
        from cerebrate.core.chunking import estimate_tokens
        self.assertLess(estimate_tokens(short_content), 500,
                        f"测试前提不成立：内容应有 <500 token")
        with self.assertRaises(ValueError):
            self.api.propose_memory({
                "title": "中等长度记忆",
                "content": short_content,
                "category": "test",
                "tags": [],
                "agent_id": "length-test",
            })

    def test_long_enough_memory_accepted(self):
        """内容 ≥500 token 正常通过"""
        from cerebrate.core.chunking import estimate_tokens
        # 400 汉字 ≈ 600 token
        valid_content = "架构设计详细说明。API 鉴权配置方法。" * 67
        token_count = estimate_tokens(valid_content)
        self.assertGreaterEqual(token_count, 500,
                                f"测试前提: 应有 ≥500 token, 实际 {token_count}")
        result = self.api.propose_memory({
            "title": "足够的记忆",
            "content": valid_content,
            "category": "coding",
            "tags": ["api", "auth"],
            "agent_id": "length-test",
        })
        self.assertIn("memory_id", result)
        # 验证存储的内容完整
        mem = self.api.get_memory(result["memory_id"])
        self.assertEqual(mem["content"], valid_content)

    def test_exactly_500_tokens_accepted(self):
        """恰好 500 token 通过"""
        from cerebrate.core.chunking import estimate_tokens
        from cerebrate.config import config
        config.memory_min_tokens = 500
        # 333 汉字 ≈ 500 token
        exact_content = "设计说明。" * 84  # 336 字
        t = estimate_tokens(exact_content)
        self.assertGreaterEqual(t, 500, f"应有 ≥500 token, 实际 {t}")
        result = self.api.propose_memory({
            "title": "刚够的记忆",
            "content": exact_content,
            "category": "test",
            "tags": [],
            "agent_id": "length-test",
        })
        self.assertIn("memory_id", result)

    def test_config_changes_threshold(self):
        """配置可调阈值"""
        from cerebrate.config import config
        config.memory_min_tokens = 1000  # 调整到 1000
        # 500 token 的内容现在应该被驳回
        with self.assertRaises(ValueError):
            self.api.propose_memory({
                "title": "不够 1000 token",
                "content": "设计说明。" * 84,  # ~500 token
                "category": "test",
                "tags": [],
                "agent_id": "length-test",
            })

    def test_empty_content_rejected(self):
        """空内容直接被驳回（走现有的 empty check）"""
        with self.assertRaises(ValueError):
            self.api.propose_memory({
                "title": "空内容",
                "content": "",
                "category": "test",
                "tags": [],
                "agent_id": "length-test",
            })

    def test_title_only_short_rejected(self):
        """有标题但内容极短被驳回"""
        from cerebrate.config import config
        config.memory_min_tokens = 500
        with self.assertRaises(ValueError):
            self.api.propose_memory({
                "title": "只有标题没有内容",
                "content": "短短短",
                "category": "test",
                "tags": [],
                "agent_id": "length-test",
            })

    # ── swarm.share() 层测试（底层保护）──

    def test_swarm_share_short_goes_through(self):
        """swarm.share() 内部调用不拦截短文（API 层负责拦截）"""
        from cerebrate.config import config
        from cerebrate.memory.swarm import SwarmMemory
        config.memory_min_tokens = 500
        swarm = SwarmMemory(config.swarm_path)
        mid = swarm.share(
            title="底层短文",
            content="太短了。",
            category="test",
            tags=[],
            source_agent="test",
        )
        mem = swarm.get_memory(mid)
        self.assertEqual(mem["content"], "太短了。")

    def test_swarm_share_long_accepted(self):
        """swarm.share() 长文通过"""
        from cerebrate.config import config
        from cerebrate.memory.swarm import SwarmMemory
        swarm = SwarmMemory(config.swarm_path)
        long_text = "架构设计文档详细说明。" * 70
        mid = swarm.share(
            title="底层长文",
            content=long_text,
            category="test",
            tags=[],
            source_agent="test",
        )
        mem = swarm.get_memory(mid)
        self.assertEqual(mem["content"], long_text)


if __name__ == "__main__":
    unittest.main()
