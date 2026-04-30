"""数据迁移工具 — JSON 文件 → ChromaDB 向量数据库

用法:
    python3 cerebrate.py migrate           # 迁移所有记忆
    python3 cerebrate.py migrate --dry-run # 预览不执行
    python3 cerebrate.py migrate --swarm-only  # 仅迁移虫群
"""
import json
import sys
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
        print("虫群目录不存在，跳过")
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

    print(f"虫群记忆: {count} 条{' (预览)' if dry_run else ' 已迁移'}")
    return count


def migrate_knowledge(dry_run: bool = False) -> int:
    """迁移知识库文档 JSON → ChromaDB"""
    from .storage.chroma_store import ChromaStore
    engine = get_embedding_engine(config.embedding_model, config.embedding_device)
    store = ChromaStore(config.chroma_path, "knowledge_base", engine)

    kb_dir = config.knowledge_path
    if not kb_dir.exists():
        print("知识库目录不存在，跳过")
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

    print(f"知识库文档: {count} 条{' (预览)' if dry_run else ' 已迁移'}")
    return count


def migrate_personal(dry_run: bool = False) -> int:
    """迁移个人记忆 JSON → ChromaDB"""
    from .storage.chroma_store import ChromaStore
    engine = get_embedding_engine(config.embedding_model, config.embedding_device)
    store = ChromaStore(config.chroma_path, "personal_memories", engine)

    personal_dir = config.personal_path
    if not personal_dir.exists():
        print("个人记忆目录不存在，跳过")
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

    print(f"个人记忆: {count} 条{' (预览)' if dry_run else ' 已迁移'}")
    return count


def migrate_all(dry_run: bool = False) -> dict:
    """迁移全部三层记忆"""
    results = {
        "swarm": migrate_swarm(dry_run),
        "knowledge": migrate_knowledge(dry_run),
        "personal": migrate_personal(dry_run),
    }
    total = sum(results.values())
    action = "预览" if dry_run else "迁移"
    print(f"\n{action}完成: 共 {total} 条记忆")
    return results
