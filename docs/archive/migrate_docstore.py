#!/usr/bin/env python3
"""docstore 迁移工具：将扁平目录迁移为 content/ + meta/ + index.json 三层结构

用法:
  python3 migrate_docstore.py                      # 迁移默认路径
  python3 migrate_docstore.py /path/to/docstore    # 指定路径
  python3 migrate_docstore.py --dry-run            # 仅预览，不执行
"""
import json
import os
import sys
import re
from pathlib import Path


def slugify(title: str) -> str:
    slug = title.lower()
    slug = re.sub(r'[^\w\u4e00-\u9fff]+', '-', slug)
    return slug.strip('-')[:80]


def migrate(docstore_path: Path, dry_run: bool = False) -> dict:
    content_dir = docstore_path / "content"
    meta_dir = docstore_path / "meta"
    index_path = docstore_path / "index.json"

    stats = {
        "md_main": 0,
        "json_main": 0,
        "chunk_md": 0,
        "chunk_json": 0,
        "index_entries": 0,
    }
    title_index: dict[str, dict] = {}

    # 加载现有索引（如果存在）
    if index_path.exists():
        try:
            title_index = json.loads(index_path.read_text(encoding='utf-8'))
        except Exception:
            title_index = {}

    files = sorted(os.listdir(docstore_path))

    for fname in files:
        fpath = docstore_path / fname
        if not fpath.is_file():
            continue

        # 跳过已存在的子目录和索引
        if fname in ("content", "meta", "index.json"):
            continue

        is_md = fname.endswith(".md")
        is_json = fname.endswith(".json")
        if not is_md and not is_json:
            stats["orphan_" + fname.rsplit(".", 1)[-1]] = \
                stats.get("orphan_" + fname.rsplit(".", 1)[-1], 0) + 1
            continue

        is_chunk = "_c" in fname and ("c0000" in fname or re.search(r'_c\d{4}\.', fname))
        doc_id = fname[:-3] if is_md else fname[:-5]

        # 如果是主 json（非分块），在移动前先提取标题
        title_for_index = None
        cat_for_index = ""
        stage_for_index = ""
        if is_json and not is_chunk:
            try:
                meta = json.loads(fpath.read_text(encoding='utf-8'))
                title_for_index = meta.get("title", "")
                cat_for_index = meta.get("category", "")
                stage_for_index = meta.get("life_stage", "")
            except Exception:
                pass

        if is_md:
            target_dir = content_dir
            stats["chunk_md" if is_chunk else "md_main"] += 1
        else:
            target_dir = meta_dir
            stats["chunk_json" if is_chunk else "json_main"] += 1

        target_path = target_dir / fname

        if not dry_run:
            target_dir.mkdir(parents=True, exist_ok=True)
            fpath.rename(target_path)

        # 写入索引
        if title_for_index:
            slug = slugify(title_for_index)
            title_index[slug] = {
                "id": doc_id,
                "title": title_for_index,
                "category": cat_for_index,
                "life_stage": stage_for_index,
            }
            stats["index_entries"] += 1

    if not dry_run:
        # 写索引
        index_path.write_text(
            json.dumps(title_index, ensure_ascii=False, indent=2),
            encoding='utf-8')
        stats["index_written"] = len(title_index)

    return stats


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    paths = [a for a in sys.argv[1:] if not a.startswith("--")]

    if paths:
        for p in paths:
            sp = Path(p)
            print(f"\n=== {'[DRY RUN]' if dry_run else ''} 迁移: {sp} ===")
            stats = migrate(sp, dry_run=dry_run)
            for k, v in stats.items():
                print(f"  {k}: {v}")
    else:
        # 默认路径
        candidates = [
            Path("/home/as-workstation01/cerebrate-data/docstore"),
            Path("/data/docstore"),
            Path("./data/docstore"),
            Path("./cerebrate_data/docstore"),
        ]
        for sp in candidates:
            if sp.exists():
                print(f"\n=== {'[DRY RUN]' if dry_run else ''} 迁移: {sp} ===")
                stats = migrate(sp, dry_run=dry_run)
                for k, v in stats.items():
                    print(f"  {k}: {v}")
                break
        else:
            print("❌ 未找到 docstore 目录，请手动指定路径")
            sys.exit(1)

    if dry_run:
        print("\n✅ 预览完成。去掉 --dry-run 执行实际迁移。")
    else:
        print("\n✅ 迁移完成。")
