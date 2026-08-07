"""记忆衰减机制 — 基于时间、复用和成功率的衰减计算."""
import math
from datetime import UTC, datetime


def calculate_decay(
    created_at: str,
    last_accessed: str | None = None,
    reuse_count: int = 0,
    success_count: int = 0,
    half_life_days: float = 30.0,
    outcome: str = "success",
) -> float:
    """
    计算记忆衰减系数 (0.0 ~ 1.0).

    公式:
      time_decay = 0.5 ** (days_since_creation / half_life_days)
      access_boost = min(log2(reuse_count + 1) / 5, 0.3)
      success_factor = 0.7 + 0.3 * (success_count / max(reuse_count, 1))
      outcome_discount = {"success": 1.0, "partial": 0.7, "failure": 0.3}

      decay = time_decay + access_boost
      decay *= success_factor * outcome_discount
      return clamp(decay, 0.05, 1.0)
    """
    now = datetime.now(UTC)

    # 时间衰减
    try:
        created_dt = datetime.fromisoformat(created_at)
        if created_dt.tzinfo is None:
            created_dt = created_dt.replace(tzinfo=UTC)
    except (ValueError, TypeError):
        created_dt = now
    days = max(0, (now - created_dt).total_seconds() / 86400)
    time_decay = 0.5 ** (days / half_life_days)

    # 访问加成
    access_boost = min(math.log2(reuse_count + 1) / 5, 0.3)

    # 合并
    decay = time_decay + access_boost

    # 成功率
    if reuse_count > 0:
        success_factor = 0.7 + 0.3 * (success_count / reuse_count)
    else:
        success_factor = 0.8

    # 结果折扣
    outcome_map = {"success": 1.0, "partial": 0.7, "failure": 0.3}
    outcome_discount = outcome_map.get(outcome, 0.7)

    decay *= success_factor * outcome_discount
    return max(0.05, min(1.0, decay))


def should_archive(decay_score: float, threshold: float = 0.1) -> bool:
    """判断记忆是否应归档."""
    return decay_score < threshold


def boost_from_reuse(reuse_count: int, success_count: int) -> float:
    """复用带来的额外分数加成."""
    if reuse_count == 0:
        return 0.0
    return min(0.2, 0.05 * math.log2(reuse_count + 1) * (success_count / reuse_count))
