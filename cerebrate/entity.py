"""本地实体抽取 — MCP 客户端实体化衍生（实体数据不离开本地）。

用户决策（2026-08-06）：Mem0 的实体链接能力由本地 MCP 承担——
服务端不存实体数据（团队共享只放结构/参考），实体抽取/衍生在用户本机执行，
服务端只接收实体名/标签等轻量结构作为记忆 tags/索引增强。

实现：纯规则抽取（零 LLM 依赖、零付费），结果可选持久化到本地实体图谱
（~/.cerebrate/entities.json，实体名→{type, count, first_seen, last_seen}）。
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# 常见技术关键词（命中即 tech 类实体；可扩充，保持小集合避免噪音）
TECH_KEYWORDS = {
    "docker", "git", "nginx", "ngrok", "postgres", "mysql", "redis",
    "chromadb", "sqlite", "flowable", "laravel", "deepseek", "qoder",
    "claude", "codex", "trae", "mcp", "totp", "bge", "fts", "llm", "api",
    "cli", "json", "yml", "yaml", "ast", "sse", "http", "https", "tls",
    "jira", "github", "gitlab", "kubernetes", "k8s", "pytest", "unittest",
    "hmac", "sha1", "base32", "chroma", "embedding", "reranker", "swarm",
    "doctrine", "nutrient", "verified_skill", "cerebrate", "origin_log",
    "docstore", "metastore", "fulltext", "rerank", "bpmn", "flowable",
    "curl", "pip", "npm", "ssh", "make", "kubectl", "sudo", "python3",
    "postgresql", "mariadb", "redis", "celery", "rabbitmq", "kafka",
}

_CAMEL_RE = re.compile(r"\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b")
_SNAKE_RE = re.compile(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b")
_URL_RE = re.compile(r"https?://[^\s\"'<>]+")
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_QUOTED_RE = re.compile(r"[\"']([^\"']{2,40})[\"']")
_SHA_RE = re.compile(r"\b[0-9a-f]{8,}\b")
_NUM_RE = re.compile(r"^[\d.]+$")


def _word_boundary(pattern: str) -> str:
    """ASCII 词边界（对中文名同样生效：中文不是 [A-Za-z0-9]）。"""
    return rf"(?<![A-Za-z0-9]){pattern}(?![A-Za-z0-9])"


def extract_entities(text: str, known: Optional[dict] = None) -> list[dict]:
    """从文本中抽取实体（本地规则，无 LLM 调用）。

    known: 可选，{名称小写: {type, ...}} 的既有实体图谱，用于复用已知类型。

    Returns:
        [{"name": str, "type": str, "count": int}]，按出现次数降序去重。
    """
    text = text or ""
    if not text.strip():
        return []
    seen: dict[str, dict] = {}  # 小写名 → 实体
    known = known or {}

    def _add(name: str, etype: str):
        key = name.lower()
        if not name or len(name) > 40:
            return
        if _SHA_RE.fullmatch(name) or _NUM_RE.match(name):
            return
        if key in seen:
            seen[key]["count"] += 1
            return
        # 已知图谱类型优先，否则用规则类型
        known_info = known.get(key)
        if known_info and isinstance(known_info, dict):
            etype = known_info.get("type", etype)
        seen[key] = {"name": name, "type": etype, "count": 1}

    # 1) URL / 邮箱 / 联系方式
    for m in _URL_RE.finditer(text):
        _add(m.group(0).strip(), "url")
    for m in _EMAIL_RE.finditer(text):
        _add(m.group(0).strip(), "contact")
    # 2) 技术关键词（单词边界，独立 token；命令动词也归入 tech，避免整段命令噪音）
    for kw in TECH_KEYWORDS:
        for m in re.finditer(_word_boundary(re.escape(kw)), text, re.I):
            _add(m.group(0), "tech")
    # 3) 驼峰/下划线标识符（代码/模块/变量）
    for m in _CAMEL_RE.finditer(text):
        _add(m.group(0), "tech")
    for m in _SNAKE_RE.finditer(text):
        _add(m.group(0), "tech")
    # 4) 引号术语
    for m in _QUOTED_RE.finditer(text):
        _add(m.group(1).strip(), "term")
    # 5) 已知图谱实体：在文本中出现即识别（复用已有类型，图谱持续生长）
    for key, info in known.items():
        if not isinstance(info, dict):
            continue
        if key in seen:
            continue  # 规则已命中，避免重复计数
        name = info.get("name") or key
        if not name:
            continue
        if re.search(_word_boundary(re.escape(name)), text, re.I):
            _add(name, info.get("type", "other"))

    entities = sorted(seen.values(), key=lambda e: (-e["count"], e["name"]))
    return entities


def load_store(path) -> dict:
    """读取本地实体图谱（不存在返回空 dict）。"""
    try:
        p = Path(path)
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def save_store(store: dict, path) -> None:
    """持久化实体图谱（原子写：先临时文件再 rename）。"""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def update_store(entities: list[dict], store: dict, cap: int = 2000) -> dict:
    """把抽取结果合并进本地实体图谱（计数累加，cap 控制图谱上限）。"""
    now = datetime.now(timezone.utc).isoformat()
    for ent in entities:
        key = ent["name"].lower()
        item = store.get(key)
        if item:
            item["count"] = item.get("count", 0) + ent.get("count", 1)
            item["last_seen"] = now
        else:
            store[key] = {
                "name": ent["name"],
                "type": ent["type"],
                "count": ent.get("count", 1),
                "first_seen": now,
                "last_seen": now,
            }
    # 超出上限时按 count 截断（保高频，控体积）
    if len(store) > cap:
        trimmed = dict(sorted(store.items(),
                              key=lambda kv: -kv[1].get("count", 0))[:cap])
        store.clear()
        store.update(trimmed)
    return store


def extract_and_update(text: str, store_path=None, persist: bool = True,
                       top: int = 30) -> dict:
    """抽取实体并可选持久化到本地图谱（MCP cerebrate_entity_extract 落点）。"""
    store = load_store(store_path) if (store_path and persist) else {}
    known = {k: v for k, v in store.items() if isinstance(v, dict)}
    entities = extract_entities(text, known=known)
    saved = False
    if persist and store_path and entities:
        update_store(entities, store)
        save_store(store, store_path)
        saved = True
    return {
        "entities": entities[:top],
        "source": "local",
        "persisted": saved,
        "store_size": len(store),
        "store_path": str(store_path) if store_path else "",
    }
