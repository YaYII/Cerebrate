import json
import unittest

from cerebrate.ipc import BatchProcessor


class FakeMemoryManager:
    def get_all_stats(self):
        return {"ok": True}


class BatchProcessorTests(unittest.TestCase):
    def test_submit_writes_valid_json_request(self):
        with self.subTest("request file contains valid JSON"):
            from tempfile import TemporaryDirectory
            from pathlib import Path

            with TemporaryDirectory() as tmp:
                tmp_path = Path(tmp)
                processor = BatchProcessor(FakeMemoryManager(), queue_path=tmp_path)

                request_id = processor.submit(
                    source_agent="codex",
                    command="stats",
                    params={},
                    project_id="cerebrate",
                )

                request_file = tmp_path / "requests" / f"{request_id}.json"
                data = json.loads(request_file.read_text())

                self.assertEqual(data["request_id"], request_id)
                self.assertEqual(data["source_agent"], "codex")
                self.assertEqual(data["project_id"], "cerebrate")
                self.assertEqual(data["command"], "stats")

    def test_process_pending_uses_request_and_writes_result(self):
        from tempfile import TemporaryDirectory
        from pathlib import Path

        with TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            processor = BatchProcessor(FakeMemoryManager(), queue_path=tmp_path)
            request_id = processor.submit("codex", "stats", {}, "cerebrate")

            self.assertEqual(processor.process_pending(limit=50), 1)

            result_file = tmp_path / "results" / f"{request_id}.result.json"
            processed_file = tmp_path / "processed" / f"{request_id}.json"
            result = json.loads(result_file.read_text())

            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["data"], {"ok": True})
            self.assertTrue(processed_file.exists())


if __name__ == "__main__":
    unittest.main()
