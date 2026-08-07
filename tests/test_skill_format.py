"""Skill 结构化资产自检 — SKILL.md frontmatter 解析（借鉴 TencentDB Agent Memory）

需求（v5.6 借鉴点）:
  - 解析 `---` 围栏 frontmatter（name/description/version/category/trigger/validation/resources）
  - 校验必填字段（name/description）与长度限制
  - 非 SKILL.md（无 frontmatter）返回 None → 按普通记忆处理（零破坏）
  - propose 带 skill_markdown → 写入结构化字段 → 详情/索引层可见
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cerebrate.core.skill_format import (  # noqa: E402
    parse_skill_markdown,
    validate_skill_fields,
)


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


SKILL_MD = """---
name: doubao-vision
description: 用豆包多模态识别图片，只识别绝不生图
version: 1.0
category: vision
trigger: 用户请求识别本地图片或图片 URL
validation: 返回结构化图像描述
resources: vision.py
---
调用 vision.py 识别图片：
1. 本地图片传路径，远程图片传 URL
2. 超过 1MB 自动压缩
3. 模型不可用时自动降级
"""


class SkillFormatTests(unittest.TestCase):
    """skill_format 纯函数测试"""

    def test_parse_full_frontmatter(self):
        parsed = parse_skill_markdown(SKILL_MD)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["name"], "doubao-vision")
        self.assertEqual(parsed["version"], "1.0")
        self.assertEqual(parsed["trigger"], "用户请求识别本地图片或图片 URL")
        self.assertEqual(parsed["validation"], "返回结构化图像描述")
        self.assertEqual(parsed["resources"], "vision.py")
        self.assertIn("识别图片", parsed["body"])

    def test_parse_default_version(self):
        md = "---\nname: x\n描述: y\n---\nbody"
        # 中文键名不被识别为 name → 无 name → None（零破坏）
        self.assertIsNone(parse_skill_markdown(md))
        md2 = "---\nname: x\ndescription: y\n---\nbody"
        parsed = parse_skill_markdown(md2)
        self.assertEqual(parsed["version"], "1.0")
        self.assertEqual(parsed["body"], "body")

    def test_parse_non_skill_returns_none(self):
        self.assertIsNone(parse_skill_markdown("普通记忆，没有 frontmatter"))
        self.assertIsNone(parse_skill_markdown(""))
        self.assertIsNone(parse_skill_markdown("---\nno closing fence"))

    def test_validate_required_fields(self):
        ok, issues = validate_skill_fields({"name": "good-name", "description": "desc"})
        self.assertTrue(ok)
        self.assertEqual(issues, [])
        ok2, issues2 = validate_skill_fields({"name": "Bad Name!", "description": "desc"})
        self.assertFalse(ok2)
        self.assertTrue(any("name" in i for i in issues2))
        ok3, _ = validate_skill_fields({"name": "ok", "description": ""})
        self.assertFalse(ok3)

    def test_validate_lengths(self):
        ok, _ = validate_skill_fields(
            {"name": "x" * 65, "description": "d" * 1100})
        self.assertFalse(ok)


class SkillProposeTests(unittest.TestCase):
    """端到端：propose 带 skill_markdown → 检索/详情可见结构化字段"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self._tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self._tmp.cleanup()

    def test_propose_skill_markdown_roundtrip(self):
        result = self.api.propose_memory({
            "title": "",
            "content": SKILL_MD,
            "category": "skill",
            "tags": "skill,vision,doubao",
            "problem": "deepseek 无图像识别",
            "solution": "用豆包视觉识别图片",
            "agent": "codex",
            "physical_user": "test-user",
            "validate": False,
            "skill_markdown": SKILL_MD,
        })
        self.assertTrue(result.get("skill"), "skill_markdown 应被解析为结构化技能")
        memory_id = result["memory_id"]

        # 详情层：skill 字段完整
        detail = self.api.memory_detail({"ids": [memory_id]})
        mem = detail["memories"][0]
        skill = mem.get("skill", {})
        self.assertEqual(skill.get("name"), "doubao-vision")
        self.assertEqual(skill.get("version"), "1.0")

        # 索引层：skill 摘要可见
        idx = self.api.search({"query": "doubao 识别图片", "mode": "vector",
                               "agent_id": "codex", "limit": 5})
        found = [e for e in idx["index"] if e.get("memory_id") == memory_id]
        self.assertTrue(found)
        self.assertEqual(found[0]["skill"]["name"], "doubao-vision")

    def test_propose_invalid_skill_raises(self):
        with self.assertRaises(ValueError):
            self.api.propose_memory({
                "title": "",
                "content": "---\nname: Bad Name!\ndescription: d\n---\nbody",
                "category": "skill",
                "tags": "skill",
                "problem": "",
                "solution": "",
                "agent": "codex",
                "physical_user": "test-user",
                "validate": False,
                "skill_markdown": "---\nname: Bad Name!\ndescription: d\n---\nbody",
            })

    def test_propose_plain_memory_ignores_skill(self):
        """不带 skill_markdown 的普通记忆：零影响，不出现 skill 字段。"""
        result = self.api.propose_memory({
            "title": "普通记忆",
            "content": "这是一个普通的技术记忆，用于验证不带 skill_markdown 时行为不变。"
                       "包含足够长度的内容以通过最小 token 校验。",
            "category": "coding",
            "tags": "test",
            "problem": "",
            "solution": "",
            "agent": "codex",
            "physical_user": "test-user",
            "validate": False,
        })
        self.assertFalse(result.get("skill", False))


if __name__ == "__main__":
    unittest.main()
