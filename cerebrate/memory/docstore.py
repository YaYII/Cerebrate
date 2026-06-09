"""文档存储层 — 按类型分层 + 子目录 content/meta

目录结构:
  {storage_path}/
    memory/               ← 原始记忆（短内容，可全文入向量库）
      content/{id}.md     ← 纯 Markdown 正文
      meta/{id}.json      ← 运营元数据（无 content）
    skill/                ← 已验证技能、蒸馏技能
      content/{id}.md
      meta/{id}.json
    evolution/            ← 进化总结、脑虫教条
      content/{id}.md
      meta/{id}.json
    index.json            ← 全局标题索引

类型映射规则:
  memory, general           → memory/
  skill, verified_skill,    → skill/
    distilled_skill
  doctrine                  → evolution/

读取时兼容旧扁平目录（storage_path/ 直放），迁移期间双读。
"""
import json
import logging
import os
import re
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

CONTENT_KEY = "content"
FULL_CONTENT_KEY = "full_content"

# 生命周期 → 子目录类型映射
LIFE_STAGE_TO_TYPE = {
    "memory": "memory",
    "nutrient": "memory",
    "skill": "skill",
    "verified_skill": "skill",
    "distilled_skill": "skill",
    "doctrine": "evolution",
}


def doc_type_for(life_stage: str) -> str:
    """根据生命周期返回对应的子目录类型。"""
    return LIFE_STAGE_TO_TYPE.get(life_stage, "memory")


