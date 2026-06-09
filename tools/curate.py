#!/usr/bin/env python3
"""脑虫知识修剪器 (Cerebrate Curator)

核心职能:
  不是"再写一条新知识"，而是"维护已有知识文件系统"。
  扫描 content/ 目录，用 LLM 判断哪些文件需要修剪:
    - 重复内容 → 合并
    - 过时内容 → 归档
    - 矛盾内容 → 标记待人工
    - 空/碎片 → 删除

用法:
  python3 tools/curate.py                  # 全面修剪
  python3 tools/curate.py --dry-run         # 仅预览不执行
  python3 tools/curate.py --topic docker    # 只修剪 docker 相关
"""
import json
import logging
import os
import re
import sys
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── 设置 cerebrate 路径 ──
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cerebrate.config import config
from cerebrate.memory.manager import MemoryManager
from cerebrate.memory.docstore import DocumentStore
from cerebrate.brain.llm import CerebrateLLM

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("curator")

WRITE_LOCK = threading.Lock()


def _read_content_files(docstore: DocumentStore) -> list[dict]:
    """扫描所有 content/ 文件，返回 {id, title, type, content, path}"""
    files = []
    for t in ["memory", "skill", "evolution"]:
        content_dir = docstore._type_dirs[t]["content"]
        meta_dir = docstore._type_dirs[t]["meta"]
        if not content_dir.exists():
            continue
        for fname in sorted(os.listdir(content_dir)):
            if not fname.endswith(".md") or "_c" in fname:
                continue  # 跳过 chunk
            doc_id = fname[:-3]
            meta_path = meta_dir / f"{doc_id}.json"
            meta = {}
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding='utf-8'))
                except Exception:
                    pass
            content = (content_dir / fname).read_text(encoding='utf-8')
            files.append({
                "id": doc_id,
                "title": meta.get("title", doc_id),
                "type": t,
                "content": content,
                "content_path": content_dir / fname,
                "meta_path": meta_path,
                "life_stage": meta.get("life_stage", ""),
                "category": meta.get("category", ""),
                "created": meta.get("created", ""),
                "reuse_count": int(meta.get("reuse_count", 0)),
                "confidence": float(meta.get("confidence", 1.0) or 1.0),
            })
    return files


def _find_overlapping_groups(files: list[dict], threshold: float = 0.75) -> list[list[dict]]:
    """用 BGE embedding 找语义相似的内容组。"""
    if len(files) < 2:
        return []

    from cerebrate.core.embedding import get_embedding_engine
    engine = get_embedding_engine()

    embeddings = {}
    for f in files:
        try:
            text = f"{f['title']}\n{f['content'][:1000]}"
            emb = engine.encode_query(text)
            embeddings[f["id"]] = emb
        except Exception:
            pass

    if len(embeddings) < 2:
        return []

    groups = []
    processed = set()
    ids = list(embeddings.keys())
    id_to_file = {f["id"]: f for f in files}

    for i, id1 in enumerate(ids):
        if id1 in processed:
            continue
        group = [id_to_file[id1]]
        for id2 in ids[i + 1:]:
            if id2 in processed:
                continue
            emb1 = embeddings[id1]
            emb2 = embeddings[id2]
            sim = sum(a * b for a, b in zip(emb1, emb2))
            if sim >= threshold:
                group.append(id_to_file[id2])
                processed.add(id2)
        if len(group) >= 2:
            groups.append(group)
        processed.add(id1)

    return groups


