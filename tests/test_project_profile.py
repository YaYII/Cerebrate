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
        import textwrap
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

    def test_harvest_domains_keeps_same_name_classes_across_packages(self):
        """P1 修复：不同包同名类（Java model.User / entity.User）必须都保留，
        不能被跨模块全局去重误删；同一文件内同名类仍去重。"""
        from cerebrate.tools.project_profile import ProfileStore
        harvest = {
            "modules": [
                {"path": "controller/UserController.java",
                 "module": "controller", "classes": ["UserController"]},
                {"path": "model/User.java", "module": "model", "classes": ["User"]},
                {"path": "entity/User.java", "module": "entity", "classes": ["User"]},
            ],
            "data_models": [],
            "endpoints": [],
        }
        domains = ProfileStore._harvest_domains(harvest)
        entities = [(e["name"], e["code_hint"])
                    for d in domains for e in d.get("entities", [])]
        self.assertIn(("User", "model/User.java"), entities)
        self.assertIn(("User", "entity/User.java"), entities)
        self.assertIn(("UserController", "controller/UserController.java"), entities)
        # 同一文件内同名类去重
        harvest_dup = {
            "modules": [{"path": "a/Foo.java", "module": "a",
                         "classes": ["Foo", "Foo"]}],
            "data_models": [],
            "endpoints": [],
        }
        domains2 = ProfileStore._harvest_domains(harvest_dup)
        foo_count = sum(1 for d in domains2
                        for e in d.get("entities", []) if e["name"] == "Foo")
        self.assertEqual(foo_count, 1)

    def test_code_sync_roundtrip(self):
        """代码同步闭环：本地打包 → 服务器安全解压 → harvest → 画像。"""
        import textwrap
        from pathlib import Path

        from cerebrate.config import config
        from cerebrate.tools.code_sync import build_package, receive_package
        proj = Path(self.tmp.name) / "sync_project"
        (proj / "src").mkdir(parents=True)
        (proj / "src" / "core.py").write_text(textwrap.dedent("""\
            from dataclasses import dataclass
            @dataclass
            class SyncEntity:
                id: str
                name: str
        """), encoding="utf-8")
        # 敏感文件应被本地打包排除
        (proj / ".env").write_text("SECRET=should-not-sync", encoding="utf-8")
        (proj / "notes.md").write_text("private note", encoding="utf-8")
        pkg = build_package(proj, project_id="sync-proj")
        self.assertGreaterEqual(pkg["files_count"], 1)
        self.assertTrue(any(".env" in ex["path"] for ex in pkg["excluded"]))
        # 服务器接收 + 自动 harvest
        result = receive_package("sync-proj", pkg["package_b64"],
                                 branch="default", auto_harvest=True)
        self.assertGreaterEqual(result["files_written"], 1)
        self.assertIn("harvest", result)
        # 解压目录不含 .env
        repo = Path(config.memory_root) / "code_repos" / "sync-proj"
        self.assertFalse((repo / ".env").exists())
        # harvest 到画像
        from cerebrate.tools.code_harvest import load_harvest
        h = load_harvest("sync-proj", branch="default")
        self.assertIsNotNone(h)
        self.assertTrue(any("SyncEntity" in m.get("classes", [])
                            for m in h["modules"]))

    def test_code_sync_incremental(self):
        """增量同步：二次 sync 只传变更/新增，删除文件进入 delete_list。"""
        from pathlib import Path

        from cerebrate.config import config
        from cerebrate.tools.code_sync import build_package, receive_package
        proj = Path(self.tmp.name) / "incr_project"
        (proj / "src").mkdir(parents=True)
        (proj / "src" / "a.py").write_text("A = 1", encoding="utf-8")
        # 首次全量
        pkg1 = build_package(proj, project_id="incr")
        self.assertFalse(pkg1["incremental"])
        self.assertEqual(pkg1["files_changed"], 1)
        # 服务器接收
        receive_package("incr", pkg1["package_b64"], auto_harvest=False)
        # 修改 a.py + 新增 b.py + 删除 c.py（先建再删）
        (proj / "src" / "c.py").write_text("C = 3", encoding="utf-8")
        receive_package("incr",
                        build_package(proj, project_id="incr")["package_b64"],
                        auto_harvest=False)
        (proj / "src" / "a.py").write_text("A = 2", encoding="utf-8")
        (proj / "src" / "b.py").write_text("B = 2", encoding="utf-8")
        (proj / "src" / "c.py").unlink()
        pkg2 = build_package(proj, project_id="incr")
        self.assertTrue(pkg2["incremental"])
        self.assertEqual(pkg2["files_changed"], 2)  # a.py(改) + b.py(新)
        self.assertIn("src/c.py", pkg2["deleted"])
        # 服务器应用增量（含删除）
        res = receive_package("incr", pkg2["package_b64"],
                              delete_list=pkg2["deleted"], auto_harvest=False)
        self.assertGreaterEqual(res["files_written"], 2)
        self.assertEqual(res["files_removed"], 1)
        repo = Path(config.memory_root) / "code_repos" / "incr" / "default"
        self.assertFalse((repo / "src" / "c.py").exists())
        self.assertTrue((repo / "src" / "b.py").exists())

    def test_profile_draft_and_promote(self):
        """草稿态：save_draft 不覆盖 confirmed；promote 提升为 confirmed。"""
        self._seed()
        from cerebrate.tools.project_profile import ProfileStore
        store = ProfileStore(self.api.mm)
        draft = store.build_draft("ihm-backend")
        store.save("ihm-backend", draft)          # confirmed v1
        draft2 = store.build_draft("ihm-backend")
        store.save_draft("ihm-backend", draft2)   # draft 不覆盖
        self.assertEqual(store.read("ihm-backend")["version"], 1)
        self.assertEqual(store.read_draft("ihm-backend")["status"], "draft")
        # promote
        res = store.promote("ihm-backend")
        self.assertTrue(res["ok"])
        self.assertEqual(store.read("ihm-backend")["version"], 2)
        self.assertIsNone(store.read_draft("ihm-backend"))

    def test_verify_consistency(self):
        """一致性校验：code_hint 漂移检出；无 harvest 时提示。"""
        from pathlib import Path

        from cerebrate.tools.code_harvest import harvest_project, save_harvest
        from cerebrate.tools.project_profile import ProfileStore
        proj = Path(self.tmp.name) / "verify_project"
        (proj / "app").mkdir(parents=True)
        (proj / "app" / "svc.py").write_text(
            "class RealService:\n    pass\n", encoding="utf-8")
        h = harvest_project(proj, project_id="verify-p")
        save_harvest(h)
        store = ProfileStore(self.api.mm)
        # 无 harvest 的项目 → no_harvest
        no_h = store.verify("no-such-project")
        self.assertFalse(no_h["ok"])
        self.assertIn("reason", no_h)
        # 构建画像：code_hint 指向不存在文件 → 漂移
        draft = store.build_draft("verify-p", harvest=h)
        draft["domains"][0]["entities"].append({
            "id": "ghost", "name": "GhostClass",
            "description": "", "fields": [], "relations": [],
            "code_hint": "app/nonexistent.py", "memories": [],
        })
        store.save("verify-p", draft)
        v = store.verify("verify-p")
        self.assertFalse(v["ok"])
        self.assertTrue(any("漂移" in i for i in v["issues"]))
        # 真实类应在 missing_in_profile 或已收录
        self.assertTrue(
            "RealService" in v["missing_in_profile"]
            or "RealService" in {
                e["name"] for d in draft["domains"]
                for e in d["entities"]})

    def test_multi_branch_isolation(self):
        """多分支同步隔离：同项目不同分支代码互不覆盖，harvest 按分支。"""
        from pathlib import Path

        from cerebrate.config import config
        from cerebrate.tools.code_harvest import load_harvest
        from cerebrate.tools.code_sync import build_package, receive_package
        proj = Path(self.tmp.name) / "branch_project"
        (proj / "src").mkdir(parents=True)
        (proj / "src" / "master_only.py").write_text(
            "class MasterOnly: pass", encoding="utf-8")
        pkg_m = build_package(proj, project_id="bproj", branch="master",
                              incremental=False)
        r_m = receive_package("bproj", pkg_m["package_b64"], branch="master",
                              auto_harvest=True)
        self.assertEqual(r_m["branch"], "master")
        # 切到 feature 分支：不同代码
        (proj / "src" / "master_only.py").unlink()
        (proj / "src" / "feature_only.py").write_text(
            "class FeatureOnly: pass", encoding="utf-8")
        pkg_f = build_package(proj, project_id="bproj", branch="feature-x",
                              incremental=False)
        r_f = receive_package("bproj", pkg_f["package_b64"], branch="feature-x",
                              auto_harvest=True)
        self.assertEqual(r_f["branch"], "feature-x")
        # 两个分支代码仓独立
        repo = Path(config.memory_root) / "code_repos" / "bproj"
        self.assertTrue((repo / "master" / "src" / "master_only.py").exists())
        self.assertTrue((repo / "feature-x" / "src" / "feature_only.py").exists())
        self.assertFalse((repo / "master" / "src" / "feature_only.py").exists())
        # harvest 按分支隔离
        h_m = load_harvest("bproj", branch="master")
        h_f = load_harvest("bproj", branch="feature-x")
        self.assertTrue(any("MasterOnly" in m.get("classes", [])
                            for m in h_m["modules"]))
        self.assertTrue(any("FeatureOnly" in m.get("classes", [])
                            for m in h_f["modules"]))
        self.assertFalse(any("FeatureOnly" in m.get("classes", [])
                             for m in h_m["modules"]))

    def test_git_branch_inference(self):
        """git 分支自动推断：build_package 无 branch 时从 git 获取当前分支。"""
        import subprocess
        from pathlib import Path

        from cerebrate.tools.code_sync import _safe_branch, build_package
        self.assertEqual(_safe_branch("feature/dob-v2"), "feature-dob-v2")
        proj = Path(self.tmp.name) / "git_project"
        proj.mkdir()
        (proj / "a.py").write_text("A=1", encoding="utf-8")
        try:
            subprocess.run(["git", "init", "-q", "-b", "feature/dob"],
                           cwd=proj, check=True, capture_output=True)
            subprocess.run(["git", "add", "-A"], cwd=proj, check=True,
                           capture_output=True)
            subprocess.run(["git", "-c", "user.email=t@t", "-c",
                            "user.name=t", "commit", "-q", "-m", "init"],
                           cwd=proj, check=True, capture_output=True)
        except Exception:
            self.skipTest("git 不可用")
        pkg = build_package(proj, project_id="gproj", incremental=False)
        self.assertEqual(pkg["branch"], "feature-dob")

    def test_harvest_push_no_code(self):
        """结构 push：本地 harvest → push 结构（不含源代码内容），服务端可 verify。"""
        import json
        import textwrap
        from pathlib import Path

        from cerebrate.tools.code_harvest import harvest_project
        from cerebrate.tools.project_profile import ProfileStore
        proj = Path(self.tmp.name) / "push_project"
        (proj / "app").mkdir(parents=True)
        (proj / "app" / "svc.py").write_text(textwrap.dedent("""\
            from dataclasses import dataclass
            @dataclass
            class PushEntity:
                id: str
            def do_work():
                pass
        """), encoding="utf-8")
        # 本地 harvest（结构不含源代码函数体）
        h = harvest_project(proj, project_id="push-p", exts=(".py",))
        serialized = json.dumps(h)
        self.assertNotIn("def do_work():", serialized)  # 不含函数体实现
        self.assertNotIn("pass", serialized)
        # 通过 API push
        resp = self.api.harvest_push({
            "project": "push-p", "branch": "dev", "harvest": h,
        })
        self.assertEqual(resp["branch"], "dev")
        self.assertTrue(resp["changed"])
        # 服务端可用结构构建画像 + verify
        store = ProfileStore(self.api.mm)
        draft = store.build_draft("push-p", harvest=h)
        store.save("push-p", draft)
        ver = store.verify("push-p", branch="dev")
        self.assertEqual(ver.get("branch"), "dev")
        # 结构未变再 push → changed=False（不重建画像）
        resp2 = self.api.harvest_push({
            "project": "push-p", "branch": "dev", "harvest": h,
        })
        self.assertFalse(resp2["changed"])

    def test_work_claim_conflict(self):
        """协作感知：claim 声明 + 同模块他人冲突检测 + release。"""
        # agent A 声明
        r1 = self.api.project_work({
            "project": "coop", "action": "claim", "agent_id": "codex-a",
            "branch": "feature-x", "module": "dob-assignment",
            "intent": "重构指派逻辑",
        })
        self.assertTrue(r1["ok"])
        self.assertFalse(r1["conflict"])
        # agent B 声明同模块 → 冲突告知
        r2 = self.api.project_work({
            "project": "coop", "action": "claim", "agent_id": "qoder-b",
            "branch": "master", "module": "dob-assignment",
            "intent": "修复指派 bug",
        })
        self.assertTrue(r2["conflict"])
        self.assertEqual(r2["conflicts"][0]["agent_id"], "codex-a")
        # list 可见
        lst = self.api.project_work({"project": "coop", "action": "list"})
        self.assertEqual(lst["active_count"], 2)
        self.assertIn("feature-x", lst["by_branch"])
        # release A → 冲突消失
        rel = self.api.project_work({
            "project": "coop", "action": "release",
            "agent_id": "codex-a", "module": "dob-assignment"})
        self.assertEqual(rel["released"], 1)
        r3 = self.api.project_work({
            "project": "coop", "action": "claim", "agent_id": "qoder-b",
            "branch": "master", "module": "dob-assignment",
            "intent": "再声明"})
        self.assertFalse(r3["conflict"])

    def test_branch_diff(self):
        """分支差异：两分支 harvest 结构差异告知冲突点。"""
        from pathlib import Path

        from cerebrate.tools.code_harvest import harvest_project
        proj = Path(self.tmp.name) / "diff_project"
        (proj / "a").mkdir(parents=True)
        (proj / "a" / "common.py").write_text("X=1", encoding="utf-8")
        (proj / "a" / "only_a.py").write_text("A=1", encoding="utf-8")
        self.api.harvest_push({"project": "diff-p", "branch": "master",
                               "harvest": harvest_project(proj)})
        (proj / "a" / "only_a.py").unlink()
        (proj / "a" / "only_b.py").write_text("B=1", encoding="utf-8")
        self.api.harvest_push({"project": "diff-p", "branch": "feature-z",
                               "harvest": harvest_project(proj)})
        diff = self.api.branch_diff({
            "project": "diff-p", "from_branch": "master",
            "to_branch": "feature-z"})
        self.assertTrue(diff["ok"])
        cp = diff["conflict_points"]
        self.assertTrue(any("only_a.py" in m for m in cp["modules_only_in_from"]))
        self.assertTrue(any("only_b.py" in m for m in cp["modules_only_in_to"]))


if __name__ == "__main__":
    unittest.main()
