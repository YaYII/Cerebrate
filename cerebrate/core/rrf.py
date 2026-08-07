"""
RRF 融合检索 — Reciprocal Rank Fusion（借鉴 TencentDB Agent Memory）。.

多路召回（FTS5 精确关键词 + ChromaDB 向量语义）各自按排名打分后，
用 1/(k+rank) 融合，避免单一来源独占结果：
  - FTS 精确命中（错误码/命令/函数名）不再因向量分低而丢失
  - 向量语义命中（近义/相关）不再被 FTS 简单拼接排在末尾
结果按 RRF 总分降序，兼顾两路召回。
"""

from collections.abc import Iterable

RRF_K = 60  # RRF 常数：排名权重衰减基准（标准值）


def reciprocal_rank_fusion(
    ranked_lists: Iterable[list[dict]],
    k: int = RRF_K,
    limit: int = 20,
) -> list[dict]:
    """
    融合多路按相关性排序的结果列表（每路须含 memory_id）。.

    Args:
        ranked_lists: 多路召回结果，每路已按相关性降序排列（rank 从 1 起）。
        k: RRF 常数，越大排名差异影响越小（标准 60）。
        limit: 返回条数上限。

    Returns:
        融合后按 RRF 总分降序的结果列表，每条含 source 标记
        （"fulltext" / "vector" / "hybrid"：多路同时命中的路径）。

    """
    scores: dict[str, float] = {}
    source: dict[str, set[str]] = {}

    for source_name, lst in enumerate(ranked_lists):
        for rank, item in enumerate(lst, start=1):
            mid = item.get("memory_id", "")
            if not mid:
                continue
            scores[mid] = scores.get(mid, 0.0) + 1.0 / (k + rank)
            src = "fulltext" if source_name == 0 else "vector"
            source.setdefault(mid, set()).add(src)

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)

    # 保序融合：结果顺序 = RRF 排名；保留第一路的原始条目内容，
    # 合并同一 memory_id 的来源标记。
    by_mid: dict[str, dict] = {}
    for lst in ranked_lists:
        for item in lst:
            mid = item.get("memory_id", "")
            if mid and mid not in by_mid:
                by_mid[mid] = dict(item)

    out: list[dict] = []
    for mid, score in ranked[:limit]:
        if mid not in by_mid:
            continue
        entry = dict(by_mid[mid])
        srcs = source.get(mid, set())
        entry["score"] = round(score, 6)
        entry["rrf_score"] = entry["score"]
        entry["source"] = "hybrid" if len(srcs) > 1 else next(iter(srcs), "vector")
        out.append(entry)
    return out
