"""虫群共享记忆层 v5 — 服务端权威内核 + ChromaDB 向量存储

v5.1 改进:
  - 长文档自动语义分块（按标题/段落/等长切割）
  - 查询结果按 origin_ids 聚合（同一文档的多块合并返回）
  - 可选 ReRanker 交叉编码器精排
  - 显式 max_length 控制 + 截断警告
"""
import hashlib
import logging
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
              project_id: str = "", language: str = "",
              life_stage: str = "memory", nutrient_score: float = 1.0,
              confidence: float = 1.0, evidence: str = "",
              supersedes: Optional[list[str]] = None,
              origin_ids: Optional[list[str]] = None,
              physical_user: str = "",
              memory_id: Optional[str] = None) -> str:
        """向虫群共享记忆

        架构:
          1. 完整内容（content/problem_solved/solution）写入 DocumentStore
          2. 仅运营元数据（title/category/tags/lifecycle）写入 ChromaDB 索引
          3. 长文档自动分块，每块独立向量化，共享 doc_group_id
        """
        project_id = project_id or config.current_project_id
        language = language or config.default_language
        now = datetime.now(timezone.utc).isoformat()
        supersedes = supersedes or []
        origin_ids = origin_ids or []

        life_stage = life_stage if life_stage in LIFE_STAGES else "memory"

        # ── 生成主 memory_id（文档级 ID）──
        if memory_id is None:
            memory_id = hashlib.sha256(
                f"{title}{category}{now}".encode()
            ).hexdigest()[:16]

        # ── 是否需要分块？ ──
        should_chunk = (
            config.chunk_enabled
            and len(content) > config.chunk_max_chars
        )

        if not should_chunk:
            # ── 不分块：内容→DocumentStore，运营元数据→ChromaDB ──
            self._docstore_put(memory_id, {
                "title": title, "content": content,
                "problem_solved": problem_solved, "solution": solution,
                "evidence": evidence, "created": now,
                "source_agent": source_agent,
                "physical_user": physical_user or "",
                "total_chunks": 1,
            })
            search_text = self._build_search_text(
                title, content,
                problem_solved=problem_solved,
                solution=solution,
                evidence=evidence)
            meta = self._build_metadata(
                title=title, content="", category=category, tags=tags,
                source_agent=source_agent, physical_user=physical_user,
                problem_solved="", solution="",
                outcome=outcome, project_id=project_id, language=language,
                life_stage=life_stage, nutrient_score=nutrient_score,
                confidence=confidence, evidence=evidence,
                supersedes=supersedes, origin_ids=origin_ids,
                created=now, updated=now,
                chunk_index=0, total_chunks=1, full_content="",
            )
            self._store.add(memory_id, search_text, meta)
            with self._stats_lock:
                self._stats["total"] += 1
                self._dirty = True
            # 同步元数据到 PostgreSQL
            self._sync_meta(memory_id, title=title, category=category,
                            tags=tags, source_agent=source_agent,
                            physical_user=physical_user or "",
                            project_id=project_id, language=language,
                            life_stage=life_stage, outcome=outcome,
                            confidence=confidence, total_chunks=1)
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

        # ── 保存完整文档到 DocumentStore ──
        self._docstore_put(memory_id, {
            "title": title, "content": content,
            "problem_solved": problem_solved, "solution": solution,
            "evidence": evidence, "created": now,
            "source_agent": source_agent,
            "physical_user": physical_user or "",
            "total_chunks": total_chunks,
            "doc_group_id": doc_group_id,
        })

        for chunk in chunks:
            ci = chunk["index"]
            chunk_text = chunk["text"]
            chunk_mid = f"{memory_id}_c{ci:04d}"
            chunk_origin_ids = origin_ids + [memory_id] if ci == 0 else [memory_id]

            # 每块的片段文本也存到 DocumentStore（含偏移量）
            self._docstore_put(chunk_mid, {
                "doc_group_id": doc_group_id,
                "chunk_index": ci,
                "total_chunks": total_chunks,
                "content": chunk_text,
                "start_char": chunk.get("start_char", 0),
                "end_char": chunk.get("end_char", len(chunk_text)),
            })

            search_text = self._build_search_text(
                title, chunk_text)
            chunk_meta = self._build_metadata(
                title=title, content="", category=category, tags=tags,
                source_agent=source_agent, physical_user=physical_user,
                problem_solved="", solution="",
                outcome=outcome, project_id=project_id, language=language,
                life_stage=life_stage, nutrient_score=nutrient_score,
                confidence=confidence, evidence=evidence,
                supersedes=supersedes, origin_ids=chunk_origin_ids,
                created=now, updated=now,
                chunk_index=ci, total_chunks=total_chunks,
                full_content="",
                doc_group_id=doc_group_id,
            )
            self._store.add(chunk_mid, search_text, chunk_meta)

        # ── 写入 parent 占位条目（供 lifecycle_counts 统计）──
        parent_meta = self._build_metadata(
            title=title, content="", category=category, tags=tags,
            source_agent=source_agent, physical_user=physical_user,
            problem_solved="", solution="",
            outcome=outcome, project_id=project_id, language=language,
            life_stage=life_stage, nutrient_score=nutrient_score,
            confidence=confidence, evidence=evidence,
            supersedes=supersedes, origin_ids=origin_ids,
            created=now, updated=now,
            chunk_index=0, total_chunks=total_chunks,
            full_content="",
            doc_group_id="",
            is_parent=True,
        )
        self._store.add(memory_id, title, parent_meta)

        with self._stats_lock:
            self._stats["total"] += 1
            self._dirty = True
        # 同步元数据到 PostgreSQL
        self._sync_meta(memory_id, title=title, category=category,
                        tags=tags, source_agent=source_agent,
                        physical_user=physical_user or "",
                        project_id=project_id, language=language,
                        life_stage=life_stage, outcome=outcome,
                        confidence=confidence, total_chunks=total_chunks)
        return memory_id

    def _docstore_put(self, doc_id: str, data: dict):
        """安全写入 DocumentStore"""
        if self._docstore:
            try:
                self._docstore.put(doc_id, data)
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

        注意：evidence 是运营字段（feedback 动态追加），
        不从 docstore 覆盖，以 ChromaDB 中的为准。
        """
        mem_id = entry.get("memory_id", "")

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
                        solution, outcome, project_id, language,
                        life_stage, nutrient_score, confidence, evidence,
                        supersedes, origin_ids,
                        created, updated,
                        chunk_index=0, total_chunks=1, full_content="",
                        doc_group_id="", is_parent=False) -> dict:
        """构建统一的元数据字典"""
        return {
            "title": title,
            "content": content,
            "category": category,
            "tags": ",".join(tags),
            "source_agent": source_agent,
            "physical_user": physical_user or "",
            "problem_solved": problem_solved,
            "solution": solution,
            "outcome": outcome,
            "project_id": project_id,
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
        }

    # ==================== 查询 ====================

    def query(self, query_text: str = "", category: Optional[str] = None,
              tags: Optional[list[str]] = None, limit: int = 10,
              project_id: Optional[str] = None,
              source_agent: Optional[str] = None,
              query_texts: Optional[list[str]] = None) -> list[dict]:
        """向量语义查询，支持多角度查询 + 分块聚合 + 可选 ReRanker 精排

        查询流程:
          0. 多查询重写（可选）：从多个角度检索
          1. ChromaDB 语义向量搜索（粗筛）
          2. Tags 过滤 + 衰减评分
          3. 按 doc_group_id 聚合分块（同一文档的多块合并）
          4. （可选）ReRanker 交叉编码器精排
          5. 返回按 final_score 降序的结果
        """
        with self._stats_lock:
            self._stats["total_queries"] += 1
            self._dirty = True

        # 构建 ChromaDB where 过滤条件
        conditions = []
        if project_id is not None:
            pid = project_id if project_id else config.current_project_id
            conditions.append({"project_id": {"$in": [pid, ""]}})
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
                item_tags = set((meta.get("tags") or "").split(","))
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
                "content": "",  # 完整内容在 DocumentStore 中
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
                "supersedes": [s for s in (meta.get("supersedes") or "").split(",") if s],
                "origin_ids": [s for s in (meta.get("origin_ids") or "").split(",") if s],
                "category": meta.get("category", ""),
                "tags": (meta.get("tags") or "").split(","),
                "source_agent": meta.get("source_agent", "unknown"),
                "physical_user": meta.get("physical_user", ""),
                "project_id": meta.get("project_id", ""),
                "language": meta.get("language", ""),
                # 分块元数据
                "chunk_index": int(meta.get("chunk_index", 0)),
                "total_chunks": int(meta.get("total_chunks", 1)),
                "full_content": "",
                "doc_group_id": meta.get("doc_group_id", ""),
                "cluster_id": meta.get("cluster_id", ""),
            })

        if not scored:
            return []

        # ── 第二步：从 DocumentStore 加载内容 ──
        for s in scored:
            self._enrich_from_docstore(s)

        # ── 第三步：上下文扩展（分块 → 加载前后文段落） ──
        if config.context_expand_enabled:
            scored = self.expand_all_contexts(
                scored,
                before_chars=config.context_expand_chars,
                after_chars=config.context_expand_chars,
            )

        # ── 第四步：相关性过滤（可选 LLM 过滤） ──
        if config.relevance_filter_enabled and len(scored) > 1:
            try:
                scored = self.filter_relevant(query_text, scored)
            except Exception as e:
                logger.warning(f"相关性过滤异常 ({e})，跳过过滤")

        # ── 第五步：按 doc_group_id 聚合 ──
        aggregated = self._aggregate_chunks(scored)

        # ── 第六步：ReRanker 精排（可选） ──
        if config.reranker_enabled and len(aggregated) > 1:
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
        return top

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

    def _aggregate_chunks(self, scored: list[dict]) -> list[dict]:
        """将分块结果聚合为按文档归并，保留最佳块得分"""
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

            # ── 从 DocumentStore 加载完整内容 ──
            full = ""
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
                "tags": group.get("tags", []),
                "source_agent": group.get("source_agent", "unknown"),
                "physical_user": group.get("physical_user", ""),
                "project_id": group.get("project_id", ""),
                "language": group.get("language", ""),
                "total_chunks": len(chunks),
                "final_score": max_score,  # ReRanker 可能覆盖
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

    def list_tags(self) -> list[str]:
        metadatas = self._store.get_all_metadata(limit=1000)
        tagset = set()
        for meta in metadatas:
            for t in (meta.get("tags") or "").split(","):
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
            "supersedes": [s for s in (meta.get("supersedes") or "").split(",") if s],
            "origin_ids": [s for s in (meta.get("origin_ids") or "").split(",") if s],
            "category": meta.get("category", ""),
            "tags": (meta.get("tags") or "").split(","),
            "source_agent": meta.get("source_agent", ""),
            "physical_user": meta.get("physical_user", ""),
            "project_id": meta.get("project_id", ""),
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
