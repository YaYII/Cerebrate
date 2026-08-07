"""本地实体抽取测试（实体本地 MCP 决策 2026-08-06）。

覆盖:
  - 规则抽取：命令/技术关键词/驼峰/下划线/URL/邮箱/引号术语
  - 去重计数、排除纯数字/hash
  - 本地实体图谱读写与合并（持久化）
  - 已知图谱类型复用
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unittest import mock

import cerebrate.mcp as mcp
from cerebrate.entity import (
    extract_and_update,
    extract_entities,
    load_store,
    save_store,
    update_store,
)


class ExtractEntitiesTests(unittest.TestCase):
    def test_command_extraction(self):
        ents = extract_entities("部署用 docker compose up -d 启动服务")
        # 命令动词归入 tech（不提取整段命令，避免噪音与关键词冗余）
        types = {e["name"]: e["type"] for e in ents}
        self.assertEqual(types.get("docker"), "tech")
        self.assertNotIn("docker compose up -d 启动服务",
                         [e["name"] for e in ents])

    def test_tech_keywords(self):
        ents = extract_entities("用 nginx 和 ngrok 做公网穿透")
        types = {e["name"]: e["type"] for e in ents}
        self.assertEqual(types.get("nginx"), "tech")
        self.assertEqual(types.get("ngrok"), "tech")

    def test_camel_and_snake(self):
        ents = extract_entities("UserAuth 与 origin_log 是核心模块")
        types = {e["name"]: e["type"] for e in ents}
        self.assertEqual(types.get("UserAuth"), "tech")
        self.assertEqual(types.get("origin_log"), "tech")

    def test_url_and_email(self):
        ents = extract_entities(
            "访问 https://example.com 联系 a@b.com")
        types = {e["name"]: e["type"] for e in ents}
        self.assertEqual(types.get("https://example.com"), "url")
        self.assertEqual(types.get("a@b.com"), "contact")

    def test_quoted_term(self):
        ents = extract_entities("叫它\"记忆去重\"就好了")
        self.assertIn("记忆去重",
                      [e["name"] for e in ents])

    def test_count_and_dedupe(self):
        ents = extract_entities("docker docker docker git")
        by_name = {e["name"]: e for e in ents}
        self.assertEqual(by_name["docker"]["count"], 3)
        self.assertEqual(len(ents), 2)

    def test_excludes_sha_and_numbers(self):
        ents = extract_entities("提交 9f86d081884c7d65 与数字 12345")
        names = [e["name"] for e in ents]
        self.assertNotIn("9f86d081884c7d65", names)
        self.assertNotIn("12345", names)

    def test_empty_text(self):
        self.assertEqual(extract_entities(""), [])
        self.assertEqual(extract_entities(None), [])


class LocalStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store_path = Path(self.tmp.name) / "entities.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_store_roundtrip(self):
        save_store({"docker": {"name": "docker", "type": "tech", "count": 1}},
                   self.store_path)
        store = load_store(self.store_path)
        self.assertEqual(store["docker"]["count"], 1)

    def test_update_accumulates_count(self):
        store = {}
        ents = [{"name": "docker", "type": "tech", "count": 2}]
        update_store(ents, store)
        update_store(ents, store)
        self.assertEqual(store["docker"]["count"], 4)
        self.assertIn("first_seen", store["docker"])
        self.assertIn("last_seen", store["docker"])

    def test_extract_and_update_persists(self):
        result = extract_and_update(
            "docker 与 nginx 是部署核心", store_path=self.store_path)
        self.assertTrue(result["persisted"])
        self.assertTrue(result["store_size"] >= 2)
        store = load_store(self.store_path)
        self.assertIn("docker", store)
        self.assertIn("nginx", store)

    def test_known_type_reuse(self):
        known = {"alice": {"name": "alice", "type": "person", "count": 1}}
        ents = extract_entities("alice 负责这个模块", known=known)
        alice = next(e for e in ents if e["name"] == "alice")
        self.assertEqual(alice["type"], "person")

    def test_known_entity_no_double_count(self):
        # 规则命中的实体，known 图谱不应再重复计数
        known = {"docker": {"name": "docker", "type": "tech", "count": 5}}
        ents = extract_entities("docker 部署", known=known)
        docker = next(e for e in ents if e["name"] == "docker")
        self.assertEqual(docker["count"], 1)

    def test_known_entity_persists_type(self):
        # 图谱实体在后续抽取中被识别并保留原类型
        store = {"flowable": {"name": "flowable", "type": "domain",
                              "count": 1, "first_seen": "", "last_seen": ""}}
        ents = extract_entities("flowable 流程引擎", known=store)
        flowable = next(e for e in ents if e["name"] == "flowable")
        self.assertEqual(flowable["type"], "domain")

    def test_top_limit(self):
        result = extract_and_update(
            "docker git nginx ngrok curl pip npm ssh make kubectl",
            store_path=self.store_path, top=3)
        self.assertLessEqual(len(result["entities"]), 3)


class McpEntityIntegrationTests(unittest.TestCase):
    """MCP 处理器：cerebrate_entity_extract 与 propose auto_entities 集成。"""

    def test_entity_extract_handler(self):
        with mock.patch.object(
                mcp, "_ENTITY_STORE",
                Path(tempfile.mkdtemp()) / "entities.json"):
            result = mcp._handle_call("cerebrate_entity_extract", {
                "text": "用 docker 和 nginx 部署，改 origin_log 保留策略",
                "persist": True,
            })
        self.assertEqual(result["status"], "ok")
        names = [e["name"] for e in result["data"]["entities"]]
        self.assertIn("docker", names)
        self.assertIn("nginx", names)
        self.assertIn("origin_log", names)
        self.assertEqual(result["data"]["source"], "local")

    def test_propose_auto_entities_merges_tags(self):
        captured = {}

        def fake_request(method, path, body):
            captured["body"] = body
            return {"status": "ok", "data": {"memory_id": "m-1"}}

        with mock.patch.object(mcp, "_request", side_effect=fake_request):
            mcp._handle_call("cerebrate_propose", {
                "title": "docker 部署",
                "content": "用 docker compose 和 nginx 部署脑虫",
                "tags": "deploy",
                "category": "devops",
                "problem": "p",
                "solution": "s",
                "auto_entities": True,
            })
        tags = [t.strip() for t in captured["body"]["tags"].split(",")]
        self.assertIn("deploy", tags)
        self.assertIn("docker", tags)
        self.assertIn("nginx", tags)

    def test_propose_auto_entities_disabled(self):
        captured = {}

        def fake_request(method, path, body):
            captured["body"] = body
            return {"status": "ok", "data": {"memory_id": "m-2"}}

        with mock.patch.object(mcp, "_request", side_effect=fake_request):
            mcp._handle_call("cerebrate_propose", {
                "title": "纯标签",
                "content": "docker 相关内容",
                "tags": "deploy",
                "category": "devops",
                "problem": "p",
                "solution": "s",
                "auto_entities": False,
            })
        tags = [t.strip() for t in captured["body"]["tags"].split(",")]
        self.assertEqual(tags, ["deploy"])


if __name__ == "__main__":
    unittest.main()
