"""智能语义分块器 — 将长文档切分为语义完整的块

分块策略（三阶降级）:
  1. 按 Markdown 标题（## / ###）分割
  2. 按段落（\n\n）分割
  3. 等长切割 + 重叠上下文

每块保留语义边界，适合后续独立的向量化检索。
"""
import logging
import re

logger = logging.getLogger(__name__)


def estimate_tokens(text: str) -> int:
    """粗略估计文本的 token 数（BGE-M3 中文约 1.5 字/token）"""
    # 中文字符
    cjk = len(re.findall(r'[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]', text))
    # 英文单词
    words = len(re.findall(r'[a-zA-Z]+', text))
    # 数字
    digits = len(re.findall(r'[0-9]+', text))
    # 空白 / 标点等
    other = len(text) - cjk - sum(len(w) for w in re.findall(r'[a-zA-Z]+', text)) - sum(len(d) for d in re.findall(r'[0-9]+', text))
    # 中文 ~1.5 token/字, 英文 ~1.3 token/词, 其他 ~0.25 token/字符
    return int(cjk * 1.5 + words * 1.3 + digits * 0.5 + other * 0.25) + 1


def split_by_headings(text: str, max_chars: int) -> list[str]:
    """按 Markdown 二级标题分割（##），超过 max_chars 的段落在段落级再分"""
    lines = text.split("\n")
    chunks = []
    current = []
    current_len = 0

    for line in lines:
        is_h2 = bool(re.match(r'^##(?!\#)\s', line))
        is_h1 = bool(re.match(r'^#\s', line))

        if is_h1:
            # H1 是文档大标题，不作为分割点
            current.append(line)
            current_len += len(line) + 1
            continue

        if is_h2:
            # 遇到新标题，把之前的存起来
            if current:
                block = "\n".join(current).strip()
                if block:
                    # 如果块太长，在段落级再分割
                    if len(block) > max_chars:
                        chunks.extend(split_by_paragraphs(block, max_chars))
                    else:
                        chunks.append(block)
            current = [line]
            current_len = len(line) + 1
        else:
            current.append(line)
            current_len += len(line) + 1

    # 最后一块
    if current:
        block = "\n".join(current).strip()
        if block:
            if len(block) > max_chars:
                chunks.extend(split_by_paragraphs(block, max_chars))
            else:
                chunks.append(block)

    return chunks


def split_by_paragraphs(text: str, max_chars: int) -> list[str]:
    """按段落（连续空行）分割，单个超长段落再等长切"""
    paragraphs = re.split(r'\n\s*\n', text)
    chunks = []
    current = []
    current_len = 0

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        # 单个段落超长
        if len(para) > max_chars:
            # 先把当前积累的存起来
            if current:
                chunks.append("\n\n".join(current).strip())
                current = []
                current_len = 0
            # 等长切割此段落
            chunks.extend(split_equal(para, max_chars))
            continue

        # 加上此段落是否会超长
        added_len = len(para) + (2 if current else 0)  # 2 for "\n\n"
        if current_len + added_len > max_chars:
            chunks.append("\n\n".join(current).strip())
            current = [para]
            current_len = len(para)
        else:
            current.append(para)
            current_len += added_len

    if current:
        chunks.append("\n\n".join(current).strip())

    return chunks


def split_equal(text: str, max_chars: int, overlap_chars: int = 100) -> list[str]:
    """等长切割 + 尾部上下文重叠"""
    if len(text) <= max_chars:
        return [text]

    chunks = []
    start = 0
    while start < len(text):
        end = min(start + max_chars, len(text))
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        # 重叠：回退 overlap_chars（但保证最小推进）
        step = max(max_chars - overlap_chars, max_chars // 2)
        start += step

    # 如果最后一块太小，合并到前一块
    if len(chunks) > 1 and len(chunks[-1]) < max_chars // 4:
        chunks[-2] = chunks[-2] + "\n" + chunks[-1]
        chunks.pop()

    return chunks


def chunk_document(content: str,
                   max_chars: int = 8000,
                   min_chars: int = 200,
                   overlap_chars: int = 100) -> list[dict]:
    """将文档内容分割为语义块，并追踪每块在原文中的字符偏移

    Args:
        content: 文档文本
        max_chars: 每块最大字符数
        min_chars: 最小有效块字符数
        overlap_chars: 等长切割时的重叠字符数

    Returns:
        [{"index": 0, "text": "...", "total": N,
          "start_char": 0, "end_char": 200}, ...]
    """
    if not content or not content.strip():
        return [{"index": 0, "text": content or "", "total": 1,
                 "start_char": 0, "end_char": len(content or "")}]

    # 如果内容很短，直接返回整块
    if len(content) <= max_chars:
        return [{"index": 0, "text": content, "total": 1,
                 "start_char": 0, "end_char": len(content)}]

    # 策略 1：按标题分割
    raw_chunks = split_by_headings(content, max_chars)

    # 如果标题分割不充分（只有一块），退回按段落
    if len(raw_chunks) <= 1 and len(content) > max_chars:
        raw_chunks = split_by_paragraphs(content, max_chars)

    # 如果段落分割也不充分，退回等长切割
    if len(raw_chunks) <= 1 and len(content) > max_chars:
        raw_chunks = split_equal(content, max_chars, overlap_chars)

    # 后处理：合并过小的尾部块
    merged = []
    for ch in raw_chunks:
        if merged and len(ch) < min_chars // 3 and len(merged[-1]) < max_chars * 0.8:
            merged[-1] += "\n" + ch
        else:
            merged.append(ch)

    # ── 计算每块在原文中的字符偏移 ──
    result = []
    search_start = 0
    total = len(merged)
    for i, chunk_text in enumerate(merged):
        # 在原文中定位此块（从上次位置开始搜索）
        pos = content.find(chunk_text, search_start)
        if pos == -1:
            # 降级：从头搜索（重叠块可能导致前一块尾部匹配失败）
            pos = content.find(chunk_text)
        if pos == -1:
            # 降级：无法定位，用 0
            pos = 0
            logger.warning(f"分块 #{i} 无法在原文中定位其偏移")
        end_pos = pos + len(chunk_text)
        result.append({
            "index": i,
            "text": chunk_text,
            "total": total,
            "start_char": pos,
            "end_char": end_pos,
        })
        search_start = pos + 1  # 下次从之后开始搜索

    return result
