"""FTS5 全文索引 — 补充向量检索的精确关键词短板（v5.3 Phase 3）

对齐 claude-mem search-architecture 的 FTS5 设计:
  - SQLite FTS5 虚拟表（trigram tokenizer，中英文都支持子串匹配）
  - 查询注入转义（剥离 FTS5 运算符，token 加引号短语匹配）
  - 与 ChromaDB 向量检索混合：FTS 精确命中 + 向量语义召回

存储结构:
  - memories_fts: FTS5 虚拟表（title/content/tags/category/scope/project_id）
  - memories_meta: 普通表（LIKE 回退 + scope/project 过滤 + snippet 源）

索引范围: 主记忆条目（parent）。分块文档不单独索引，用父文档完整内容。
"""
import logging
import re
import sqlite3
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def _escape_fts(query: str) -> str:
    """FTS5 注入转义：剥离 FTS5 运算符，token 加双引号短语匹配。

    对齐 claude-mem 的 escapeFTS5Query（双引号加倍），但更严格：
    只保留词元（unicode 字母/数字/中文），其余字符全部剥离。
    """
    if not query:
        return '""'
    tokens = re.findall(r"[\w\u4e00-\u9fff]+", query, re.UNICODE)
    if not tokens:
        return '""'
    return " ".join(f'"{t}"' for t in tokens)


