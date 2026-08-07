"""pytest 全局配置：测试环境禁用真实 LLM（防付费，2026-08-06）。

背景：cerebrate/config.py 模块级 `_load_dotenv()` 会把 .env 中的
DEEPSEEK_API_KEY 写回 os.environ；测试中 48 处 propose_memory 未显式
validate=False（默认 True）→ 每次测试都会调真实 DeepSeek API → 烧钱。

根治：先 import cerebrate.config 触发 _load_dotenv（.env 写回仅此一次），
再清除所有 LLM API key 环境变量。此后任何测试路径
（propose/answer/distill/compress_title 等）的 CerebrateLLM.is_available()
都返回 False → 走规则保底（deterministic rule immune validation），零付费。

mock 掉 LLM 的测试（如 test_distill_async）不读真实环境，不受影响。
"""
import os

# 先触发 cerebrate.config 的 _load_dotenv（把 .env 写回 os.environ，仅此一次），
# 之后 cerebrate.config 已加载不会再写回，清除才真正生效。
import cerebrate.config  # noqa: E402,F401

for _llm_key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"):
    os.environ.pop(_llm_key, None)

# 蒸馏窗口（v5.1.1）：测试默认关闭窗口限制（否则所有测试受当前小时影响），
# 专项窗口测试（tests/test_evolution_window.py）单独开启并注入时间验证。
from cerebrate.config import config  # noqa: E402

config.evolution_window_enabled = False
