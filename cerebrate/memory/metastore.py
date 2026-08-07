"""PostgreSQL 元数据存储层 — 文档元数据的关系型持久化

与 DocumentStore（文件系统存内容）、ChromaDB（向量索引）组成三层存储架构：
  - PostgreSQL = 文档元数据（标题/标签/状态/版本/作者...）
  - DocumentStore = 完整原始内容（JSON 文件）
  - ChromaDB = 纯向量索引（doc_id + 向量）

PostgreSQL 是可选层：无 DATABASE_URL 时降级为 ChromaDB metadata（原始行为）。
"""
import json
import logging
import os
import threading
from typing import Optional

logger = logging.getLogger(__name__)

# 全局连接（线程安全，惰性初始化）
_pool = None
_pool_lock = threading.Lock()
_pool_ready = False


def _get_connection():
    """获取 PostgreSQL 连接（惰性初始化连接池）"""
    global _pool, _pool_ready
    if not _pool_ready:
        return None
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                try:
                    import psycopg2
                    from psycopg2 import pool as pg_pool
                    dsn = os.environ.get("CEREBRATE_DATABASE_URL", "")
                    if not dsn:
                        # 尝试从单个配置项拼接
                        host = os.environ.get("CEREBRATE_PG_HOST", "127.0.0.1")
                        port = int(os.environ.get("CEREBRATE_PG_PORT", "5432"))
                        db = os.environ.get("CEREBRATE_PG_DB", "cerebrate")
                        user = os.environ.get("CEREBRATE_PG_USER", "cerebrate")
                        pw = os.environ.get("CEREBRATE_PG_PASSWORD", "")
                        dsn = f"host={host} port={port} dbname={db} user={user} password={pw}"
                    _pool = pg_pool.ThreadedConnectionPool(
                        minconn=1, maxconn=8, dsn=dsn)
                    logger.info(f"PostgreSQL 连接池已建立 ({db}@{host})")
                except Exception as e:
                    logger.warning(f"PostgreSQL 连接失败 ({e})，降级为 ChromaDB metadata")
                    _pool = None
    if _pool:
        try:
            return _pool.getconn()
        except Exception as e:
            logger.error(f"PostgreSQL 获取连接失败: {e}")
    return None


def _put_conn(conn):
    """归还连接到池"""
    global _pool
    if _pool and conn:
        try:
            _pool.putconn(conn)
        except Exception:
            pass


