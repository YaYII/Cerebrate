"""权威知识库层 v5 — 服务端权威知识 + ChromaDB 向量存储 + Markdown 文件持久化"""
import hashlib
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cerebrate.core.storage import ChromaStore
from cerebrate.config import config


class KnowledgeBase:
    """权威知识库：ChromaDB 向量存储后端"""

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self._store: Optional[ChromaStore] = None
        self._hash_index: dict[str, str] = {}  # content_hash → doc_id
        self._init_store()
        self._build_hash_index()

    def _init_store(self):
        from cerebrate.core.embedding import get_embedding_engine
        engine = get_embedding_engine(config.embedding_model, config.embedding_device)
        self._store = ChromaStore(config.chroma_path, "knowledge_base", engine)

    def _build_hash_index(self):
        """启动时扫描一次，建立 content hash → doc_id 索引"""
        self._hash_index.clear()
        for did in self._store.get_all_ids():
            item = self._store.get(did)
            if item:
                h = item["metadata"].get("hash")
                if h:
                    self._hash_index[h] = did

    def flush(self):
        pass  # ChromaDB 自动持久化

    # ==================== 写入 ====================

    def store(self, title: str, content: str, source: str, topics: list[str],
              is_policy: bool = False, policy_name: str = "",
              version: str = "1.0", author: str = "",
              project_id: str = "") -> str:
        project_id = project_id or config.current_project_id
        doc_hash = hashlib.sha256(content.encode()).hexdigest()

        # O(1) 哈希索引去重
        if doc_hash in self._hash_index:
            return self._hash_index[doc_hash]

        doc_id = hashlib.sha256(
            f"{title}{source}{datetime.now(timezone.utc).isoformat()}".encode()
        ).hexdigest()[:16]

        now = datetime.now(timezone.utc).isoformat()
        search_text = f"{title}\n{content}"
        metadata = {
            "title": title,
            "content": content,
            "source": source,
            "version": version,
            "author": author,
            "topics": ",".join(topics),
            "is_policy": str(is_policy),
            "policy_name": policy_name,
            "project_id": project_id,
            "hash": doc_hash,
            "created": now,
            "updated": now,
            "access_count": 0,
            "verified": str(False),
            "deprecated": str(False),
        }

        self._store.add(doc_id, search_text, metadata)
        self._hash_index[doc_hash] = doc_id

        # ── 双写：同步写入人类可读的 Markdown 文件 ──
        self._write_markdown(doc_id, title, content, metadata, topics,
                             is_policy, policy_name)

        return doc_id

    # ==================== 查询 ====================

    def lookup(self, query: str, topic: Optional[str] = None,
               exact_policy: bool = False, project_id: Optional[str] = None) -> list[dict]:
        """向量语义查询知识库"""
        conditions = []
        if project_id is not None:
            pid = project_id if project_id else config.current_project_id
            conditions.append({"project_id": {"$in": [pid, ""]}})
        if topic:
            conditions.append({"topics": {"$contains": topic}})
        if exact_policy:
            conditions.append({"is_policy": "True"})

        where = None
        if len(conditions) == 1:
            where = conditions[0]
        elif len(conditions) > 1:
            where = {"$and": conditions}

        from cerebrate.core.embedding import get_embedding_engine
        engine = get_embedding_engine()
        q_emb = engine.encode_query(query) if engine.mode == "bge" else None

        raw_results = self._store.search(query, top_k=10, where=where,
                                         query_embedding=q_emb)

        results = []
        for item in raw_results:
            meta = item["metadata"]
            bonus = 0.0
            if meta.get("is_policy") == "True":
                bonus += 0.15
            if meta.get("verified") == "True":
                bonus += 0.1
            if meta.get("deprecated") == "True":
                bonus -= 0.3

            sem_score = 1.0 - (item["distance"] / 2.0)
            results.append({
                "doc_id": item["id"],
                "title": meta.get("title", ""),
                "content": meta.get("content", ""),
                "source": meta.get("source", ""),
                "version": meta.get("version", ""),
                "is_policy": meta.get("is_policy") == "True",
                "policy_name": meta.get("policy_name", ""),
                "topics": (meta.get("topics") or "").split(","),
                "project_id": meta.get("project_id", ""),
                "verified": meta.get("verified") == "True",
                "deprecated": meta.get("deprecated") == "True",
                "score": round(min(1.0, sem_score + bonus), 4),
            })

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:5]

    def get_policy(self, policy_name: str) -> Optional[dict]:
        # 扫描查找匹配 policy_name
        for did in self._store.get_all_ids():
            item = self._store.get(did)
            if item and item["metadata"].get("policy_name") == policy_name:
                meta = item["metadata"]
                return {
                    "doc_id": item["id"],
                    "title": meta.get("title", ""),
                    "content": meta.get("content", ""),
                    "source": meta.get("source", ""),
                    "version": meta.get("version", ""),
                    "policy_name": meta.get("policy_name", ""),
                    "project_id": meta.get("project_id", ""),
                    "verified": meta.get("verified") == "True",
                    "deprecated": meta.get("deprecated") == "True",
                }
        return None

    def verify(self, doc_id: str, verified: bool = True):
        item = self._store.get(doc_id)
        if item:
            meta = item["metadata"]
            meta["verified"] = str(verified)
            meta["updated"] = datetime.now(timezone.utc).isoformat()
            text = f"{meta.get('title','')}\n{meta.get('content','')}"
            self._store.upsert(doc_id, text, meta)

    def deprecate(self, doc_id: str):
        item = self._store.get(doc_id)
        if item:
            meta = item["metadata"]
            meta["deprecated"] = str(True)
            meta["updated"] = datetime.now(timezone.utc).isoformat()
            text = f"{meta.get('title','')}\n{meta.get('content','')}"
            self._store.upsert(doc_id, text, meta)

    def list_topics(self) -> list[str]:
        topics = set()
        for did in self._store.get_all_ids()[:500]:
            item = self._store.get(did)
            if item:
                for t in (item["metadata"].get("topics") or "").split(","):
                    if t.strip():
                        topics.add(t.strip())
        return list(topics)

    def list_policies(self) -> list[str]:
        policies = set()
        for did in self._store.get_all_ids()[:500]:
            item = self._store.get(did)
            if item and item["metadata"].get("policy_name"):
                policies.add(item["metadata"]["policy_name"])
        return list(policies)

    # ── Markdown 文件持久化 ──────────────────────────────

    def export_pdf(self, doc_id: str) -> Optional[bytes]:
        """将知识文档导出为 PDF 文件内容。"""
        item = self._store.get(doc_id)
        if not item:
            return None
        meta = item["metadata"]
        title = meta.get("title", "Untitled")
        content = meta.get("content", "")

        try:
            from fpdf import FPDF
            pdf = FPDF()
            pdf.add_page()
            pdf.set_auto_page_break(auto=True, margin=15)

            # 标题
            pdf.set_font("Helvetica", "B", 16)
            pdf.multi_cell(0, 10, title)
            pdf.ln(4)

            # 元数据
            pdf.set_font("Helvetica", "I", 9)
            meta_line = f"来源: {meta.get('source','')} | 版本: {meta.get('version','')} | {meta.get('updated','')[:10]}"
            pdf.cell(0, 6, meta_line, ln=True)
            topics = meta.get("topics", "")
            if topics:
                pdf.cell(0, 6, f"主题: {topics}", ln=True)
            pdf.ln(6)

            # 正文
            pdf.set_font("Helvetica", "", 10)
            # 处理 Markdown 基本格式
            for line in content.split("\n"):
                line = line.strip()
                if not line:
                    pdf.ln(3)
                    continue

                if line.startswith("# ") and not line.startswith("##"):
                    pdf.set_font("Helvetica", "B", 13)
                    pdf.cell(0, 8, line[2:], ln=True)
                    pdf.set_font("Helvetica", "", 10)
                elif line.startswith("## "):
                    pdf.set_font("Helvetica", "B", 11)
                    pdf.cell(0, 7, line[3:], ln=True)
                    pdf.set_font("Helvetica", "", 10)
                elif line.startswith("### "):
                    pdf.set_font("Helvetica", "BI", 10)
                    pdf.cell(0, 6, line[4:], ln=True)
                    pdf.set_font("Helvetica", "", 10)
                elif line.startswith("```"):
                    pdf.set_font("Courier", "", 9)
                elif line.startswith("- ") or line.startswith("* "):
                    pdf.set_x(pdf.l_margin + 5)
                    pdf.multi_cell(0, 5, "  " + line[2:])
                elif line.startswith("  ") and pdf.font_family == "Courier":
                    pdf.set_font("Courier", "", 9)
                    pdf.cell(0, 5, line, ln=True)
                elif line.startswith("> "):
                    pdf.set_font("Helvetica", "I", 9)
                    pdf.multi_cell(0, 5, line[2:])
                    pdf.set_font("Helvetica", "", 10)
                else:
                    pdf.multi_cell(0, 5, line)

            return pdf.output()
        except ImportError:
            return None
        except Exception:
            return None

    def _get_files_dir(self) -> Path:
        """知识库 Markdown 文件存储目录。"""
        d = config.memory_root / "knowledge_files"
        d.mkdir(parents=True, exist_ok=True)
        return d

    @staticmethod
    def _safe_name(s: str) -> str:
        """安全文件名：仅保留字母数字和中文，替换特殊字符。"""
        s = re.sub(r'[<>:"/\\|?*\s]+', '_', s.strip())
        return s[:80] if s else "untitled"

    def _write_markdown(self, doc_id: str, title: str, content: str,
                        metadata: dict, topics: list, is_policy: bool,
                        policy_name: str):
        """将知识文档写入人类可读的 Markdown 文件。"""
        try:
            files_dir = self._get_files_dir()

            # 按类型和主题分子目录
            category = "policies" if is_policy else "knowledge"
            topic_dir = self._safe_name(policy_name or (topics[0] if topics else "general"))
            target_dir = files_dir / category / topic_dir
            target_dir.mkdir(parents=True, exist_ok=True)

            # 写 .md 文件
            safe_title = self._safe_name(title)
            filepath = target_dir / f"{safe_title}_{doc_id[:8]}.md"

            header = (
                f"---\n"
                f"doc_id: {doc_id}\n"
                f"title: {title}\n"
                f"topics: {', '.join(topics)}\n"
                f"policy: {is_policy}\n"
                f"policy_name: {policy_name}\n"
                f"source: {metadata.get('source','')}\n"
                f"version: {metadata.get('version','')}\n"
                f"author: {metadata.get('author','')}\n"
                f"created: {metadata.get('created','')}\n"
                f"updated: {metadata.get('updated','')}\n"
                f"---\n\n"
            )

            with open(filepath, "w", encoding="utf-8") as f:
                f.write(header + content)

            # 写索引文件，方便按时间浏览所有知识
            index_path = files_dir / "INDEX.md"
            if not index_path.exists():
                with open(index_path, "w", encoding="utf-8") as f:
                    f.write("# 虫群知识库索引\n\n")
            with open(index_path, "a", encoding="utf-8") as f:
                f.write(f"- [{title}]({filepath.relative_to(files_dir)})\n")

        except Exception:
            pass  # 文件写入非关键路径

    def update_document(self, doc_id: str, title: str, content: str,
                        metadata: dict = None):
        """更新已有文档的 ChromaDB 记录，并同步更新 Markdown 文件。"""
        item = self._store.get(doc_id)
        if not item:
            return False
        meta = item["metadata"]
        meta["content"] = content
        meta["title"] = title
        meta["updated"] = datetime.now(timezone.utc).isoformat()
        if metadata:
            meta.update(metadata)
        text = f"{title}\n{content[:500]}"
        self._store.upsert(doc_id, text, meta)

        # 重写 Markdown 文件
        topics = (meta.get("topics") or "").split(",")
        is_policy = meta.get("is_policy", "False") == "True"
        policy_name = meta.get("policy_name", "")
        self._write_markdown(doc_id, title, content, meta, topics,
                             is_policy, policy_name)
        return True
