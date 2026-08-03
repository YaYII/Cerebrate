#!/usr/bin/env python3
"""cerebrate/tools/project_context.py — 项目级上下文生成（Phase 5 第 2 项）

为 scope=project 的项目生成浓缩版上下文文件（对齐 claude-mem Folder Context）：
  - 聚合该项目的记忆 + 通用记忆（scope 隔离，绝不混入其他项目）
  - 生成紧凑 Markdown（标题/类型/标签/时间/要点），非全量倾倒
  - `<cerebrate-context>` 标签包裹自动生成内容，手动内容放标签外不受影响

安全策略：
  - 写入服务端数据目录 `{memory_root}/context/{project_id}.md`
    （绝不写入用户项目目录，避免覆盖手写 CLAUDE.md / 未知路径）
  - 只读项目记忆，不改写群体记忆
"""
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cerebrate.config import config

logger = logging.getLogger(__name__)


def _safe_split(val, separator=","):
    if not val:
        return []
    if isinstance(val, list):
        return [s for s in val if s]
    if isinstance(val, str):
        return [s.strip() for s in val.split(separator) if s.strip()]
    return [str(val)]


class ProjectContext:
    """项目级上下文：聚合项目记忆生成浓缩文件（服务端侧）。"""

    def __init__(self, manager):
        self.mm = manager

    def _context_dir(self) -> Path:
        ctx_dir = Path(config.memory_root) / "context"
        ctx_dir.mkdir(parents=True, exist_ok=True)
        return ctx_dir

    def _collect(self, project_id: str, limit: int = 50) -> list[dict]:
        """收集项目记忆 + 通用记忆（scope 隔离），按 created 倒序取最近。"""
        swarm = self.mm.swarm
        items = []
        for mid in swarm.get_all_memory_ids():
            item = swarm._store.get(mid)
            if not item:
                continue
            meta = item["metadata"]
            # 跳过分块子条目（父条目已含完整元数据）
            if int(meta.get("chunk_index", 0) or 0) > 0:
                continue
            scope = meta.get("scope") or (
                "project" if meta.get("project_id") else "general")
            if scope == "general":
                include = True
            elif scope == "project" and meta.get("project_id") == project_id:
                include = True
            else:
                include = False
            if not include:
                continue
            items.append({
                "memory_id": mid,
                "title": meta.get("title", ""),
                "category": meta.get("category", ""),
                "tags": _safe_split(meta.get("tags")),
                "scope": scope,
                "created": meta.get("created", ""),
                "observation_type": meta.get("observation_type", ""),
                "solution": meta.get("solution", "") or "",
            })
        items.sort(key=lambda x: x["created"], reverse=True)
        return items[:limit]

    def _render(self, project_id: str, items: list[dict]) -> str:
        now = datetime.now(timezone.utc).isoformat()
        lines = [
            "<!-- 自动生成于 %s | Cerebrate Project Context（请勿手动编辑标签内内容） -->"
            % now,
            f'<cerebrate-context project="{project_id}">',
            "",
            f"# 项目上下文: {project_id}",
            "",
            f"> 最近 {len(items)} 条记忆概览（自动生成）。手动补充内容请放在标签外，"
            "不会被覆盖。",
            "",
        ]
        # 按类型分组
        by_cat: dict[str, list[dict]] = {}
        for it in items:
            by_cat.setdefault(it["category"] or "general", []).append(it)
        for cat in sorted(by_cat):
            lines.append(f"## {cat}")
            for it in by_cat[cat]:
                tags = ",".join(it["tags"]) if it["tags"] else "-"
                lines.append(f"- **{it['title']}** [id={it['memory_id']}]")
                lines.append(f"  - 类型: {it['observation_type'] or cat} | 标签: {tags}")
                if it["created"]:
                    lines.append(f"  - 时间: {it['created'][:19]}")
                if it["solution"]:
                    solution = it["solution"].replace("\n", " ")[:200]
                    lines.append(f"  - 要点: {solution}")
            lines.append("")
        lines.append("</cerebrate-context>")
        return "\n".join(lines)

    def build(self, project_id: str, limit: int = 50) -> dict:
        """生成（或更新）项目上下文文件，返回文件路径与统计。"""
        if not project_id:
            raise ValueError("project_id is required")
        items = self._collect(project_id, limit=limit)
        content = self._render(project_id, items)
        target = self._context_dir() / f"{project_id}.md"
        # 原子写：临时文件 + rename，防止并发读半成品
        tmp = target.with_suffix(".md.tmp")
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(target)
        return {
            "project_id": project_id,
            "path": str(target),
            "memory_count": len(items),
            "categories": sorted({it["category"] for it in items}),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    def read(self, project_id: str) -> Optional[dict]:
        """读取已生成的项目上下文文件（不存在返回 None）。"""
        target = self._context_dir() / f"{project_id}.md"
        if not target.exists():
            return None
        return {
            "project_id": project_id,
            "path": str(target),
            "content": target.read_text(encoding="utf-8"),
        }

    def list_projects(self) -> list[str]:
        """列出已有上下文文件的项目。"""
        ctx_dir = self._context_dir()
        if not ctx_dir.exists():
            return []
        return sorted(p.stem for p in ctx_dir.glob("*.md"))
