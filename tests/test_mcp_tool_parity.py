"""MCP 工具三方一致性自检 — 服务端 / 本地 Python / 本地 Node

需求（2026-08-07，用户强调"要有测试否则回归"）:
  - 服务端 mcp_transport.py 声明的工具 ⊆ 本地 cerebrate/mcp.py（Python 客户端）
  - 服务端 mcp_transport.py 声明的工具 ⊆ 本地 mcp.js（Node 客户端）
  - 本地 Python 客户端每个声明工具都有分发分支（_handle_call）
  - 本地 Node 客户端每个声明工具都有分发 case（switch）
  - 新增服务端工具必须同步到两个本地客户端，否则测试失败（防漏同步回归）
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ROOT = Path(__file__).resolve().parents[1]


def extract_server_tools() -> set[str]:
    """解析服务端 mcp_transport.py 工具声明。"""
    src = (ROOT / "cerebrate/server/mcp_transport.py").read_text()
    return set(re.findall(r'"name": "(cerebrate_[a-z_]+)"', src))


def extract_python_tools() -> set[str]:
    """解析本地 Python 客户端 cerebrate/mcp.py 工具声明。"""
    src = (ROOT / "cerebrate/mcp.py").read_text()
    return set(re.findall(r'"name": "(cerebrate_[a-z_]+)"', src))


def extract_python_dispatch() -> set[str]:
    """解析本地 Python 客户端 _handle_call 分发分支。"""
    src = (ROOT / "cerebrate/mcp.py").read_text()
    return set(re.findall(r'name == "(cerebrate_[a-z_]+)"', src))


def extract_node_tools() -> set[str]:
    """解析本地 Node 客户端 mcp.js TOOLS 声明（const TOOLS = [...] 区间）。"""
    src = (ROOT / "mcp.js").read_text()
    m = re.search(r"const TOOLS = \[(.*?)\n\];", src, re.S)
    if not m:
        return set()
    return set(re.findall(r'name: "(cerebrate_[a-z_]+)"', m.group(1)))


def extract_node_dispatch() -> set[str]:
    """解析本地 Node 客户端 mcp.js 分发 case。"""
    src = (ROOT / "mcp.js").read_text()
    return set(re.findall(r'case "(cerebrate_[a-z_]+)"', src))


class McpToolParityTests(unittest.TestCase):
    """三方工具一致性 + 分发完整性"""

    def setUp(self):
        self.server = extract_server_tools()
        self.py_tools = extract_python_tools()
        self.py_dispatch = extract_python_dispatch()
        self.node_tools = extract_node_tools()
        self.node_dispatch = extract_node_dispatch()
        self.assertGreaterEqual(len(self.server), 30, "服务端工具数异常（应≥30）")

    def test_server_tools_subset_of_python(self):
        """服务端工具 ⊆ 本地 Python 客户端。"""
        missing = self.server - self.py_tools
        self.assertEqual(
            missing, set(),
            f"服务端有但 Python MCP 缺（需同步 cerebrate/mcp.py）: {sorted(missing)}")

    def test_server_tools_subset_of_node(self):
        """服务端工具 ⊆ 本地 Node 客户端。"""
        missing = self.server - self.node_tools
        self.assertEqual(
            missing, set(),
            f"服务端有但 Node MCP 缺（需同步 mcp.js）: {sorted(missing)}")

    def test_python_dispatch_complete(self):
        """Python 客户端每个声明工具都有分发分支。"""
        missing = self.py_tools - self.py_dispatch
        self.assertEqual(
            missing, set(),
            f"Python MCP 声明但无分发分支: {sorted(missing)}")

    def test_node_dispatch_complete(self):
        """Node 客户端每个声明工具都有分发 case。"""
        missing = self.node_tools - self.node_dispatch
        self.assertEqual(
            missing, set(),
            f"Node MCP 声明但无分发 case: {sorted(missing)}")

    def test_python_node_sets_consistent(self):
        """Python 与 Node 客户端工具声明集合一致（跨端同步）。"""
        self.assertEqual(
            self.py_tools, self.node_tools,
            f"Python/Node 工具集不一致: "
            f"Python独有={sorted(self.py_tools - self.node_tools)} "
            f"Node独有={sorted(self.node_tools - self.py_tools)}")


if __name__ == "__main__":
    unittest.main()