def _llm_judge(group: list[dict], dry_run: bool = False) -> Optional[dict]:
    """让 LLM 判断一组相似文件应该如何修剪。"""
    llm = CerebrateLLM()
    if not llm.is_available():
        return None

    docs = []
    for i, f in enumerate(group):
        docs.append(
            f"[文档 {i+1}] ID={f['id'][:12]} 类型={f['type']} "
            f"标题={f['title']}\n"
            f"内容摘要: {f['content'][:800]}...\n"
        )

    prompt = f"""你是一位经验丰富的知识库管理员 (Knowledge Curator)。你的职责是**修剪**已有知识文档，消除冗余、过时、矛盾的内容。

以下是 {len(group)} 篇关于同一主题的知识文档。请分析它们的关系，并决定如何修剪：

{chr(10).join(docs)}

请返回 JSON，格式如下:

```json
{{
  "judgment": "merge | supersede | keep_separate | flag_contradiction",
  "reason": "判断的详细理由",
  "keeper_index": 0,
  "merger_content": "如果选择 merge，这里写入合并后的全文（含两篇所有技术细节，用 Markdown 格式）",
  "merger_title": "合并后的新标题",
  "to_archive_indexes": [1],
  "notes": "其他说明"
}}
```

判断标准:
- merge: 内容高度重叠，合并为一份更完整文档 → 提供 merger_content（合并全文）
- supersede: 一篇完全覆盖另一篇 → 指定 keeper_index 和 to_archive_indexes
- keep_separate: 各有独立价值，保留全部
- flag_contradiction: 存在矛盾且不能统一 → 保留全部，但标注意见

只返回 JSON，不要其他文字。"""

    try:
        client = llm._get_client()
        is_thinking = llm._is_thinking_model
        kwargs = {
            "model": llm._model,
            "messages": [{"role": "user", "content": prompt}],
        }
        if not is_thinking:
            kwargs["max_tokens"] = 4096
            kwargs["temperature"] = 0.1
        else:
            kwargs["max_tokens"] = 65536
            if "v4-pro" in llm._model:
                kwargs.update(llm._deepseek_thinking_kwargs())

        if llm._provider == "anthropic":
            from anthropic import Anthropic
            response = client.messages.create(**kwargs)
            text = response.content[0].text if response.content else ""
        else:
            response = client.chat.completions.create(**kwargs)
            text = response.choices[0].message.content if response.choices else ""

        match = re.search(r'\{[\s\S]*\}', text)
        if match:
            result = json.loads(match.group())
            result["group"] = group
            return result
    except Exception as e:
        log.warning(f"  LLM 判断异常: {e}")
    return None