class FullTextIndex:
    """SQLite FTS5 全文索引（线程安全）。"""

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        try:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        self._lock = threading.Lock()
        self._ready = False
        try:
            self._init_db()
            self._ready = True
        except Exception as e:
            logger.warning(f"FTS5 初始化失败，全文检索降级不可用: {e}")

    @property
    def available(self) -> bool:
        return self._ready

    def _init_db(self):
        with self._lock, sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                    title, content, tags, category, scope, project_id,
                    doc_id UNINDEXED,
                    tokenize='trigram'
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS memories_meta (
                    doc_id TEXT PRIMARY KEY,
                    title TEXT, content TEXT, tags TEXT,
                    category TEXT, scope TEXT, project_id TEXT,
                    created TEXT, updated TEXT,
                    observation_type TEXT
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_meta_scope ON memories_meta(scope, project_id)"
            )
            # 迁移：旧表无 observation_type 列时补充（CREATE IF NOT EXISTS 不会加列）
            cols = [r[1] for r in conn.execute(
                "PRAGMA table_info(memories_meta)").fetchall()]
            if "observation_type" not in cols:
                conn.execute(
                    "ALTER TABLE memories_meta ADD COLUMN observation_type TEXT")
            conn.commit()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def upsert(self, doc_id: str, *, title: str = "", content: str = "",
               tags: str = "", category: str = "", scope: str = "general",
               project_id: str = "", created: str = "", updated: str = "",
               observation_type: str = "") -> bool:
        """写入/更新一条记忆的全文索引。"""
        if not self._ready or not doc_id:
            return False
        tags = tags or ""
        try:
            with self._lock, self._conn() as conn:
                conn.execute(
                    "DELETE FROM memories_fts WHERE doc_id = ?", (doc_id,))
                conn.execute(
                    "INSERT INTO memories_fts(title, content, tags, category, scope, project_id, doc_id) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (title, content, tags, category, scope, project_id, doc_id))
                conn.execute(
                    """
                    INSERT INTO memories_meta(doc_id, title, content, tags, category, scope, project_id, created, updated, observation_type)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(doc_id) DO UPDATE SET
                        title=excluded.title, content=excluded.content,
                        tags=excluded.tags, category=excluded.category,
                        scope=excluded.scope, project_id=excluded.project_id,
                        created=excluded.created, updated=excluded.updated,
                        observation_type=excluded.observation_type
                    """,
                    (doc_id, title, content, tags, category, scope,
                     project_id, created, updated, observation_type))
                conn.commit()
            return True
        except Exception as e:
            logger.warning(f"FTS upsert 失败 ({doc_id}): {e}")
            return False

    def delete(self, doc_id: str) -> bool:
        if not self._ready:
            return False
        try:
            with self._lock, self._conn() as conn:
                conn.execute(
                    "DELETE FROM memories_fts WHERE doc_id = ?", (doc_id,))
                conn.execute(
                    "DELETE FROM memories_meta WHERE doc_id = ?", (doc_id,))
                conn.commit()
            return True
        except Exception as e:
            logger.warning(f"FTS delete 失败 ({doc_id}): {e}")
            return False

    def _scope_conditions(self, scope: Optional[str],
                          project_id: Optional[str], prefix: str = "m") -> str:
        """scope 隔离过滤条件（与向量层语义一致）。

        prefix: 表别名（memories_meta 别名为 m，FTS 查询中 m 已 JOIN）。
        """
        pfx = f"{prefix}." if prefix else ""
        if scope == "all":
            return ""
        if scope == "general":
            return f" AND {pfx}scope = 'general'"
        if scope == "project":
            pid = project_id or ""
            return f" AND {pfx}scope = 'project' AND {pfx}project_id IN ('', '{pid}')"
        if project_id is not None:
            return f" AND {pfx}scope = 'project' AND {pfx}project_id IN ('', '{project_id}')"
        # 默认：只查通用记忆（对齐 scope 隔离规则）
        return f" AND {pfx}scope = 'general'"

    def search(self, query: str, limit: int = 20,
               scope: Optional[str] = None, project_id: Optional[str] = None,
               category: Optional[str] = None) -> list[dict]:
        """FTS5 全文检索（精确关键词优先） + LIKE 回退（中文短词兜底）。

        返回按相关度排序的文档索引，字段与向量层 index 对齐：
        doc_id/title/category/scope/project_id/created/token_estimate/source
        """
        if not self._ready:
            return []
        if not query:
            return []
        # FTS JOIN 查询使用 memories_fts f JOIN memories_meta m，条件前缀 m.
        scope_cond = self._scope_conditions(scope, project_id, prefix="m")
        cat_cond = ""
        if category:
            cat_cond = f" AND m.category = '{category}'"
        # LIKE 回退直接查 memories_meta（无别名），条件前缀为空
        scope_cond_like = self._scope_conditions(scope, project_id, prefix="")
        cat_cond_like = ""
        if category:
            cat_cond_like = f" AND category = '{category}'"

        try:
            with self._conn() as conn:
                # 1. FTS5 精确匹配
                rows = []
                fts_q = _escape_fts(query)
                if fts_q != '""':
                    sql = (
                        "SELECT f.doc_id, m.title, m.category, m.scope, "
                        "m.project_id, m.created, m.observation_type, "
                        "length(m.content) AS content_len, "
                        "snippet(memories_fts, 1, '[', ']', '…', 12) AS snippet "
                        "FROM memories_fts f "
                        "JOIN memories_meta m ON m.doc_id = f.doc_id "
                        "WHERE memories_fts MATCH ?" + scope_cond + cat_cond +
                        " ORDER BY bm25(memories_fts) LIMIT ?"
                    )
                    rows = conn.execute(sql, (fts_q, limit * 3)).fetchall()

                # 2. LIKE 回退（中文 1-2 字词、FTS 漏网）
                like_rows = []
                like_q = f"%{query.strip()}%"
                if len(rows) < limit:
                    sql = (
                        "SELECT doc_id, title, category, scope, project_id, created, "
                        "observation_type, "
                        "length(content) AS content_len, '' AS snippet "
                        "FROM memories_meta "
                        "WHERE (title LIKE ? OR content LIKE ?)" +
                        scope_cond_like + cat_cond_like + " LIMIT ?"
                    )
                    try:
                        like_rows = conn.execute(
                            sql, (like_q, like_q, limit)).fetchall()
                    except sqlite3.OperationalError:
                        like_rows = []

                # 3. 合并去重（FTS 优先）
                seen: set[str] = set()
                result = []
                for r in list(rows) + list(like_rows):
                    doc_id = r["doc_id"] or ""
                    if not doc_id or doc_id in seen:
                        continue
                    seen.add(doc_id)
                    result.append({
                        "memory_id": doc_id,
                        "title": r["title"],
                        "category": r["category"],
                        "scope": r["scope"],
                        "project_id": r["project_id"],
                        "created": r["created"],
                        "observation_type": r["observation_type"] or "",
                        "token_estimate": max(1, int((r["content_len"] or 0) // 4)),
                        "source": "fulltext",
                        "snippet": r["snippet"] or "",
                    })
                    if len(result) >= limit:
                        break
                return result
        except Exception as e:
            logger.warning(f"FTS search 失败: {e}")
            return []

    def count(self) -> int:
        if not self._ready:
            return 0
        try:
            with self._conn() as conn:
                return conn.execute(
                    "SELECT COUNT(*) FROM memories_meta").fetchone()[0]
        except Exception:
            return 0

    def clear(self) -> bool:
        if not self._ready:
            return False
        try:
            with self._lock, self._conn() as conn:
                conn.execute("DELETE FROM memories_fts")
                conn.execute("DELETE FROM memories_meta")
                conn.commit()
            return True
        except Exception as e:
            logger.warning(f"FTS clear 失败: {e}")
            return False
