"""
查询重写器 — 将用户原始查询扩展为多个角度的检索语句.

查询重写能大幅提升召回率：同一问题从不同角度检索，找到不同表述方式的相关文档。

策略（两级降级）:
  1. LLM 重写: 用配置的 LLM 将查询改写为 2-4 个不同角度的变体
  2. 规则保底: LLM 不可用时，提取关键词 + 生成简单的词序变体
"""
import logging
import re

logger = logging.getLogger(__name__)


def rewrite_query(query: str,
                  max_variations: int = 3,
                  enabled: bool = True) -> list[str]:
    """
    将用户查询重写为多个角度的检索语句.

    Args:
        query: 用户原始查询
        max_variations: 最多生成多少个变体（含原始查询）
        enabled: 是否启用重写

    Returns:
        [原始查询, 变体1, 变体2, ...]

    """
    if not enabled or not query.strip():
        return [query]

    # 尝试 LLM 重写
    llm_variants = _rewrite_with_llm(query, max_variations - 1)
    if llm_variants:
        # 去重 + 去空 + 限制数量
        seen = set()
        result = [query]
        for v in llm_variants:
            v = v.strip()
            if v and v not in seen and v != query:
                seen.add(v)
                result.append(v)
                if len(result) >= max_variations:
                    break
        return result

    # 规则保底
    return [query] + _rule_variants(query, max_variations - 1)


def _rewrite_with_llm(query: str, count: int) -> list[str] | None:
    """用 LLM 生成查询变体."""
    if count <= 0:
        return None
    try:
        from cerebrate.brain.llm import CerebrateLLM
        llm = CerebrateLLM()
        if not llm.is_available() or not llm._sdk_ready():
            return None

        client = llm._get_client()
        if not client:
            return None

        prompt = f"""你是一个检索专家。请将用户查询改写为 {count} 个不同角度的检索句子。

要求:
1. 每个句子保持原意但用不同表述
2. 覆盖不同关键词和表达角度
3. 简洁，直接输出，每行一个
4. 不要编号，不要多余文字

用户查询: {query}

改写结果:"""
        provider = llm._provider
        model = llm._model
        kwargs = {
            "model": model,
            "max_tokens": 300,
            "temperature": 0.7,
            "messages": [{"role": "user", "content": prompt}],
        }
        if provider == "anthropic":
            response = client.messages.create(**kwargs)
            raw = response.content[0].text if response.content else ""
        else:
            response = client.chat.completions.create(**kwargs)
            raw = response.choices[0].message.content if response.choices else ""

        if not raw:
            return None
        lines = []
        for line in raw.split("\n"):
            line = line.strip().strip('"\'')
            line = line.lstrip("0123456789.-)•· ").strip()
            if line and len(line) > 5:
                lines.append(line)
        return lines[:count]
    except Exception as e:
        logger.warning(f"LLM 查询重写失败 ({e})，使用规则保底")
        return None


def _rule_variants(query: str, count: int) -> list[str]:
    """基于规则的查询变体生成."""
    if count <= 0:
        return []
    variants = []

    # 策略 1: 提取关键词重新排序
    tokens = _tokenize(query)
    if len(tokens) >= 3:
        # 把最后的核心词提前
        reordered = _reorder_tokens(tokens)
        if reordered != query:
            variants.append(reordered)

    # 策略 2: 去掉修饰词，保留核心名词
    core = _extract_core(query)
    if core and core != query and core not in variants:
        variants.append(core)

    # 策略 3: 用"关键词1 关键词2"的简短查询
    if len(tokens) >= 4:
        short = " ".join(tokens[:3])
        if short != query and short not in variants:
            variants.append(short)

    # 策略 4: 尝试英文同义替换（对中文技术文档有帮助）
    eng = _add_english_fallback(query)
    if eng and eng != query and eng not in variants:
        variants.append(eng)

    return variants[:count]


def _tokenize(text: str) -> list[str]:
    """分词：中文按字/词，英文按空格."""
    # 中文字符作为一个词
    tokens = re.findall(r'[\u4e00-\u9fff]+|[a-zA-Z_]+', text)
    return [t for t in tokens if t.strip()]


def _reorder_tokens(tokens: list[str]) -> str:
    """重排序：把末尾的核心词提到前面."""
    if len(tokens) <= 2:
        return " ".join(tokens)
    # 把最后一个词提前
    return " ".join([tokens[-1]] + tokens[:-1])


def _extract_core(text: str) -> str:
    """提取核心内容：去掉常见的前缀词."""
    prefixes = ["请问", "如何", "怎么", "怎样", "什么是", "有没有",
                "能不能", "在哪里", "哪个"]
    for p in prefixes:
        if text.startswith(p):
            return text[len(p):].strip()
    return text


def _add_english_fallback(text: str) -> str | None:
    """对中文技术查询添加英文关键词."""
    # 常见技术术语的中英映射
    mapping = {
        "接口": "API",
        "对接": "integration",
        "部署": "deploy",
        "配置": "config",
        "架构": "architecture",
        "编码": "coding",
        "测试": "test",
        "调试": "debug",
        "性能": "performance",
        "安全": "security",
        "数据库": "database",
        "文档": "documentation",
        "方案": "solution",
        "设计": "design",
    }
    found = []
    for cn, en in mapping.items():
        if cn in text:
            found.append(en)
    if found:
        return text + " " + " ".join(found[:3])
    return None
