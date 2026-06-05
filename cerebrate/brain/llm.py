"""LLM 客户端 — 脑虫的灵魂与免疫系统

核心职责:
1. 验证虫群记忆质量，过滤有毒/低质内容
2. 自动总结和打标签
3. 检测知识库冲突
"""

import json
import os
import re
import time
from typing import Optional

from cerebrate.config import config


class CerebrateLLM:
    """脑虫的 LLM 大脑 — 可选的智能增强层，无 API Key 时回退到规则引擎"""

    def __init__(self):
        self._client = None
        self._available = None
        self._sdk_available = None  # SDK 是否可导入（与 API Key 存在分开管理）
        self._provider = config.llm_provider
        self._model = config.llm_model
        self._immune_enabled = config.immune_enabled
        self._immune_threshold = config.immune_threshold

    def is_available(self) -> bool:
        """检查 LLM 是否可用（仅检查 API Key 是否存在）"""
        if self._available is not None:
            return self._available
        if self._provider == "anthropic":
            self._available = bool(os.environ.get("ANTHROPIC_API_KEY"))
        elif self._provider == "openai":
            self._available = bool(os.environ.get("OPENAI_API_KEY"))
        else:
            self._available = False
        return self._available

    def _sdk_ready(self) -> bool:
        """检查 SDK 是否可正常导入和初始化（失败后有 5 分钟冷却期）。"""
        if self._sdk_available is not None:
            age = time.time() - self._sdk_checked_at if hasattr(self, '_sdk_checked_at') else 999
            if self._sdk_available or age < 300:
                return self._sdk_available
        self._sdk_checked_at = time.time()
        try:
            if self._provider == "anthropic":
                import anthropic
                self._client = anthropic.Anthropic()
            elif self._provider == "openai":
                import openai
                self._client = openai.OpenAI()
            else:
                self._sdk_available = False
                return False
            self._sdk_available = True
        except (ImportError, Exception):
            self._sdk_available = False
        return self._sdk_available

    def status(self) -> dict:
        """返回 LLM/免疫层状态，用于服务端自检和客户端排障。"""
        api_key_present = self.is_available()
        sdk_available = self._sdk_ready() if api_key_present else False
        llm_available = api_key_present and sdk_available
        return {
            "provider": self._provider,
            "model": self._model,
            "api_key_present": api_key_present,
            "sdk_available": sdk_available,
            "available": llm_available,
            "immune_enabled": self._immune_enabled,
            "immune_threshold": self._immune_threshold,
            "mode": "llm-assisted" if llm_available and self._immune_enabled else "rule-only",
            "fallback": "deterministic rule immune validation",
            "responsibilities": [
                "memory safety validation",
                "quality scoring",
                "tag suggestions",
                "summarization",
                "knowledge conflict detection",
            ],
        }

    def _get_client(self):
        """获取 LLM 客户端，SDK 不可用时返回 None"""
        if self._client is not None:
            return self._client
        if not self._sdk_ready():
            return None
        return self._client

    # ==================== 免疫系统 ====================

    def validate_memory(self, content: str, source_agent: str = "unknown") -> dict:
        """验证记忆质量，检测有毒/低质内容

        Returns:
            {"safe": bool, "quality": float, "issues": list[str], "suggested_tags": list[str]}
        """
        issues = []
        quality = 1.0

        # 规则层检查 (总是执行)
        rule_result = self._rule_validate(content, source_agent)
        issues.extend(rule_result["issues"])
        quality *= rule_result["quality"]

        # LLM 层检查 (SDK 可用且免疫开启时执行)
        immune_active = self.is_available() and self._sdk_ready() and self._immune_enabled
        if immune_active:
            llm_result = self._llm_validate(content, source_agent)
            issues.extend(llm_result.get("issues", []))
            quality *= llm_result.get("quality", 1.0)

        safe = quality >= self._immune_threshold
        return {
            "safe": safe,
            "quality": round(min(quality, 1.0), 3),
            "issues": issues,
            "suggested_tags": rule_result.get("suggested_tags", []),
            "immune_active": immune_active,
        }

    def _rule_validate(self, content: str, source_agent: str) -> dict:
        """规则引擎验证 — 无 LLM 时的基础防护"""
        issues = []
        quality = 1.0
        content_lower = content.lower()

        # 检测常见有毒模式
        toxic_patterns = [
            (r"rm\s+-rf\s+/", 0.5, "危险命令: rm -rf /"),
            (r"sudo\s+rm\s+-rf", 0.3, "危险命令: sudo rm -rf"),
            (r"eval\s*\(.*\)", 0.2, "潜在危险: eval()"),
            (r"<script.*>", 0.4, "XSS 注入尝试"),
            (r"DROP\s+TABLE", 0.5, "SQL 注入: DROP TABLE"),
            (r"DELETE\s+FROM", 0.3, "SQL 注入: DELETE FROM"),
        ]
        for pattern, penalty, desc in toxic_patterns:
            if re.search(pattern, content, re.IGNORECASE):
                issues.append(desc)
                quality -= penalty

        # 检测空内容
        if len(content.strip()) < 5:
            issues.append("内容过短 (<5字符)")
            quality *= 0.3

        # 检测全大写 (可能是垃圾)
        if len(content) > 50 and content.isupper():
            issues.append("全大写内容")
            quality *= 0.7

        # 简单标签建议
        suggested_tags = []
        if re.search(r'python|py\b', content_lower):
            suggested_tags.append("python")
        if re.search(r'javascript|js\b|node', content_lower):
            suggested_tags.append("javascript")
        if re.search(r'api|http|rest|graphql', content_lower):
            suggested_tags.append("api")
        if re.search(r'bug|错误|失败|error|fix', content_lower):
            suggested_tags.append("bug-fix")
        if re.search(r'docker|容器|container', content_lower):
            suggested_tags.append("docker")

        return {
            "issues": issues,
            "quality": max(0.05, quality),
            "suggested_tags": suggested_tags,
        }

    def _llm_validate(self, content: str, source_agent: str) -> dict:
        """使用 LLM 进行深度内容验证"""
        client = self._get_client()
        if not client:
            return {"issues": [], "quality": 1.0}

        prompt = f"""你是一个 AI 编程知识库的安全审核员。请评估以下内容的可信度和质量。

来源智能体: {source_agent}

内容:
{content[:3000]}

请分析并返回 JSON:
{{
  "is_safe": true/false,
  "quality": 0.0-1.0,
  "issues": ["问题1", "问题2"],
  "is_code_related": true/false,
  "suggested_category": "类别",
  "suggested_tags": ["标签1"]
}}

评估标准:
- 是否是有效的编程知识/经验?
- 内容是否恶意(破坏性命令、安全漏洞利用)?
- 是否有明显错误或误导性信息?
- 来源格式是否符合编程社区规范?

只返回 JSON，不要其他文字。"""

        try:
            kwargs = {
                "model": self._model,
                "max_tokens": 500,
                "temperature": 0,
                "messages": [{"role": "user", "content": prompt}],
            }
            if self._provider == "anthropic":
                response = client.messages.create(**kwargs)
                text = response.content[0].text if response.content else ""
            else:
                response = client.chat.completions.create(**kwargs)
                text = response.choices[0].message.content

            match = re.search(r'\{[\s\S]*\}', text)
            if match:
                result = json.loads(match.group())
                issues = result.get("issues", [])
                if not result.get("is_safe", True):
                    issues.insert(0, "LLM 判定为不安全内容")
                    return {"issues": issues, "quality": 0.1}
                return {
                    "issues": issues,
                    "quality": result.get("quality", 1.0),
                    "suggested_tags": result.get("suggested_tags", []),
                    "suggested_category": result.get("suggested_category", ""),
                }
        except Exception:
            pass

        return {"issues": [], "quality": 1.0}

    # ==================== 智能增强 ====================

    def summarize_memory(self, content: str, max_length: int = 200) -> Optional[str]:
        """将冗长的记忆内容压缩为关键要点"""
        if not self.is_available() or not self._sdk_ready():
            return self._rule_summarize(content, max_length)
        return self._llm_summarize(content, max_length)

    def _rule_summarize(self, content: str, max_length: int) -> str:
        if len(content) <= max_length:
            return content
        return content[:max_length - 3] + "..."

    def _llm_summarize(self, content: str, max_length: int) -> Optional[str]:
        client = self._get_client()
        if not client:
            return self._rule_summarize(content, max_length)

        prompt = f"""请将以下编程记忆总结为 {max_length} 字以内的关键要点:

{content[:4000]}

总结要点:
1. 核心技术/问题
2. 采用的解决方案
3. 关键注意事项

直接输出总结，不要JSON格式。"""

        try:
            kwargs = {
                "model": self._model,
                "max_tokens": max_length,
                "temperature": 0.3,
                "messages": [{"role": "user", "content": prompt}],
            }
            if self._provider == "anthropic":
                response = client.messages.create(**kwargs)
                content = response.content[0].text if response.content else ""
                return content.strip()
            else:
                response = client.chat.completions.create(**kwargs)
                content = response.choices[0].message.content if response.choices else ""
                return content.strip()
        except Exception:
            return self._rule_summarize(content, max_length)

    def suggest_tags(self, content: str) -> list[str]:
        """自动生成标签"""
        if self.is_available() and self._sdk_ready():
            llm_tags = self._llm_suggest_tags(content)
            if llm_tags:
                return llm_tags
        return self._rule_validate(content, "").get("suggested_tags", [])

    def _llm_suggest_tags(self, content: str) -> Optional[list[str]]:
        client = self._get_client()
        if not client:
            return None

        prompt = f"""为以下编程相关内容生成 3-5 个英文标签(小写,单个词或连字符):

{content[:2000]}

返回 JSON: {{"tags": ["tag1", "tag2"]}}，不要其他文字。"""

        try:
            kwargs = {
                "model": self._model,
                "max_tokens": 100,
                "temperature": 0,
                "messages": [{"role": "user", "content": prompt}],
            }
            if self._provider == "anthropic":
                response = client.messages.create(**kwargs)
                text = response.content[0].text if response.content else ""
            else:
                response = client.chat.completions.create(**kwargs)
                text = response.choices[0].message.content

            match = re.search(r'\{[\s\S]*\}', text)
            if match:
                result = json.loads(match.group())
                return result.get("tags", [])
        except Exception:
            pass
        return None

    # ==================== 知识蒸馏 ====================

    def distill_knowledge(self, memories: list[dict], topic: str) -> Optional[dict]:
        """将多条相关实战记忆提炼为学术级结构化知识文档。

        采用四层知识架构：概念 → 原理 → 方法 → 实践。
        每条论断标注证据等级和原始记忆引用。
        """
        if not self.is_available() or not self._sdk_ready():
            return None
        client = self._get_client()
        if not client:
            return None

        # 构建记忆列表（按复用次数降序）
        sorted_mems = sorted(memories, key=lambda m: m.get("reuse_count", 0), reverse=True)
        memory_blocks = []
        for i, m in enumerate(sorted_mems):
            tags = m.get("tags", "")
            if isinstance(tags, list):
                tags = ",".join(tags)
            memory_blocks.append(
                f"### 记忆源 #{i+1} (复用{m.get('reuse_count',0)}次, 成功率{m.get('success_count',0)/max(m.get('reuse_count',1),1):.0%})\n"
                f"- 标题: {m.get('title','')}\n"
                f"- 场景: {m.get('problem_solved','')}\n"
                f"- 方案: {m.get('solution','')}\n"
                f"- 详情: {m.get('content','')[:600]}\n"
                f"- 标签: {tags}\n"
                f"- 来源: {m.get('source_agent','')} | {m.get('physical_user','')}\n"
            )

        prompt = f"""你是一位计算机科学领域的高级研究员（清华大学博士水平）。请将以下多条工程实战记忆，提炼为一份符合学术规范的结构化知识文档。

## 研究主题
{topic}

## 原始数据（按复用验证次数降序）
{chr(10).join(memory_blocks)}

## ⚠️ 质量红线

**如果原始数据不足以形成一篇合格的知识文档（信息碎片化、内容空泛、缺少具体细节），请返回 skip 标记而非强行生成低质量内容：**

```json
{{"skip": true, "reason": "具体原因（如：缺少根因分析数据、无具体命令示例、方案步骤不完整等）"}}
```

合格标准：
1. 每个核心概念必须有至少一条记忆提供准确定义
2. 每个解决方案必须有可执行的具体步骤或命令
3. 陷阱/边界情况必须有实际发生的案例支撑
4. abstract 不少于 150 字，全文有效内容不少于 2000 字
5. 每个 section 不能出现"可能"、"也许"等无实质内容的占位表述

## 知识文档结构规范

请严格按以下 JSON Schema 输出，所有内容必须来源于原始数据，严禁编造：

```json
{{
  "meta": {{
    "title": "知识标题（精准描述，≤50字，必须有具体技术名词）",
    "topic": "学科/技术领域",
    "version": "1.0.0",
    "distilled_at": "生成时间ISO格式",
    "source_count": "原始记忆数量",
    "total_reuse": "总复用次数",
    "confidence": 0.0-1.0
  }},
  "abstract": "学术摘要（≥150字）：问题域、核心发现、方法论要点、适用范围。必须包含具体的技术名词和数据",
  "concept_layer": {{
    "description": "概念层：定义核心概念和术语体系",
    "concepts": [
      {{
        "term": "术语名（必须具体，不能是通用词）",
        "definition": "精确定义（≥30字，包含技术细节）",
        "evidence_level": "A/B/C",
        "refs": [1, 3]
      }}
    ]
  }},
  "principle_layer": {{
    "description": "原理层：问题产生的根本原因和触发机制",
    "root_causes": [
      {{
        "cause": "根因描述（≥20字，包含因果逻辑链）",
        "mechanism": "触发机制（说明在什么条件下触发）",
        "evidence_level": "A/B/C",
        "refs": [1]
      }}
    ]
  }},
  "methodology_layer": {{
    "description": "方法论层：可复用的解决模式",
    "patterns": [
      {{
        "name": "模式名称（具体，非"解决方案"这种通用名）",
        "steps": ["步骤1: 包含具体命令/参数/配置的完整描述", "步骤2: ..."],
        "preconditions": "前置条件（环境、权限、依赖等）",
        "expected_outcome": "预期结果（可验证的具体指标）",
        "evidence_level": "A/B/C",
        "refs": [1, 2, 4]
      }}
    ]
  }},
  "practice_layer": {{
    "description": "实践层：可直接复制执行的操作指南",
    "guides": [
      {{
        "scenario": "操作场景（具体描述）",
        "commands": ["完整的、可直接复制执行的命令"],
        "verification": "验证方法（如何确认操作成功）",
        "rollback": "回滚方案（操作失败时如何恢复）",
        "evidence_level": "A/B/C",
        "refs": [2]
      }}
    ]
  }},
  "pitfalls_and_edge_cases": [
    {{
      "description": "陷阱/边界情况描述（≥30字）",
      "consequence": "后果（具体影响）",
      "mitigation": "缓解措施（具体步骤）",
      "refs": [1]
    }}
  ],
  "knowledge_graph": {{
    "prerequisites": ["前置知识（具体的技术栈/概念名）"],
    "related_topics": ["关联主题（具体的、有实际关联的）"],
    "conflicts": ["已知矛盾点描述（如有不同记忆给出矛盾方案）"]
  }},
  "references": [
    {{
      "index": 1,
      "memory_id": "原始记忆ID",
      "title": "记忆标题",
      "contribution": "该记忆对本文档的具体贡献（≥15字）"
    }}
  ],
  "reproducibility": {{
    "can_reproduce": true/false,
    "estimated_time": "预估复现耗时",
    "required_env": "所需环境（OS/依赖/版本等）"
  }}
}}
```

## 证据等级标准
- **A 级**：≥3 次独立复用且成功率 ≥80%，结论高度可信
- **B 级**：1-2 次复用或成功率 60-80%，结论可信但需进一步验证
- **C 级**：单次经验或推论，标注为"[待验证]"

## 铁律
1. 无具体数据 → 不写。每个字段必须是具体的技术内容，不能是空泛的套话
2. 来源可追溯：每个论断标注 refs，无来源不写入
3. 区分事实与观点：事实用陈述句，推论标注"[推断]"或"[待验证]"
4. 保留分歧：矛盾方案不强行统一，记录在 conflicts 中
5. 可复现：操作步骤包含验证方法 + 回滚方案
6. 术语一致：同一概念全文统一术语，技术名词保留英文原名
7. 禁止编造：不确定的内容标注"[待验证]"，严禁编造填补空白
8. 去重合并：同一问题的多条描述合并，保留最完整版本

只返回 JSON，不要其他文字。"""

        try:
            kwargs = {
                "model": self._model,
                "max_tokens": 4096,
                "temperature": 0.2,
                "messages": [{"role": "user", "content": prompt}],
            }
            if self._provider == "anthropic":
                response = client.messages.create(**kwargs)
                text = response.content[0].text if response.content else ""
            else:
                response = client.chat.completions.create(**kwargs)
                text = response.choices[0].message.content if response.choices else ""

            match = re.search(r'\{[\s\S]*\}', text)
            if match:
                return json.loads(match.group())
        except Exception:
            pass
        return None

    def detect_conflicts(self, text_a: str, text_b: str) -> Optional[str]:
        """检测两段知识是否存在矛盾"""
        if not self.is_available() or not self._sdk_ready():
            return None
        client = self._get_client()
        if not client:
            return None

        prompt = f"""判断以下两段编程知识是否存在矛盾:

A: {text_a[:1500]}

B: {text_b[:1500]}

如果存在矛盾，返回 JSON: {{"conflict": true, "description": "矛盾描述"}}
如果不存在矛盾，返回: {{"conflict": false}}

只返回 JSON。"""

        try:
            kwargs = {
                "model": self._model,
                "max_tokens": 200,
                "temperature": 0,
                "messages": [{"role": "user", "content": prompt}],
            }
            if self._provider == "anthropic":
                response = client.messages.create(**kwargs)
                text = response.content[0].text if response.content else ""
            else:
                response = client.chat.completions.create(**kwargs)
                text = response.choices[0].message.content

            match = re.search(r'\{[\s\S]*\}', text)
            if match:
                result = json.loads(match.group())
                if result.get("conflict"):
                    return result.get("description", "检测到知识冲突")
        except Exception:
            pass
        return None
