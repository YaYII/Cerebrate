"""认证权限测试 — owner 身份优先 / 查询优先自己 / 投票放开。

覆盖:
  - propose 时 owner 以服务端身份（_current_user）为准，客户端伪造 physical_user 无效
  - 未登录时回退客户端自报（旧客户端兼容）
  - search 时自己的记忆排到前面（查询优先自己）
  - query 时 all_matches 自己的记忆提前
  - vote 可对他人记忆投票（不校验 owner）
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
    config.auth_path = root / "auth"
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


class AuthPermissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self.tmp.cleanup()

    def _propose(self, title, content, **kwargs):
        return self.api.propose_memory({
            "title": title, "content": content,
            "category": "coding", "tags": ["test"],
            "agent_id": "test-agent", **kwargs})

    def test_owner_from_server_identity_wins(self):
        """登录用户写入：owner=_current_user（即使客户端伪造 physical_user）。"""
        r = self._propose(
            "身份优先测试", "服务端认证身份优先于客户端自报，防伪造。",
            _current_user="alice", physical_user="hacker")
        mid = r["memory_id"]
        mem = self.api.mm.get_swarm_memory(mid)
        self.assertEqual(mem["physical_user"], "alice")

    def test_owner_fallback_client_reported(self):
        """未登录（无 _current_user）时回退客户端自报（旧客户端兼容）。"""
        r = self._propose(
            "兼容回退测试", "无服务端身份时使用客户端上报的 physical_user。",
            physical_user="legacy-user")
        mem = self.api.mm.get_swarm_memory(r["memory_id"])
        self.assertEqual(mem["physical_user"], "legacy-user")

    def test_owner_missing_rejected(self):
        """无任何身份时拒绝写入（安全溯源）。"""
        with self.assertRaises(ValueError):
            self._propose("无身份", "没有任何身份信息应该被拒绝写入。")

    def test_search_prioritize_own(self):
        """查询优先自己：alice 搜索时自己的记忆排最前。"""
        self._propose("alice 的部署经验", "Alice 关于 Docker 部署的独有经验内容。",
                      _current_user="alice", tags=["部署", "docker"])
        self._propose("bob 的部署经验", "Bob 关于 Docker 部署的独有经验内容。",
                      _current_user="bob", tags=["部署", "docker"])
        result = self.api.search({
            "query": "部署", "limit": 10, "scope": "all",
            "_current_user": "alice"})
        index = result["index"]
        self.assertGreater(len(index), 0)
        # 第一个必须是 alice 的（自己的记忆优先）
        self.assertEqual(index[0]["physical_user"], "alice")
        # 自己的记忆全部在他人之前
        seen_other = False
        for item in index:
            if item.get("physical_user") == "bob":
                seen_other = True
            if seen_other:
                self.assertNotEqual(item.get("physical_user"), "alice",
                                    "alice 的记忆不应出现在 bob 之后")

    def test_vote_other_memory_allowed(self):
        """可对他人记忆投票（不校验 owner）。"""
        r = self._propose("bob 的记忆", "Bob 写的记忆，Alice 可以投票。",
                          _current_user="bob")
        mid = r["memory_id"]
        ev = self.api.consensus_vote({
            "memory_id": mid, "agent": "alice", "vote": "support",
            "evidence": "共享读取，投票放开", "confidence": 0.8})
        self.assertIn("consensus", ev)
        self.assertEqual(ev["consensus"]["votes"]["support"], 1)


if __name__ == "__main__":
    unittest.main()
