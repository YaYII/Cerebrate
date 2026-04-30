"""嵌入引擎 — 文本向量化，BGE 模型优先，TF-IDF 回退"""
import logging
from typing import Optional

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
    不可用时回退到本地 TF-IDF。
    """

    def __init__(self, model_name: str = "BAAI/bge-small-zh-v1.5",
                 device: str = "cpu"):
        self.model_name = model_name
        self.device = device
        self._model = None
        self._tfidf = None
        self._mode = None  # "bge" | "tfidf"
        self._init_model()

    def _init_model(self):
        """尝试加载 BGE 模型，失败则回退 TF-IDF"""
        try:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(self.model_name, device=self.device)
            self._mode = "bge"
            try:
                dim = self._model.get_embedding_dimension()
            except AttributeError:
                dim = self._model.get_sentence_embedding_dimension()
            logger.info(f"嵌入引擎: BGE ({self.model_name}, {dim}维)")
        except Exception as e:
            logger.warning(f"BGE 模型加载失败 ({e})，回退到 TF-IDF")
            self._init_tfidf()

    def _init_tfidf(self):
        from ..memory.semantic import SemanticIndex
        self._tfidf = SemanticIndex()
        self._mode = "tfidf"
        logger.info("嵌入引擎: TF-IDF (回退模式)")

    @property
    def mode(self) -> str:
        return self._mode or "unknown"

    @property
    def dimension(self) -> int:
        if self._mode == "bge" and self._model:
            return self._model.get_sentence_embedding_dimension()
        return 0  # TF-IDF 维度不固定

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
        else:
            return self._tfidf_encode(texts)

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
        else:
            return self._tfidf_encode([query])[0] if self._tfidf_encode([query]) else []

    def encode_document(self, text: str) -> list[float]:
        """编码文档文本"""
        if self._mode == "bge" and self._model:
            emb = self._model.encode(
                text,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            return emb.tolist()
        else:
            result = self._tfidf_encode([text])
            return result[0] if result else []

    def _tfidf_encode(self, texts: list[str]) -> list[list[float]]:
        """TF-IDF 向量化（回退方案）

        TF-IDF 向量维度不固定，不适合直接做余弦相似度。
        改为返回稀疏表示，由 ChromaStore 判断是否使用。
        在实际使用中，TF-IDF 模式会绕过 ChromaDB 的 embedding 函数，
        直接用 ChromaDB 的内建 all-MiniLM-L6-v2 ONNX 模型。
        """
        # 如果连 TF-IDF 索引都没初始化，返回空
        if not self._tfidf:
            self._init_tfidf()
        # TF-IDF 不支持直接向量化，标记交由调用方处理
        return []

    def add_documents(self, ids: list[str], texts: list[str]):
        """向 TF-IDF 索引添加文档（回退模式用）"""
        if self._tfidf:
            for i, (did, text) in enumerate(zip(ids, texts)):
                self._tfidf.add_document(did, text)

    def remove_document(self, doc_id: str):
        """从 TF-IDF 索引移除文档"""
        if self._tfidf:
            self._tfidf.remove_document(doc_id)
