"""虫群共享记忆层 v5 — 服务端权威内核 + ChromaDB 向量存储

v5.1 改进:
  - 长文档自动语义分块（按标题/段落/等长切割）
  - 查询结果按 origin_ids 聚合（同一文档的多块合并返回）
  - 可选 ReRanker 交叉编码器精排
  - 显式 max_length 控制 + 截断警告
"""
import hashlib
import logging
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cerebrate.core.storage import ChromaStore
from cerebrate.core.decay import calculate_decay, boost_from_reuse
from cerebrate.memory.docstore import DocumentStore
from cerebrate.memory.metastore import get_metastore
from cerebrate.config import config

logger = logging.getLogger(__name__)

LIFE_STAGES = {"nutrient", "memory", "verified_skill",
               "doctrine", "quarantined", "archived"}

SCOPES = {"general", "project"}

# category → observation_type 映射（渐进式披露索引层的类型标签）
# 对齐 claude-mem observation type 语义：
#   decision/bugfix/feature/refactor/discovery/change + gotcha/how-it-works/problem-solution
CATEGORY_OBSERVATION_TYPE = {
    "debugging": "bugfix",
    "bugfix": "bugfix",
    "security": "gotcha",
    "testing": "gotcha",
    "architecture": "decision",
    "refactor": "refactor",
    "performance": "optimization",
    "devops": "how-it-works",
    "config": "how-it-works",
    "coding": "problem-solution",
    "skill": "discovery",
    "doctrine": "decision",
}


def observation_type_for(category: str) -> str:
    """从 category 推导 observation type（未知分类归为 discovery）。"""
    return CATEGORY_OBSERVATION_TYPE.get(category or "", "discovery")


def _extract_concepts(tags: list[str], category: str, title: str = "") -> list[str]:
    """规则提取 concepts：标签 + 分类 + 标题关键词（去重、截断）。"""
    concepts: list[str] = []
    for t in tags:
        t = str(t).strip()
        if t and t not in concepts:
            concepts.append(t)
    if category and category not in concepts:
        concepts.append(category)
    # 标题关键词（简单分词：按空白/常见分隔符切分，取长度>=2 的词）
    if title:
        for w in re.split(r"[\s,，。；;:：/\\|()（）\-_]+", title):
            w = w.strip()
            if len(w) >= 2 and w not in concepts:
                concepts.append(w)
    return concepts[:12]


def _extract_facts(solution: str = "", problem_solved: str = "") -> list[str]:
    """规则提取 facts：从 solution/problem_solved 拆出短句（最多 5 条）。"""
    facts: list[str] = []
    for src in (solution, problem_solved):
        if not src:
            continue
        for part in re.split(r"[。；;\n]+", src):
            part = part.strip()
            if len(part) >= 4 and part not in facts:
                facts.append(part)
    return facts[:5]


def _safe_split(val, separator=","):
    """安全地将可能是 str 或 list 的元数据值转为列表。"""
    if not val:
        return []
    if isinstance(val, list):
        return [s for s in val if s]
    if isinstance(val, str):
        return [s.strip() for s in val.split(separator) if s.strip()]
    return [str(val)]


