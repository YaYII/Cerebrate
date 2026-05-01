import unittest

from server.decision import DecisionRouter


class FakeMemoryManager:
    def __init__(self):
        self.swarm_project_id = None
        self.kb_project_id = None

    def query_swarm(self, **kwargs):
        self.swarm_project_id = kwargs.get("project_id")
        return []

    def lookup_knowledge(self, **kwargs):
        self.kb_project_id = kwargs.get("project_id")
        return []

    def log_query(self, *args):
        pass

    def get_user_tone(self, user_id):
        return "专业简洁"

    def get_user_profile(self, user_id):
        return {"preferences": {"language": "简体中文"}, "facts": {}}


class DecisionRouterTests(unittest.TestCase):
    def test_decide_forwards_project_id_to_swarm_and_knowledge(self):
        mm = FakeMemoryManager()
        router = DecisionRouter(mm)

        router.decide(
            "yangying",
            "项目规则怎么查",
            context={"project_id": "cerebrate", "require_authoritative": True},
        )

        self.assertEqual(mm.swarm_project_id, "cerebrate")
        self.assertEqual(mm.kb_project_id, "cerebrate")


if __name__ == "__main__":
    unittest.main()
