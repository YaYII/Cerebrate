"""数据迁移工具 — ChromaDB 内部 reindex。

用法:
    python3 cerebrate.py migrate              # 重建所有 collection 索引
    python3 cerebrate.py migrate --dry-run    # 预览不执行
    python3 cerebrate.py migrate --swarm-only # 仅重建虫群
"""

from datetime import datetime, timezone

from cerebrate.config import config
from cerebrate.core.embedding import get_embedding_engine
from cerebrate.core.storage import ChromaStore


def _migrate_collection(collection_name: str, dry_run: bool) -> int:
    """将 collection 内的所有文档用当前 embedding 模式重新索引。
    本质是读旧 doc → 删旧 → 用当前 engine 写回，消除 hash/bge 切换时的模式漂移。
    """
    engine = get_embedding_engine(config.embedding_model, config.embedding_device)
    store = ChromaStore(config.chroma_path, collection_name, engine)

    ids = store.get_all_ids()
    if not ids:
        return 0

    # 先取出全部文档
    docs = []
    for doc_id in ids:
        item = store.get(doc_id)
        if item:
            docs.append((doc_id, item.get("metadata", {}), item.get("document", "")))

    if not docs:
        return 0

    if dry_run:
        return len(docs)

    # 删除旧 collection 然后用当前 engine 重建
    import chromadb
    client = chromadb.PersistentClient(
        path=str(config.chroma_path),
        settings=chromadb.Settings(anonymized_telemetry=False),
    )
    try:
        client.delete_collection(store.collection_name)
    except Exception:
        pass

    # 重新创建
    store = ChromaStore(config.chroma_path, collection_name, engine)
    for doc_id, meta, document in docs:
        store.upsert(doc_id, document, meta)

    return len(docs)


def migrate_swarm(dry_run: bool = False) -> int:
    return _migrate_collection("swarm_memories", dry_run)


def migrate_knowledge(dry_run: bool = False) -> int:
    return _migrate_collection("knowledge_base", dry_run)


def migrate_personal(dry_run: bool = False) -> int:
    return _migrate_collection("personal_memories", dry_run)


def migrate_all(dry_run: bool = False) -> dict:
    results = {
        "swarm": migrate_swarm(dry_run),
        "knowledge": migrate_knowledge(dry_run),
        "personal": migrate_personal(dry_run),
    }
    return results


def reindex_from_seeds(dry_run: bool = False) -> dict:
    """reindex: 直接对 swarm_memories 做一次读-删-写周期，用当前 embedding 模式重建。"""
    return {"reindexed": migrate_swarm(dry_run), "embedding_mode": get_embedding_engine().mode, "dry_run": dry_run}


def export_seeds() -> dict:
    """v5 不再需要导出 JSONL 种子——所有数据在 ChromaDB 中。
    用 `migrate` 做 reindex 即可，不需要文件中间层。
    """
    return {"message": "v5: 数据已在 ChromaDB。用 migrate --reindex 重建索引即可。", "exported": 0}
