"""LLM 客户端 — 脑虫的记忆管理者（Chief Memory Curator）

核心职责:
1. 验证虫群记忆质量，过滤有毒/低质内容
2. 评估知识价值，识别低价值/重复提交
3. 自动分类归档、打标签、关联建议
4. 检测知识库冲突
5. 链式多轮知识整合（突破单次 token 限制）
6. 思考模式推理（deepseek-v4-pro + thinking enabled）
"""

import json
import os
import re
import time
from typing import Optional

from cerebrate.config import config


class CerebrateLLM:
    """脑虫的记忆管理者（Chief Memory Curator）

    智能增强层。无 API Key 时回退到规则引擎。

    角色定位：
    - 安全审核员 → 检查内容安全性
    - 知识管理员 → 评估知识价值、判断重复、建议归档
    - 标签专家 → 自动生成分类标签
    - 高级研究员 → 知识蒸馏为结构化文档
    - 冲突调解员 → 检测记忆间的矛盾
    """

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
        elif self._provider == "deepseek":
            self._available = bool(os.environ.get("DEEPSEEK_API_KEY"))
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
            elif self._provider == "deepseek":
                import openai
                self._client = openai.OpenAI(
                    base_url="https://api.deepseek.com/v1",
                    api_key=os.environ.get("DEEPSEEK_API_KEY", ""),
                )
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
                "knowledge value assessment",
                "duplication detection",
                "curator categorization suggestions",
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

    @property
    def _is_thinking_model(self) -> bool:
        """当前模型是否支持/需要思考（推理）模式。

        DeepSeek: v4-pro 和 reasoner 都支持思考模式
        """
        if self._provider != "deepseek":
            return False
        return "v4-pro" in self._model or "reasoner" in self._model

    def _deepseek_thinking_kwargs(self) -> dict:
        """返回 DeepSeek 思考模式专属参数。

        - temperature: 思考模式下不支持
        - reasoning_effort: high 表示最大推理深度
        - extra_body: {"thinking": {"type": "enabled"}} 启用思考
        """
        return {
            "extra_body": {"thinking": {"type": "enabled"}},
            "reasoning_effort": "high",
        }

    # ==================== 免疫系统 ====================

    def validate_memory(self, content: str, source_agent: str = "unknown") -> dict:
        """验证记忆质量，检测有毒/低质内容，评估知识价值

        Returns:
            {"safe": bool, "quality": float, "issues": list[str],
             "suggested_tags": list[str], "has_knowledge_value": bool,
             "is_duplicate_likely": bool, "curator_note": str,
             "suggested_category": str}
        """
        issues = []
        quality = 1.0

        # 规则层检查 (总是执行)
        rule_result = self._rule_validate(content, source_agent)
        issues.extend(rule_result["issues"])
        quality *= rule_result["quality"]

        # LLM 层检查 (SDK 可用且免疫开启时执行)
        immune_active = self.is_available() and self._sdk_ready() and self._immune_enabled
        has_knowledge_value = True
        is_duplicate_likely = False
        curator_note = ""
        suggested_category = ""
        if immune_active:
            llm_result = self._llm_validate(content, source_agent)
            issues.extend(llm_result.get("issues", []))
            quality *= llm_result.get("quality", 1.0)
            has_knowledge_value = llm_result.get("has_knowledge_value", True)
            is_duplicate_likely = llm_result.get("is_duplicate_likely", False)
            curator_note = llm_result.get("curator_note", "")
            suggested_category = llm_result.get("suggested_category", "")

        safe = quality >= self._immune_threshold
        return {
            "safe": safe,
            "quality": round(min(quality, 1.0), 3),
            "issues": issues,
            "suggested_tags": rule_result.get("suggested_tags", []),
            "immune_active": immune_active,
            "has_knowledge_value": has_knowledge_value,
            "is_duplicate_likely": is_duplicate_likely,
            "curator_note": curator_note,
            "suggested_category": suggested_category,
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
        """使用 LLM 进行深度记忆管理审核

        升级为「记忆管理者」角色，不仅做安全检查，
        还评估知识价值、归档建议、去重提示等图书管理员职责。
        """
        client = self._get_client()
        if not client:
            return {"issues": [], "quality": 1.0}

        prompt = f"""你是一位经验丰富的编程知识库管理者（Chief Memory Curator）。
你的职责不仅是安全检查，更要确保虫群的每条记忆都有知识价值，归档得当。

来源智能体: {source_agent}

收到的候选记忆内容:
{content[:3000]}

请评估并返回 JSON：
{{
  "is_safe": true/false,
  "has_knowledge_value": true/false,
  "is_duplicate_likely": true/false,
  "quality": 0.0-1.0,
  "suggested_category": "架构|编码|调试|运维|性能|安全|测试|配置",
  "suggested_tags": ["标签1"],
  "issues": ["问题1"],
  "curator_note": "管理员的归档建议或关联提示"
}}

评估标准:
1. **知识价值**（核心）：是否包含具体的解决方案、根因分析、可复用的经验模式？
2. **内容质量**：是否有具体的技术细节、命令、配置、代码片段？
3. **完整性**：问题描述、原因、解决方案、验证方法是否四要素齐全？
4. **安全性**：是否包含恶意内容、破坏性命令、注入攻击代码？
5. **唯一性**：在虫群中可能已有相似的现有记忆？
6. **分类匹配**：内容最匹配哪个类别？（架构/编码/调试/运维/性能/安全/测试/配置）
7. **归档建议**：用 curator_note 给出管理员角度的建议，如"建议与XXX话题关联"或"缺少验证步骤，建议补充"

只返回 JSON，不要其他文字。"""

        try:
            kwargs = {
                "model": self._model,
                "max_tokens": 600,
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
                    "has_knowledge_value": result.get("has_knowledge_value", True),
                    "is_duplicate_likely": result.get("is_duplicate_likely", False),
                    "curator_note": result.get("curator_note", ""),
                }
        except Exception:
            pass

        return {"issues": [], "quality": 1.0}

    # ==================== 自动经验提取（人人为我） ====================

    def extract_lesson_from_usage(self, problem: str, original_memory: Optional[dict],
                                   outcome: str, feedback: str, agent_id: str) -> Optional[dict]:
        """从记忆复用场景中自动提取完整经验教训，用于自动同步到虫群。

        铁律：输出信息密度不降低——提取的是完整经验，不是压缩摘要。
        """
        if self.is_available() and self._sdk_ready():
            return self._llm_extract_lesson(problem, original_memory, outcome, feedback, agent_id)
        return self._rule_extract_lesson(problem, original_memory, outcome, feedback)

    def _rule_extract_lesson(self, problem: str, original_memory: Optional[dict],
                              outcome: str, feedback: str) -> dict:
        """规则回退：用模板构建经验文档，确保信息完整性。"""
        content_parts = [f"## 问题场景\n{problem}"]
        if original_memory:
            content_parts.append(f"## 参考记忆\n标题: {original_memory.get('title', '')}")
            orig_content = original_memory.get('content', '')
            if orig_content:
                content_parts.append(f"内容: {orig_content[:2000]}")
        content_parts.append(f"## 结果\n{'✅ 成功' if outcome == 'success' else '⚠️ 部分成功' if outcome == 'partial' else '❌ 失败'}")
        if feedback:
            content_parts.append(f"## 经验反馈\n{feedback}")
        content = "\n\n".join(content_parts)
        return {
            "title": f"[自动经验] {problem[:60]}",
            "content": content,
            "tags": ["auto-extracted", outcome],
            "category": "coding",
        }

    def _llm_extract_lesson(self, problem: str, original_memory: Optional[dict],
                             outcome: str, feedback: str, agent_id: str) -> Optional[dict]:
        """LLM驱动的自动经验提取——从使用上下文中提取完整、可复用的经验教训。"""
        client = self._get_client()
        if not client:
            return self._rule_extract_lesson(problem, original_memory, outcome, feedback)

        mem_ctx = ""
        if original_memory:
            mem_ctx = (
                f"### 被复用的原始记忆\n"
                f"- 标题: {original_memory.get('title', '')}\n"
                f"- 内容: {original_memory.get('content', '')[:2000]}\n"
                f"- 方案: {original_memory.get('solution', '')}\n"
                f"- 标签: {original_memory.get('tags', '')}\n"
            )

        prompt = f"""你是一个从实战中自动提取经验的智能体——"人人为我"机制的神经突触。

你的任务：从一次"记忆复用"的完整上下文中，提取一份**完整、详细、可直接复用的经验教训**。
这不是压缩，是**提取精华**——输出要比输入的任何单条信息都更完整。

## 上下文

### 执行智能体
{agent_id}

### 遇到的问题/场景
{problem}

{mem_ctx}

### 执行结果
{'✅ 成功' if outcome == 'success' else '⚠️ 部分成功' if outcome == 'partial' else '❌ 失败'}

### 智能体反馈
{feedback or '（无额外反馈）'}

## 输出要求

请返回 JSON，包含以下字段：

```json
{{
  "title": "经验标题（一句话概括问题领域和解决方法，如: 'Docker Compose 多阶段构建时.env 变量传递失败及修复'）",
  "content": "完整经验文档（Markdown格式）：\\n## 问题描述\\n...\\n## 根因分析\\n...\\n## 解决方案\\n...\\n## 关键命令/代码\\n...\\n## 注意事项\\n...\\n要求：每个技术细节都必须保留，不能因为"常见"就省略；包含可复现的命令或代码片段；包含边界条件和陷阱",
  "tags": ["至少3个标签，小写英文，第一个是技术栈，第二个是问题类型，第三个是领域"],
  "category": "最合适的分类（coding|debugging|architecture|devops|performance|security|testing|config）",
  "problem_solved": "简明版问题描述（用于快速检索）",
  "solution": "简明版解决方案（50-200字，供其他智能体快速参考）"
}}
```

只返回 JSON，不要其他文字。确保 content 完整、详尽、可直接指导实践。"""

        try:
            is_thinking = self._is_thinking_model
            kwargs: dict = {
                "model": self._model,
                "messages": [{"role": "user", "content": prompt}],
            }
            if not is_thinking:
                kwargs["max_tokens"] = 4096
                kwargs["temperature"] = 0.3
            else:
                kwargs["max_tokens"] = 65536
                if self._provider == "deepseek" and "v4-pro" in self._model:
                    kwargs.update(self._deepseek_thinking_kwargs())
            if self._provider == "anthropic":
                response = client.messages.create(**kwargs)
                text = response.content[0].text if response.content else ""
            else:
                response = client.chat.completions.create(**kwargs)
                text = response.choices[0].message.content if response.choices else ""

            match = re.search(r'\{[\s\S]*\}', text)
            if match:
                result = json.loads(match.group())
                # 确保必要字段
                if result.get("content") and len(result["content"]) > 50:
                    return result
        except Exception:
            pass
        return self._rule_extract_lesson(problem, original_memory, outcome, feedback)

    # ==================== 结构化字段增强（Phase 4） ====================

    def compress_title(self, title: str, content: str = "") -> str:
        """语义压缩标题：让索引层"只看标题即可判断相关性"。

        对齐 claude-mem 的语义压缩原则：
          好标题 = 具体、可检索、自包含（🔴 Hook timeout: 60s too short for npm install）
        LLM 可用时调用压缩；不可用时规则保底（截断 + 保留关键词）。
        """
        title = (title or "").strip()
        # 规则保底 1：空标题从内容推导
        if not title and content:
            title = content.strip().splitlines()[0][:40]
        # 规则保底 2：过长标题截断
        if len(title) > 60:
            title = title[:60].rstrip() + "…"
        if not self.is_available() or not self._sdk_ready():
            return title
        compressed = self._llm_compress_title(title, content)
        return compressed or title

    def _llm_compress_title(self, title: str, content: str = "") -> Optional[str]:
        client = self._get_client()
        if not client:
            return None
        prompt = f"""你是编程记忆库的编辑（Memory Editor）。
把下面的记忆标题压缩成 ≤12 个英文/中文词，要求：
- 具体、可检索、自包含（只看标题就能判断是否相关）
- 保留关键信息：技术栈、问题类型、方案要点
- 不要模糊词汇（如"关于""一些""问题"）

原标题: {title}
"""
        if content:
            prompt += f"\n内容摘要: {content[:300]}"
        prompt += "\n\n只返回压缩后的标题，不要其他文字。"
        try:
            kwargs = {
                "model": self._model,
                "max_tokens": 60,
                "temperature": 0.1,
                "messages": [{"role": "user", "content": prompt}],
            }
            if self._provider == "anthropic":
                response = client.messages.create(**kwargs)
                text = response.content[0].text if response.content else ""
            else:
                response = client.chat.completions.create(**kwargs)
                text = response.choices[0].message.content
            text = (text or "").strip().strip('"').strip("'")
            return text[:60] if text else None
        except Exception:
            return None

    def extract_facts_concepts(self, content: str, solution: str = "",
                               problem_solved: str = "",
                               tags: Optional[list[str]] = None,
                               category: str = "") -> dict:
        """提取结构化 facts/concepts（LLM 可用时增强，否则返回空由规则层兜底）。

        返回: {"facts": [...], "concepts": [...]}
        """
        result = {"facts": [], "concepts": []}
        if not self.is_available() or not self._sdk_ready():
            return result
        client = self._get_client()
        if not client:
            return result
        prompt = f"""你是编程记忆库的结构化提取器（Structured Extractor）。
从下面的记忆内容中提取结构化字段，返回 JSON：

内容: {content[:1500]}
"""
        if solution:
            prompt += f"\n方案: {solution[:200]}"
        if problem_solved:
            prompt += f"\n解决的问题: {problem_solved[:200]}"
        if tags:
            prompt += f"\n已有标签: {', '.join(tags)}"
        if category:
            prompt += f"\n分类: {category}"
        prompt += """

返回 JSON:
{
  "facts": ["事实1", "事实2", ...],   # ≤5 条，每条 ≤20 字，可验证的具体事实
  "concepts": ["概念1", "概念2", ...]  # ≤8 个，技术概念/关键词
}
不要其他文字。"""
        try:
            kwargs = {
                "model": self._model,
                "max_tokens": 200,
                "temperature": 0.1,
                "messages": [{"role": "user", "content": prompt}],
            }
            if self._provider == "anthropic":
                response = client.messages.create(**kwargs)
                text = response.content[0].text if response.content else ""
            else:
                response = client.chat.completions.create(**kwargs)
                text = response.choices[0].message.content
            match = re.search(r'\{[\s\S]*\}', text or "")
            if match:
                data = json.loads(match.group())
                result["facts"] = [str(f) for f in (data.get("facts") or [])][:5]
                result["concepts"] = [str(c) for c in (data.get("concepts") or [])][:8]
            return result
        except Exception:
            return {"facts": [], "concepts": []}

    # ==================== 知识蒸馏(链式多轮) ====================

    def _chat_completion(self, messages: list[dict], max_tokens: int = 8192,
                         temperature: float = 0.2) -> Optional[str]:
        """统一的 LLM 对话补全调用，兼容 anthropic / openai / deepseek。

        思考模式模型（如 deepseek-v4-pro）自动启用 thinking 参数。
        """
        client = self._get_client()
        if not client:
            return None
        is_thinking = self._is_thinking_model
        kwargs: dict = {
            "model": self._model,
            "messages": messages,
        }
        if not is_thinking:
            kwargs["max_tokens"] = max_tokens
            kwargs["temperature"] = temperature
        else:
            kwargs["max_tokens"] = 65536
            if self._provider == "deepseek" and "v4-pro" in self._model:
                kwargs.update(self._deepseek_thinking_kwargs())
        try:
            if self._provider == "anthropic":
                response = client.messages.create(**kwargs)
                return response.content[0].text if response.content else None
            else:
                response = client.chat.completions.create(**kwargs)
                return response.choices[0].message.content if response.choices else None
        except Exception:
            return None

    @staticmethod
    def _format_memory_block(memories: list[dict], offset: int = 0) -> str:
        """将记忆列表格式化为 LLM 可读的文本块，每条标注序号。"""
        blocks = []
        for i, m in enumerate(memories):
            idx = offset + i + 1
            tags = m.get("tags", "")
            if isinstance(tags, list):
                tags = ",".join(tags)
            blocks.append(
                f"### 记忆源 #{idx} (复用{m.get('reuse_count',0)}次)\n"
                f"- 记忆ID: {m.get('memory_id', '')}\n"
                f"- 标题: {m.get('title','')}\n"
                f"- 场景: {m.get('problem_solved','')}\n"
                f"- 方案: {m.get('solution','')}\n"
                f"- 详情: {m.get('content','')}\n"
                f"- 标签: {tags}\n"
                f"- 来源: {m.get('source_agent','')} | {m.get('physical_user','')}\n"
            )
        return "\n".join(blocks)

    def _build_initial_prompt(self, topic: str, batch_mems: list[dict]) -> str:
        """第一轮 prompt：从首批记忆中构建初始知识结构。"""
        memory_block = self._format_memory_block(batch_mems)
        return f"""你是一位计算机科学领域的高级研究员（清华大学博士水平）。请根据以下工程实战记忆，**综合整合**为一份符合学术规范的结构化知识文档。

⚠️ 核心哲学：这是**多轮链式整合的第一轮**。本轮只处理第 1 批记忆（共多批）。请基于当前记忆构建**初始完整结构**，后续轮次会逐步补充更多内容。

## 研究主题
{topic}

## 第 1 批原始数据
{memory_block}

## 输出要求

请严格按以下 JSON Schema 输出。所有内容必须来源于原始数据，**每条结论标注 refs 指向记忆源序号**：

```json
{{
  "meta": {{
    "title": "知识标题",
    "topic": "{topic}",
    "version": "1.0.0",
    "source_count": {len(batch_mems)},
    "total_reuse": {sum(m.get('reuse_count',0) for m in batch_mems)},
    "confidence": 0.0-1.0
  }},
  "abstract": "学术摘要",
  "concept_layer": {{
    "description": "概念层定义",
    "concepts": [
      {{"term": "术语名", "definition": "定义", "evidence_level": "A/B/C", "refs": [1]}}
    ]
  }},
  "principle_layer": {{
    "description": "原理层",
    "root_causes": [
      {{"cause": "根因", "mechanism": "触发机制", "evidence_level": "A/B/C", "refs": [1]}}
    ]
  }},
  "methodology_layer": {{
    "description": "方法论层",
    "patterns": [
      {{
        "name": "模式名称", "scenario": "适用场景", "steps": [],
        "preconditions": "", "expected_outcome": "",
        "evidence_level": "A/B/C", "refs": [1]
      }}
    ]
  }},
  "practice_layer": {{
    "description": "实践层",
    "guides": [
      {{
        "scenario": "场景", "commands": [],
        "verification": "", "rollback": "",
        "evidence_level": "A/B/C", "refs": [1]
      }}
    ]
  }},
  "pitfalls_and_edge_cases": [
    {{"description": "陷阱描述", "consequence": "后果", "mitigation": "缓解", "refs": [1]}}
  ],
  "knowledge_graph": {{
    "prerequisites": [], "related_topics": [], "conflicts": []
  }},
  "references": [
    {{"index": 1, "memory_id": "原始记忆ID", "title": "标题", "contribution": "贡献描述"}}
  ],
  "reproducibility": {{
    "can_reproduce": true, "estimated_time": "", "required_env": ""
  }}
}}
```

## 铁律
1. 所有内容来源于当前批次的记忆，refs 标注对应序号
2. 完整保留每个技术细节，不压缩不丢弃
3. 区分事实与观点，推论标注"[推断]"
4. 多解法并存：有不同的模式全部列出
5. 禁止编造

只返回 JSON，不要其他文字。如果数据不足以形成知识文档，返回 {{"skip": true, "reason": "原因"}}。"""

    def _build_update_prompt(self, topic: str, new_batch: list[dict],
                              previous_draft: dict, round_num: int,
                              total_so_far: int) -> list[dict]:
        """后续轮次 prompt：将新批次的记忆融入已有知识结构。"""
        new_block = self._format_memory_block(new_batch, offset=total_so_far)
        import json as _json
        draft_json = _json.dumps(previous_draft, ensure_ascii=False, indent=2)

        instruction = f"""你正在**链式整合知识文档第 {round_num} 轮**。以下是当前已有的知识文档草稿和一批新的原始记忆。

## 研究主题
{topic}

## 当前知识文档草稿
```json
{draft_json}
```

## 需要整合的新记忆（第 {round_num} 批）
{new_block}

## 任务

请将新记忆的内容整合到知识文档中：补充/更新概念、根因、模式、操作指南、陷阱。不删除已有内容，只扩展。

## 输出要求

返回完整的 JSON（同前一轮的 schema），整合了新旧所有内容。
- refs 必须使用全局序号（新批次的序号从 {total_so_far + 1} 开始）
- 必须包含 references 段列出所有记忆源
- 只返回 JSON，不要其他文字"""

        return [
            {"role": "user", "content": instruction},
        ]

    def chain_distill_knowledge(self, memories: list[dict], topic: str,
                                 batch_size: Optional[int] = None) -> Optional[dict]:
        """链式多轮知识整合：分批消化记忆，逐轮累加构建完整的结构化知识文档。

        每轮：
        1. 将一批新记忆送入 LLM
        2. LLM 基于前一轮的草稿 + 新内容，输出更新后的完整草稿
        3. 最终轮输出最终的完整文档

        Args:
            memories: 原始记忆列表
            topic: 研究主题
            batch_size: （可选）每批处理多少条记忆。
                       不传则根据模型上下文窗口动态计算，
                       目标是用尽可能少的轮次处理完所有记忆，
                       同时每轮记忆数量控制在模型可接收范围内。

        Returns:
            完整的结构化知识文档 dict，或 None（数据不足）
        """
        if not self.is_available() or not self._sdk_ready():
            return None
        if not memories:
            return None

        sorted_mems = sorted(memories, key=lambda m: m.get("reuse_count", 0), reverse=True)
        total = len(sorted_mems)

        from cerebrate.core.chunking import estimate_tokens

        # ── 动态计算 batch_size ──
        # 目标：每个 LLM 请求的总 token 不超过上下文窗口的 80%
        # deepseek-v4-pro 上下文窗口 128K token，保留 20% 给输出
        # 非思考模型保守设 8K，思考模型大输出设 128K
        if self._is_thinking_model:
            context_limit = 98304  # 128K * 0.75，留 25% 给 reasoning + output
        else:
            context_limit = 64000

        # 测量一条典型记忆的 token 成本
        _sample_block = self._format_memory_block(sorted_mems[:1])
        sample_tokens = estimate_tokens(_sample_block)

        # 测量初始模板的 token 成本（不含记忆）
        _template = self._build_initial_prompt(topic, sorted_mems[:1])
        template_tokens = estimate_tokens(_template)
        overhead_tokens = template_tokens - sample_tokens  # 模板固定开销

        def _calc_batch_size(remaining: int, draft: Optional[dict] = None) -> int:
            """动态计算当前轮次可以安全处理的记忆数量。"""
            if remaining <= 0:
                return 0
            current_overhead = overhead_tokens

            # 如果有草稿（后续轮次），它的体积会占用上下文
            if draft is not None:
                import json as _json
                draft_str = _json.dumps(draft, ensure_ascii=False)
                draft_tokens = estimate_tokens(draft_str)
                current_overhead += draft_tokens + 200  # 200 用于更新指令的 token 数

            available = context_limit - current_overhead
            if available <= 0:
                return 1  # 最少也得处理 1 条

            # 每条记忆需要 sample_tokens，但取最大安全值
            per_mem_tokens = max(sample_tokens, 200)
            n = max(1, available // per_mem_tokens)
            return min(n, remaining)

        # ── 自适应分轮 ──
        accumulated: Optional[dict] = None
        processed_count = 0
        round_num = 0

        while processed_count < total:
            remaining = total - processed_count
            if remaining <= 0:
                break
            current_batch_size = _calc_batch_size(remaining, accumulated)
            batch = sorted_mems[processed_count:processed_count + current_batch_size]

            is_first = (processed_count == 0)

            if is_first:
                prompt = self._build_initial_prompt(topic, batch)
                text = self._chat_completion(
                    [{"role": "user", "content": prompt}],
                    max_tokens=context_limit, temperature=0.2,
                )
            else:
                messages = self._build_update_prompt(
                    topic, batch, accumulated, round_num, processed_count,
                )
                text = self._chat_completion(
                    messages, max_tokens=context_limit, temperature=0.2,
                )

            if not text:
                return accumulated if accumulated else None

            import re
            match = re.search(r'\{[\s\S]*\}', text)
            if not match:
                return accumulated if accumulated else None

            try:
                import json
                result = json.loads(match.group())
            except json.JSONDecodeError:
                return accumulated if accumulated else None

            if result.get("skip"):
                return None if is_first else accumulated

            if accumulated is None:
                accumulated = result
            else:
                if result.get("meta"):
                    accumulated["meta"] = result["meta"]
                for key in ["abstract", "concept_layer", "principle_layer",
                            "methodology_layer", "practice_layer",
                            "pitfalls_and_edge_cases", "knowledge_graph",
                            "references", "reproducibility"]:
                    if key in result:
                        accumulated[key] = result[key]

            processed_count += len(batch)
            round_num += 1
            import logging
            logger = logging.getLogger("cerebrate.llm")
            logger.info("链式蒸馏: 处理 %d/%d 条 (batch=%d, 剩余%d轮)",
                         processed_count, total, len(batch),
                         (remaining - len(batch) + current_batch_size - 1) // current_batch_size)

        return accumulated

    def distill_knowledge(self, memories: list[dict], topic: str) -> Optional[dict]:
        """将多条相关实战记忆综合整合为学术级结构化知识文档（自动链式多轮）。

        采用四层知识架构：概念 → 原理 → 方法 → 实践。
        铁律：信息密度只增不减。
        batch_size 根据模型上下文窗口和记忆内容量动态计算。
        """
        if not self.is_available() or not self._sdk_ready():
            return None
        return self.chain_distill_knowledge(memories, topic)

    def filter_relevant(self, query: str, title: str, content: str) -> dict:
        """判断一段内容是否与查询相关

        用于检索后过滤，移除不相关的结果块。

        Args:
            query: 用户查询
            title: 内容标题
            content: 正文内容（最多 3000 字）

        Returns:
            {"relevant": bool, "relevance_score": float, "reason": str}
        """
        if not self.is_available() or not self._sdk_ready():
            return self._rule_filter_relevant(query, title, content)

        client = self._get_client()
        if not client:
            return self._rule_filter_relevant(query, title, content)

        prompt = f"""你是一个检索评估专家。判断以下内容是否与用户查询相关。

用户查询: {query}

文档标题: {title}
文档内容:
{content[:2500]}

请返回 JSON:
{{
  "relevant": true/false,
  "relevance_score": 0.0-1.0,
  "reason": "一句话说明判断理由"
}}

相关=该内容直接回答了查询问题或提供了关键背景信息
不相关=内容主题完全不同或仅有边缘关联
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
                text = response.choices[0].message.content if response.choices else ""

            match = re.search(r'\{[\s\S]*\}', text)
            if match:
                result = json.loads(match.group())
                return {
                    "relevant": bool(result.get("relevant", False)),
                    "relevance_score": float(result.get("relevance_score", 0)),
                    "reason": result.get("reason", ""),
                }
        except Exception:
            pass
        return self._rule_filter_relevant(query, title, content)

    def _rule_filter_relevant(self, query: str, title: str,
                              content: str) -> dict:
        """规则降级：关键词匹配判断相关性"""
        query_lower = query.lower()
        content_lower = content.lower()
        title_lower = title.lower()

        query_words = set(query_lower.split())
        title_words = set(title_lower.split())
        common = query_words & title_words

        if common:
            score = min(0.5 + len(common) * 0.1, 0.9)
            return {"relevant": True, "relevance_score": score,
                    "reason": f"标题匹配关键词: {', '.join(common)}"}

        content_matches = sum(1 for w in query_words if w in content_lower)
        if content_matches >= max(1, len(query_words) // 2):
            score = min(0.4 + content_matches * 0.1, 0.8)
            return {"relevant": True, "relevance_score": score,
                    "reason": f"内容匹配 {content_matches}/{len(query_words)} 个关键词"}

        return {"relevant": False, "relevance_score": 0.0,
                "reason": "关键词匹配不足"}

    def generate_scene_mmd(self, events: list[dict],
                           existing_mmd: Optional[str] = None,
                           task_goal: str = "") -> Optional[dict]:
        """生成/更新场景 Mermaid 认知状态机（借鉴 TencentDB Agent Memory L2）。

        把短期场景的原始事件流压缩为一张 Mermaid flowchart TD 认知状态机：
          - taskGoal / progress / status（done/doing/paused/blocked）
          - 节点 summary 结论导向、极简（≤150 字）
          - 已有图时增量 replace，无图时 write
        LLM 不可用时返回 None（调用方降级：保留原始事件，不强制压缩）。
        """
        if not self.is_available():
            return None
        if not events:
            return None

        event_lines = []
        for i, ev in enumerate(events[:100], start=1):
            kind = ev.get("kind", "tool")
            text = (ev.get("text") or "")[:500]
            event_lines.append(f"{i}. [{kind}] {text}")
        events_text = "\n".join(event_lines)

        system = (
            "你是任务拓扑架构师：把工具调用/消息事件流压缩为一张极简 Mermaid "
            "flowchart TD 认知状态机。只记录已发生的事实（实事求是），不写未来规划。"
            "节点格式：NodeID[\"阶段名: 宏观动作<BR/>status: done|doing|paused|blocked"
            "<BR/>summary: 核心结论摘要<BR/>Timestamp: ISO8601\"]。"
            "语义浓缩：shape 表达领域，summary 极简（≤150 字）。"
            "只输出纯 JSON：{\"task_goal\":\"一句话任务目标\","
            "\"progress\":0-100,\"file_action\":\"write|replace\","
            "\"mmd_content\":\"```mermaid ... ```\"}，禁止解释文本。"
        )
        user_parts = [f"## 事件流（共 {len(events)} 条，展示最近 100 条）：\n{events_text}"]
        if existing_mmd:
            user_parts.append(
                f"## 已有 Mermaid（file_action=replace 时增量更新，保留仍有效的节点）：\n"
                f"{existing_mmd}")
        else:
            user_parts.append("## 无已有图：file_action=write 新建。")
        if task_goal:
            user_parts.append(f"## 任务目标（可动态更新）：{task_goal}")

        try:
            text = self._chat_completion(
                [{"role": "system", "content": system},
                 {"role": "user", "content": "\n\n".join(user_parts)}],
                max_tokens=4000, temperature=0.2)
            if not text:
                return None
            import re as _re
            match = _re.search(r'\{[\s\S]*\}', text)
            if not match:
                return None
            result = json.loads(match.group())
            mmd = result.get("mmd_content") or ""
            # 剥掉 ```mermaid 围栏
            mmd = mmd.strip()
            if mmd.startswith("```mermaid"):
                mmd = mmd[len("```mermaid"):].strip()
            if mmd.startswith("```"):
                mmd = mmd[3:].strip()
            if mmd.endswith("```"):
                mmd = mmd[:-3].strip()
            return {
                "task_goal": (result.get("task_goal") or task_goal)[:300],
                "progress": max(0, min(int(result.get("progress", 0) or 0), 100)),
                "file_action": result.get("file_action") or "write",
                "mmd": mmd,
            }
        except Exception:
            return None

    def distill_scene_to_skill(self, scene: dict) -> Optional[dict]:
        """把短期场景蒸馏为结构化技能（借鉴 TencentDB Agent Memory 场景→技能沉淀）。

        输入场景（事件流 + Mermaid 图 + 元数据），输出 SKILL.md 结构化技能：
          {title, skill_markdown, problem, solution}
        LLM 不可用/失败返回 None（调用方保留场景，不强制沉淀）。
        """
        if not self.is_available():
            return None
        events = scene.get("events", []) or []
        mmd = scene.get("mmd") or ""
        meta = scene.get("meta", {}) or {}
        if not events and not mmd:
            return None

        event_lines = []
        for i, ev in enumerate(events[:100], start=1):
            kind = ev.get("kind", "tool")
            text = (ev.get("text") or "")[:500]
            event_lines.append(f"{i}. [{kind}] {text}")
        events_text = "\n".join(event_lines)

        system = (
            "你是技能提炼专家：把完成任务的短期场景沉淀为可复用的 SKILL.md 技能。"
            "输出必须是合法 YAML frontmatter + body 的 SKILL.md："
            "frontmatter 含 name（小写连字符）、description、version、"
            "trigger（何时触发）、validation（如何验证）、resources（可选）；"
            "body 写清场景、排查步骤、根因、方案、验证。"
            "只输出纯 JSON：{\"title\":\"技能标题\","
            "\"skill_markdown\":\"---\\nname: ...\\n---\\n正文\","
            "\"problem\":\"解决的原始问题\",\"solution\":\"一句话方案\"}。"
            "禁止解释文本。"
        )
        user_parts = [
            f"## 任务目标：{meta.get('task_goal', '')}",
            f"## 进度：{meta.get('progress', 0)}%",
            f"## 事件流（共 {len(events)} 条，展示最近 100 条）：\n{events_text}",
        ]
        if mmd:
            user_parts.append(f"## Mermaid 认知状态机（压缩摘要）：\n{mmd}")
        user_parts.append(
            "## 要求：提炼出可复用的完整技能，body 至少 500 字符，"
            "包含具体命令/步骤/验证方法。")

        try:
            text = self._chat_completion(
                [{"role": "system", "content": system},
                 {"role": "user", "content": "\n\n".join(user_parts)}],
                max_tokens=4000, temperature=0.2)
            if not text:
                return None
            import re as _re
            match = _re.search(r'\{[\s\S]*\}', text)
            if not match:
                return None
            result = json.loads(match.group())
            skill_md = (result.get("skill_markdown") or "").strip()
            title = (result.get("title") or "").strip()
            if not skill_md or not skill_md.startswith("---"):
                return None
            return {
                "title": title[:200] or "技能: 场景沉淀",
                "skill_markdown": skill_md,
                "problem": (result.get("problem") or "")[:500],
                "solution": (result.get("solution") or "")[:300],
            }
        except Exception:
            return None
