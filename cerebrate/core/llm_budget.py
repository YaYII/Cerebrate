"""LLM 消费预算控制（v5.2.2）— 每日额度，超出自动关闭 LLM 能力。

背景（2026-08-11，用户要求）:
  LLM API（deepseek）按 token 计费，无官方「按日消耗」统计接口（仅有账户余额）。
  为防「钱包被攻击」（消费失控），本地记账：每次 LLM 调用成功后从响应 usage
  提取 token 用量 × 单价换算成本，当日累计；达到每日预算（默认 1 元）后
  exceeded() → CerebrateLLM.is_available() 返回 False → 所有 LLM 增强层
  （免疫验证/蒸馏/经验提取/查询改写/相关性过滤）自动降级为规则实现。

账本文件: {memory_root}/llm_budget.json（跨天自动重置，本地时区 Asia/Macau UTC+8）
"""
import json
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cerebrate.config import config

_BUDGET_FILE = "llm_budget.json"


class LLMBudget:
    """线程安全的每日 LLM 消费记账。"""

    def __init__(self, path: Path | None = None,
                 daily_budget: float | None = None):
        self.path = Path(path or (Path(config.memory_root) / _BUDGET_FILE))
        self.daily_budget = (daily_budget if daily_budget is not None
                             else config.llm_daily_budget_yuan)
        self._lock = threading.Lock()
        self._data = self._load()

    def _local_date(self) -> str:
        now = datetime.now(UTC) + timedelta(
            hours=config.evolution_window_tz_offset_hours)
        return now.strftime("%Y-%m-%d")

    def _load(self) -> dict:
        try:
            if self.path.exists():
                return json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            pass
        return self._empty()

    def _empty(self) -> dict:
        return {
            "date": self._local_date(),
            "cost": 0.0,
            "tokens": {"input": 0, "output": 0, "cached": 0},
            "calls": 0,
        }

    def _save(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(
                json.dumps(self._data, ensure_ascii=False, indent=2),
                encoding="utf-8")
        except Exception:
            pass

    def _roll_if_new_day(self):
        if self._data.get("date") != self._local_date():
            self._data = self._empty()

    def record(self, prompt_tokens: int = 0, completion_tokens: int = 0,
               cached_tokens: int = 0) -> dict:
        """记录一次 LLM 调用消耗（token → 费用），返回当日累计快照。"""
        with self._lock:
            self._roll_if_new_day()
            cost = (
                int(prompt_tokens or 0) * config.llm_input_price_per_m
                + int(completion_tokens or 0) * config.llm_output_price_per_m
                + int(cached_tokens or 0) * config.llm_cached_input_price_per_m
            ) / 1_000_000.0
            self._data["cost"] = round(self._data.get("cost", 0.0) + cost, 6)
            tokens = self._data.setdefault(
                "tokens", {"input": 0, "output": 0, "cached": 0})
            tokens["input"] = int(tokens.get("input", 0)) + int(prompt_tokens or 0)
            tokens["output"] = int(tokens.get("output", 0)) + int(completion_tokens or 0)
            tokens["cached"] = int(tokens.get("cached", 0)) + int(cached_tokens or 0)
            self._data["calls"] = int(self._data.get("calls", 0)) + 1
            self._save()
            return self.today_locked()

    def today_locked(self) -> dict:
        """当日累计快照（调用方须已持锁）。"""
        cost = float(self._data.get("cost", 0.0))
        budget = float(self.daily_budget)
        if budget < 0:  # 负值 = 不限制
            exceeded = False
        elif budget == 0:  # 0 = 完全禁止
            exceeded = True
        else:
            exceeded = cost >= budget
        return {
            "date": self._data.get("date", self._local_date()),
            "cost": round(cost, 6),
            "daily_budget": budget,
            "remaining": max(0.0, budget - cost) if budget > 0 else 0.0,
            "exceeded": exceeded,
            "tokens": dict(self._data.get("tokens", {})),
            "calls": int(self._data.get("calls", 0)),
        }

    def today(self) -> dict:
        """当日累计快照（公开读取）。"""
        with self._lock:
            self._roll_if_new_day()
            return self.today_locked()

    def exceeded(self) -> bool:
        """是否已达当日预算（超出则 LLM 应关闭）。"""
        with self._lock:
            self._roll_if_new_day()
            return self.today_locked()["exceeded"]

    def reset(self) -> dict:
        """手动清零当日账本（管理员逃生门，一般不使用）。"""
        with self._lock:
            self._data = self._empty()
            self._save()
            return self.today_locked()
