"""本地 MCP 客户端（cerebrate/mcp.py）新工具分发自检

需求（2026-08-07，v5.2.0/5.2.1 新增 10 个工具后用户强调要有测试）:
  - _handle_call 对 scene/skill/loadout 新工具正确分发
  - 每个工具请求的 HTTP method + path + payload 与服务端契约一致
  - 不依赖真实服务（mock _request），纯静态回归防漏同步
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cerebrate.mcp as mcp  # noqa: E402


class LocalDispatchTests(unittest.TestCase):
    """_handle_call 分发到 _request 的路径/payload 正确性"""

    def setUp(self):
        self.calls: list[tuple] = []
        patcher = mock.patch.object(
            mcp, "_request",
            side_effect=lambda method, path, body=None: self._record(
                method, path, body))
        self._patcher = patcher
        patcher.start()
        self.addCleanup(patcher.stop)

    def _record(self, method, path, body):
        self.calls.append((method, path, body))
        return {"status": "ok", "data": {"ok": True}}

    def _last(self):
        return self.calls[-1]

    # ── scene 系列 ──

    def test_scene_ingest(self):
        mcp._handle_call("cerebrate_scene_ingest", {
            "session_id": "s1",
            "events": [{"kind": "msg", "text": "x"}],
            "prompt": "p",
        })
        method, path, body = self._last()
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/v1/scene/ingest")
        self.assertEqual(body["session_id"], "s1")
        self.assertEqual(body["events"], [{"kind": "msg", "text": "x"}])

    def test_scene_get(self):
        mcp._handle_call("cerebrate_scene_get", {"session_id": "s1"})
        method, path, body = self._last()
        self.assertEqual(method, "GET")
        self.assertEqual(path, "/v1/scene/s1")
        self.assertIsNone(body)

    def test_scene_compress(self):
        mcp._handle_call("cerebrate_scene_compress", {
            "session_id": "s1", "force": True})
        method, path, body = self._last()
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/v1/scene/compress")
        self.assertTrue(body["force"])

    def test_scene_list(self):
        mcp._handle_call("cerebrate_scene_list", {})
        method, path, body = self._last()
        self.assertEqual(method, "GET")
        self.assertEqual(path, "/v1/scene/list")

    def test_scene_distill(self):
        mcp._handle_call("cerebrate_scene_distill", {
            "session_id": "s1", "cleanup": True, "project_id": "p1"})
        method, path, body = self._last()
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/v1/scene/distill")
        self.assertTrue(body["cleanup"])
        self.assertEqual(body["project_id"], "p1")

    # ── skill 版本化系列 ──

    def test_skill_append_version(self):
        mcp._handle_call("cerebrate_skill_append_version", {
            "memory_id": "mid1", "content": "c",
            "description": "d", "skill_markdown": "---",
        })
        method, path, body = self._last()
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/v1/skills/append-version")
        self.assertEqual(body["memory_id"], "mid1")
        self.assertEqual(body["content"], "c")
        self.assertEqual(body["skill_markdown"], "---")
        self.assertIn("physical_user", body)

    def test_skill_versions(self):
        mcp._handle_call("cerebrate_skill_versions", {"memory_id": "mid1"})
        method, path, body = self._last()
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/v1/skills/versions")
        self.assertEqual(body["memory_id"], "mid1")

    def test_skill_diff(self):
        mcp._handle_call("cerebrate_skill_diff", {
            "memory_id": "mid1", "from_version": "1", "to_version": "2"})
        method, path, body = self._last()
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/v1/skills/diff")
        self.assertEqual(body["from_version"], "1")
        self.assertEqual(body["to_version"], "2")

    # ── loadout 系列 ──

    def test_loadout_set(self):
        mcp._handle_call("cerebrate_loadout_set", {
            "bound_projects": ["cerebrate"],
            "preferred_scope": "project",
            "bound_tags": ["skill"],
        })
        method, path, body = self._last()
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/v1/loadout")
        self.assertEqual(body["bound_projects"], ["cerebrate"])
        self.assertEqual(body["preferred_scope"], "project")

    def test_loadout_get(self):
        with mock.patch.object(mcp, "_PHYSICAL_USER", "alice"):
            mcp._handle_call("cerebrate_loadout_get", {"user": "alice"})
        method, path, body = self._last()
        self.assertEqual(method, "GET")
        self.assertIn("/v1/loadout", path)
        self.assertIn("user=alice", path)


if __name__ == "__main__":
    unittest.main()