class DocumentStore:
    """文件系统文档存储（按类型分层）

    每篇文档存为两个文件：
      {type}/content/{doc_id}.md     ← 原始内容（纯文本，无 JSON 包裹）
      {type}/meta/{doc_id}.json      ← 运营元数据（小 JSON，无 content）

    分块文档：
      {type}/content/{memory_id}.md         → 完整文档 Markdown
      {type}/meta/{memory_id}.json          → 父条目元数据
      {type}/content/{memory_id}_c0000.md   → 第 0 块片段文本
      {type}/meta/{memory_id}_c0000.json    → 第 0 块元数据

    index.json：
       存储标题→ID 映射，含 type 字段指明所属子目录。
    """

    # 所有可能的类型子目录（含旧扁平路径，用于兼容读取）
    ALL_TYPES = ["memory", "skill", "evolution"]

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self._lock = threading.Lock()
        os.makedirs(storage_path, exist_ok=True)

        # 为每个类型创建子目录
        self._type_dirs: dict[str, dict[str, Path]] = {}
        for t in self.ALL_TYPES:
            content_dir = storage_path / t / "content"
            meta_dir = storage_path / t / "meta"
            os.makedirs(content_dir, exist_ok=True)
            os.makedirs(meta_dir, exist_ok=True)
            self._type_dirs[t] = {"content": content_dir, "meta": meta_dir}

        # 旧扁平路径（兼容读取）
        self._flat_content = storage_path / "content"
        self._flat_meta = storage_path / "meta"

        self._index_path = storage_path / "index.json"
        self._title_index: dict[str, dict] = {}
        self._load_index()
        logger.info(f"DocumentStore: {storage_path} (memory/skill/evolution)")

    # ═══════════════════════════════════════════════
    # 标题索引
    # ═══════════════════════════════════════════════

    def _load_index(self):
        if self._index_path.exists():
            try:
                with self._lock:
                    self._title_index = json.loads(
                        self._index_path.read_text(encoding='utf-8'))
            except (json.JSONDecodeError, OSError):
                self._title_index = {}
        else:
            self._title_index = {}

    def _save_index(self):
        with self._lock:
            self._index_path.write_text(
                json.dumps(self._title_index, ensure_ascii=False, indent=2),
                encoding='utf-8')

    def _index_slug(self, title: str) -> str:
        slug = title.lower()
        slug = re.sub(r'[^\w\u4e00-\u9fff]+', '-', slug)
        return slug.strip('-')[:80]

    # ═══════════════════════════════════════════════
    # 写
    # ═══════════════════════════════════════════════

    def put(self, doc_id: str, data: dict, doc_type: str = "memory") -> str:
        """存储或更新文档。

        Args:
            doc_id: 文档 ID
            data: 数据字典（含 content / 元数据）
            doc_type: 子目录类型: memory / skill / evolution
        """
        content = self._pop_content(data)
        metadata = data

        type_dirs = self._type_dirs.get(doc_type, self._type_dirs["memory"])

        # ── 写 .md 文件 ──
        if content:
            md_path = type_dirs["content"] / f"{doc_id}.md"
            with self._lock:
                md_path.write_text(content, encoding='utf-8')

        # ── 写 .json 文件 ──
        if metadata:
            json_path = type_dirs["meta"] / f"{doc_id}.json"
            with self._lock:
                json_path.write_text(
                    json.dumps(metadata, ensure_ascii=False, indent=2),
                    encoding='utf-8')

        # ── 更新标题索引 ──
        title = metadata.get("title", "") if metadata else ""
        if title:
            slug = self._index_slug(title)
            self._title_index[slug] = {
                "id": doc_id,
                "title": title,
                "type": doc_type,
                "category": metadata.get("category", ""),
                "life_stage": metadata.get("life_stage", ""),
            }
            self._save_index()

        return doc_id

    # ═══════════════════════════════════════════════
    # 读
    # ═══════════════════════════════════════════════

    def get(self, doc_id: str, doc_type: Optional[str] = None) -> Optional[dict]:
        """读取文档。

        如果指定 doc_type，只查对应子目录。
        如果未指定，按 memory → skill → evolution → 扁平 顺序尝试。
        """
        result = {}
        found = False

        if doc_type:
            md_content = self._read_file(
                self._type_dirs[doc_type]["content"] / f"{doc_id}.md")
            if md_content is not None:
                result["content"] = md_content
                found = True

            json_data = self._read_json(
                self._type_dirs[doc_type]["meta"] / f"{doc_id}.json")
            if json_data is not None:
                result.update(json_data)
                found = True
        else:
            # 按 memory → skill → evolution → 扁平 顺序尝试
            for t in self.ALL_TYPES:
                md_content = self._read_file(
                    self._type_dirs[t]["content"] / f"{doc_id}.md")
                if md_content is not None:
                    result["content"] = md_content
                    found = True
                    break

            for t in self.ALL_TYPES:
                json_data = self._read_json(
                    self._type_dirs[t]["meta"] / f"{doc_id}.json")
                if json_data is not None:
                    result.update(json_data)
                    found = True
                    break

            # 回退扁平目录
            if not found:
                md_content = self._read_file(
                    self._flat_content / f"{doc_id}.md" if self._flat_content.exists() else None)
                if md_content is not None:
                    result["content"] = md_content
                    found = True
                json_data = self._read_json(
                    self._flat_meta / f"{doc_id}.json" if self._flat_meta.exists() else None)
                if json_data is not None:
                    result.update(json_data)
                    found = True

        return result if found else None

    def get_content(self, doc_id: str, doc_type: Optional[str] = None) -> Optional[str]:
        """仅读取 .md 内容。"""
        if doc_type:
            return self._read_file(
                self._type_dirs[doc_type]["content"] / f"{doc_id}.md")

        for t in self.ALL_TYPES:
            result = self._read_file(self._type_dirs[t]["content"] / f"{doc_id}.md")
            if result is not None:
                return result
        # 扁平回退
        flat = self._flat_content / f"{doc_id}.md" if self._flat_content.exists() else None
        if flat and flat.exists():
            return self._read_file(flat)
        return None

    def get_metadata(self, doc_id: str, doc_type: Optional[str] = None) -> Optional[dict]:
        """仅读取 .json 元数据。"""
        if doc_type:
            return self._read_json(self._type_dirs[doc_type]["meta"] / f"{doc_id}.json")

        for t in self.ALL_TYPES:
            result = self._read_json(self._type_dirs[t]["meta"] / f"{doc_id}.json")
            if result is not None:
                return result
        # 扁平回退
        flat = self._flat_meta / f"{doc_id}.json" if self._flat_meta.exists() else None
        if flat and flat.exists():
            return self._read_json(flat)
        return None

    # ═══════════════════════════════════════════════
    # 删
    # ═══════════════════════════════════════════════

    def delete(self, doc_id: str, doc_type: Optional[str] = None) -> bool:
        """删除文档。"""
        found = False
        paths_to_check = []

        if doc_type:
            paths_to_check = [
                self._type_dirs[doc_type]["content"] / f"{doc_id}.md",
                self._type_dirs[doc_type]["meta"] / f"{doc_id}.json",
            ]
        else:
            for t in self.ALL_TYPES:
                paths_to_check.extend([
                    self._type_dirs[t]["content"] / f"{doc_id}.md",
                    self._type_dirs[t]["meta"] / f"{doc_id}.json",
                ])
            # 扁平路径
            paths_to_check.extend([
                self.storage_path / f"{doc_id}.md",
                self.storage_path / f"{doc_id}.json",
                self._flat_content / f"{doc_id}.md",
                self._flat_meta / f"{doc_id}.json",
            ])

        with self._lock:
            for p in paths_to_check:
                if p and p.exists():
                    p.unlink()
                    found = True

        keys_to_remove = [
            k for k, v in self._title_index.items()
            if v.get("id") == doc_id
        ]
        for k in keys_to_remove:
            del self._title_index[k]
        if keys_to_remove:
            self._save_index()

        return found

    def exists(self, doc_id: str) -> bool:
        if (self._type_dirs["memory"]["content"] / f"{doc_id}.md").exists():
            return True
        for t in self.ALL_TYPES:
            if (self._type_dirs[t]["meta"] / f"{doc_id}.json").exists():
                return True
        if (self.storage_path / f"{doc_id}.md").exists():
            return True
        if (self.storage_path / f"{doc_id}.json").exists():
            return True
        return False

    def get_available_ids(self) -> list[str]:
        ids = set()
        for t in self.ALL_TYPES:
            content_dir = self._type_dirs[t]["content"]
            if content_dir.exists():
                for fname in os.listdir(content_dir):
                    if fname.endswith(".md"):
                        ids.add(fname[:-3])
            meta_dir = self._type_dirs[t]["meta"]
            if meta_dir.exists():
                for fname in os.listdir(meta_dir):
                    if fname.endswith(".json"):
                        ids.add(fname[:-5])
        return sorted(ids)

    def find_by_title(self, title_keyword: str) -> list[dict]:
        keyword = title_keyword.lower()
        results = []
        for slug, entry in self._title_index.items():
            if keyword in entry.get("title", "").lower() or keyword in slug:
                results.append(entry)
        return results

    def list_by_type(self, doc_type: str) -> list[dict]:
        """列出指定类型的所有条目。"""
        return [
            v for v in self._title_index.values()
            if v.get("type") == doc_type
        ]

    # ═══════════════════════════════════════════════
    # 内部方法
    # ═══════════════════════════════════════════════

    def _read_file(self, path) -> Optional[str]:
        if path is None or not path.exists():
            return None
        with self._lock:
            return path.read_text(encoding='utf-8')

    def _read_json(self, path) -> Optional[dict]:
        if path is None or not path.exists():
            return None
        try:
            with self._lock:
                return json.loads(path.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError) as e:
            logger.error(f"DocumentStore JSON 读取失败 {path.name}: {e}")
            return None

    def _pop_content(self, data: dict) -> str:
        return (data.pop("content", "") or data.pop("full_content", "") or "").strip()
