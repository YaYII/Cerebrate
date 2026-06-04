"""嵌入引擎 — 文本向量化，BGE 模型优先，本地 hash 回退"""
import hashlib
import logging
import math
import re
from typing import Optional

from cerebrate.config import config

logger = logging.getLogger(__name__)

# 延迟加载单例
_engine: Optional["EmbeddingEngine"] = None


def get_embedding_engine(model_name: str = "BAAI/bge-small-zh-v1.5",
                         device: str = "cpu") -> "EmbeddingEngine":
    """获取嵌入引擎单例"""
    global _engine
    if _engine is None:
        _engine = EmbeddingEngine(model_name, device)
    return _engine


class EmbeddingEngine:
    """文本向量化引擎

    优先使用 sentence-transformers + BGE 模型，
    不可用时回退到确定性本地 hash 向量。
    """

    def __init__(self, model_name: str = "BAAI/bge-small-zh-v1.5",
                 device: str = "cpu"):
        self.model_name = model_name
        self.device = device
        self._model = None
        self._mode = None  # "bge" | "hash"
        self._dimension = config.embedding_hash_dim
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
                         getattr(self._model, 'get_sentence_embedding_dimension', lambda: 384))()
            self._dimension = dim
            logger.info(f"嵌入引擎: BGE ({self.model_name}, {dim}维)")
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

    def encode(self, texts: list[str]) -> list[list[float]]:
        """将文本列表编码为向量列表"""
        if not texts:
            return []
        if self._mode == "bge" and self._model:
            embeddings = self._model.encode(
                texts,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            return embeddings.tolist()
        return [self._hash_encode(text) for text in texts]

    def encode_query(self, query: str) -> list[float]:
        """编码查询文本（BGE 需要加前缀）"""
        if self._mode == "bge" and self._model:
            # BGE 模型查询时需要加 instruction 前缀
            emb = self._model.encode(
                f"为这个句子生成表示以用于检索相关文章：{query}",
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            return emb.tolist()
        return self._hash_encode(query)

    def encode_document(self, text: str) -> list[float]:
        """编码文档文本"""
        if self._mode == "bge" and self._model:
            emb = self._model.encode(
                text,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            return emb.tolist()
        return self._hash_encode(text)

    def _hash_encode(self, text: str) -> list[float]:
        """确定性特征哈希向量，保证无网络时 Chroma 仍可查询。"""
        vector = [0.0] * self._dimension
        tokens = re.findall(r"[\w\u4e00-\u9fff]+", (text or "").lower())
        if not tokens:
            tokens = [text or ""]
        for token in tokens:
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            bucket = int.from_bytes(digest[:4], "big") % self._dimension
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vector[bucket] += sign
        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]
"""嵌入引擎 — 文本向量化，BGE 模型优先，本地 hash 回退"""
import hashlib
import logging
import math
import re
import threading
from typing import Optional

from cerebrate.config import config

logger = logging.getLogger(__name__)

# 延迟加载单例
_engine: Optional["EmbeddingEngine"] = None
_engine_lock = threading.Lock()

# 线程安全锁：PyTorch/BGE 模型不是线程安全的，多线程并发调用 encode 可能导致 segfault
_encode_lock = threading.Lock()


def get_embedding_engine(model_name: str = "BAAI/bge-small-zh-v1.5",
                         device: str = "cpu") -> "EmbeddingEngine":
    """获取嵌入引擎单例（线程安全）"""
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:  # double-checked locking
                _engine = EmbeddingEngine(model_name, device)
    return _engine


class EmbeddingEngine:
    """文本向量化引擎

    优先使用 sentence-transformers + BGE 模型，
    不可用时回退到确定性本地 hash 向量。
    """

    def __init__(self, model_name: str = "BAAI/bge-small-zh-v1.5",
                 device: str = "cpu"):
        self.model_name = model_name
        self.device = device
        self._model = None
        self._mode = None  # "bge" | "hash"
        self._dimension = config.embedding_hash_dim
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
                         getattr(self._model, 'get_sentence_embedding_dimension', lambda: 384))()
            self._dimension = dim
            logger.info(f"嵌入引擎: BGE ({self.model_name}, {dim}维)")
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

    def encode(self, texts: list[str]) -> list[list[float]]:
        """将文本列表编码为向量列表（线程安全）"""
        if not texts:
            return []
        with _encode_lock:
            if self._mode == "bge" and self._model:
                embeddings = self._model.encode(
                    texts,
                    normalize_embeddings=True,
                    show_progress_bar=False,
                )
                return embeddings.tolist()
            return [self._hash_encode(text) for text in texts]

    def encode_query(self, query: str) -> list[float]:
        """编码查询文本（BGE 需要加前缀，线程安全）"""
        with _encode_lock:
            if self._mode == "bge" and self._model:
                # BGE 模型查询时需要加 instruction 前缀
                emb = self._model.encode(
                    f"为这个句子生成表示以用于检索相关文章：{query}",
                    normalize_embeddings=True,
                    show_progress_bar=False,
                )
                return emb.tolist()
            return self._hash_encode(query)

    def encode_document(self, text: str) -> list[float]:
        """编码文档文本（线程安全）"""
        with _encode_lock:
            if self._mode == "bge" and self._model:
                emb = self._model.encode(
                    text,
                    normalize_embeddings=True,
                    show_progress_bar=False,
                )
                return emb.tolist()
            return self._hash_encode(text)

    def _hash_encode(self, text: str) -> list[float]:
        """确定性特征哈希向量，保证无网络时 Chroma 仍可查询。"""
        vector = [0.0] * self._dimension
        tokens = re.findall(r"[\w\u4e00-\u9fff]+", (text or "").lower())
        if not tokens:
            tokens = [text or ""]
        for token in tokens:
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            bucket = int.from_bytes(digest[:4], "big") % self._dimension
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vector[bucket] += sign
        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]
