
"""嵌入引擎 — 文本向量化，BGE 模型优先，本地 hash 回退"""
import hashlib
import logging
import math
import re
import threading
from collections import OrderedDict
from typing import Optional

from cerebrate.config import config

logger = logging.getLogger(__name__)

# 延迟加载单例
_engine: Optional["EmbeddingEngine"] = None
_engine_lock = threading.Lock()

# 线程安全锁：PyTorch/BGE 模型不是线程安全的，多线程并发调用 encode 可能导致 segfault
_encode_lock = threading.Lock()
# 查询向量 LRU 缓存（高频查询复用编码结果，减 _encode_lock 串行压力，阶段 1 扩展）
_query_cache: "OrderedDict[str, list[float]]" = OrderedDict()
_query_cache_lock = threading.Lock()
# 查询缓存命中/未命中计数（供 /v1/status 调度信号：高频查询复用度）
_query_cache_hits = 0
_query_cache_misses = 0


def get_embedding_engine(model_name: str = "BAAI/bge-small-zh-v1.5",
                         device: str = "cpu") -> "EmbeddingEngine":
    """获取嵌入引擎单例（线程安全）"""
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:  # double-checked locking
                _engine = EmbeddingEngine(model_name, device)
    return _engine


def query_cache_stats() -> dict:
    """查询向量缓存统计（供 /v1/status 调度信号）。

    返回当前缓存占用、容量、命中/未命中计数与命中率——
    AI 据此判断「高频查询是否已被缓存复用，现在查询代价高低」。
    """
    global _query_cache_hits, _query_cache_misses
    with _query_cache_lock:
        hits = _query_cache_hits
        misses = _query_cache_misses
        size = len(_query_cache)
        capacity = config.embedding_query_cache_size
        total = hits + misses
        return {
            "size": size,
            "capacity": capacity,
            "hits": hits,
            "misses": misses,
            "hit_rate": round(hits / total, 3) if total else 0.0,
        }


class EmbeddingEngine:
    """文本向量化引擎

    优先使用 sentence-transformers + BGE 模型（推荐 BAAI/bge-m3，8192 tokens），
    不可用时回退到确定性本地 hash 向量。
    """

    def __init__(self, model_name: str = "BAAI/bge-m3",
                 device: str = "cpu"):
        self.model_name = model_name
        self.device = device
        self._model = None
        self._mode = None  # "bge" | "hash"
        self._dimension = config.embedding_hash_dim
        self._max_length: int = config.embedding_max_length
        self._model_max_length: int = 512  # 从模型读取的实际限制
        self._init_model()

    def _init_model(self):
        """尝试加载 BGE 模型，失败则回退 hash"""
        try:
            from sentence_transformers import SentenceTransformer
            kwargs = {"device": self.device}
            if not config.embedding_allow_download:
                kwargs["local_files_only"] = True
            self._model = SentenceTransformer(self.model_name, **kwargs)
            self._mode = "bge"
            dim = getattr(self._model, 'get_embedding_dimension',
                          getattr(self._model, 'get_sentence_embedding_dimension', lambda: 1024))()
            self._dimension = dim
            # 读取模型自身的 max_seq_length
            model_max = getattr(self._model, 'max_seq_length', None)
            if model_max:
                self._model_max_length = model_max
            logger.info(f"嵌入引擎: BGE ({self.model_name}, {dim}维, 最大序列长度={self._model_max_length})")
        except Exception as e:
            logger.warning(f"BGE 模型加载失败 ({e})，回退到 hash")
            self._init_hash()

    def _init_hash(self):
        self._model = None
        self._mode = "hash"
        self._dimension = config.embedding_hash_dim
        logger.info(f"嵌入引擎: hash ({self._dimension}维，本地离线模式)")

    @property
    def mode(self) -> str:
        return self._mode or "unknown"

    @property
    def dimension(self) -> int:
        if self._mode == "bge" and self._model:
            return getattr(self._model, 'get_embedding_dimension',
                           getattr(self._model, 'get_sentence_embedding_dimension', lambda: self._dimension))()
        return self._dimension

    def encode(self, texts: list[str], max_length: Optional[int] = None) -> list[list[float]]:
        """将文本列表编码为向量列表（线程安全）"""
        if not texts:
            return []
        effective_max = max_length or self._max_length
        with _encode_lock:
            if self._mode == "bge" and self._model:
                # 检查并警告截断（max_length 仅用于日志，实际截断由模型 tokenizer 自动处理）
                for i, t in enumerate(texts):
                    token_count = len(self._model.tokenizer.encode(t)) if hasattr(self._model, 'tokenizer') else len(t)
                    if token_count > effective_max:
                        logger.warning(
                            f"文本 #{i} 超过模型最大长度 "
                            f"({token_count} > {effective_max} tokens)，"
                            f"将截断前 {effective_max} tokens"
                        )
                embeddings = self._model.encode(
                    texts,
                    normalize_embeddings=True,
                    show_progress_bar=False,
                )
                return embeddings.tolist()
            return [self._hash_encode(text) for text in texts]

    def encode_query(self, query: str, max_length: Optional[int] = None) -> list[float]:
        """编码查询文本（BGE 需要加前缀，线程安全）"""
        global _query_cache_hits, _query_cache_misses
        # LRU 缓存：相同查询直接命中，避免重复编码（阶段 1 扩展）
        cache_key = query if max_length is None else f"{query}\x00{max_length}"
        with _query_cache_lock:
            hit = _query_cache.get(cache_key)
            if hit is not None:
                _query_cache.move_to_end(cache_key)
                _query_cache_hits += 1
                return hit
            _query_cache_misses += 1
        with _encode_lock:
            if self._mode == "bge" and self._model:
                prefixed = f"为这个句子生成表示以用于检索相关文章：{query}"
                emb = self._model.encode(
                    prefixed,
                    normalize_embeddings=True,
                    show_progress_bar=False,
                )
                result = emb.tolist()
            else:
                result = self._hash_encode(query)
        with _query_cache_lock:
            _query_cache[cache_key] = result
            if len(_query_cache) > config.embedding_query_cache_size:
                _query_cache.popitem(last=False)
        return result

    def _hash_encode(self, text: str) -> list[float]:
        """确定性特征哈希向量，保证无网络时 Chroma 仍可查询。"""
        vector = [0.0] * self._dimension
        tokens = re.findall(r"[\w\u4e00-\u9fff]+", (text or "").lower())
        if not tokens:
            tokens = [text or ""]
        for token in tokens:
            digest = hashlib.blake2b(token.encode(
                "utf-8"), digest_size=8).digest()
            bucket = int.from_bytes(digest[:4], "big") % self._dimension
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vector[bucket] += sign
        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]
