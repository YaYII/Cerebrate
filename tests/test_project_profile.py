"""业务画像（数据世界）测试（Phase 1-4）。

验证:
  - draft 从业务记忆构建领域骨架（scope 隔离：只收录该项目业务记忆）
  - save/read 持久化 + version 递增 + Markdown 渲染
  - navigate 定位域/实体并返回挂载记忆 + 依赖 + 代码入口
  - attach 把业务记忆挂到画像节点
  - knowledge_type 元数据：propose 写入、默认推断（项目→business、通用→tech）
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


class ProjectProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()
        self.api.register_agent({
            "agent_id": "profile-test",
            "capabilities": ["testing"],
            "physical_user": "tester",
        })

    def tearDown(self):
        self.tmp.cleanup()

    def _seed(self):
        api = self.api
        api.propose_memory({
            "title": "DOB个案创建业务规则", "content": "DOB 个案创建的完整业务规则与校验流程",
            "category": "architecture", "agent_id": "profile-test",
            "project_id": "ihm-backend", "solution": "先校验后创建",
            "validate": False,
        })
        api.propose_memory({
            "title": "DOB重新指派两阶段执行", "content": "DOB 重新指派的完整两阶段执行与回滚",
            "category": "architecture", "agent_id": "profile-test",
            "project_id": "ihm-backend", "solution": "两阶段提交",
            "validate": False,
        })
        api.propose_memory({
            "title": "项目B独有经验", "content": "项目B的业务知识",
            "category": "coding", "agent_id": "profile-test",
            "project_id": "proj-b", "validate": False,
        })
        api.propose_memory({
            "title": "Flowable多实例安全操作", "content": "Flowable 多实例的安全操作通用技能",
            "category": "coding", "agent_id": "profile-test",
            "scope": "general", "validate": False,
        })

    def test_build_draft_scope_isolation(self):
        """draft 只收录该项目业务记忆，通用记忆进 shared_tech。"""
        self._seed()
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.api.mm)
        draft = store.build_draft("ihm-backend", limit=50)
        self.assertEqual(draft["status"], "draft")
        self.assertEqual(draft["project_id"], "ihm-backend")
        all_mids = [m for d in draft["domains"] for m in d["memories"]]
        self.assertEqual(len(all_mids), 2)  # 只有 2 条 ihm-backend 业务记忆
        # 不混入 proj-b
        self.assertNotIn("项目B独有经验", str(draft))
        # 通用技术记忆进入 shared_tech（stack 提取到 Flowable）
        self.assertIn("Flowable", draft["shared_tech"]["stack"])

    def test_save_read_version_and_markdown(self):
        """save 持久化 JSON + 渲染 Markdown，version 递增。"""
        self._seed()
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.api.mm)
        draft = store.build_draft("ihm-backend")
        result = store.save("ihm-backend", draft)
        self.assertEqual(result["version"], 1)
        read = store.read("ihm-backend")
        self.assertEqual(read["status"], "confirmed")
        self.assertEqual(read["version"], 1)
        md = Path(result["markdown_path"]).read_text(encoding="utf-8")
        self.assertIn("<cerebrate-profile", md)
        self.assertIn("DOB个案创建业务规则", md)
        # 再 save → version 2
        store.save("ihm-backend", read)
        self.assertEqual(store.read("ihm-backend")["version"], 2)

    def test_navigate(self):
        """navigate 定位目标域/实体，返回路径 + 挂载记忆。"""
        self._seed()
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.api.mm)
        draft = store.build_draft("ihm-backend")
        store.save("ihm-backend", draft)
        result = store.navigate("ihm-backend", "DOB")
        self.assertTrue(result["found"])
        self.assertGreaterEqual(len(result["hits"]), 1)
        hit = result["hits"][0]
        self.assertIn("kind", hit)
        self.assertIn("path", hit)
        # 未构建画像的项目 → no_profile
        no_profile = store.navigate("nonexistent", "DOB")
        self.assertFalse(no_profile["found"])
        self.assertEqual(no_profile["reason"], "no_profile")

    def test_attach_memory(self):
        """attach 把业务记忆挂到画像节点。"""
        self._seed()
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.api.mm)
        draft = store.build_draft("ihm-backend")
        store.save("ihm-backend", draft)
        domain = draft["domains"][0]
        node = "/" + domain["id"]
        res = store.attach_memory("ihm-backend", node, "some-other-memory")
        self.assertTrue(res["ok"])
        read = store.read("ihm-backend")
        self.assertIn("some-other-memory", read["domains"][0]["memories"])

    def test_knowledge_type_metadata(self):
        """propose 写入 knowledge_type：项目→business、通用→tech、显式覆盖。"""
        self._seed()
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.api.mm)
        collected = store._collect_memories("ihm-backend")
        for m in collected["business"]:
            self.assertEqual(m["knowledge_type"], "business")
        for m in collected["tech"]:
            self.assertEqual(m["knowledge_type"], "tech")
        # 显式覆盖
        resp = self.api.propose_memory({
            "title": "混合记忆显式标记", "content": "既是 DOB 业务接口又含通用设计模式的内容",
            "category": "coding", "agent_id": "profile-test",
            "project_id": "ihm-backend", "knowledge_type": "tech",
            "validate": False,
        })
        item = self.api.mm.swarm._store.get(resp["memory_id"])
        self.assertEqual(item["metadata"].get("knowledge_type"), "tech")

    def test_api_actions(self):
        """API 层 action：list/draft/read/navigate。"""
        self._seed()
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.api.mm)
        draft = store.build_draft("ihm-backend")
        store.save("ihm-backend", draft)
        listing = self.api.project_profile({"action": "list"})
        self.assertIn("ihm-backend", listing["projects"])
        draft_resp = self.api.project_profile(
            {"project": "ihm-backend", "action": "draft"})
        self.assertGreaterEqual(draft_resp["domain_count"], 1)
        nav = self.api.project_navigate(
            {"project": "ihm-backend", "target": "DOB"})
        self.assertTrue(nav["found"])

    def test_progressive_disclosure_levels(self):
        """分层披露：summary(宏观) 不依赖实体细节；graph 含实体关系；detail 完整。"""
        self._seed()
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.api.mm)
        draft = store.build_draft("ihm-backend")
        store.save("ihm-backend", draft)
        # summary：只有域级元数据，不包含实体细节
        summary = store.read("ihm-backend", level="summary")
        self.assertEqual(summary["level"], "summary")
        self.assertIn("summary", summary)
        for dom in summary["summary"]["domains"]:
            self.assertIn("entity_count", dom)
            self.assertIn("depends_on", dom)
        self.assertNotIn("graph", summary)
        self.assertNotIn("fields", str(summary["summary"]))
        # graph：含实体 + 关系，不含字段/记忆明细
        graph = store.read("ihm-backend", level="graph")
        self.assertEqual(graph["level"], "graph")
        for dom in graph["graph"]["domains"]:
            for ent in dom["entities"]:
                self.assertIn("relations", ent)
        self.assertNotIn("fields", str(graph["graph"]))
        # detail：完整画像
        detail = store.read("ihm-backend", level="detail")
        self.assertIn("domains", detail)
        self.assertIn("entities", str(detail["domains"]))
        # API 层 level 透传
        api_summary = self.api.project_profile(
            {"project": "ihm-backend", "action": "read", "level": "summary"})
        self.assertTrue(api_summary["found"])
        self.assertEqual(api_summary["level"], "summary")

    def test_flow_view(self):
        """流程视图：flows 持久化 + 分层披露 + Markdown 渲染。"""
        self._seed()
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.api.mm)
        draft = store.build_draft("ihm-backend")
        draft["flows"] = [{
            "id": "dob-reassign",
            "name": "DOB 人员重新指派流程",
            "trigger": "协调员发起重新指派",
            "actors": ["协调员", "系统"],
            "steps": [
                {"seq": 1, "actor": "协调员", "action": "提交重指派请求",
                 "input": "case_id+角色槽位", "output": "待校验"},
                {"seq": 2, "actor": "系统", "action": "槽位校验+两阶段执行",
                 "condition": "校验通过", "output": "成功/回滚",
                 "detail": "DobReassignmentServiceV2"},
            ],
            "state_machine": {
                "states": ["pending", "assigned", "success", "rollback"],
                "transitions": [{"from": "pending", "to": "assigned",
                                 "on": "校验通过"}],
            },
            "depends_on": ["dob-assignment"],
            "memories": ["m1"],
        }]
        store.save("ihm-backend", draft)
        # detail 含完整 flows
        detail = store.read("ihm-backend", level="detail")
        self.assertEqual(len(detail["flows"]), 1)
        self.assertEqual(detail["flows"][0]["id"], "dob-reassign")
        self.assertEqual(detail["flows"][0]["state_machine"]["states"][0],
                         "pending")
        # summary 含流程名（宏观）
        summary = store.read("ihm-backend", level="summary")
        self.assertIn("DOB 人员重新指派流程", summary["summary"]["flows"])
        self.assertEqual(summary["summary"]["flow_count"], 1)
        # graph 含流程步骤（中观）
        graph = store.read("ihm-backend", level="graph")
        self.assertIn("flows", graph["graph"])
        self.assertEqual(graph["graph"]["flows"][0]["steps"][0]["actor"],
                         "协调员")
        # Markdown 渲染流程
        md = store._render_markdown(detail)
        self.assertIn("🔄 流程世界", md)
        self.assertIn("协调员 → 提交重指派请求", md)
        self.assertIn("状态机: pending → assigned → success → rollback", md)

    def test_harvest_code_fusion(self):
        """代码养料收割：真实代码 AST → 画像骨架（数据模型字段/端点真实）。"""
        import tempfile, textwrap
        from pathlib import Path
        from cerebrate.tools.code_harvest import harvest_project
        proj = Path(self.tmp.name) / "demo_project"
        (proj / "app").mkdir(parents=True)
        (proj / "app" / "models.py").write_text(textwrap.dedent("""\
            from dataclasses import dataclass
            @dataclass
            class User:
                id: int
                name: str
                email: str
            @dataclass
            class Order:
                order_id: str
                amount: float
        """), encoding="utf-8")
        (proj / "app" / "api.py").write_text(textwrap.dedent("""\
            def query():
                pass
        """), encoding="utf-8")
        h = harvest_project(proj, project_id="demo")
        self.assertGreaterEqual(h["stats"]["data_models"], 2)
        self.assertEqual(h["stats"]["files"], 2)
        # 融合进画像
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.api.mm)
        draft = store.build_draft("demo", harvest=h)
        self.assertGreaterEqual(len(draft["domains"]), 1)
        entity_names = [e["name"] for d in draft["domains"]
                        for e in d["entities"]]
        self.assertIn("User", entity_names)
        self.assertIn("Order", entity_names)
        user_entity = next(e for d in draft["domains"]
                           for e in d["entities"] if e["name"] == "User")
        self.assertTrue(any(f["name"] == "email" for f in user_entity["fields"]))
        # 保存后可导航到真实代码入口
        store.save("demo", draft)
        nav = store.navigate("demo", "User")
        self.assertTrue(nav["found"])
        self.assertTrue(any("models.py" in h.get("code_hint", "")
                            for hit in nav["hits"]
                            for h in [hit]))


if __name__ == "__main__":
    unittest.main()
