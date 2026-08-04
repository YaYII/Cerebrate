"""代码结构养料收割器（企业级精度核心）。

从真实代码 AST 提取项目结构，作为业务画像（数据世界+流程世界）的**真实骨架**：
  - modules: 模块树（文件 → 类 → 函数/方法）
  - data_models: 数据模型（dataclass/带字段注解的类 → 真实字段）
  - endpoints: API 端点（HTTP 方法 + 路径 + 处理函数）
  - 不从记忆推断，结构 100% 来自代码

设计:
  - Python 用 ast 精确解析
  - 其他语言留扩展点（按扩展名分发）
  - 输出 {memory_root}/harvest/{project_id}.json，供 ProfileStore.build_draft 融合

用法:
  from cerebrate.tools.code_harvest import harvest_project, save_harvest
  h = harvest_project(Path("/path/to/project"), project_id="cerebrate")
  save_harvest(h)
"""

import ast
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cerebrate.config import config

logger = logging.getLogger(__name__)

SKIP_DIRS = {
    ".git", "__pycache__", ".venv", "venv", "node_modules", "vendor",
    "dist", "build", ".codex", ".qoder", ".claude", "data", "profiles",
    "harvest", "context", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "tests", "test", "docs_build",
}
SKIP_FILES = {"__init__.py", "setup.py", "conftest.py"}

# ── AST 提取 ──

def _decorator_names(node) -> list[str]:
    out = []
    for dec in getattr(node, "decorator_list", []):
        try:
            out.append(ast.unparse(dec))
        except Exception:
            out.append("")
    return out


def _class_fields(node: ast.ClassDef) -> list[dict]:
    """提取类字段：类体注解赋值 + __init__ 中 self.x: T 注解。"""
    fields: dict[str, dict] = {}
    for child in node.body:
        if isinstance(child, ast.AnnAssign) and isinstance(child.target, ast.Name):
            fields[child.target.id] = {
                "name": child.target.id,
                "type": ast.unparse(child.annotation) if child.annotation else "",
                "desc": "",
            }
        elif isinstance(child, ast.Assign):
            for t in child.targets:
                if isinstance(t, ast.Name):
                    fields.setdefault(t.id, {"name": t.id, "type": "", "desc": ""})
    # __init__ 注解字段
    for child in node.body:
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and child.name == "__init__":
            for stmt in ast.walk(child):
                if (isinstance(stmt, ast.AnnAssign)
                        and isinstance(stmt.target, ast.Attribute)
                        and isinstance(stmt.target.value, ast.Name)
                        and stmt.target.value.id == "self"):
                    fields.setdefault(stmt.target.attr, {
                        "name": stmt.target.attr,
                        "type": ast.unparse(stmt.annotation) if stmt.annotation else "",
                        "desc": "",
                    })
    return list(fields.values())


def _is_dataclass(node: ast.ClassDef) -> bool:
    return any("dataclass" in d for d in _decorator_names(node))


def _class_entry(node: ast.ClassDef, file_rel: str) -> dict:
    return {
        "name": node.name,
        "bases": [ast.unparse(b) if hasattr(b, "id") else ast.unparse(b)
                  for b in node.bases] if hasattr(node, "bases") else [],
        "decorators": _decorator_names(node),
        "kind": "data_model" if _is_dataclass(node) else "class",
        "fields": _class_fields(node)[:60] if _is_dataclass(node) else [],
        "file": file_rel,
        "doc": (ast.get_docstring(node) or "")[:200],
    }


def _function_entry(node, file_rel: str) -> dict:
    return {
        "name": node.name,
        "decorators": _decorator_names(node),
        "args": [a.arg for a in node.args.args][:12],
        "file": file_rel,
        "doc": (ast.get_docstring(node) or "")[:200],
    }


