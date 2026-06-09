"""文档存储层 — 存储记忆的原始完整内容

存储策略（行业标准）:
  - {doc_id}.md   → 原始内容（纯 Markdown，可 grep/可 diff/可 git）
  - {doc_id}.json → 运营元数据（小 JSON，不含 content 字段）

与 ChromaDB 向量索引分离设计：
  - Document Store = 源文档持久化（Markdown 文件）
  - ChromaDB = 纯向量索引（doc_id + 向量 + 最小运营元数据）
"""
import json
import logging
import os
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# 内容类字段：写 .md 文件的核心字段
CONTENT_KEY = "content"
FULL_CONTENT_KEY = "full_content"


class DocumentStore:
    """文件系统文档存储

    每篇文档存为两个文件：
      {storage_path}/{doc_id}.md      ← 原始内容（纯文本，无 JSON 包裹）
      {storage_path}/{doc_id}.json    ← 运营元数据（小 JSON，无 content）

    分块文档：
      {memory_id}.md          → 完整文档 Markdown
      {memory_id}.json        → 父条目元数据
      {memory_id}_c0000.md    → 第 0 块片段文本
      {memory_id}_c0000.json  → 第 0 块元数据
    """

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self._lock = threading.Lock()
        os.makedirs(storage_path, exist_ok=True)
        logger.info(f"DocumentStore: {storage_path}")

    def put(self, doc_id: str, data: dict) -> str:
        """存储或更新文档

        自动拆分：
          - content/problem_solved/solution/evidence → .md（纯文本）
          - 其余非内容字段 → .json（元数据）
        """
        content = self._pop_content(data)
        metadata = data  # 剩余字段

        # ── 写 .md 文件（纯文本） ──
        if content:
            md_path = self.storage_path / f"{doc_id}.md"
            with self._lock:
                md_path.write_text(content, encoding='utf-8')

        # ── 写 .json 文件（仅元数据，无 content 字段） ──
        if metadata:
            json_path = self.storage_path / f"{doc_id}.json"
            with self._lock:
                json_path.write_text(
                    json.dumps(metadata, ensure_ascii=False, indent=2),
                    encoding='utf-8')

        return doc_id

    def get(self, doc_id: str) -> Optional[dict]:
        """读取文档

        从 .md 加载内容 + 从 .json 加载元数据，合并返回。
        返回格式与旧 JSON-only 格式兼容。
        """
        result = {}
        found = False

        # ── 读 .md 文件 ──
        md_path = self.storage_path / f"{doc_id}.md"
        if md_path.exists():
            with self._lock:
                text = md_path.read_text(encoding='utf-8')
            # 解析 content（第一段为 content，后面按字段名分割）
            result["content"] = text
            found = True

        # ── 读 .json 文件 ──
        json_path = self.storage_path / f"{doc_id}.json"
        if json_path.exists():
            try:
                with self._lock:
                    meta = json.loads(json_path.read_text(encoding='utf-8'))
                result.update(meta)
                found = True
            except (json.JSONDecodeError, OSError) as e:
                logger.error(f"DocumentStore JSON 读取失败 {doc_id}: {e}")

        return result if found else None

    def get_content(self, doc_id: str) -> Optional[str]:
        """仅读取 .md 内容（跳过 JSON 解析，更高效）"""
        md_path = self.storage_path / f"{doc_id}.md"
        if not md_path.exists():
            return None
        with self._lock:
            return md_path.read_text(encoding='utf-8')

    def get_metadata(self, doc_id: str) -> Optional[dict]:
        """仅读取 .json 元数据（跳过 .md 读取）"""
        json_path = self.storage_path / f"{doc_id}.json"
        if not json_path.exists():
            return None
        try:
            with self._lock:
                return json.loads(json_path.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError) as e:
            logger.error(f"DocumentStore 元数据读取失败 {doc_id}: {e}")
            return None

    def delete(self, doc_id: str) -> bool:
        """删除文档（同时清理 .md 和 .json）"""
        found = False
        md_path = self.storage_path / f"{doc_id}.md"
        json_path = self.storage_path / f"{doc_id}.json"
        with self._lock:
            if md_path.exists():
                md_path.unlink()
                found = True
            if json_path.exists():
                json_path.unlink()
                found = True
        return found

    def exists(self, doc_id: str) -> bool:
        """检查文档是否存在（.md 或 .json 任一存在即可）"""
        return ((self.storage_path / f"{doc_id}.md").exists()
                or (self.storage_path / f"{doc_id}.json").exists())

    def get_available_ids(self) -> list[str]:
        """列出所有可用的文档 ID（基于 .md 文件）"""
        ids = set()
        with self._lock:
            for fname in os.listdir(self.storage_path):
                if fname.endswith(".md"):
                    ids.add(fname[:-3])
                elif fname.endswith(".json"):
                    ids.add(fname[:-5])
        return sorted(ids)

    def _pop_content(self, data: dict) -> str:
        """从 data 中提取内容字段，拼接为纯文本

        仅 `content`（正文）写 .md 文件。
        problem_solved/solution/evidence 等结构化字段
        留在 .json 元数据中。
        """
        return (data.pop("content", "") or data.pop("full_content", "") or "").strip()