def init_db():
    """初始化数据库：创建表（幂等）"""
    global _pool_ready
    conn = _get_connection()
    if not conn:
        _pool_ready = False
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                    document_id VARCHAR(32) PRIMARY KEY,
                    title VARCHAR(500) NOT NULL DEFAULT '',
                    content_path VARCHAR(500) NOT NULL DEFAULT '',
                    file_type VARCHAR(20) NOT NULL DEFAULT 'json',
                    author VARCHAR(200) NOT NULL DEFAULT '',
                    source_agent VARCHAR(200) NOT NULL DEFAULT '',
                    physical_user VARCHAR(200) NOT NULL DEFAULT '',
                    category VARCHAR(100) NOT NULL DEFAULT '',
                    tags JSONB NOT NULL DEFAULT '[]',
                    project_id VARCHAR(100) NOT NULL DEFAULT '',
                    language VARCHAR(50) NOT NULL DEFAULT '简体中文',
                    life_stage VARCHAR(20) NOT NULL DEFAULT 'memory',
                    outcome VARCHAR(20) NOT NULL DEFAULT 'success',
                    confidence REAL NOT NULL DEFAULT 1.0,
                    reuse_count INTEGER NOT NULL DEFAULT 0,
                    success_count INTEGER NOT NULL DEFAULT 0,
                    score REAL NOT NULL DEFAULT 1.0,
                    total_chunks INTEGER NOT NULL DEFAULT 1,
                    status VARCHAR(20) NOT NULL DEFAULT 'active',
                    version INTEGER NOT NULL DEFAULT 1,
                    metadata JSONB NOT NULL DEFAULT '{}',
                    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS document_versions (
                    id SERIAL PRIMARY KEY,
                    document_id VARCHAR(32) NOT NULL REFERENCES documents(document_id),
                    version INTEGER NOT NULL,
                    content_path VARCHAR(500) NOT NULL,
                    change_log TEXT NOT NULL DEFAULT '',
                    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                    created_by VARCHAR(100) NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
                CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
                CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);
                CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
                CREATE INDEX IF NOT EXISTS idx_docver_docid ON document_versions(document_id);
            """)
            conn.commit()
            _pool_ready = True
            logger.info("PostgreSQL 表初始化完成")
            return True
    except Exception as e:
        conn.rollback()
        logger.warning(f"PostgreSQL 表初始化失败 ({e})，降级为 ChromaDB metadata")
        _pool_ready = False
        return False
    finally:
        _put_conn(conn)


class MetaStore:
    """PostgreSQL 元数据存储

    所有写操作自动更新 updated_at。
    版本控制：每次 put 增加版本号，旧版本存档到 document_versions。
    """

    def __init__(self):
        self._ready = None  # None=未检测, True/False
        self._init_lock = threading.Lock()

    @property
    def available(self) -> bool:
        """PostgreSQL 是否可用"""
        global _pool_ready
        if self._ready is None:
            with self._init_lock:
                if self._ready is None:
                    self._ready = init_db()
        return self._ready or _pool_ready

    def put_document(self, doc_id: str, title: str = "",
                     content_path: str = "", file_type: str = "json",
                     author: str = "", source_agent: str = "",
                     physical_user: str = "", category: str = "",
                     tags: Optional[list[str]] = None,
                     project_id: str = "", language: str = "",
                     life_stage: str = "memory", outcome: str = "success",
                     confidence: float = 1.0, total_chunks: int = 1,
                     metadata: Optional[dict] = None,
                     change_log: str = "", created_by: str = "") -> bool:
        """插入或更新文档元数据（幂等，自动递增版本）"""
        if not self.available:
            return False
        conn = _get_connection()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                # 检查是否存在
                cur.execute(
                    "SELECT version FROM documents WHERE document_id = %s",
                    (doc_id,))
                row = cur.fetchone()
                if row:
                    # 更新：递增版本
                    new_version = row[0] + 1
                    # 存档旧版本
                    old_path = ""
                    cur.execute(
                        "SELECT content_path FROM documents WHERE document_id = %s",
                        (doc_id,))
                    old_row = cur.fetchone()
                    if old_row:
                        old_path = old_row[0] or ""
                    if old_path:
                        cur.execute(
                            """INSERT INTO document_versions
                               (document_id, version, content_path, change_log, created_by)
                               VALUES (%s, %s, %s, %s, %s)""",
                            (doc_id, row[0], old_path, change_log, created_by or source_agent))
                    # 更新主表
                    cur.execute(
                        """UPDATE documents SET
                           title=%s, content_path=%s, file_type=%s,
                           author=%s, source_agent=%s, physical_user=%s,
                           category=%s, tags=%s, project_id=%s, language=%s,
                           life_stage=%s, outcome=%s, confidence=%s,
                           total_chunks=%s, version=%s,
                           metadata=%s, updated_at=NOW()
                           WHERE document_id=%s""",
                        (title, content_path, file_type,
                         author, source_agent, physical_user,
                         category, json.dumps(tags or []), project_id, language,
                         life_stage, outcome, confidence,
                         total_chunks, new_version,
                         json.dumps(metadata or {}),
                         doc_id))
                else:
                    # 插入新记录
                    cur.execute(
                        """INSERT INTO documents
                           (document_id, title, content_path, file_type,
                            author, source_agent, physical_user,
                            category, tags, project_id, language,
                            life_stage, outcome, confidence,
                            total_chunks, version, metadata,
                            created_at, updated_at)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s,
                                   %s, %s, %s, %s, %s, %s, 1, %s, NOW(), NOW())""",
                        (doc_id, title, content_path, file_type,
                         author, source_agent, physical_user,
                         category, json.dumps(tags or []), project_id, language,
                         life_stage, outcome, confidence,
                         total_chunks,
                         json.dumps(metadata or {})))
            conn.commit()
            return True
        except Exception as e:
            conn.rollback()
            logger.error(f"MetaStore put_document 失败 ({doc_id}): {e}")
            return False
        finally:
            _put_conn(conn)

    def get_document(self, doc_id: str) -> Optional[dict]:
        """获取文档元数据"""
        if not self.available:
            return None
        conn = _get_connection()
        if not conn:
            return None
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT document_id, title, content_path, file_type,
                              author, source_agent, physical_user,
                              category, tags, project_id, language,
                              life_stage, outcome, confidence,
                              reuse_count, success_count, score,
                              total_chunks, status, version, metadata,
                              created_at, updated_at
                       FROM documents WHERE document_id = %s""",
                    (doc_id,))
                row = cur.fetchone()
                if not row:
                    return None
                return {
                    "document_id": row[0],
                    "title": row[1] or "",
                    "content_path": row[2] or "",
                    "file_type": row[3] or "json",
                    "author": row[4] or "",
                    "source_agent": row[5] or "",
                    "physical_user": row[6] or "",
                    "category": row[7] or "",
                    "tags": row[8] if row[8] else [],
                    "project_id": row[9] or "",
                    "language": row[10] or "简体中文",
                    "life_stage": row[11] or "memory",
                    "outcome": row[12] or "success",
                    "confidence": float(row[13]) if row[13] is not None else 1.0,
                    "reuse_count": row[14] or 0,
                    "success_count": row[15] or 0,
                    "score": float(row[16]) if row[16] is not None else 1.0,
                    "total_chunks": row[17] or 1,
                    "status": row[18] or "active",
                    "version": row[19] or 1,
                    "metadata": row[20] if row[20] else {},
                    "created_at": row[21].isoformat() if row[21] else "",
                    "updated_at": row[22].isoformat() if row[22] else "",
                }
        except Exception as e:
            logger.error(f"MetaStore get_document 失败 ({doc_id}): {e}")
            return None
        finally:
            _put_conn(conn)

    def update_lifecycle(self, doc_id: str, life_stage: str,
                         confidence: Optional[float] = None,
                         evidence: str = "") -> bool:
        """更新生命周期状态"""
        if not self.available:
            return False
        conn = _get_connection()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                sets = ["life_stage = %s", "updated_at = NOW()"]
                params = [life_stage]
                if confidence is not None:
                    sets.append("confidence = %s")
                    params.append(confidence)
                if evidence:
                    sets.append("metadata = jsonb_set(COALESCE(metadata, '{}'), '{evidence}', %s)")
                    params.append(json.dumps(evidence))
                params.append(doc_id)
                cur.execute(
                    f"UPDATE documents SET {', '.join(sets)} WHERE document_id = %s",
                    params)
            conn.commit()
            return cur.rowcount > 0
        except Exception as e:
            conn.rollback()
            logger.error(f"MetaStore update_lifecycle 失败 ({doc_id}): {e}")
            return False
        finally:
            _put_conn(conn)

    def mark_reused(self, doc_id: str, success: bool = True,
                    feedback: str = "") -> bool:
        """标记复用"""
        if not self.available:
            return False
        conn = _get_connection()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                if success:
                    cur.execute(
                        """UPDATE documents SET
                           reuse_count = reuse_count + 1,
                           success_count = success_count + 1,
                           score = LEAST(1.0, score + 0.05),
                           updated_at = NOW()
                           WHERE document_id = %s""",
                        (doc_id,))
                else:
                    cur.execute(
                        """UPDATE documents SET
                           reuse_count = reuse_count + 1,
                           score = GREATEST(0.1, score - 0.05),
                           updated_at = NOW()
                           WHERE document_id = %s""",
                        (doc_id,))
                if feedback:
                    cur.execute(
                        """UPDATE documents SET
                           metadata = jsonb_set(COALESCE(metadata, '{}'), '{last_feedback}', %s)
                           WHERE document_id = %s""",
                        (json.dumps(feedback), doc_id))
            conn.commit()
            return cur.rowcount > 0
        except Exception as e:
            conn.rollback()
            logger.error(f"MetaStore mark_reused 失败 ({doc_id}): {e}")
            return False
        finally:
            _put_conn(conn)

    def delete_document(self, doc_id: str) -> bool:
        """软删除：将状态设为 archived"""
        if not self.available:
            return False
        conn = _get_connection()
        if not conn:
            return False
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE documents SET status='archived', updated_at=NOW() WHERE document_id=%s",
                    (doc_id,))
            conn.commit()
            return cur.rowcount > 0
        except Exception as e:
            conn.rollback()
            logger.error(f"MetaStore delete_document 失败 ({doc_id}): {e}")
            return False
        finally:
            _put_conn(conn)

    def list_documents(self, status: str = "active", category: str = "",
                       project_id: str = "", limit: int = 100,
                       offset: int = 0) -> list[dict]:
        """查询文档列表"""
        if not self.available:
            return []
        conn = _get_connection()
        if not conn:
            return []
        try:
            conditions = ["status = %s"]
            params = [status]
            if category:
                conditions.append("category = %s")
                params.append(category)
            if project_id:
                conditions.append("project_id = %s")
                params.append(project_id)
            where = " AND ".join(conditions)
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT document_id, title, category, tags, "
                    f"life_stage, status, version, "
                    f"reuse_count, success_count, score, "
                    f"created_at, updated_at "
                    f"FROM documents WHERE {where} "
                    f"ORDER BY updated_at DESC LIMIT %s OFFSET %s",
                    params + [limit, offset])
                rows = cur.fetchall()
                return [
                    {
                        "document_id": r[0],
                        "title": r[1] or "",
                        "category": r[2] or "",
                        "tags": r[3] if r[3] else [],
                        "life_stage": r[4] or "memory",
                        "status": r[5] or "active",
                        "version": r[6] or 1,
                        "reuse_count": r[7] or 0,
                        "success_count": r[8] or 0,
                        "score": float(r[9]) if r[9] is not None else 1.0,
                        "created_at": r[10].isoformat() if r[10] else "",
                        "updated_at": r[11].isoformat() if r[11] else "",
                    }
                    for r in rows
                ]
        except Exception as e:
            logger.error(f"MetaStore list_documents 失败: {e}")
            return []
        finally:
            _put_conn(conn)

    def get_versions(self, doc_id: str, limit: int = 20) -> list[dict]:
        """获取文档历史版本"""
        if not self.available:
            return []
        conn = _get_connection()
        if not conn:
            return []
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT id, document_id, version, content_path,
                              change_log, created_by, created_at
                       FROM document_versions
                       WHERE document_id = %s
                       ORDER BY version DESC LIMIT %s""",
                    (doc_id, limit))
                return [
                    {
                        "id": r[0],
                        "document_id": r[1],
                        "version": r[2],
                        "content_path": r[3] or "",
                        "change_log": r[4] or "",
                        "created_by": r[5] or "",
                        "created_at": r[6].isoformat() if r[6] else "",
                    }
                    for r in cur.fetchall()
                ]
        except Exception as e:
            logger.error(f"MetaStore get_versions 失败 ({doc_id}): {e}")
            return []
        finally:
            _put_conn(conn)

    def get_stats(self) -> dict:
        """获取元数据统计"""
        if not self.available:
            return {"available": False}
        conn = _get_connection()
        if not conn:
            return {"available": False}
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT status, COUNT(*) FROM documents GROUP BY status")
                status_counts = {r[0]: r[1] for r in cur.fetchall()}
                cur.execute("SELECT COUNT(*) FROM document_versions")
                version_count = cur.fetchone()[0]
                return {
                    "available": True,
                    "total_documents": sum(status_counts.values()),
                    "status_counts": status_counts,
                    "total_versions": version_count,
                }
        except Exception as e:
            logger.error(f"MetaStore get_stats 失败: {e}")
            return {"available": False, "error": str(e)}
        finally:
            _put_conn(conn)


# 全局单例
_metastore: Optional[MetaStore] = None
_metastore_lock = threading.Lock()


def get_metastore() -> MetaStore:
    """获取 MetaStore 单例"""
    global _metastore
    if _metastore is None:
        with _metastore_lock:
            if _metastore is None:
                _metastore = MetaStore()
    return _metastore
