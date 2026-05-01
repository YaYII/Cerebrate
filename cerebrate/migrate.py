"""数据迁移工具 — JSON 文件 → ChromaDB 向量数据库

用法:
    python3 cerebrate.py migrate           # 迁移所有记忆
    python3 cerebrate.py migrate --dry-run # 预览不执行
    python3 cerebrate.py migrate --swarm-only  # 仅迁移虫群
"""
import json
from datetime import datetime, timezone
from pathlib import Path

from .config import config
from .embedding import get_embedding_engine


def migrate_swarm(dry_run: bool = False) -> int:
    """迁移虫群记忆 JSON → ChromaDB"""
    from .storage.chroma_store import ChromaStore
    engine = get_embedding_engine(config.embedding_model, config.embedding_device)
    store = ChromaStore(config.chroma_path, "swarm_memories", engine)

    swarm_dir = config.swarm_path
    if not swarm_dir.exists():
        return 0

    json_files = sorted(swarm_dir.glob("*.json"))
    # 排除索引文件
    json_files = [f for f in json_files if not f.name.startswith("_")]
    count = 0

    for f in json_files:
        try:
            mem = json.loads(f.read_text())
        except Exception:
            continue

        mid = mem.get("memory_id", f.stem)
        # 检查是否已存在
        if store.get(mid):
            continue

        text = f"{mem.get('title','')}\n{mem.get('content','')}\n{mem.get('problem_solved','')}\n{mem.get('solution','')}"
        metadata = {
            "title": mem.get("title", ""),
            "content": mem.get("content", ""),
            "category": mem.get("category", ""),
            "tags": ",".join(mem.get("tags", [])) if isinstance(mem.get("tags"), list) else mem.get("tags", ""),
            "source_agent": mem.get("source_agent", "unknown"),
            "problem_solved": mem.get("problem_solved", ""),
            "solution": mem.get("solution", ""),
            "outcome": mem.get("outcome", "success"),
            "project_id": mem.get("project_id", ""),
            "language": mem.get("language", ""),
            "score": mem.get("confidence", 1.0),
            "reuse_count": mem.get("reuse_count", 0),
            "success_count": mem.get("success_count", 0),
            "created": mem.get("created", ""),
            "updated": mem.get("updated", ""),
        }

        if not dry_run:
            store.add(mid, text, metadata)
        count += 1

    return count


def migrate_knowledge(dry_run: bool = False) -> int:
    """迁移知识库文档 JSON → ChromaDB"""
    from .storage.chroma_store import ChromaStore
    engine = get_embedding_engine(config.embedding_model, config.embedding_device)
    store = ChromaStore(config.chroma_path, "knowledge_base", engine)

    kb_dir = config.knowledge_path
    if not kb_dir.exists():
        return 0

    json_files = sorted(kb_dir.glob("*.json"))
    json_files = [f for f in json_files if not f.name.startswith("_")]
    count = 0

    for f in json_files:
        try:
            doc = json.loads(f.read_text())
        except Exception:
            continue

        did = doc.get("doc_id", f.stem)
        if store.get(did):
            continue

        text = f"{doc.get('title','')}\n{doc.get('content','')}"
        metadata = {
            "title": doc.get("title", ""),
            "content": doc.get("content", ""),
            "source": doc.get("source", ""),
            "version": doc.get("version", ""),
            "author": doc.get("author", ""),
            "topics": ",".join(doc.get("topics", [])) if isinstance(doc.get("topics"), list) else doc.get("topics", ""),
            "is_policy": str(doc.get("is_policy", False)),
            "policy_name": doc.get("policy_name", ""),
            "project_id": doc.get("project_id", ""),
            "hash": doc.get("hash", ""),
            "created": doc.get("created", ""),
            "updated": doc.get("updated", ""),
            "access_count": doc.get("access_count", 0),
            "verified": str(doc.get("verified", False)),
            "deprecated": str(doc.get("deprecated", False)),
        }

        if not dry_run:
            store.add(did, text, metadata)
        count += 1

    return count


def migrate_personal(dry_run: bool = False) -> int:
    """迁移个人记忆 JSON → ChromaDB"""
    from .storage.chroma_store import ChromaStore
    engine = get_embedding_engine(config.embedding_model, config.embedding_device)
    store = ChromaStore(config.chroma_path, "personal_memories", engine)

    personal_dir = config.personal_path
    if not personal_dir.exists():
        return 0

    json_files = sorted(personal_dir.glob("*.json"))
    json_files = [f for f in json_files if not f.name.startswith("_")]
    count = 0

    for f in json_files:
        try:
            data = json.loads(f.read_text())
        except Exception:
            continue

        # 文件名格式: {user_id}.json
        user_id = f.stem
        for key, entry in data.items():
            if not isinstance(entry, dict):
                continue
            doc_id = f"{user_id}:{key}"
            if store.get(doc_id):
                continue

            value = entry.get("value", "")
            text = f"{key}: {value}"
            metadata = {
                "user_id": user_id,
                "key": key,
                "value": str(value),
                "confidence": entry.get("confidence", 1.0),
                "updated": entry.get("updated", ""),
                "project_id": entry.get("project_id", ""),
                "access_count": entry.get("access_count", 0),
            }

            if not dry_run:
                store.add(doc_id, text, metadata)
            count += 1

    return count


