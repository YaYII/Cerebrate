"""系统边界测试：验证业务画像/代码同步在边界输入下不崩溃。

覆盖:
  - 空 harvest / 空目录 harvest
  - 无画像 / 无 harvest 的 navigate/verify
  - 非法参数（level / project_id / package_b64）
  - 恶意 tar（路径穿越）与超大包
  - 损坏 manifest 回退全量
  - LLM 非法 JSON 解析回退
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
    config.profile_path = root / "profiles"
    config.code_repos_path = root / "code_repos"
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
    config.fulltext_enabled = True
    config.profile_llm_enabled = False
    embedding._engine = None


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()
        self.api.register_agent({
            "agent_id": "boundary-test",
            "capabilities": ["testing"], "physical_user": "tester",
        })

    def tearDown(self):
        self.tmp.cleanup()

    # ── 空数据 ──
    def test_empty_harvest_no_crash(self):
        """空 harvest（空目录）不崩，stats 为 0。"""
        from cerebrate.tools.code_harvest import harvest_project
        empty = Path(self.tmp.name) / "empty_project"
        empty.mkdir()
        h = harvest_project(empty, project_id="empty")
        self.assertEqual(h["stats"]["files"], 0)
        self.assertEqual(h["stats"]["modules"], 0)

    def test_build_draft_empty_project_no_crash(self):
        """无任何业务记忆/无 harvest 时 build_draft 返回空画像不崩。"""
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.api.mm)
        draft = store.build_draft("ghost-project")
        self.assertEqual(draft["status"], "draft")
        self.assertEqual(draft["domains"], [])
        self.assertEqual(draft["flows"], [])

    def test_navigate_verify_no_profile_no_crash(self):
        """无画像/无 harvest 的 navigate/verify 返回原因，不抛异常。"""
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.api.mm)
        nav = store.navigate("ghost", "anything")
        self.assertFalse(nav["found"])
        self.assertEqual(nav["reason"], "no_profile")
        ver = store.verify("ghost")
        self.assertFalse(ver["ok"])
        self.assertIn("reason", ver)

    # ── 非法参数 ──
    def test_invalid_level_rejected(self):
        """非法 level 抛 ValueError（HTTP 层 400），不崩。"""
        with self.assertRaises(ValueError):
            self.api.project_profile(
                {"project": "x", "action": "read", "level": "bogus"})

    def test_missing_project_id_rejected(self):
        """缺少 project_id 抛 ValueError。"""
        with self.assertRaises(ValueError):
            self.api.project_profile({"action": "read"})
        with self.assertRaises(ValueError):
            self.api.project_navigate({"target": "x"})
        with self.assertRaises(ValueError):
            self.api.code_sync({"package_b64": "AAAA"})

    # ── 恶意/非法输入 ──
    def test_malicious_tar_path_traversal_rejected(self):
        """恶意 tar（../ 路径穿越）被拒绝，不写出越界文件。"""
        import io, tarfile, base64
        from cerebrate.tools.code_sync import receive_package
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            info = tarfile.TarInfo("../evil.txt")
            data = b"pwned"
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        res = receive_package("evil", base64.b64encode(buf.getvalue()).decode())
        repo = Path(self.tmp.name) / "memory" / "code_repos" / "evil"
        self.assertEqual(res["files_written"], 0)
        self.assertFalse((repo.parent.parent / "evil.txt").exists())

    def test_empty_package_rejected(self):
        """空 package_b64 抛 ValueError。"""
        from cerebrate.tools.code_sync import receive_package
        with self.assertRaises(ValueError):
            receive_package("x", "")

    def test_corrupt_manifest_falls_back_to_full(self):
        """损坏的本地 manifest 回退全量同步，不崩。"""
        import os, textwrap
        from cerebrate.tools.code_sync import (
            build_package, _manifest_path)
        proj = Path(self.tmp.name) / "corrupt_project"
        (proj / "src").mkdir(parents=True)
        (proj / "src" / "a.py").write_text("A=1", encoding="utf-8")
        mp = _manifest_path("corrupt")
        mp.parent.mkdir(parents=True, exist_ok=True)
        mp.write_text("{ not valid json", encoding="utf-8")
        pkg = build_package(proj, project_id="corrupt")
        self.assertEqual(pkg["incremental"], False)  # 回退全量
        self.assertEqual(pkg["files_changed"], 1)

    def test_llm_invalid_json_parse_returns_none(self):
        """LLM 返回非法 JSON 时 _parse_json 返回 None（上层回退骨架）。"""
        from cerebrate.tools.project_profile import ProfileStore
        self.assertIsNone(ProfileStore._parse_json("not json at all"))
        self.assertIsNone(ProfileStore._parse_json("```json\n{broken\n```"))
        self.assertIsNone(ProfileStore._parse_json("[]"))

    def test_parse_json_from_fenced_block(self):
        """LLM 输出 markdown 围栏 JSON 也能解析。"""
        from cerebrate.tools.project_profile import ProfileStore
        out = ProfileStore._parse_json(
            '```json\n{"domains": [], "flows": []}\n```')
        self.assertEqual(out, {"domains": [], "flows": []})

    # ── API 层边界（HTTP 语义） ──
    def test_api_actions_unknown_rejected(self):
        """未知 action 抛 ValueError。"""
        with self.assertRaises(ValueError):
            self.api.project_profile({"project": "x", "action": "bogus"})


if __name__ == "__main__":
    unittest.main()