def _extract_endpoints(module: ast.Module, file_rel: str) -> list[dict]:
    """识别 API 端点：
    1) 装饰器风格 @app.route("/path", methods=["POST"]) / @bp.post("/path")
    2) Cerebrate http.py 风格: if method == "POST" and path == "/v1/query":
    """
    endpoints = []
    for node in ast.walk(module):
        if isinstance(node, ast.FunctionDef):
            for dec in node.decorator_list:
                text = ast.unparse(dec) if True else ""
                # @app.route(...)
                if ".route(" in text or ".get(" in text or ".post(" in text \
                        or ".put(" in text or ".delete(" in text:
                    endpoints.append({
                        "method": "ANY", "path": text, "handler": node.name,
                        "file": file_rel,
                    })
        # Cerebrate ThreadingHTTPServer 风格
        if (isinstance(node, ast.Compare)
                and isinstance(node.left, ast.Name) and node.left.id == "path"
                and any(isinstance(c, ast.Str) or isinstance(c, ast.Constant)
                        for c in node.comparators)):
            for c in node.comparators:
                if isinstance(c, ast.Constant) and isinstance(c.value, str) \
                        and c.value.startswith("/"):
                    endpoints.append({
                        "method": "HTTP", "path": c.value,
                        "handler": "dispatch", "file": file_rel,
                    })
    return endpoints


def harvest_file(filepath: Path, root: Path) -> Optional[dict]:
    file_rel = str(filepath.relative_to(root))
    try:
        tree = ast.parse(filepath.read_text(encoding="utf-8", errors="replace"))
    except Exception as e:
        logger.debug("AST 解析失败 %s: %s", filepath, e)
        return None
    classes, functions = [], []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            classes.append(_class_entry(node, file_rel))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if not any(isinstance(n, ast.ClassDef) for n in ast.walk(tree)
                       if n is not node and node in ast.walk(n)):
                functions.append(_function_entry(node, file_rel))
    return {
        "path": file_rel,
        "module": filepath.stem,
        "classes": classes[:80],
        "functions": functions[:80],
        "endpoints": _extract_endpoints(tree, file_rel),
    }


def harvest_project(root: Path, project_id: str = "",
                    exts: tuple = (".py",), limit_files: int = 2000) -> dict:
    """扫描项目目录，AST 提取代码结构。"""
    root = root.resolve()
    modules, endpoints, data_models = [], [], []
    file_count = 0
    for filepath in sorted(root.rglob("*")):
        if not filepath.is_file():
            continue
        # 只按「项目相对路径」判断排除目录（绝对路径可能含 /data 等挂载点）
        rel_parts = filepath.relative_to(root).parts
        if any(part in SKIP_DIRS for part in rel_parts[:-1]):
            continue
        if filepath.name in SKIP_FILES:
            continue
        if filepath.suffix not in exts:
            continue
        if file_count >= limit_files:
            break
        file_count += 1
        info = harvest_file(filepath, root)
        if not info:
            continue
        modules.append({
            "path": info["path"],
            "module": info["module"],
            "classes": [c["name"] for c in info["classes"]],
            "functions": [f["name"] for f in info["functions"]],
        })
        endpoints.extend(info["endpoints"])
        for c in info["classes"]:
            if c["kind"] == "data_model":
                data_models.append({
                    "name": c["name"],
                    "fields": c["fields"],
                    "file": c["file"],
                    "doc": c["doc"],
                })
    # 去重端点
    seen = set()
    uniq_endpoints = []
    for ep in endpoints:
        key = (ep.get("method"), ep.get("path"))
        if key in seen:
            continue
        seen.add(key)
        uniq_endpoints.append(ep)
    return {
        "project_id": project_id,
        "root": str(root),
        "harvested_at": datetime.now(timezone.utc).isoformat(),
        "files_scanned": file_count,
        "modules": modules,
        "data_models": data_models,
        "endpoints": uniq_endpoints[:300],
        "stats": {
            "files": file_count,
            "modules": len(modules),
            "data_models": len(data_models),
            "endpoints": len(uniq_endpoints),
        },
    }


def save_harvest(harvest: dict) -> dict:
    """写入 {memory_root}/harvest/{project_id}.json。"""
    project_id = harvest.get("project_id") or "unknown"
    d = config.memory_root / "harvest"
    d.mkdir(parents=True, exist_ok=True)
    target = d / f"{project_id}.json"
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(harvest, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    tmp.replace(target)
    return {"project_id": project_id, "path": str(target),
            "stats": harvest.get("stats", {})}


def load_harvest(project_id: str) -> Optional[dict]:
    p = config.memory_root / "harvest" / f"{project_id}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("读取代码结构失败 %s: %s", p, e)
        return None
