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
