#!/usr/bin/env python3
"""脑虫知识修剪器 v3 — LLM 直接输出文件操作

架构:
  不是"LLM 给建议，Python 做决策"，
  而是"LLM 输出文件操作列表，Python 仅机械执行"。

操作原语:
  {"op": "read",    "path": "/data/docstore/memory/content/xxx.md"}
  {"op": "write",   "path": "xxx.md", "content": "完整的 Markdown 内容"}
  {"op": "delete",  "path": "xxx.md"}
  {"op": "archive", "path": "xxx.md"}
  {"op": "move",    "from": "xxx.md", "to": "yyy.md"}

用法:
  python3 tools/curate_v3.py                 # 执行修剪
  python3 tools/curate_v3.py --dry-run       # 仅预览操作列表
  python3 tools/curate_v3.py --topic docker  # 只处理特定主题
"""
import json
import logging
import os
import re
import sys
import shutil
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cerebrate.config import config
from cerebrate.memory.manager import MemoryManager
from cerebrate.brain.llm import CerebrateLLM

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("curator.v3")

# ── 文件系统根 ──
DOCSTORE = Path("/data/docstore")
CONTENT_DIR = DOCSTORE / "memory" / "content"
META_DIR = DOCSTORE / "memory" / "meta"
ARCHIVE_DIR = DOCSTORE / "_archive"


def scan_directory() -> list[dict]:
    """扫描 content 目录，返回文件摘要列表供 LLM 决策。"""
    files = []
    if not CONTENT_DIR.exists():
        return files
    for fname in sorted(os.listdir(CONTENT_DIR)):
        if not fname.endswith(".md") or "_c" in fname:
            continue
        fpath = CONTENT_DIR / fname
        doc_id = fname[:-3]
        size = fpath.stat().st_size

        # 读取元数据
        meta = {}
        meta_path = META_DIR / f"{doc_id}.json"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding='utf-8'))
            except Exception:
                pass

        # 读前 300 字用于 LLM 判断
        content = fpath.read_text(encoding='utf-8')
        preview = content[:300]

        files.append({
            "id": doc_id,
            "filename": fname,
            "title": meta.get("title", doc_id),
            "size_bytes": size,
            "size_kb": round(size / 1024, 1),
            "life_stage": meta.get("life_stage", ""),
            "category": meta.get("category", ""),
            "created": meta.get("created", "")[:10],
            "confidence": meta.get("confidence", ""),
            "preview": preview,
        })
    return files


def build_prompt(files: list[dict], topic_filter: str = "") -> str:
    """构建 LLM prompt，让 LLM 直接输出文件操作列表。"""
    file_list = []
    for f in files:
        file_list.append(
            f"[{f['id'][:12]}] {f['filename']}"
            f" | {f['size_kb']}KB"
            f" | 标题: {f['title'][:50]}"
            f" | 分类: {f.get('category','')}"
            f" | 创建: {f.get('created','')}"
            f" | 预览: {f['preview'][:100].replace(chr(10),' ')}"
        )

    file_summary = "\n".join(file_list)

    return f"""你是脑虫 Cerebrate 的知识库管理员 (Curator)。你的权限：**直接操作文件系统**。

## 当前 content/ 目录

以下是 /data/docstore/memory/content/ 目录下的 {len(files)} 个 .md 文件：

{file_summary}

## 你的任务

分析这些文件，输出一个**文件操作列表**来整理知识库。操作原语只有 5 种：

1. **read** — 读取文件完整内容（用于需要全文判断时）
2. **write** — 写入/覆盖文件（用于合并后的新文档）
3. **delete** — 删除无用碎片
4. **archive** — 归档过时/重复内容（移到 _archive/ 目录，可恢复）
5. **rebuild_index** — 所有操作完成后重建 index.json

## 规则

1. 优先使用 read 获取完整内容后再决策
2. 合并多个文件时用 write 创建合并版，用 archive 归档旧版
3. 明显测试/空内容用 delete 删除
4. 内容相似的多个版本，保留最完整的一个，其余 archive
5. **大文件（>50KB）很可能包含完整知识，优先保留**
6. 每个 op 必须包含完整 path（以 /data/docstore/memory/content/ 开头）

## 输出格式

```json
{{
  "analysis": "你的整体分析",
  "operations": [
    {{"op": "read", "path": "/data/docstore/memory/content/xxx.md"}},
    {{"op": "write", "path": "/data/docstore/memory/content/merged.md",
     "content": "合并后的完整 Markdown 内容"}},
    {{"op": "archive", "path": "/data/docstore/memory/content/old.md"}},
    {{"op": "delete", "path": "/data/docstore/memory/content/test.md"}},
    {{"op": "rebuild_index"}}
  ]
}}
```

直接输出 JSON，不要其他文字。"""