def migrate_all(dry_run: bool = False) -> dict:
    """迁移全部三层记忆"""
    results = {
        "swarm": migrate_swarm(dry_run),
        "knowledge": migrate_knowledge(dry_run),
        "personal": migrate_personal(dry_run),
    }
    total = sum(results.values())
    return results


def _chroma_client():
    import chromadb
    return chromadb.PersistentClient(
        path=str(config.chroma_path),
        settings=chromadb.Settings(anonymized_telemetry=False),
    )


def _collection_records(collection_name: str) -> list[dict]:
    try:
        collection = _chroma_client().get_collection(collection_name)
    except Exception:
        return []
    data = collection.get(include=["metadatas", "documents"])
    records = []
    ids = data.get("ids") or []
    metadatas = data.get("metadatas") or []
    documents = data.get("documents") or []
    for i, doc_id in enumerate(ids):
        meta = metadatas[i] if i < len(metadatas) else {}
        document = documents[i] if i < len(documents) else ""
        record = dict(meta)
        record["memory_id"] = doc_id
        record["_document"] = document
        record["life_stage"] = record.get("life_stage", "nutrient")
        record["nutrient_score"] = record.get("nutrient_score", 0.6)
        record["confidence"] = record.get("confidence", 0.6)
        records.append(record)
    return records


def export_seeds() -> dict:
    """导出现有 Chroma 虫群记忆为 JSONL 养分种子。"""
    config.seeds_path.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    seed_file = config.seeds_path / f"swarm_nutrients_{stamp}.jsonl"
    seen = set()
    exported = 0
    collections = ["swarm_memories", "swarm_memories_bge", "swarm_memories_hash"]
    with seed_file.open("w", encoding="utf-8") as f:
        for collection_name in collections:
            for record in _collection_records(collection_name):
                mid = record.get("memory_id")
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                record["_source_collection"] = collection_name
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
                exported += 1
    return {"seed_file": str(seed_file), "exported": exported}


def _seed_files() -> list[Path]:
    if not config.seeds_path.exists():
        return []
    return sorted(config.seeds_path.glob("*.jsonl"))


def _load_seed_records() -> list[dict]:
    records = []
    for seed_file in _seed_files():
        for line in seed_file.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def reindex_from_seeds(dry_run: bool = False) -> dict:
    """用当前 embedding 模式从 JSONL 养分种子重建虫群索引。"""
    if not _seed_files():
        export_seeds()

    from .storage.chroma_store import ChromaStore
    engine = get_embedding_engine(config.embedding_model, config.embedding_device)
    store = ChromaStore(config.chroma_path, "swarm_memories", engine)

    indexed = 0
    skipped = 0
    for record in _load_seed_records():
        memory_id = record.get("memory_id")
        if not memory_id:
            skipped += 1
            continue
        if store.get(memory_id):
            skipped += 1
            continue
        text = "\n".join([
            record.get("title", ""),
            record.get("content", ""),
            record.get("problem_solved", ""),
            record.get("solution", ""),
            record.get("evidence", ""),
        ])
        metadata = {
            "title": record.get("title", ""),
            "content": record.get("content", ""),
            "category": record.get("category", "nutrient"),
            "tags": record.get("tags", ""),
            "source_agent": record.get("source_agent", "seed-export"),
            "problem_solved": record.get("problem_solved", ""),
            "solution": record.get("solution", ""),
            "outcome": record.get("outcome", "partial"),
            "project_id": record.get("project_id", ""),
            "language": record.get("language", config.default_language),
            "score": float(record.get("score", 0.6) or 0.6),
            "reuse_count": int(record.get("reuse_count", 0) or 0),
            "success_count": int(record.get("success_count", 0) or 0),
            "life_stage": record.get("life_stage", "nutrient"),
            "nutrient_score": float(record.get("nutrient_score", 0.6) or 0.6),
            "confidence": float(record.get("confidence", 0.6) or 0.6),
            "evidence": record.get("evidence", ""),
            "supersedes": record.get("supersedes", ""),
            "created": record.get("created", datetime.now(timezone.utc).isoformat()),
            "updated": datetime.now(timezone.utc).isoformat(),
        }
        if not dry_run:
            store.add(memory_id, text, metadata)
        indexed += 1
    return {
        "indexed": indexed,
        "skipped": skipped,
        "embedding_mode": store.embedding_mode,
        "seed_files": [str(p) for p in _seed_files()],
        "dry_run": dry_run,
    }