def _execute_judgment(judgment: dict, archive_dir: Path, dry_run: bool = False) -> dict:
    """执行 LLM 的修剪判断，操作文件系统。"""
    action = judgment.get("judgment", "keep_separate")
    group = judgment.get("group", [])
    result = {
        "action": action,
        "reason": judgment.get("reason", ""),
        "affected": [f["id"][:12] for f in group],
        "deleted": [],
        "archived": [],
        "merged": None,
    }

    if action == "keep_separate" or action == "flag_contradiction":
        result["note"] = "保留全部"
        return result

    keeper_idx = judgment.get("keeper_index", 0)
    to_archive = judgment.get("to_archive_indexes", [])
    keeper = None
    victims = []

    for i, f in enumerate(group):
        if i == keeper_idx:
            keeper = f
        elif i in to_archive:
            victims.append(f)

    if action == "merge" and keeper:
        merger_title = judgment.get("merger_title", keeper["title"])
        merger_content = judgment.get("merger_content", "")
        if merger_content:
            # 写合并后的文件
            if not dry_run:
                keeper["content_path"].write_text(merger_content, encoding='utf-8')
                if keeper["meta_path"].exists():
                    meta = json.loads(keeper["meta_path"].read_text(encoding='utf-8'))
                    meta["title"] = merger_title
                    meta["merged_from"] = ",".join([f["id"] for f in group if f["id"] != keeper["id"]])
                    keeper["meta_path"].write_text(
                        json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')
            result["merged"] = keeper["id"][:12]
            result["merger_title"] = merger_title

    # 归档被淘汰的文件
    for victim in victims:
        if dry_run:
            result["archived"].append(victim["id"][:12])
            continue
        # 移动到 archive/ 子目录
        v_type = victim["type"]
        v_archive = archive_dir / v_type
        v_archive.mkdir(parents=True, exist_ok=True)

        # move .md
        src_md = victim["content_path"]
        if src_md.exists():
            dst = v_archive / src_md.name
            shutil.move(str(src_md), str(dst))
            result["archived"].append(victim["id"][:12])

        # move .json
        src_json = victim["meta_path"]
        if src_json.exists():
            dst = v_archive / src_json.name
            shutil.move(str(src_json), str(dst))

    return result


def curate(dry_run: bool = False, topic_filter: Optional[str] = None) -> dict:
    """执行一次全面知识修剪。"""
    mm = MemoryManager(config.personal_path, config.swarm_path, config.knowledge_path)
    docstore = mm.swarm._docstore
    archive_dir = docstore.storage_path / "_archive"

    log.info(f"{'[DRY RUN] ' if dry_run else ''}🧹 脑虫知识修剪器启动")
    log.info(f"归档目录: {archive_dir}")

    # 1. 读取所有文件
    all_files = _read_content_files(docstore)
    if topic_filter:
        kw = topic_filter.lower()
        all_files = [f for f in all_files if kw in f["title"].lower() or kw in f["content"][:200].lower()]

    log.info(f"扫描文件: {len(all_files)} 个")

    # 2. 找语义重叠组
    groups = _find_overlapping_groups(all_files, threshold=0.78)
    log.info(f"发现重叠组: {len(groups)} 组")

    if not groups:
        log.info("✅ 无可修剪内容")
        return {"groups_found": 0, "actions": []}

    # 3. 对每组并行 LLM 判断
    all_actions = []
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(_llm_judge, g, dry_run): g for g in groups}
        for future in as_completed(futures):
            group = futures[future]
            try:
                judgment = future.result()
                if judgment:
                    action = _execute_judgment(judgment, archive_dir, dry_run)
                    all_actions.append(action)
                    titles = [f["title"][:30] for f in group]
                    if action["action"] == "merge":
                        log.info(f"  🔗 合并: {titles} → {action.get('merger_title','')[:30]}")
                    elif action["action"] == "supersede":
                        log.info(f"  📦 归档: {[titles[i] for i in judgment.get('to_archive_indexes',[])]} (被 {titles[judgment.get('keeper_index',0)]} 覆盖)")
                    elif action["action"] == "keep_separate":
                        log.info(f"  ✅ 保留: {titles}")
                    elif action["action"] == "flag_contradiction":
                        log.info(f"  ⚠️  矛盾: {titles}")
            except Exception as e:
                log.warning(f"  ❌ 处理异常: {e}")

    # 4. 记录日志
    try:
        from cerebrate.brain.logger import get_logger
        cl = get_logger()
        cl.info("curator", "curate",
                f"修剪完成: 扫描{len(all_files)}文件, {len(groups)}组合并",
                details={"dry_run": dry_run, "actions": len(all_actions),
                         "merged": sum(1 for a in all_actions if a["action"]=="merge"),
                         "archived": sum(1 for a in all_actions if a["action"]=="supersede")})
    except Exception:
        pass

    # 5. 重建 index
    if not dry_run:
        _rebuild_index(docstore)

    log.info(f"{'[DRY RUN] ' if dry_run else ''}🧹 修剪完成: {len(all_actions)} 次操作")
    return {
        "groups_found": len(groups),
        "actions": all_actions,
        "dry_run": dry_run,
    }


def _rebuild_index(docstore: DocumentStore):
    """修剪后重建 index.json。"""
    import re as _re
    index = {}
    for t in ["memory", "skill", "evolution"]:
        meta_dir = docstore._type_dirs[t]["meta"]
        if not meta_dir.exists():
            continue
        for fname in os.listdir(meta_dir):
            if not fname.endswith(".json") or "_c" in fname:
                continue
            doc_id = fname[:-5]
            try:
                meta = json.loads((meta_dir / fname).read_text(encoding='utf-8'))
                title = meta.get("title", "")
                if title:
                    slug = title.lower()
                    slug = _re.sub(r'[^\w\u4e00-\u9fff]+', '-', slug)[:80]
                    index[slug] = {
                        "id": doc_id,
                        "title": title,
                        "type": t,
                        "category": meta.get("category", ""),
                        "life_stage": meta.get("life_stage", ""),
                    }
            except Exception:
                pass
    docstore._title_index = index
    docstore._save_index()
    log.info(f"索引重建: {len(index)} 条")


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    topic = None
    for arg in sys.argv[1:]:
        if arg.startswith("--topic="):
            topic = arg.split("=", 1)[1]
        elif arg.startswith("--topic"):
            topic = True

    result = curate(dry_run=dry_run, topic_filter=topic)
    print(json.dumps(result, indent=2, ensure_ascii=False))