def estimate_tokens(text: str) -> int:
    """粗略 token 估算：中英混合按 4 字符/token，最低 1。

    用于渐进式披露索引层展示"取这条记忆要花多少 token"，
    让 agent 在决定是否拉取详情前能做成本/收益判断。
    """
    if not text:
        return 1
    return max(1, int(len(text) // 4))


class SwarmMemory:
    """虫群共享记忆：ChromaDB 向量索引 + DocumentStore 原始内容

    架构设计:
      - ChromaDB = 纯向量索引（doc_id + 向量 + 运营元数据）
      - DocumentStore = 原始完整内容持久化（JSON 文件）
      内容类字段（content, problem_solved, solution, evidence）
      仅存储在 DocumentStore 中，ChromaDB metadata 不再存储。
    """

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self._store: Optional[ChromaStore] = None
        self._docstore: Optional[DocumentStore] = None
        # 元数据存储（PostgreSQL，可选）
        self._metastore: object = None  # lazy init
        # 轻量级计数器（会话内内存，定期刷盘）
        self._stats = {"total": 0, "total_queries": 0, "total_successes": 0}
        self._dirty = False
        self._stats_lock = threading.Lock()
        self._mem_locks: dict[str, threading.Lock] = {}
        self._mem_locks_lock = threading.Lock()
        self._init_store()

    def _init_store(self):
        from cerebrate.core.embedding import get_embedding_engine
        engine = get_embedding_engine(
            config.embedding_model, config.embedding_device)
        self._store = ChromaStore(config.chroma_path, "swarm_memories", engine)
        self._docstore = DocumentStore(config.docstore_path)

        # 从 ChromaDB 恢复计数
        self._stats["total"] = self._store.count()
        stats_item = self._store.get("_swarm_stats")
        if stats_item:
            saved = stats_item["metadata"]
            with self._stats_lock:
                self._stats["total_queries"] = int(
                    saved.get("total_queries", 0))
                self._stats["total_successes"] = int(
                    saved.get("total_successes", 0))

    def _flush_stats(self):
        """将统计计数器刷到 ChromaDB"""
        if self._store:
            with self._stats_lock:
                self._store.upsert(
                    "_swarm_stats", "swarm statistics counter", dict(self._stats))

    def flush(self):
        if self._dirty:
            self._flush_stats()
            with self._stats_lock:
                self._dirty = False

    @property
    def _ms(self):
        """惰性获取 MetaStore 单例"""
        if self._metastore is None:
            self._metastore = get_metastore()
        return self._metastore

    @staticmethod
    def _build_search_text(title: str, content: str, *,
                           problem_solved: str = "",
                           solution: str = "",
                           evidence: str = "",
                           max_chars: int = 0) -> str:
        """构建用于向量嵌入的聚焦摘要文本

        向量数据库是「定位器」，不是「全文搜索引擎」。
        嵌入文本应如目录摘要般聚焦——讲清楚「文档是关于什么的」，
        而非包含所有细节。

        策略：标题 + 内容开头的摘要段落。
        problem_solved/solution/evidence 仅在有空间时补充。
        """
        if max_chars <= 0:
            max_chars = config.embedding_summary_chars

        # 核心：标题 + 内容开头（摘要段落）
        content_summary = content[:max_chars] if content else ""
        summary = title
        if content_summary:
            summary += "\n" + content_summary

        # 内容摘要不够长时，补充关键字段
        remaining = max_chars * 2 - len(summary)  # 允许稍长
        if remaining > 100:
            for field, val in [("问题", problem_solved),
                               ("方案", solution),
                               ("证据", evidence)]:
                if val and len(val) <= remaining:
                    summary += f"\n{field}: {val[:remaining]}"
                    remaining -= len(val) + len(field) + 4
                    if remaining < 50:
                        break

        # 截断到合理长度（避免浪费 token）
        return summary[:max_chars * 2]

    # ==================== 写入 ====================

    def share(self, title: str, content: str, category: str, tags: list[str],
              source_agent: str = "unknown", problem_solved: str = "",
              solution: str = "", outcome: str = "success",
              project_id: str = "", scope: str = "", language: str = "",
              life_stage: str = "memory", nutrient_score: float = 1.0,
              confidence: float = 1.0, evidence: str = "",
              supersedes: Optional[list[str]] = None,
              origin_ids: Optional[list[str]] = None,
              physical_user: str = "",
              memory_id: Optional[str] = None,
              observation_type: str = "",
              facts: Optional[list[str]] = None,
              concepts: Optional[list[str]] = None) -> str:
        """向虫群共享记忆

        架构:
          1. 完整内容（content/problem_solved/solution）写入 DocumentStore
          2. 仅运营元数据（title/category/tags/lifecycle）写入 ChromaDB 索引
          3. 长文档自动分块，每块独立向量化，共享 doc_group_id

        结构化字段（v5.3 Phase 4，对齐 claude-mem observation）:
          - observation_type: 类型标签（decision/bugfix/refactor/discovery/...）
          - facts: 事实清单（从 solution/problem_solved 规则提取，或 LLM 提取后传入）
          - concepts: 概念标签（tags + category + 标题关键词，或 LLM 提取后传入）
        """
        # ── 结构化字段：缺省时规则推导 ──
        observation_type = observation_type or observation_type_for(category)
        concepts = concepts or _extract_concepts(tags, category, title)
        facts = facts or _extract_facts(solution, problem_solved)

        # ── 记忆分类：通用记忆(scope=general) / 项目记忆(scope=project) ──
        # 规则:
        #   显式 scope="general" → 强制通用，project_id 置空
        #   显式 scope="project" → 项目记忆，project_id 缺失时用当前项目
        #   scope 未指定 → 按 project_id 自动推导（非空=项目，空=通用）
        if scope in SCOPES:
            if scope == "general":
                project_id = ""
            else:
                project_id = project_id or config.current_project_id
                if not project_id:
                    # 显式 project 但无可用项目 ID → 降级为通用，避免状态不一致
                    scope = "general"
        else:
            project_id = project_id or config.current_project_id
            scope = "project" if project_id else "general"
        language = language or config.default_language
        now = datetime.now(timezone.utc).isoformat()
        supersedes = supersedes or []
        origin_ids = origin_ids or []

        life_stage = life_stage if life_stage in LIFE_STAGES else "memory"
        from cerebrate.memory.docstore import doc_type_for
        doc_type = doc_type_for(life_stage)

        # ── 是否需要分块？ ──
        should_chunk = (
            config.chunk_enabled
            and len(content) > config.chunk_max_chars
        )
        is_short_memory = (life_stage == "memory" and not should_chunk)

        # ── 生成主 memory_id（文档级 ID）──
        if memory_id is None:
            memory_id = hashlib.sha256(
                f"{title}{category}{now}".encode()
            ).hexdigest()[:16]

        if not should_chunk:
            # ── 不分块：按类型路由 → DocumentStore，运营元数据→ChromaDB ──
            self._docstore_put(memory_id, {
                "title": title, "content": content,
                "problem_solved": problem_solved, "solution": solution,
                "evidence": evidence, "created": now,
                "source_agent": source_agent,
                "physical_user": physical_user or "",
                "total_chunks": 1,
            }, doc_type=doc_type)
            search_text = self._build_search_text(
                title, content,
                problem_solved=problem_solved,
                solution=solution,
                evidence=evidence)
            # 短记忆（原始经验）：全文直接入向量库，查询无需 docstore 回填
            chroma_doc = content if is_short_memory else search_text
            meta = self._build_metadata(
                title=title, content="", category=category, tags=tags,
                source_agent=source_agent, physical_user=physical_user,
                problem_solved="", solution="",
                outcome=outcome, project_id=project_id, scope=scope, language=language,
                life_stage=life_stage, nutrient_score=nutrient_score,
                confidence=confidence, evidence=evidence,
                supersedes=supersedes, origin_ids=origin_ids,
                created=now, updated=now,
                chunk_index=0, total_chunks=1, full_content="",
                token_estimate=estimate_tokens(content),
                observation_type=observation_type,
                facts=facts,
                concepts=concepts,
            )
            # 短记忆标记位：让 enrich 知道内容已在 ChromaDB 中
            if is_short_memory:
                meta["_fast_content"] = "1"
                meta["_content_len"] = str(len(content))
            self._store.add(memory_id, chroma_doc, meta)
            with self._stats_lock:
                self._stats["total"] += 1
                self._dirty = True
            # 双写 FTS5 全文索引（精确关键词检索）
            self._fts_upsert(memory_id, title=title, content=content,
                             tags=",".join(tags), category=category,
                             scope=scope, project_id=project_id,
                             created=now, updated=now,
                             observation_type=observation_type)
            # 同步元数据到 PostgreSQL
            self._sync_meta(memory_id, title=title, category=category,
                            tags=tags, source_agent=source_agent,
                            physical_user=physical_user or "",
                            project_id=project_id, language=language,
                            life_stage=life_stage, outcome=outcome,
                            confidence=confidence, total_chunks=1,
                            metadata={"scope": scope})
            return memory_id

        # ── 分块存储 ──
        from cerebrate.core.chunking import chunk_document

        chunks = chunk_document(
            content,
            max_chars=config.chunk_max_chars,
            min_chars=config.chunk_min_chars,
            overlap_chars=config.chunk_overlap_chars,
        )
        total_chunks = len(chunks)
        doc_group_id = memory_id  # 所有块用同一个 doc_group_id

        logger.info(
            f"记忆 '{title}' 分 {total_chunks} 块存储 "
            f"(共 {len(content)} 字符，每块 ≤{config.chunk_max_chars} 字符)"
        )

        # ── 保存完整文档到 DocumentStore（按类型路由）──
        self._docstore_put(memory_id, {
            "title": title, "content": content,
            "problem_solved": problem_solved, "solution": solution,
            "evidence": evidence, "created": now,
            "source_agent": source_agent,
            "physical_user": physical_user or "",
            "total_chunks": total_chunks,
            "doc_group_id": doc_group_id,
        }, doc_type=doc_type)

        for chunk in chunks:
            ci = chunk["index"]
            chunk_text = chunk["text"]
            chunk_mid = f"{memory_id}_c{ci:04d}"
            chunk_origin_ids = origin_ids + [memory_id] if ci == 0 else [memory_id]

            # 每块的片段文本也存到 DocumentStore（按类型路由）
            self._docstore_put(chunk_mid, {
                "doc_group_id": doc_group_id,
                "chunk_index": ci,
                "total_chunks": total_chunks,
                "content": chunk_text,
                "start_char": chunk.get("start_char", 0),
                "end_char": chunk.get("end_char", len(chunk_text)),
            }, doc_type=doc_type)

            search_text = self._build_search_text(
                title, chunk_text)
            chunk_meta = self._build_metadata(
                title=title, content="", category=category, tags=tags,
                source_agent=source_agent, physical_user=physical_user,
                problem_solved="", solution="",
                outcome=outcome, project_id=project_id, scope=scope, language=language,
                life_stage=life_stage, nutrient_score=nutrient_score,
                confidence=confidence, evidence=evidence,
                supersedes=supersedes, origin_ids=chunk_origin_ids,
                created=now, updated=now,
                chunk_index=ci, total_chunks=total_chunks,
                full_content="",
                doc_group_id=doc_group_id,
                token_estimate=estimate_tokens(chunk_text),
                observation_type=observation_type,
                facts=facts,
                concepts=concepts,
            )
            self._store.add(chunk_mid, search_text, chunk_meta)

        # ── 写入 parent 占位条目（供 lifecycle_counts 统计）──
        parent_meta = self._build_metadata(
            title=title, content="", category=category, tags=tags,
            source_agent=source_agent, physical_user=physical_user,
            problem_solved="", solution="",
            outcome=outcome, project_id=project_id, scope=scope, language=language,
            life_stage=life_stage, nutrient_score=nutrient_score,
            confidence=confidence, evidence=evidence,
            supersedes=supersedes, origin_ids=origin_ids,
            created=now, updated=now,
            chunk_index=0, total_chunks=total_chunks,
            full_content="",
            doc_group_id="",
            is_parent=True,
            token_estimate=estimate_tokens(content),
            observation_type=observation_type,
            facts=facts,
            concepts=concepts,
        )
        parent_meta["_content_len"] = str(len(content))
        self._store.add(memory_id, title, parent_meta)

        with self._stats_lock:
            self._stats["total"] += 1
            self._dirty = True
        # 双写 FTS5 全文索引（用父文档完整内容）
        self._fts_upsert(memory_id, title=title, content=content,
                         tags=",".join(tags), category=category,
                         scope=scope, project_id=project_id,
                         created=now, updated=now,
                         observation_type=observation_type)
        # 同步元数据到 PostgreSQL
        self._sync_meta(memory_id, title=title, category=category,
                        tags=tags, source_agent=source_agent,
                        physical_user=physical_user or "",
                        project_id=project_id, language=language,
                        life_stage=life_stage, outcome=outcome,
                        confidence=confidence, total_chunks=total_chunks,
                        metadata={"scope": scope})
        return memory_id

    def _docstore_put(self, doc_id: str, data: dict, doc_type: str = "memory"):
        """安全写入 DocumentStore（按类型路由子目录）"""
        if self._docstore:
            try:
                self._docstore.put(doc_id, data, doc_type)
            except Exception as e:
                logger.error(f"DocumentStore 写入失败 {doc_id}: {e}")

    def _docstore_get(self, doc_id: str) -> Optional[dict]:
        """安全读取 DocumentStore"""
        if self._docstore:
            try:
                return self._docstore.get(doc_id)
            except Exception as e:
                logger.error(f"DocumentStore 读取失败 {doc_id}: {e}")
        return None

    def _docstore_delete(self, doc_id: str) -> bool:
        """安全删除 DocumentStore"""
        if self._docstore:
            try:
                return self._docstore.delete(doc_id)
            except Exception as e:
                logger.error(f"DocumentStore 删除失败 {doc_id}: {e}")
        return False

    def _sync_meta(self, doc_id: str, **kwargs):
        """同步元数据到 PostgreSQL（静默失败，不阻塞主流程）"""
        try:
            ms = self._ms
            if ms and ms.available:
                ms.put_document(doc_id, **kwargs)
        except Exception as e:
            logger.debug(f"元数据同步跳过 ({doc_id}): {e}")

    def _enrich_from_docstore(self, entry: dict) -> dict:
        """从 DocumentStore 加载完整内容并填充到条目中

        对于短记忆（_fast_content=1），内容已在 ChromaDB 中，跳过 docstore。

        注意：evidence 是运营字段（feedback 动态追加），
        不从 docstore 覆盖，以 ChromaDB 中的为准。
        """
        mem_id = entry.get("memory_id", "")

        # 短记忆：内容已在 ChromaDB document 字段
        if entry.get("_fast_content") == "1":
            entry["_docstore_loaded"] = True
            return entry

        # 先查精准 memory_id
        doc = self._docstore_get(mem_id)
        if doc:
            entry["content"] = doc.get("content", entry.get("content", ""))
            entry["problem_solved"] = doc.get("problem_solved", entry.get("problem_solved", ""))
            entry["solution"] = doc.get("solution", entry.get("solution", ""))
            entry["_docstore_loaded"] = True
            return entry

        # 查 doc_group_id（分块文档的父条目）
        doc_group = entry.get("doc_group_id", "")
        if doc_group:
            doc = self._docstore_get(doc_group)
            if doc:
                entry["content"] = doc.get("content", entry.get("content", ""))
                entry["problem_solved"] = doc.get("problem_solved", entry.get("problem_solved", ""))
                entry["solution"] = doc.get("solution", entry.get("solution", ""))
                entry["_docstore_loaded"] = True
                return entry

        # 降级：从 memory_id 去掉 _c 后缀
        if "_c" in mem_id:
            parent_id = mem_id[:mem_id.rfind("_c")]
            doc = self._docstore_get(parent_id)
            if doc:
                entry["content"] = doc.get("content", entry.get("content", ""))
                entry["problem_solved"] = doc.get("problem_solved", entry.get("problem_solved", ""))
                entry["solution"] = doc.get("solution", entry.get("solution", ""))
                entry["_docstore_loaded"] = True
                return entry

        return entry

    # ==================== 上下文扩展 ====================

    def expand_context(self, entry: dict,
                       before_chars: int = 1500,
                       after_chars: int = 1500) -> dict:
        """对匹配到的记忆块做上下文扩展

        根据块在原文中的字符偏移，加载前后文，让 AI 看到完整上下文。

        Args:
            entry: 匹配到的记忆条目（含 memory_id）
            before_chars: 向前扩展的字符数
            after_chars: 向后扩展的字符数

        Returns:
            同一条目，追加 _expanded_context 和 _context_range 字段
        """
        entry["_expanded_context"] = entry.get("content", "")
        entry["_context_range"] = {"before": 0, "after": 0, "total": 0}

        mem_id = entry.get("memory_id", "")

        # 判断是否为分块（_cXXXX 结尾）
        is_chunk = "_c" in mem_id and mem_id[mem_id.rfind("_c") + 2:].isdigit()
        if not is_chunk:
            # 非分块记忆：整篇文档就是上下文
            return entry

        # 查找 doc_group_id
        doc_group_id = entry.get("doc_group_id", "")
        if not doc_group_id:
            # 从 memory_id 推断
            doc_group_id = mem_id[:mem_id.rfind("_c")]

        # 读取父文档
        parent_doc = self._docstore_get(doc_group_id)
        if not parent_doc:
            return entry

        full_content = parent_doc.get("content", "")
        if not full_content:
            return entry

        # 读取分块偏移量
        chunk_doc = self._docstore_get(mem_id)
        start_char = (chunk_doc or {}).get("start_char", 0)
        end_char = (chunk_doc or {}).get("end_char", len(full_content))

        # 扩展上下文窗口
        ctx_start = max(0, start_char - before_chars)
        ctx_end = min(len(full_content), end_char + after_chars)

        expanded = full_content[ctx_start:ctx_end]
        entry["_expanded_context"] = expanded
        entry["_context_range"] = {
            "before": start_char - ctx_start,
            "after": ctx_end - end_char,
            "total": len(full_content),
            "doc_id": doc_group_id,
        }
        # 标记原文中匹配块的范围（用于引用标注）
        entry["_source_range"] = {
            "start": start_char,
            "end": end_char,
            "document": doc_group_id,
        }
        return entry

    def expand_all_contexts(self, entries: list[dict],
                             before_chars: int = 1500,
                             after_chars: int = 1500) -> list[dict]:
        """批量上下文扩展"""
        return [self.expand_context(e, before_chars, after_chars) for e in entries]

    # ==================== 相关性过滤 ====================

    def filter_relevant(self, query: str, entries: list[dict]) -> list[dict]:
        """用 LLM 对候选块做相关性过滤

        使用 CerebrateLLM 逐块判断相关性，仅保留高相关的块。
        LLM 不可用时降级为分数阈值过滤。
        """
        if not entries:
            return entries

        from cerebrate.brain.llm import CerebrateLLM
        llm = CerebrateLLM()
        if not llm.is_available() or not llm._sdk_ready():
            # LLM 不可用时：用分数阈值降级
            return [e for e in entries if e.get("score", 0) >= 0.15]

        filtered = []
        for entry in entries:
            content = entry.get("_expanded_context") or entry.get("content", "")
            title = entry.get("title", "")
            if not content:
                continue
            # 用 LLM 判断相关性
            result = llm.filter_relevant(query, title, content)
            if result.get("relevant", False):
                entry["_relevance"] = result.get("relevance_score", 0.5)
                entry["_relevance_reason"] = result.get("reason", "")
                filtered.append(entry)
            else:
                logger.debug(
                    f"相关性过滤丢弃: {title} "
                    f"(score={entry.get('score', 0):.3f}, "
                    f"reason={result.get('reason', '')})")
        return filtered if filtered else entries

    def _build_metadata(self, *, title, content, category, tags,
                        source_agent, physical_user, problem_solved,
                        solution, outcome, project_id, scope, language,
                        life_stage, nutrient_score, confidence, evidence,
                        supersedes, origin_ids,
                        created, updated,
                        chunk_index=0, total_chunks=1, full_content="",
                        doc_group_id="", is_parent=False,
                        token_estimate=0,
                        observation_type="", facts=None, concepts=None) -> dict:
        """构建统一的元数据字典"""
        return {
            "title": title,
            "content": content,
            "category": category,
            "tags": ",".join(tags),
            "observation_type": observation_type or observation_type_for(category),
            "facts": ",".join(facts or []),
            "concepts": ",".join(concepts or []),
            "source_agent": source_agent,
            "physical_user": physical_user or "",
            "problem_solved": problem_solved,
            "solution": solution,
            "outcome": outcome,
            "project_id": project_id,
            "scope": scope,
            "language": language,
            "score": 1.0,
            "reuse_count": 0,
            "success_count": 0,
            "life_stage": life_stage,
            "nutrient_score": float(nutrient_score),
            "confidence": float(confidence),
            "evidence": evidence,
            "supersedes": ",".join(supersedes),
            "origin_ids": ",".join(origin_ids),
            "created": created,
            "updated": updated,
            # 分块字段
            "chunk_index": chunk_index,
            "total_chunks": total_chunks,
            "full_content": full_content,
            "doc_group_id": doc_group_id or "",
            "is_parent": is_parent,
            # 渐进式披露：取详情预估 token 成本（写入时计算）
            "token_estimate": max(1, int(token_estimate or 1)),
        }

    # ==================== FTS5 全文索引（Phase 3） ====================

    def _get_fulltext(self):
        """懒加载 FTS5 全文索引（线程安全）。"""
        if not config.fulltext_enabled:
            return None
        if not hasattr(self, "_fulltext_cache"):
            from cerebrate.core.fulltext import FullTextIndex
            # 动态从 memory_root 派生路径：跟随测试/多实例的 memory_root 覆盖
            self._fulltext_cache = FullTextIndex(
                Path(config.memory_root) / "fulltext.sqlite3")
        return self._fulltext_cache

    def _fts_upsert(self, memory_id: str, *, title: str, content: str,
                    tags: str, category: str, scope: str, project_id: str,
                    created: str, updated: str,
                    observation_type: str = "") -> bool:
        """双写 FTS5（失败静默降级，不影响主写入路径）。"""
        fts = self._get_fulltext()
        if not fts or not fts.available:
            return False
        return fts.upsert(
            memory_id, title=title, content=content, tags=tags,
            category=category, scope=scope, project_id=project_id,
            created=created, updated=updated,
            observation_type=observation_type or observation_type_for(category))

    def fulltext_query(self, query_text: str, limit: int = 20,
                       project_id: Optional[str] = None,
                       scope: Optional[str] = None,
                       category: Optional[str] = None) -> list[dict]:
        """FTS5 全文检索：精确关键词（错误码/命令/函数名）优先。

        返回渐进式披露索引层格式（source=fulltext + snippet）。
        """
        fts = self._get_fulltext()
        if not fts or not fts.available:
            return []
        return fts.search(query_text, limit=limit, scope=scope,
                          project_id=project_id, category=category)

    def recent_index(self, limit: int = 10,
                     project_id: Optional[str] = None,
                     scope: Optional[str] = None) -> list[dict]:
        """最近记忆紧凑索引（Phase 5）：会话开始即见存在什么 + token 成本。

        数据源优先 FTS5 meta 表（轻量）；FTS 不可用时降级返回空列表
        （sense 是低风险读路径，不因索引缺失阻塞）。
        """
        fts = self._get_fulltext()
        if not fts or not fts.available:
            return []
        return fts.recent(limit=limit, scope=scope, project_id=project_id)

    def rebuild_fulltext(self, batch_size: int = 200) -> dict:
        """从 DocStore + ChromaDB 全量重建 FTS5 索引。"""
        fts = self._get_fulltext()
        if not fts:
            return {"status": "skipped", "reason": "fulltext disabled"}
        if not fts.available:
            return {"status": "error", "reason": "fulltext unavailable"}
        fts.clear()
        ids = self._store.get_all_ids()
        indexed = 0
        failed = 0
        for eid in ids:
            if eid == "_seq" or "_c" in eid:
                continue
            try:
                mem = self.get_memory(eid)
                if not mem:
                    continue
                meta = mem
                ok = self._fts_upsert(
                    eid, title=meta.get("title", ""),
                    content=meta.get("content", ""),
                    tags=",".join(meta.get("tags", []) or []),
                    category=meta.get("category", ""),
                    scope=meta.get("scope", "general"),
                    project_id=meta.get("project_id", ""),
                    created=meta.get("created", ""),
                    updated=meta.get("updated", ""),
                    observation_type=meta.get("observation_type", ""))
                if ok:
                    indexed += 1
                else:
                    failed += 1
            except Exception:
                failed += 1
        return {
            "status": "ok",
            "indexed": indexed,
            "failed": failed,
            "total": fts.count(),
        }

    # ==================== 查询 ====================

    def query(self, query_text: str = "", category: Optional[str] = None,
              tags: Optional[list[str]] = None, limit: int = 10,
              project_id: Optional[str] = None, scope: Optional[str] = None,
              source_agent: Optional[str] = None,
              query_texts: Optional[list[str]] = None,
              index_only: bool = False) -> list[dict]:
        """向量语义查询，支持多角度查询 + 分块聚合 + 可选 ReRanker 精排

        index_only=True 时进入"渐进式披露索引层"模式：
          跳过 DocumentStore 全文加载、上下文扩展、LLM 相关性过滤、ReRanker，
          每条结果只返回紧凑索引字段（memory_id/title/category/scope/score/token_estimate），
          供 agent 先扫描再决定取哪几条详情（对齐 claude-mem 3 层工作流）。

        查询流程:
          0. 多查询重写（可选）：从多个角度检索
          1. ChromaDB 语义向量搜索（粗筛）
          2. Tags 过滤 + 衰减评分
          3. 按 doc_group_id 聚合分块（同一文档的多块合并）
          4. （可选）ReRanker 交叉编码器精排
          5. 返回按 final_score 降序的结果

        记忆分类 scope（通用记忆 / 项目记忆隔离）:
          - "general"  : 只返回通用记忆（project_id=""），不含任何项目记忆
          - "project"  : 返回指定项目记忆 + 通用记忆（project_id=pid 或 ""）
          - "all"      : 跨项目全量（进化/管理用），不做 scope 隔离
          - None       : 兼容旧行为；传了 project_id 按项目查，否则按通用查
        """
        with self._stats_lock:
            self._stats["total_queries"] += 1
            self._dirty = True

        # 构建 ChromaDB where 过滤条件（scope 优先，兼容旧 project_id 语义）
        conditions = []
        if scope == "all":
            pass  # 跨项目全量，不按项目隔离
        elif scope == "general":
            conditions.append({"project_id": ""})
        elif scope == "project":
            pid = project_id if project_id else config.current_project_id
            conditions.append({"project_id": {"$in": [pid, ""]}})
        elif project_id is not None:
            pid = project_id if project_id else config.current_project_id
            conditions.append({"project_id": {"$in": [pid, ""]}})
        else:
            # 默认（未指定 scope 且未传 project_id）→ 只查通用记忆
            conditions.append({"project_id": ""})
        if category:
            conditions.append({"category": category})
        if source_agent:
            conditions.append({"source_agent": source_agent})

        where = None
        if len(conditions) == 1:
            where = conditions[0]
        elif len(conditions) > 1:
            where = {"$and": conditions}

        # ── 确定搜索的查询文本列表 ──
        if query_texts is None:
            query_texts = [query_text] if query_text else []
        # 确保至少有一个查询
        if not query_texts:
            query_texts = [query_text] if query_text else [""]
        if not query_texts[0]:
            query_texts[0] = query_text

        from cerebrate.core.embedding import get_embedding_engine
        engine = get_embedding_engine()

        # ── 多查询搜索 + 合并 ──
        raw_limit = max(limit * 10, 50)
        seen_ids: set[str] = set()
        all_raw_results: list[dict] = []

        for q in query_texts:
            if not q.strip():
                continue
            q_emb = engine.encode_query(q) if engine.mode == "bge" else None
            batch = self._store.search(q, top_k=raw_limit,
                                       where=where, query_embedding=q_emb)
            for item in batch:
                mid = item.get("id", "")
                if mid and mid not in seen_ids:
                    seen_ids.add(mid)
                    all_raw_results.append(item)

        # ── 第一步：过滤 + 评分 ──
        scored = []
        for item in all_raw_results:
            meta = item["metadata"]
            # tags 过滤
            if tags:
                item_tags = set(_safe_split(meta.get("tags")))
                if not item_tags.intersection(tags):
                    continue
            if meta.get("life_stage") == "quarantined":
                continue
            if meta.get("is_parent", False):
                continue

            decay = calculate_decay(
                created_at=meta.get("created", ""),
                last_accessed=meta.get("updated"),
                reuse_count=meta.get("reuse_count", 0),
                success_count=meta.get("success_count", 0),
                half_life_days=config.decay_half_life_days,
                outcome=meta.get("outcome", "success"),
            )
            sem_score = 1.0 - (item["distance"] / 2.0)
            reuse_boost = boost_from_reuse(meta.get("reuse_count", 0),
                                           meta.get("success_count", 0))
            confidence = float(meta.get("confidence", 1.0) or 1.0)
            final_score = (sem_score * 0.7 + sem_score *
                           decay * 0.2 + reuse_boost) * confidence

            scored.append({
                "memory_id": item["id"],
                "title": meta.get("title", ""),
                "content": item.get("document", "") if meta.get("_fast_content") == "1" else "",
                "problem_solved": "",
                "solution": "",
                "outcome": meta.get("outcome", "unknown"),
                "reuse_count": meta.get("reuse_count", 0),
                "success_count": meta.get("success_count", 0),
                "score": round(final_score, 4),
                "semantic_score": round(sem_score, 4),
                "decay": round(decay, 4),
                "life_stage": meta.get("life_stage", "memory"),
                "nutrient_score": meta.get("nutrient_score", 1.0),
                "confidence": meta.get("confidence", 1.0),
                "evidence": meta.get("evidence", ""),
                "supersedes": _safe_split(meta.get("supersedes")),
                "origin_ids": _safe_split(meta.get("origin_ids")),
                "category": meta.get("category", ""),
                "observation_type": meta.get("observation_type", ""),
                "concepts": _safe_split(meta.get("concepts")),
                "facts": _safe_split(meta.get("facts")),
                "tags": _safe_split(meta.get("tags")),
                "source_agent": meta.get("source_agent", "unknown"),
                "physical_user": meta.get("physical_user", ""),
                "project_id": meta.get("project_id", ""),
                "scope": meta.get("scope", "project" if meta.get("project_id") else "general"),
                "language": meta.get("language", ""),
                # 分块元数据
                "chunk_index": int(meta.get("chunk_index", 0)),
                "total_chunks": int(meta.get("total_chunks", 1)),
                "full_content": "",
                "doc_group_id": meta.get("doc_group_id", ""),
                "cluster_id": meta.get("cluster_id", ""),
                "token_estimate": int(meta.get("token_estimate", 0) or 0),
            })

        if not scored:
            return []

        # ── 第二步：从 DocumentStore 加载内容 ──
        if not index_only:
            for s in scored:
                self._enrich_from_docstore(s)

        # ── 第三步：上下文扩展（分块 → 加载前后文段落） ──
        if not index_only and config.context_expand_enabled:
            scored = self.expand_all_contexts(
                scored,
                before_chars=config.context_expand_chars,
                after_chars=config.context_expand_chars,
            )

        # ── 第四步：相关性过滤（可选 LLM 过滤） ──
        if not index_only and config.relevance_filter_enabled and len(scored) > 1:
            try:
                scored = self.filter_relevant(query_text, scored)
            except Exception as e:
                logger.warning(f"相关性过滤异常 ({e})，跳过过滤")

        # ── 第五步：按 doc_group_id 聚合 ──
        aggregated = self._aggregate_chunks(scored, load_content=not index_only)

        # ── 第六步：ReRanker 精排（可选） ──
        if not index_only and config.reranker_enabled and len(aggregated) > 1:
            try:
                from cerebrate.core.reranker import get_reranker
                reranker = get_reranker(
                    model_name=config.reranker_model,
                    device="cpu",
                    enabled=config.reranker_enabled,
                )
                if reranker.available:
                    aggregated = reranker.rerank(
                        query_text, aggregated, top_k=limit)
            except Exception as e:
                logger.warning(f"ReRanker 异常 ({e})，使用原始排序")

        # ── 第七步：最终排序 + 多样性重排序 + 截取 ──
        aggregated.sort(key=lambda x: x.get("final_score", x.get("score", 0)), reverse=True)
        top = self._diversity_rerank(aggregated, limit)

        if top and top[0].get("score", 0) > 0.1:
            with self._stats_lock:
                self._stats["total_successes"] += 1
        if index_only:
            return [self._to_index_entry(e) for e in top]
        return top

    @staticmethod
    def _to_index_entry(e: dict) -> dict:
        """渐进式披露索引层：把完整结果压缩为紧凑索引行。

        对齐 claude-mem 索引格式（ID/标题/类型/时间/成本），
        让 agent 在扫描阶段即可判断相关性，无需读取全文。
        """
        token_estimate = int(e.get("token_estimate", 0) or 0)
        if token_estimate <= 0:
            content_len = int(e.get("_content_len", 0) or 0)
            token_estimate = estimate_tokens(
                content_len) if content_len else estimate_tokens(e.get("title", ""))
        return {
            "memory_id": e.get("memory_id", ""),
            "title": e.get("title", ""),
            "category": e.get("category", ""),
            "observation_type": e.get("observation_type", ""),
            "scope": e.get("scope", ""),
            "life_stage": e.get("life_stage", ""),
            "created": e.get("created", ""),
            "updated": e.get("updated", ""),
            "score": round(float(e.get("final_score", e.get("score", 0))), 4),
            "token_estimate": token_estimate,
            "tags": e.get("tags", []),
            "concepts": e.get("concepts", [])[:8],
            "project_id": e.get("project_id", ""),
            "source_agent": e.get("source_agent", ""),
            "reuse_count": e.get("reuse_count", 0),
            "success_count": e.get("success_count", 0),
            "outcome": e.get("outcome", ""),
            "confidence": e.get("confidence", 1.0),
            "total_chunks": e.get("total_chunks", 1),
        }
    @staticmethod
    def _diversity_rerank(results: list[dict], limit: int) -> list[dict]:
        """多样性重排序：在保持分数优先的前提下，确保结果覆盖不同的语义簇。

        算法：
        1. 按分数降序排列
        2. 贪心选择：每轮从不同 cluster_id 中挑最高分的
        3. 所有 cluster 都已覆盖后，再填充剩余名额
        4. 没有 cluster_id 的记录视为各自独立簇
        """
        if not results:
            return []

        # 按 cluster_id 分组（无 cluster_id 的各自独立）
        cluster_groups: dict[str, list[dict]] = {}
        for r in results:
            cid = r.get("cluster_id") or f"_nogroup_{id(r)}"
            cluster_groups.setdefault(cid, []).append(r)

        # 每个簇内部按分数降序
        for cid in cluster_groups:
            cluster_groups[cid].sort(
                key=lambda x: x.get("final_score", x.get("score", 0)), reverse=True)

        # 贪心轮询
        diverse: list[dict] = []
        cluster_ids = list(cluster_groups.keys())
        pointers = {cid: 0 for cid in cluster_ids}

        # 第一阶段：轮询各簇，确保每个簇至少出一个代表
        # 按每簇最高分排序簇的顺序
        cluster_ids.sort(
            key=lambda cid: cluster_groups[cid][0].get("final_score", cluster_groups[cid][0].get("score", 0)),
            reverse=True,
        )

        # 轮转选择：每次从得分最高的未选簇中取一个
        used_clusters: set[str] = set()
        for _ in range(len(cluster_ids)):
            if len(diverse) >= limit:
                break
            # 找分数最高且未在当前 diverse 中出现的簇
            best_cid = None
            best_score = -1
            for cid in cluster_ids:
                if cid in used_clusters:
                    continue
                ptr = pointers[cid]
                if ptr < len(cluster_groups[cid]):
                    item = cluster_groups[cid][ptr]
                    score = item.get("final_score", item.get("score", 0))
                    if score > best_score:
                        best_score = score
                        best_cid = cid
            if best_cid is None:
                break
            diverse.append(cluster_groups[best_cid][pointers[best_cid]])
            pointers[best_cid] += 1
            used_clusters.add(best_cid)

        # 第二阶段：名额未满，从各簇继续按分数取
        if len(diverse) < limit:
            remaining = []
            for cid in cluster_ids:
                ptr = pointers[cid]
                remaining.extend(cluster_groups[cid][ptr:])
            remaining.sort(
                key=lambda x: x.get("final_score", x.get("score", 0)), reverse=True)
            diverse.extend(remaining[:limit - len(diverse)])

        return diverse[:limit]

    def _aggregate_chunks(self, scored: list[dict],
                          load_content: bool = True) -> list[dict]:
        """将分块结果聚合为按文档归并，保留最佳块得分

        load_content=False（索引层模式）时跳过 DocumentStore 全文加载，
        直接聚合各块的元数据，避免查询索引时产生大量磁盘 IO。
        """
        groups: dict[str, dict] = {}

        for item in scored:
            # 确定分组 key：doc_group_id 优先，其次 memory_id 前缀（去掉 _cXXXX 部分）
            group_key = item.get("doc_group_id") or ""
            if not group_key:
                mid = item.get("memory_id", "")
                if "_c" in mid and mid.rfind("_c") > len(mid) - 10:
                    group_key = mid[:mid.rfind("_c")]
                else:
                    group_key = mid

            if group_key not in groups:
                # 新组：复制一份作为组代表
                groups[group_key] = dict(item)
                groups[group_key]["_chunks"] = [item]
                groups[group_key]["_max_score"] = item.get("score", 0)
                # 保留上下文字段
                for ctx_key in ("_expanded_context", "_context_range",
                                "_source_range", "_relevance", "_relevance_reason"):
                    if ctx_key in item:
                        groups[group_key][ctx_key] = item[ctx_key]
            else:
                # 已有组：更新最佳得分
                groups[group_key]["_chunks"].append(item)
                score = item.get("score", 0)
                if score > groups[group_key]["_max_score"]:
                    groups[group_key]["_max_score"] = score
                    # 将最佳匹配块的部分字段提升到组代表
                    groups[group_key]["content"] = item.get("content", groups[group_key]["content"])
                    groups[group_key]["chunk_index"] = item.get("chunk_index", 0)
                    groups[group_key]["semantic_score"] = item.get("semantic_score", 0)
                    groups[group_key]["score"] = score
                    # 同时提升上下文字段
                    for ctx_key in ("_expanded_context", "_context_range",
                                    "_source_range", "_relevance", "_relevance_reason"):
                        if ctx_key in item:
                            groups[group_key][ctx_key] = item[ctx_key]

        # ── 重建完整内容 ──
        result = []
        for group_key, group in groups.items():
            chunks = sorted(group.pop("_chunks", []),
                            key=lambda x: x.get("chunk_index", 0))
            max_score = group.pop("_max_score", 0)

            # ── 从 DocumentStore 加载完整内容（索引层模式跳过） ──
            full = ""
            if load_content:
                # 尝试从 docstore 加载父文档
                parent_doc = self._docstore_get(group_key)
                if parent_doc:
                    full = parent_doc.get("content", "")
                if not full:
                    # 降级：拼接各块内容
                    parts = [ch.get("content", "") for ch in chunks]
                    full = "\n\n".join(parts) if len(parts) > 1 else (parts[0] if parts else "")
                # 再次降级：尝试从第一个块加载
                if not full and chunks:
                    chunk_doc = self._docstore_get(chunks[0].get("memory_id", ""))
                    if chunk_doc:
                        full = chunk_doc.get("content", "")

            # 构建最终结果
            entry = {
                "memory_id": group_key,
                "title": group.get("title", ""),
                "content": full,  # 完整内容（聚合后）
                "problem_solved": group.get("problem_solved", ""),
                "solution": group.get("solution", ""),
                "outcome": group.get("outcome", "unknown"),
                "reuse_count": group.get("reuse_count", 0),
                "success_count": group.get("success_count", 0),
                "score": max_score,
                "semantic_score": group.get("semantic_score", 0),
                "decay": group.get("decay", 0),
                "life_stage": group.get("life_stage", "memory"),
                "nutrient_score": group.get("nutrient_score", 1.0),
                "confidence": group.get("confidence", 1.0),
                "evidence": group.get("evidence", ""),
                "supersedes": group.get("supersedes", []),
                "origin_ids": group.get("origin_ids", []),
                "category": group.get("category", ""),
                "observation_type": group.get("observation_type", ""),
                "facts": group.get("facts", []),
                "concepts": group.get("concepts", []),
                "tags": group.get("tags", []),
                "source_agent": group.get("source_agent", "unknown"),
                "physical_user": group.get("physical_user", ""),
                "project_id": group.get("project_id", ""),
                "scope": group.get("scope", "project" if group.get("project_id") else "general"),
                "language": group.get("language", ""),
                "total_chunks": len(chunks),
                "final_score": max_score,  # ReRanker 可能覆盖
                # 渐进式披露索引层字段（聚合时透传）
                "token_estimate": int(group.get("token_estimate", 0) or 0),
                "_content_len": group.get("_content_len", 0),
                # 携带最佳块的扩展上下文和来源范围
                "_expanded_context": group.get("_expanded_context", full),
                "_context_range": group.get("_context_range", {}),
                "_source_range": group.get("_source_range", {}),
                "_relevance": group.get("_relevance", max_score),
                "_relevance_reason": group.get("_relevance_reason", ""),
            }
            result.append(entry)

        return result

    # ==================== 反馈 ====================

    def _get_mem_lock(self, memory_id: str) -> threading.Lock:
        with self._mem_locks_lock:
            if memory_id not in self._mem_locks:
                self._mem_locks[memory_id] = threading.Lock()
            return self._mem_locks[memory_id]

    def mark_reused(self, memory_id: str, success: bool = True, feedback: str = ""):
        # 先标记主条目
        item = self._store.get(memory_id)
        parent_found = False
        if item:
            parent_found = bool(item["metadata"].get("is_parent", False))
            self._mark_item_reused(item, success, feedback)

        # 如果主条目是 parent（分块文档）或未找到，标记所有分块
        if parent_found or not item:
            chunks = self._store.get_items_by_where(
                {"doc_group_id": memory_id})
            for ch in chunks:
                self._mark_item_reused(ch, success, feedback)
        elif not parent_found and item:
            pass
        # 同步元数据到 PostgreSQL
        try:
            if self._ms.available:
                self._ms.mark_reused(memory_id, success, feedback)
        except Exception:
            pass

    def _mark_item_reused(self, item: dict, success: bool, feedback: str):
        with self._get_mem_lock(item["id"]):
            meta = item["metadata"]
            meta["reuse_count"] = meta.get("reuse_count", 0) + 1
            if success:
                meta["success_count"] = meta.get("success_count", 0) + 1
            if feedback:
                previous = meta.get("evidence", "")
                meta["evidence"] = (
                    previous + "\n" if previous else "") + feedback[:500]
            meta["updated"] = datetime.now(timezone.utc).isoformat()
            meta["score"] = self._calculate_swarm_score(meta)
            # 从 DocumentStore 加载内容用于重新嵌入
            doc = self._docstore_get(item["id"])
            if doc:
                text = self._build_search_text(
                    meta.get('title', ''),
                    doc.get('content', ''),
                    problem_solved=doc.get('problem_solved', ''),
                    solution=doc.get('solution', ''))
            else:
                text = meta.get("title", "")
            self._store.upsert(item["id"], text, meta)

    # ==================== 统计与列表 ====================

    def get_stats(self) -> dict:
        with self._stats_lock:
            return dict(self._stats)

    def list_categories(self) -> list[str]:
        metadatas = self._store.get_all_metadata(limit=1000)
        cats = set()
        for meta in metadatas:
            cat = meta.get("category", "")
            if cat:
                cats.add(cat)
        return list(cats)

    def list_projects(self) -> list[str]:
        metadatas = self._store.get_all_metadata(limit=1000)
        projects = set()
        for meta in metadatas:
            pid = meta.get("project_id", "")
            if pid:
                projects.add(pid)
        return list(projects)

    def scope_counts(self) -> dict:
        """统计通用记忆 / 项目记忆数量（含各项目分布）"""
        metadatas = self._store.get_all_metadata(limit=1000)
        result = {"general": 0, "project": 0, "by_project": {}}
        for meta in metadatas:
            if meta.get("is_parent", False):
                continue
            scope = meta.get("scope") or (
                "project" if meta.get("project_id") else "general")
            if scope == "general":
                result["general"] += 1
            else:
                result["project"] += 1
                pid = meta.get("project_id", "") or "unknown"
                result["by_project"][pid] = result["by_project"].get(pid, 0) + 1
        return result

    def list_tags(self) -> list[str]:
        metadatas = self._store.get_all_metadata(limit=1000)
        tagset = set()
        for meta in metadatas:
            for t in _safe_split(meta.get("tags")):
                if t.strip():
                    tagset.add(t.strip())
        return list(tagset)

    def get_memory(self, memory_id: str) -> Optional[dict]:
        item = self._store.get(memory_id)
        if item:
            meta = item["metadata"]
            is_parent = meta.get("is_parent", False) or meta.get("total_chunks", 1) > 1
            if is_parent:
                # parent 条目无内容，从分块聚合
                return self._aggregate_memory_from_chunks(memory_id, meta)
            result = self._item_to_dict(item["id"], meta)
            # 从 DocumentStore 加载完整内容
            return self._enrich_from_docstore(result)

        # 可能是分块文档的 doc_group_id：尝试查找分块
        return self._aggregate_memory_from_chunks(memory_id)

    def _aggregate_memory_from_chunks(self, doc_group_id: str,
                                      parent_meta: Optional[dict] = None) -> Optional[dict]:
        """从分块聚合完整记忆内容，内容从 DocumentStore 加载"""
        chunks = self._store.get_items_by_where(
            {"doc_group_id": doc_group_id})
        if not chunks:
            return None

        base = dict(parent_meta) if parent_meta else dict(chunks[0]["metadata"])

        # 从 DocumentStore 加载完整内容
        full_content = ""
        parent_doc = self._docstore_get(doc_group_id)
        if parent_doc:
            full_content = parent_doc.get("content", "")
        if not full_content:
            # 降级：拼接各块内容
            chunks_sorted = sorted(chunks, key=lambda x: int(
                x["metadata"].get("chunk_index", 0)))
            parts = [ch["metadata"].get("content", "") for ch in chunks_sorted]
            full_content = "\n\n".join(parts) if len(parts) > 1 else (parts[0] if parts else "")

        base["content"] = full_content
        base["total_chunks"] = len(chunks)
        return self._item_to_dict(doc_group_id, base)

    def delete_memory(self, memory_id: str) -> bool:
        # 从 DocumentStore 删除
        self._docstore_delete(memory_id)

        # PostgreSQL 软删除（不删记录，设 status=archived）
        try:
            if self._ms.available:
                self._ms.delete_document(memory_id)
        except Exception:
            pass

        item = self._store.get(memory_id)
        if item:
            meta = item["metadata"]
            has_chunks = meta.get("is_parent", False) or meta.get("total_chunks", 1) > 1
            # 先删所有分块
            if has_chunks:
                chunks = self._store.get_items_by_where(
                    {"doc_group_id": memory_id})
                for ch in chunks:
                    self._store.delete(ch["id"])
                    self._docstore_delete(ch["id"])
            # 再删主条目
            self._store.delete(memory_id)
            with self._stats_lock:
                self._stats["total"] = max(0, self._stats["total"] - 1)
                self._dirty = True
            return True

        # 按 doc_group_id 查找分块
        chunks = self._store.get_items_by_where(
            {"doc_group_id": memory_id})
        if chunks:
            for ch in chunks:
                self._store.delete(ch["id"])
                self._docstore_delete(ch["id"])
            with self._stats_lock:
                self._stats["total"] = max(0, self._stats["total"] - 1)
                self._dirty = True
            return True

        return False

    def load_memory_raw(self, memory_id: str) -> Optional[dict]:
        """公共接口: 加载完整记忆元数据（分块文档自动聚合）."""
        return self._load_memory(memory_id)

    def _load_memory(self, memory_id: str) -> Optional[dict]:
        """兼容旧调用者的内部接口（含 DocumentStore 加载）."""
        item = self._store.get(memory_id)
        if item:
            meta = item["metadata"]
            meta["memory_id"] = item["id"]
            is_parent = meta.get("is_parent", False) or meta.get("total_chunks", 1) > 1
            if is_parent:
                result = self._aggregate_memory_from_chunks(memory_id, meta)
                if result:
                    return {"memory_id": memory_id, **result}
            # 短记忆：内容已在 ChromaDB document 字段
            chroma_content = item.get("document", "")
            if chroma_content and meta.get("_fast_content") == "1":
                meta["content"] = chroma_content
                return meta
            # 从 DocumentStore 加载内容
            doc = self._docstore_get(memory_id)
            if doc:
                meta["content"] = doc.get("content", "")
                meta["problem_solved"] = doc.get("problem_solved", "")
                meta["solution"] = doc.get("solution", "")
            return meta
        return self._load_memory_from_chunks(memory_id)

    def _load_memory_from_chunks(self, memory_id: str) -> Optional[dict]:
        """分块文档聚合加载（从 DocumentStore）"""
        # 先尝试 docstore 父文档
        doc = self._docstore_get(memory_id)
        if doc:
            return {
                "memory_id": memory_id,
                "content": doc.get("content", ""),
                "title": doc.get("title", ""),
                "problem_solved": doc.get("problem_solved", ""),
                "solution": doc.get("solution", ""),
                "evidence": doc.get("evidence", ""),
                "source_agent": doc.get("source_agent", ""),
                "physical_user": doc.get("physical_user", ""),
                "total_chunks": doc.get("total_chunks", 1),
            }

        # 降级：从 ChromaDB 分块聚合
        chunks = self._store.get_items_by_where(
            {"doc_group_id": memory_id})
        if not chunks:
            return None
        base = dict(chunks[0]["metadata"])
        base["memory_id"] = memory_id
        parts = [
            c["metadata"].get("content", "")
            for c in sorted(chunks, key=lambda x: int(
                x["metadata"].get("chunk_index", 0)))
        ]
        base["content"] = "\n\n".join(parts)
        return base

    def update_lifecycle(self, memory_id: str, life_stage: str,
                         confidence: Optional[float] = None,
                         evidence: str = "") -> bool:
        # 尝试直接查找
        item = self._store.get(memory_id)
        parent_found = False
        success = False
        if item:
            parent_found = bool(item["metadata"].get("is_parent", False))
            success = self._update_item_lifecycle(item["id"], item["metadata"],
                                                   life_stage, confidence, evidence)

        # 如果是分块文档，更新所有分块
        if parent_found:
            chunks = self._store.get_items_by_where(
                {"doc_group_id": memory_id})
            for ch in chunks:
                self._update_item_lifecycle(ch["id"], ch["metadata"],
                                             life_stage, confidence, evidence)
            success = True
        elif not item:
            # 分块文档但 parent 不在（降级路径）
            chunks = self._store.get_items_by_where(
                {"doc_group_id": memory_id})
            if chunks:
                for ch in chunks:
                    self._update_item_lifecycle(ch["id"], ch["metadata"],
                                                 life_stage, confidence, evidence)
                success = True

        # 同步元数据到 PostgreSQL
        try:
            if self._ms.available:
                self._ms.update_lifecycle(memory_id, life_stage,
                                           confidence, evidence)
        except Exception:
            pass

        return success

    def _update_item_lifecycle(self, item_id: str, meta: dict,
                                life_stage: str,
                                confidence: Optional[float] = None,
                                evidence: str = "") -> bool:
        if life_stage not in LIFE_STAGES:
            return False
        with self._get_mem_lock(item_id):
            meta["life_stage"] = life_stage
            if confidence is not None:
                meta["confidence"] = float(confidence)
            if evidence:
                previous = meta.get("evidence", "")
                meta["evidence"] = (
                    previous + "\n" if previous else "") + evidence
            meta["updated"] = datetime.now(timezone.utc).isoformat()
            # 从 DocumentStore 加载内容用于重新嵌入
            doc = self._docstore_get(item_id)
            if doc:
                text = self._build_search_text(
                    meta.get('title', ''),
                    doc.get('content', ''),
                    problem_solved=doc.get('problem_solved', ''),
                    solution=doc.get('solution', ''),
                    evidence=meta.get('evidence', ''))
            else:
                text = meta.get("title", "")
            self._store.upsert(item_id, text, meta)
            return True

    def lifecycle_counts(self) -> dict:
        ids = self.get_all_memory_ids()
        seen_groups = set()
        counts = {stage: 0 for stage in sorted(LIFE_STAGES)}
        for mid in ids:
            # 跳过分块子 ID（以 _cXXXX 结尾的）
            if "_c" in mid and mid[mid.rfind("_c") + 2:].isdigit():
                continue
            item = self._store.get(mid)
            if item:
                stage = item["metadata"].get("life_stage", "memory")
                counts[stage] = counts.get(stage, 0) + 1
        return counts

    def get_all_memory_ids(self) -> list[str]:
        return self._store.get_all_ids()

    # ==================== 内部 ====================

    def _item_to_dict(self, memory_id: str, meta: dict) -> dict:
        """将 ChromaDB 元数据转为标准返回字典"""
        return {
            "memory_id": memory_id,
            "title": meta.get("title", ""),
            "content": meta.get("content", ""),
            "problem_solved": meta.get("problem_solved", ""),
            "solution": meta.get("solution", ""),
            "outcome": meta.get("outcome", ""),
            "reuse_count": meta.get("reuse_count", 0),
            "success_count": meta.get("success_count", 0),
            "life_stage": meta.get("life_stage", "memory"),
            "nutrient_score": meta.get("nutrient_score", 1.0),
            "confidence": meta.get("confidence", 1.0),
            "evidence": meta.get("evidence", ""),
            "supersedes": _safe_split(meta.get("supersedes")),
            "origin_ids": _safe_split(meta.get("origin_ids")),
            "category": meta.get("category", ""),
            "observation_type": meta.get("observation_type", ""),
            "facts": _safe_split(meta.get("facts")),
            "concepts": _safe_split(meta.get("concepts")),
            "tags": _safe_split(meta.get("tags")),
            "source_agent": meta.get("source_agent", ""),
            "physical_user": meta.get("physical_user", ""),
            "project_id": meta.get("project_id", ""),
            "scope": meta.get("scope", "project" if meta.get("project_id") else "general"),
            "created": meta.get("created", ""),
            "total_chunks": meta.get("total_chunks", 1),
        }

    def _calculate_swarm_score(self, meta: dict) -> float:
        reuse = meta.get("reuse_count", 0)
        success = meta.get("success_count", 0)
        score = 0.5
        if reuse > 0:
            score += 0.3 * (success / reuse)
        score += 0.2 * min(reuse / 100, 1.0)
        return min(score, 1.0)