def execute_operations(ops: list[dict], dry_run: bool = False) -> list[dict]:
    """机械执行 LLM 输出的操作列表，不加任何判断。"""
    results = []
    archive_dir = ARCHIVE_DIR / "memory"
    archive_dir.mkdir(parents=True, exist_ok=True)

    for op in ops:
        op_type = op.get("op", "")
        result = {"op": op_type, "status": "pending"}

        if op_type == "read":
            path = op["path"]
            if os.path.exists(path):
                with open(path, 'r') as f:
                    content = f.read()
                result["status"] = "ok"
                result["content_preview"] = content[:200]
                result["content_length"] = len(content)
            else:
                result["status"] = "error"
                result["message"] = f"文件不存在: {path}"

        elif op_type == "write":
            path = op["path"]
            content = op.get("content", "")
            if not dry_run:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, 'w') as f:
                    f.write(content)
            result["status"] = "ok"
            result["bytes"] = len(content)
            result["note"] = f"{'[DRY RUN] ' if dry_run else ''}写入 {path}"

        elif op_type == "delete":
            path = op["path"]
            if not dry_run and os.path.exists(path):
                os.remove(path)
                # 同时删对应的 json
                json_path = path.replace("/content/", "/meta/").replace(".md", ".json")
                if os.path.exists(json_path):
                    os.remove(json_path)
            result["status"] = "ok" if os.path.exists(path) else "already_gone"
            result["note"] = f"{'[DRY RUN] ' if dry_run else ''}删除 {path}"

        elif op_type == "archive":
            path = op["path"]
            if os.path.exists(path):
                fname = os.path.basename(path)
                dst = archive_dir / fname
                if not dry_run:
                    shutil.move(path, str(dst))
                    # 同时归档 json
                    json_path = path.replace("/content/", "/meta/").replace(".md", ".json")
                    if os.path.exists(json_path):
                        shutil.move(json_path, str(archive_dir / fname.replace(".md", ".json")))
            result["status"] = "ok"
            result["note"] = f"{'[DRY RUN] ' if dry_run else ''}归档 {path}"

        elif op_type == "rebuild_index":
            result["status"] = "ok"
            result["note"] = "索引重建标记"

        results.append(result)

    return results


def curate_v3(dry_run: bool = False, topic_filter: str = "") -> dict:
    """主流程：扫描 → LLM 决策 → 执行。"""
    log.info(f"{'[DRY RUN] ' if dry_run else ''}🧹 脑虫知识修剪器 v3")

    # 1. 扫描
    files = scan_directory()
    if topic_filter:
        kw = topic_filter.lower()
        files = [f for f in files if kw in f["title"].lower() or kw in f.get("category","").lower()]
    log.info(f"扫描文件: {len(files)} 个")

    # 2. LLM 决策
    llm = CerebrateLLM()
    if not llm.is_available():
        return {"error": "LLM 不可用"}

    prompt = build_prompt(files, topic_filter)
    log.info(f"发送到 LLM ({len(prompt)} 字符 prompt)...")

    client = llm._get_client()
    is_thinking = llm._is_thinking_model
    kwargs = {
        "model": llm._model,
        "messages": [{"role": "user", "content": prompt}],
    }
    if not is_thinking:
        kwargs["max_tokens"] = 65536
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
    if not match:
        return {"error": "LLM 返回非 JSON"}

    try:
        decision = json.loads(match.group())
    except json.JSONDecodeError as e:
        return {"error": f"JSON 解析失败: {e}"}

    ops = decision.get("operations", [])
    log.info(f"LLM 决定执行 {len(ops)} 个操作")

    for op in ops:
        log.info(f"  {op.get('op','?')}: {op.get('path','')[:60]}")

    # 3. 机械执行（LLM 输出 read -> 自动回填 content 再给 LLM 第二轮）
    read_ops = [op for op in ops if op.get("op") == "read"]
    if read_ops:
        log.info(f"LLM 要求读取 {len(read_ops)} 个文件全文，执行中...")
        for op in read_ops:
            result = execute_operations([op])
            op["content"] = result[0].get("content_preview", "")
            op["full_content"] = _read_full(op["path"])

        # 把读到的内容送回 LLM 做第二轮决策
        log.info("发送第二轮决策（含完整内容）...")
        second_prompt = prompt + "\n\n## 你要求读取的文件已读完，以下是完整内容：\n\n"
        for op in read_ops:
            second_prompt += f"### {op['path']}\n```markdown\n{op.get('full_content','')[:2000]}\n```\n\n"
        second_prompt += "\n请基于完整内容输出最终的操作列表。只返回 JSON。"

        kwargs["messages"] = [{"role": "user", "content": second_prompt}]
        if llm._provider == "anthropic":
            response2 = client.messages.create(**kwargs)
            text2 = response2.content[0].text if response2.content else ""
        else:
            response2 = client.chat.completions.create(**kwargs)
            text2 = response2.choices[0].message.content if response2.choices else ""

        match2 = re.search(r'\{[\s\S]*\}', text2)
        if match2:
            try:
                decision = json.loads(match2.group())
                ops = decision.get("operations", [])
                log.info(f"第二轮决策: {len(ops)} 个操作")
            except json.JSONDecodeError:
                log.warning("第二轮 JSON 解析失败，使用第一轮结果")

    # 4. 执行最终操作
    log.info(f"{'[DRY RUN] ' if dry_run else ''}执行操作...")
    results = execute_operations(ops, dry_run=dry_run)

    # 5. 标记需要重建索引
    needs_rebuild = any(
        r["op"] in ("write", "delete", "archive") and r["status"] == "ok"
        for r in results
    )

    return {
        "analysis": decision.get("analysis", ""),
        "operations_count": len(ops),
        "operations": results,
        "needs_rebuild": needs_rebuild,
        "dry_run": dry_run,
    }


def _read_full(path: str) -> str:
    try:
        with open(path, 'r') as f:
            return f.read()
    except Exception:
        return ""


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    topic = ""
    for arg in sys.argv[1:]:
        if arg.startswith("--topic="):
            topic = arg.split("=", 1)[1]

    result = curate_v3(dry_run=dry_run, topic_filter=topic)
    print(json.dumps(result, indent=2, ensure_ascii=False))
