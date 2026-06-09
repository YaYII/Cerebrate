"""LLM 客户端 — 脑虫的记忆管理者（Chief Memory Curator）

核心职责:
1. 验证虫群记忆质量，过滤有毒/低质内容
2. 评估知识价值，识别低价值/重复提交
3. 自动分类归档、打标签、关联建议
4. 检测知识库冲突
5. 智能总结与知识蒸馏
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
            is_reasoner = self._provider == "deepseek" and "reasoner" in self._model
            kwargs: dict = {
                "model": self._model,
                "messages": [{"role": "user", "content": prompt}],
            }
            if not is_reasoner:
                kwargs["max_tokens"] = 4096
                kwargs["temperature"] = 0.3
            else:
                kwargs["max_tokens"] = 65536
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

        prompt = f"""你是编程知识库的管理员（Knowledge Curator）。
为以下编程相关内容推荐分类标签，帮助其他智能体快速检索到它：

{content[:2000]}

要求:
- 3-5 个英文标签，小写，单个词或连字符
- 第一个标签反映技术栈/语言（如 python、docker、react）
- 第二个标签反映问题类型（如 bug、setup、performance）
- 其余标签补充关键上下文

返回 JSON: {{"tags": ["tag1", "tag2", "tag3"]}}，不要其他文字。"""

        try:
            kwargs = {
                "model": self._model,
                "max_tokens": 100,
                "temperature": 0.1,
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
        """将多条相关实战记忆综合整合为学术级结构化知识文档。

        采用四层知识架构：概念 → 原理 → 方法 → 实践。
        铁律：信息密度只增不减——输出必须完整保留所有源记忆的全部技术内容。
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
                f"- 详情: {m.get('content','')}\n"
                f"- 标签: {tags}\n"
                f"- 来源: {m.get('source_agent','')} | {m.get('physical_user','')}\n"
            )

        prompt = f"""你是一位计算机科学领域的高级研究员（清华大学博士水平）。请将以下多条工程实战记忆**综合整合**为一份符合学术规范的结构化知识文档。

⚠️ 核心哲学：**综合整合 ≠ 压缩提炼。** 你是在做信息综合（synthesis），不是信息压缩（compression）。
- 整合后的文档必须比任何一条源记忆都更完整、更详尽
- 每条源记忆中的**每一个技术细节、代码示例、命令、配置参数、报错信息、边界情况**都必须保留
- 输出长度只增不减——所有源记忆的技术信息密度不能降低
- **多解法并存**：同一个问题可能有多种有效解法，每种对应不同场景——全部保留，用 scenario 标注各自的适用条件

## 研究主题
{topic}

## 原始数据（按复用验证次数降序）
{chr(10).join(memory_blocks)}

## ⚠️ 质量红线

**如果原始数据不足以形成一份合格的知识文档（信息碎片化、内容空泛、缺少具体细节），请返回 skip 标记而非强行生成低质量内容：**

```json
{{"skip": true, "reason": "具体原因（如：缺少根因分析数据、无具体命令示例、方案步骤不完整等）"}}
```

合格标准：
1. 每个核心概念必须有至少一条记忆提供准确定义
2. 每个解决方案必须有可执行的具体步骤或命令
3. 陷阱/边界情况必须有实际发生的案例支撑
4. **所有源记忆的每一条技术细节都必须保留在最终文档中，不压缩、不丢弃**
5. 每个 section 不能出现"可能"、"也许"等无实质内容的占位表述

## 知识文档结构规范

请严格按以下 JSON Schema 输出，所有内容必须来源于原始数据，严禁编造：

```json
{{
  "meta": {{
    "title": "知识标题（精准描述，必须体现具体技术名词和所属领域）",
    "topic": "学科/技术领域",
    "version": "1.0.0",
    "distilled_at": "生成时间ISO格式",
    "source_count": "原始记忆数量",
    "total_reuse": "总复用次数",
    "confidence": 0.0-1.0
  }},
  "abstract": "学术摘要：问题域、核心发现、方法论要点、适用范围。必须包含每条源记忆提炼出的综合洞察",
  "concept_layer": {{
    "description": "概念层：定义核心概念和术语体系",
    "concepts": [
      {{
        "term": "术语名（必须具体，不能是通用词）",
        "definition": "精确定义（包含技术细节）",
        "evidence_level": "A/B/C",
        "refs": [1, 3]
      }}
    ]
  }},
  "principle_layer": {{
    "description": "原理层：问题产生的根本原因和触发机制",
    "root_causes": [
      {{
        "cause": "根因描述（包含因果逻辑链）",
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
        "scenario": "该解法适用的具体场景（什么条件下选这条路）",
        "steps": ["步骤1: 包含具体命令/参数/配置的完整描述", "步骤2: ..."],
        "preconditions": "前置条件（环境、权限、依赖等）",
        "expected_outcome": "预期结果（可验证的具体指标）",
        "evidence_level": "A/B/C",
        "refs": [1, 2, 4]
      }}
    ]
  }},
  "practice_layer": {{
    "description": "实践层：不同场景下的可复制操作指南",
    "guides": [
      {{
        "scenario": "操作场景（具体描述，什么情况下使用本方案）",
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
      "description": "陷阱/边界情况描述（包含具体技术细节）",
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
1. 完整保留：每条源记忆中的**全部内容**都必须体现在最终文档中，不压缩、不丢弃
2. 来源可追溯：每个论断标注 refs，无来源不写入
3. 区分事实与观点：事实用陈述句，推论标注"[推断]"或"[待验证]"
4. 保留分歧：矛盾方案不强行统一，记录在 conflicts 中
5. 可复现：操作步骤包含验证方法 + 回滚方案
6. 术语一致：同一概念全文统一术语，技术名词保留英文原名
7. 禁止编造：不确定的内容标注"[待验证]"，严禁编造填补空白
8. 多解法并存：同一问题有多种有效解法时全部保留，用 scenario 字段区分适用条件，不合并、不筛选
9. 横向全量：呈现 N 种方法对比，帮读者根据自身场景选择

只返回 JSON，不要其他文字。"""

        try:
            is_reasoner = self._provider == "deepseek" and "reasoner" in self._model
            kwargs: dict = {
                "model": self._model,
                "messages": [{"role": "user", "content": prompt}],
            }
            # deepseek-reasoner 不支持 temperature/max_tokens
            if not is_reasoner:
                kwargs["max_tokens"] = 8192
                kwargs["temperature"] = 0.2
            else:
                kwargs["max_tokens"] = 65536  # reasoner 大输出
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
