"""语义搜索引擎 — 纯 Python TF-IDF + 余弦相似度，零外部依赖"""
import json
import math
import re
from pathlib import Path
from typing import Optional

from .storage import atomic_write_json


# 中文字符范围
_RE_CHINESE = re.compile(r"[一-鿿㐀-䶿豈-﫿]+")
# 英文/代码 token: 字母数字下划线，至少2字符
_RE_TOKEN = re.compile(r"[a-z0-9_]{2,}")
# 中文标点和空白
_RE_PUNCT = re.compile(r"[，。！？；：、\s]+")


def tokenize(text: str) -> list[str]:
    """中英混合分词: 中文用字符 bigram，英文用小写词切分"""
    tokens = []
    pos = 0
    for m in _RE_CHINESE.finditer(text):
        # 处理中文段之前的英文段
        preceding = text[pos:m.start()].lower()
        tokens.extend(_RE_TOKEN.findall(preceding))
        # 中文 bigram
        ch = m.group()
        if len(ch) == 1:
            tokens.append(ch)
        else:
            for i in range(len(ch) - 1):
                tokens.append(ch[i:i + 2])
        pos = m.end()
    # 末尾英文段
    remaining = text[pos:].lower()
    tokens.extend(_RE_TOKEN.findall(remaining))
    return [t for t in tokens if len(t) >= 1]


class SemanticIndex:
    """TF-IDF 语义索引 — 稀疏矩阵存储，支持增量更新"""

    def __init__(self):
        self.documents: dict[str, str] = {}          # doc_id -> text
        self.term_docs: dict[str, dict[str, float]] = {}  # term -> {doc_id: tf}
        self.doc_terms: dict[str, dict[str, float]] = {}  # doc_id -> {term: tf}
        self.idf: dict[str, float] = {}              # term -> idf
        self.doc_count: int = 0

    def add_document(self, doc_id: str, text: str) -> None:
        """添加或更新文档"""
        if doc_id in self.documents:
            self.remove_document(doc_id)
        tokens = tokenize(text)
        if not tokens:
            return
        self.documents[doc_id] = text
        self.doc_count += 1

        # 计算 TF
        tf: dict[str, float] = {}
        for t in tokens:
            tf[t] = tf.get(t, 0) + 1
        # 归一化: TF / sqrt(len)
        norm = math.sqrt(len(tokens))
        for t in tf:
            tf[t] /= norm

        self.doc_terms[doc_id] = tf
        for t, v in tf.items():
            self.term_docs.setdefault(t, {})[doc_id] = v

        # 更新 IDF
        for t in tf:
            self.idf[t] = math.log(self.doc_count / len(self.term_docs[t])) + 1

    def remove_document(self, doc_id: str) -> None:
        """移除文档（标记删除，需要 rebuild 清理）"""
        if doc_id not in self.documents:
            return
        del self.documents[doc_id]
        self.doc_count -= 1
        terms = self.doc_terms.pop(doc_id, {})
        for t in terms:
            if t in self.term_docs:
                self.term_docs[t].pop(doc_id, None)
                if not self.term_docs[t]:
                    del self.term_docs[t]
                    self.idf.pop(t, None)

    def search(self, query: str, top_k: int = 10,
               doc_ids: Optional[set[str]] = None) -> list[tuple[str, float]]:
        """搜索: 返回 [(doc_id, score), ...] 按分数降序"""
        query_tokens = tokenize(query)
        if not query_tokens:
            return []

        # 查询向量 TF
        q_tf: dict[str, float] = {}
        for t in query_tokens:
            q_tf[t] = q_tf.get(t, 0) + 1
        q_norm = math.sqrt(len(query_tokens))
        for t in q_tf:
            q_tf[t] /= q_norm

        # 计算余弦相似度
        scores: dict[str, float] = {}
        for term, q_weight in q_tf.items():
            if term not in self.term_docs or term not in self.idf:
                continue
            idf = self.idf[term]
            q_tfidf = q_weight * idf
            for d_id, d_tf in self.term_docs[term].items():
                if doc_ids is not None and d_id not in doc_ids:
                    continue
                scores[d_id] = scores.get(d_id, 0) + q_tfidf * d_tf * idf

        # 归一化
        for d_id in scores:
            d_norm = math.sqrt(sum(
                (tf * self.idf.get(t, 0)) ** 2
                for t, tf in self.doc_terms.get(d_id, {}).items()
            ))
            if d_norm > 0:
                scores[d_id] /= d_norm

        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        return ranked[:top_k]

    def save(self, path: Path) -> None:
        """持久化索引到 JSON"""
        data = {
            "documents": self.documents,
            "term_docs": self.term_docs,
            "doc_terms": self.doc_terms,
            "idf": self.idf,
            "doc_count": self.doc_count,
        }
        atomic_write_json(path, data)

    def load(self, path: Path) -> bool:
        """从 JSON 加载索引"""
        if not path.exists():
            return False
        data = json.loads(path.read_text())
        self.documents = data.get("documents", {})
        self.term_docs = data.get("term_docs", {})
        self.doc_terms = data.get("doc_terms", {})
        self.idf = data.get("idf", {})
        self.doc_count = data.get("doc_count", 0)
        return True

    def doc_count_internal(self) -> int:
        return self.doc_count
