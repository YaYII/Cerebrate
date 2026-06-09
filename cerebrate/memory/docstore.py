"""文档存储层 — 按目录分层存储记忆的原始完整内容

目录结构:
  {storage_path}/
    content/              ← .md 文件（纯 Markdown 正文）
      {doc_id}.md
      {doc_id}_c0000.md   ← 分块片段
    meta/                 ← .json 文件（运营元数据，不含 content 字段）
      {doc_id}.json
      {doc_id}_c0000.json ← 分块元数据
    index.json            ← 标题索引: { "slug": { "id": "doc_id", "title": "..." } }

兼容旧版（扁平结构）：读取时先查新目录，找不到则回退到扁平目录。

与 ChromaDB 向量索引分离设计：
  - Document Store = 源文档持久化（Markdown 文件）
  - ChromaDB = 纯向量索引（doc_id + 向量 + 最小运营元数据）
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


class DocumentStore:
    """文件系统文档存储（分层目录）

    每篇文档存为两个文件：
      content/{doc_id}.md      ← 原始内容（纯文本，无 JSON 包裹）
      meta/{doc_id}.json       ← 运营元数据（小 JSON，无 content）

    分块文档：
      content/{memory_id}.md          → 完整文档 Markdown
      meta/{memory_id}.json           → 父条目元数据
      content/{memory_id}_c0000.md    → 第 0 块片段文本
      meta/{memory_id}_c0000.json     → 第 0 块元数据

    index.json：
       存储标题→ID 映射，支持按语义名称快速查找。
    """

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self._lock = threading.Lock()
        os.makedirs(storage_path, exist_ok=True)

        # 子目录
        self._content_dir = storage_path / "content"
        self._meta_dir = storage_path / "meta"
        self._index_path = storage_path / "index.json"
        os.makedirs(self._content_dir, exist_ok=True)
        os.makedirs(self._meta_dir, exist_ok=True)

        self._title_index: dict[str, dict] = {}
        self._load_index()
        logger.info(f"DocumentStore: {storage_path} (content/, meta/, index.json)")

    # ═══════════════════════════════════════════════
    # 标题索引
    # ═══════════════════════════════════════════════

    def _load_index(self):
        """加载标题索引。"""
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
        """持久化标题索引。"""
        with self._lock:
            self._index_path.write_text(
                json.dumps(self._title_index, ensure_ascii=False, indent=2),
                encoding='utf-8')

    def _index_slug(self, title: str) -> str:
        """将标题转为索引用 slug。"""
        slug = title.lower()
        slug = re.sub(r'[^\w\u4e00-\u9fff]+', '-', slug)
        slug = slug.strip('-')
        return slug[:80]

    def put(self, doc_id: str, data: dict) -> str:
        """存储或更新文档

        自动拆分：
          - content → content/{doc_id}.md（纯文本）
          - 其余非内容字段 → meta/{doc_id}.json（元数据）
          - 如有 title 字段 → 更新 index.json
        """
        content = self._pop_content(data)
        metadata = data  # 剩余字段

        # ── 写 .md 文件 ──
        if content:
            md_path = self._content_dir / f"{doc_id}.md"
            with self._lock:
                md_path.write_text(content, encoding='utf-8')

        # ── 写 .json 文件（仅元数据） ──
        if metadata:
            json_path = self._meta_dir / f"{doc_id}.json"
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
                "category": metadata.get("category", ""),
                "life_stage": metadata.get("life_stage", ""),
            }
            self._save_index()

        return doc_id

    def get(self, doc_id: str) -> Optional[dict]:
        """读取文档

        从 content/{doc_id}.md 加载内容 + meta/{doc_id}.json 加载元数据。
        兼容旧扁平结构：先查新目录，找不到则回退。
        """
        result = {}
        found = False

        # ── 读 .md 文件（先新目录，再回退扁平） ──
        md_content = self._read_file(self._content_dir / f"{doc_id}.md",
                                     self.storage_path / f"{doc_id}.md")
        if md_content is not None:
            result["content"] = md_content
            found = True

        # ── 读 .json 文件 ──
        json_data = self._read_json(self._meta_dir / f"{doc_id}.json",
                                    self.storage_path / f"{doc_id}.json")
        if json_data is not None:
            result.update(json_data)
            found = True

        return result if found else None

    def get_content(self, doc_id: str) -> Optional[str]:
        """仅读取 .md 内容（跳过 JSON 解析，更高效）"""
        return self._read_file(
            self._content_dir / f"{doc_id}.md",
            self.storage_path / f"{doc_id}.md",
        )

    def get_metadata(self, doc_id: str) -> Optional[dict]:
        """仅读取 .json 元数据（跳过 .md 读取）"""
        return self._read_json(
            self._meta_dir / f"{doc_id}.json",
            self.storage_path / f"{doc_id}.json",
        )

    def delete(self, doc_id: str) -> bool:
        """删除文档（同时清理新目录和旧扁平目录）"""
        found = False
        pairs = [
            (self._content_dir / f"{doc_id}.md",
             self.storage_path / f"{doc_id}.md"),
            (self._meta_dir / f"{doc_id}.json",
             self.storage_path / f"{doc_id}.json"),
        ]
        with self._lock:
            for new_path, old_path in pairs:
                if new_path.exists():
                    new_path.unlink()
                    found = True
                if old_path.exists():
                    old_path.unlink()
                    found = True

        # 清理索引条目
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
        """检查文档是否存在"""
        return (
            (self._content_dir / f"{doc_id}.md").exists()
            or (self._meta_dir / f"{doc_id}.json").exists()
            or (self.storage_path / f"{doc_id}.md").exists()
            or (self.storage_path / f"{doc_id}.json").exists()
        )

    def get_available_ids(self) -> list[str]:
        """列出所有可用的文档 ID"""
        ids = set()
        with self._lock:
            for d in [self._content_dir, self.storage_path]:
                if not d.exists():
                    continue
                for fname in os.listdir(d):
                    if fname.endswith(".md"):
                        ids.add(fname[:-3])
                    elif fname.endswith(".json"):
                        ids.add(fname[:-5])
        return sorted(ids)

    def find_by_title(self, title_keyword: str) -> list[dict]:
        """按标题关键词查找记忆。

        遍历 index.json 中标题包含关键词的条目。
        """
        keyword = title_keyword.lower()
        results = []
        for slug, entry in self._title_index.items():
            if keyword in entry.get("title", "").lower() or keyword in slug:
                results.append(entry)
        return results

    def list_evolution_results(self) -> list[dict]:
        """列出所有进化结果（distilled_skill / doctrine）。"""
        return [
            v for v in self._title_index.values()
            if v.get("category") in ("distilled_skill", "doctrine")
        ]

    # ═══════════════════════════════════════════════
    # 内部方法
    # ═══════════════════════════════════════════════

    def _read_file(self, primary: Path, fallback: Path) -> Optional[str]:
        """先读新路径，再回退旧路径。"""
        with self._lock:
            if primary.exists():
                return primary.read_text(encoding='utf-8')
            if fallback.exists():
                return fallback.read_text(encoding='utf-8')
        return None

    def _read_json(self, primary: Path, fallback: Path) -> Optional[dict]:
        """先读新路径的 JSON，再回退旧路径。"""
        path = primary if primary.exists() else (fallback if fallback.exists() else None)
        if not path:
            return None
        try:
            with self._lock:
                return json.loads(path.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError) as e:
            logger.error(f"DocumentStore JSON 读取失败 {path.name}: {e}")
            return None

    def _pop_content(self, data: dict) -> str:
        """从 data 中提取内容字段，拼接为纯文本"""
        return (data.pop("content", "") or data.pop("full_content", "") or "").strip()
