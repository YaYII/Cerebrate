"""BGE ReRanker 重排序 — 精排候选记忆

在 ChromaDB 向量粗搜后，用交叉编码器对 top-N 结果做精细排序。
可选依赖，加载失败时自动降级（不重排）。
"""
import logging
import threading
from typing import Optional

logger = logging.getLogger(__name__)


class ReRanker:
    """交叉编码器重排序器

    使用 BAAI/bge-reranker-v2-m3（与 bge-m3 配对使用），对候选列表
    按 query 与每个候选的语义相关性重新打分排序。
    """

    def __init__(self, model_name: str = "BAAI/bge-reranker-v2-m3",
                 device: str = "cpu", enabled: bool = True):
        self.model_name = model_name
        self.device = device
        self._model = None
        self._enabled = enabled
        self._lock = threading.Lock()
        self._init_model()

    def _init_model(self):
        """尝试加载 ReRanker 模型，失败则标记为不可用"""
        if not self._enabled:
            logger.info("ReRanker 已禁用（配置关闭）")
            return
        try:
            from sentence_transformers import CrossEncoder
            self._model = CrossEncoder(
                self.model_name,
                device=self.device,
                max_length=8192,
            )
            logger.info(f"ReRanker 加载成功: {self.model_name} ({self.device})")
        except Exception as e:
            logger.warning(f"ReRanker 加载失败 ({e})，将跳过重排序")
            self._model = None

    @property
    def available(self) -> bool:
        return self._model is not None

    def rerank(self, query: str, candidates: list[dict],
               top_k: int = 5) -> list[dict]:
        """对候选列表按 query 重排序

        Args:
            query: 查询文本
            candidates: [{"content": "...", "score": ..., ...}, ...]
            top_k: 返回前 N 条

        Returns:
            按新得分降序排列的候选列表（追加 rerank_score 字段）
        """
        if not self._model or not candidates:
            return candidates

        try:
            with self._lock:
                # 构造 query + 候选对
                pairs = []
                for c in candidates:
                    content = c.get("content", "") or c.get("text", "")
                    title = c.get("title", "")
                    pair_text = f"{title} {content}"[:4000]  # 防止极端长文本
                    pairs.append([query, pair_text])

                # 批量打分
                scores = self._model.predict(pairs)

            # 合并得分
            reranked = []
            for i, c in enumerate(candidates):
                score = float(scores[i]) if i < len(scores) else c.get("score", 0)
                c["rerank_score"] = round(score, 4)
                c["final_score"] = round(score, 4)  # ReRanker 分数作为最终分
                reranked.append(c)

            # 按 ReRanker 得分降序
            reranked.sort(key=lambda x: x.get("rerank_score", 0), reverse=True)
            return reranked[:top_k]

        except Exception as e:
            logger.warning(f"ReRanker 重排序异常 ({e})，使用原始排序")
            for c in candidates:
                c["rerank_score"] = c.get("score", 0)
                c["final_score"] = c.get("score", 0)
            return candidates[:top_k]


# 全局单例
_reranker: Optional[ReRanker] = None
_reranker_lock = threading.Lock()


def get_reranker(model_name: str = "BAAI/bge-reranker-v2-m3",
                 device: str = "cpu",
                 enabled: bool = True) -> ReRanker:
    """获取 ReRanker 单例（线程安全）"""
    global _reranker
    if _reranker is None and enabled:
        with _reranker_lock:
            if _reranker is None:
                _reranker = ReRanker(model_name, device, enabled)
    return _reranker or ReRanker("", enabled=False)  # 返回一个 disabled 实例
