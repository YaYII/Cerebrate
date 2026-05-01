import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "cerebrate.py"


class CliV4ContractTests(unittest.TestCase):
    def run_cli(self, *args, check=True, memory_root=None):
        env = os.environ.copy()
        env["CEREBRATE_MEMORY_ROOT"] = str(memory_root or self.memory_root)
        env["CEREBRATE_EMBEDDING_MODEL"] = "not-a-real-local-model"
        env["CEREBRATE_EMBEDDING_ALLOW_DOWNLOAD"] = "false"
        env["PYTHONPYCACHEPREFIX"] = str(self.pycache)
        proc = subprocess.run(
            [sys.executable, str(CLI), *args],
            cwd=str(ROOT),
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if check and proc.returncode != 0:
            self.fail(f"command failed: {args}\nstdout={proc.stdout}\nstderr={proc.stderr}")
        payload = json.loads(proc.stdout)
        return proc, payload

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.memory_root = Path(self.tmp.name) / "memory"
        self.pycache = Path(self.tmp.name) / "pycache"

    def tearDown(self):
        self.tmp.cleanup()

    def assert_ok_envelope(self, payload):
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["meta"]["protocol"], "v4")
        self.assertIn("data", payload)
        self.assertEqual(set(payload.keys()), {"status", "data", "meta"})

    def test_core_commands_return_strict_v4_envelopes(self):
        commands = [
            ("sense",),
            ("query", "离线查询测试"),
            ("recall", "--user", "yangying"),
            ("agent", "register", "--id", "test-unit", "--type", "cli"),
            ("batch", "process", "--limit", "10"),
            ("llm", "status"),
        ]
        for command in commands:
            with self.subTest(command=command):
                _, payload = self.run_cli(*command)
                self.assert_ok_envelope(payload)

    def test_errors_are_json_without_traceback(self):
        proc, payload = self.run_cli("use", "finish", "--usage-id", "missing", "--outcome", "success", check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["meta"]["protocol"], "v4")
        self.assertIn("error", payload)
        self.assertNotIn("Traceback", proc.stdout + proc.stderr)

    def test_validate_share_quarantines_low_quality_memory(self):
        _, payload = self.run_cli(
            "share",
            "--title", "短内容",
            "--content", "x",
            "--category", "testing",
            "--agent", "unit",
            "--validate",
        )
        self.assert_ok_envelope(payload)
        self.assertEqual(payload["data"]["life_stage"], "quarantined")

    def test_query_use_feedback_updates_memory_and_agent(self):
        _, shared = self.run_cli(
            "share",
            "--title", "可复用经验",
            "--content", "使用 hash embedding 保证离线查询可用",
            "--category", "testing",
            "--agent", "unit",
            "--solution", "启用确定性本地向量",
        )
        memory_id = shared["data"]["memory_id"]
        _, started = self.run_cli(
            "use", "start",
            "--memory-id", memory_id,
            "--agent", "unit",
            "--problem", "离线查询失败",
        )
        usage_id = started["data"]["usage_id"]
        _, finished = self.run_cli(
            "use", "finish",
            "--usage-id", usage_id,
            "--outcome", "success",
            "--feedback", "方案有效",
        )
        self.assertEqual(finished["data"]["outcome"], "success")
        _, stats = self.run_cli("agent", "stats", "--id", "unit")
        self.assertGreaterEqual(stats["data"]["success_count"], 1)

    def test_seed_export_and_reindex_are_json(self):
        self.run_cli(
            "share",
            "--title", "养分样本",
            "--content", "旧索引可以导出为 JSONL 种子",
            "--category", "testing",
        )
        _, exported = self.run_cli("migrate", "--export-seeds")
        seed_file = Path(exported["data"]["seed_file"])
        self.assertTrue(seed_file.exists())
        _, reindexed = self.run_cli("migrate", "--reindex", "--dry-run")
        self.assertIn("embedding_mode", reindexed["data"])


if __name__ == "__main__":
    unittest.main()
