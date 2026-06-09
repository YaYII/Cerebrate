#!/usr/bin/env python3
"""docstore 迁移 v2: 将扁平/单层目录迁移为 memory/skill/evolution 三层子目录

迁移步骤:
  1. 扫描 docstore/ 下所有文件
  2. 读取每个 .json 元数据，提取 life_stage / category
  3. 按类型映射到 memory/ / skill/ / evolution/ 子目录
  4. 更新 index.json

用法:
  python3 tools/migrate_docstore_v2.py
  python3 tools/migrate_docstore_v2.py --dry-run
"""
import json
import os
import re
import sys
from pathlib import Path

from cerebrate.memory.docstore import doc_type_for


def slugify(title: str) -> str:
    slug = title.lower()
    slug = re.sub(r'[^\w\u4e00-\u9fff]+', '-', slug)
    return slug.strip('-')[:80]


def migrate(docstore_path: Path, dry_run: bool = False) -> dict:
    content_dirs = {
        "memory": docstore_path / "memory" / "content",
        "skill": docstore_path / "skill" / "content",
        "evolution": docstore_path / "evolution" / "content",
    }
    meta_dirs = {
        "memory": docstore_path / "memory" / "meta",
        "skill": docstore_path / "skill" / "meta",
        "evolution": docstore_path / "evolution" / "meta",
    }

    # 旧路径（兼容扫描）
    old_flat = docstore_path
    old_content = docstore_path / "content"
    old_meta = docstore_path / "meta"

    stats = {
        "moved_md": 0,
        "moved_json": 0,
        "skipped_chunk_md": 0,
        "skipped_chunk_json": 0,
        "index_entries": 0,
        "errors": 0,
    }
    index = {}

    # 收集所有文件
    all_files = []
    for d in [old_flat, old_content, old_meta]:
        if d.exists():
            for fname in sorted(os.listdir(d)):
                fpath = d / fname
                if fpath.is_file():
                    all_files.append((d, fname))

    for srcdir, fname in all_files:
        if fname in ("content", "meta", "index.json"):
            continue

        is_md = fname.endswith(".md")
        is_json = fname.endswith(".json")
        if not is_md and not is_json:
            continue

        doc_id = fname[:-3] if is_md else fname[:-5]
        is_chunk = bool(re.search(r'_c\d{4}\.', fname))

        # 确定类型
        doc_type = "memory"
        if is_json:
            try:
                meta = json.loads((srcdir / fname).read_text(encoding='utf-8'))
                life_stage = meta.get("life_stage", "") or meta.get("_life_stage", "")
                cat = meta.get("category", "")
                if life_stage:
                    doc_type = doc_type_for(life_stage)
                elif cat in ("distilled_skill", "doctrine"):
                    doc_type = doc_type_for(cat)

                # 提取标题索引
                title = meta.get("title", "")
                if title and not is_chunk:
                    slug = slugify(title)
                    index[slug] = {
                        "id": doc_id,
                        "title": title,
                        "type": doc_type,
                        "category": cat,
                        "life_stage": life_stage,
                    }
                    stats["index_entries"] += 1
            except Exception:
                stats["errors"] += 1
                doc_type = "memory"

        if is_md:
            target_dir = content_dirs[doc_type]
            stats["skipped_chunk_md" if is_chunk else "moved_md"] += 1
        else:
            target_dir = meta_dirs[doc_type]
            stats["skipped_chunk_json" if is_chunk else "moved_json"] += 1

        src_path = srcdir / fname
        dst_path = target_dir / fname

        if not dry_run:
            target_dir.mkdir(parents=True, exist_ok=True)
            # 如果目标已存在则跳过（避免覆盖已迁移的）
            if not dst_path.exists():
                src_path.rename(dst_path)
            elif src_path.exists():
                # 目标已有但源还在，可能是重复迁移尝试，删除源
                src_path.unlink()

    # 写索引
    if not dry_run:
        index_path = docstore_path / "index.json"
        index_path.write_text(
            json.dumps(index, ensure_ascii=False, indent=2),
            encoding='utf-8')
        stats["index_written"] = len(index)

    return stats


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv

    candidates = [
        Path("/home/as-workstation01/cerebrate-data/docstore"),
        Path("/data/docstore"),
        Path("./data/docstore"),
    ]

    for sp in candidates:
        if sp.exists():
            print(f"{'[DRY RUN]' if dry_run else ''} 迁移: {sp}")
            # 先检查是否有待迁移的扁平文件
            flat_count = 0
            for d in [sp, sp / "content", sp / "meta"]:
                if d.exists():
                    for f in os.listdir(d):
                        if f.endswith(".md") or f.endswith(".json"):
                            if f not in ("content", "meta", "index.json"):
                                flat_count += 1
            print(f"  待处理文件: {flat_count}")

            stats = migrate(sp, dry_run=dry_run)
            for k, v in stats.items():
                print(f"  {k}: {v}")

            if not dry_run:
                print("\n✅ 迁移完成")
                # 显示新目录结构
                for t in ("memory", "skill", "evolution"):
                    td = sp / t / "content"
                    if td.exists():
                        cnt = len(os.listdir(td))
                        print(f"  {t}/: {cnt} 文件")
            else:
                print("\n✅ 预览完成。去掉 --dry-run 执行迁移")
            break
    else:
        print("❌ 未找到 docstore 目录")
        sys.exit(1)
