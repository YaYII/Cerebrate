"""业务画像（数据世界）：项目的领域树 + 实体关系 + 依赖导航。

设计文档: docs/DESIGN_BUSINESS_PROFILE_DATAWORLD_20260804.md

核心概念（用户认知模型）:
  - 业务层面记忆（scope=project + project_id）是画像的输入（业务专属）
  - 技术层面记忆（scope=general）是跨项目参考，不进业务画像，仅统计技术栈
  - 树 = 导航（project → domain → entity → field）
  - 图 = 依赖（entity.relations + domain.depends_on），供「改 A 影响谁」分析
  - 画像版本化：draft → confirmed，每次 save version+1

存储:
  {memory_root}/profiles/{project_id}.json（机器可读）
  {memory_root}/profiles/{project_id}.md（Markdown 导航页，AI 可读）
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cerebrate.config import config

logger = logging.getLogger(__name__)


def _safe_split(val, separator=","):
    if not val:
        return []
    if isinstance(val, list):
        return [str(v).strip() for v in val if str(v).strip()]
    return [v.strip() for v in str(val).split(separator) if v.strip()]


def _slug(text: str) -> str:
    """转为安全的 id（小写字母数字连字符，支持中文保留）。"""
    import re
    s = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff_-]+", "-", str(text).strip().lower())
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s[:48] or "node"


def _match(node: dict, target: str) -> bool:
    import re
    t = target.lower()
    haystack = " ".join([
        str(node.get("id", "")),
        str(node.get("name", "")),
        str(node.get("description", "")),
    ]).lower()
    # 空格/斜杠分隔的关键词：全部命中才算匹配（支持「DOB 指派」→ DOB人员指派管理）
    tokens = [tok for tok in re.split(r"[\s/]+", t) if tok]
    if tokens and all(tok in haystack for tok in tokens):
        return True
    return t in haystack


class ProfileStore:
    """业务画像存储：读写、构建草稿、导航、Markdown 渲染。"""

    def __init__(self, manager):
        self.mm = manager

    # ── 基础路径 ──
    def _profile_dir(self) -> Path:
        d = config.profile_path
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _path(self, project_id: str) -> Path:
        return self._profile_dir() / f"{project_id}.json"

    def _md_path(self, project_id: str) -> Path:
        return self._profile_dir() / f"{project_id}.md"

    # ── CRUD ──
    def read(self, project_id: str, level: str = "detail") -> Optional[dict]:
        p = self._path(project_id)
        if not p.exists():
            return None
        try:
            profile = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning("读取业务画像失败 %s: %s", p, e)
            return None
        if level == "summary":
            return self._render_level(profile, "summary")
        if level == "graph":
            return self._render_level(profile, "graph")
        return profile

    def _render_level(self, profile: dict, level: str) -> dict:
        """分层披露（渐进式披露思想）：

        - summary（宏观）: 只含域级元数据（id/name/描述/实体数/记忆数/依赖），
          与实体细节完全解耦——微观调整不影响宏观走向，宏观可自由调控。
        - graph（中观）: 域 + 实体（id/name/关系），不含字段与记忆明细。
        - detail（微观）: 完整画像（字段/关系/挂载记忆/代码入口）。
        """
        result = {
            "project_id": profile.get("project_id", ""),
            "version": profile.get("version", 0),
            "status": profile.get("status", ""),
            "level": level,
            "updated_at": profile.get("updated_at", ""),
        }
        if level == "summary":
            flow_names = [f.get("name", f.get("id", ""))
                          for f in profile.get("flows", [])]
            domains = []
            for d in profile.get("domains", []):
                domains.append({
                    "id": d.get("id", ""),
                    "name": d.get("name", ""),
                    "description": d.get("description", ""),
                    "entity_count": len(d.get("entities", [])),
                    "memory_count": len(d.get("memories", [])),
                    "depends_on": d.get("depends_on", []),
                })
            result["summary"] = {
                "domain_count": len(domains),
                "domains": domains,
                "flow_count": len(flow_names),
                "flows": flow_names,
                "shared_tech_stack": profile.get(
                    "shared_tech", {}).get("stack", []),
            }
            return result
        # graph：域 + 实体 + 关系（无字段/记忆明细）
        domains = []
        for d in profile.get("domains", []):
            entities = []
            for e in d.get("entities", []):
                entities.append({
                    "id": e.get("id", ""),
                    "name": e.get("name", ""),
                    "relations": e.get("relations", []),
                })
            domains.append({
                "id": d.get("id", ""),
                "name": d.get("name", ""),
                "description": d.get("description", ""),
                "depends_on": d.get("depends_on", []),
                "entities": entities,
            })
        # graph：附加流程（步骤时序，不含状态机细节）
        flows = []
        for f in profile.get("flows", []):
            flows.append({
                "id": f.get("id", ""),
                "name": f.get("name", ""),
                "trigger": f.get("trigger", ""),
                "actors": f.get("actors", []),
                "steps": f.get("steps", []),
                "depends_on": f.get("depends_on", []),
            })
        result["graph"] = {"domains": domains}
        if flows:
            result["graph"]["flows"] = flows
        return result

    def save(self, project_id: str, profile: dict) -> dict:
        """保存（人工确认版）画像：version+1，原子写 JSON + 渲染 Markdown。"""
        profile = self._sanitize(profile)
        profile.setdefault("project_id", project_id)
        profile["project_id"] = project_id
        profile["status"] = "confirmed"
        profile["updated_at"] = datetime.now(timezone.utc).isoformat()
        profile["version"] = int(profile.get("version", 0)) + 1
        target = self._path(project_id)
        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(profile, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        tmp.replace(target)
        md = self._render_markdown(profile)
        md_tmp = self._md_path(project_id).with_suffix(".md.tmp")
        md_tmp.write_text(md, encoding="utf-8")
        md_tmp.replace(self._md_path(project_id))
        return {
            "project_id": project_id,
            "version": profile["version"],
            "status": profile["status"],
            "path": str(target),
            "markdown_path": str(self._md_path(project_id)),
        }

    @staticmethod
    def _sanitize(profile: dict) -> dict:
        """规范化画像结构：LLM 输出可能含 None/非法类型，统一清洗防渲染崩溃。"""
        profile = dict(profile or {})
        for f in profile.get("flows", []) or []:
            if not isinstance(f, dict):
                continue
            f["state_machine"] = f.get("state_machine") or {
                "states": [], "transitions": []}
            sm = f["state_machine"]
            if not isinstance(sm.get("states"), list):
                sm["states"] = []
            if not isinstance(sm.get("transitions"), list):
                sm["transitions"] = []
            for key in ("actors", "depends_on", "memories"):
                if not isinstance(f.get(key), list):
                    f[key] = []
            f["steps"] = [s for s in (f.get("steps") or [])
                          if isinstance(s, dict)]
        for d in profile.get("domains", []) or []:
            if not isinstance(d, dict):
                continue
            for key in ("depends_on", "memories"):
                if not isinstance(d.get(key), list):
                    d[key] = []
            for e in d.get("entities", []) or []:
                if not isinstance(e, dict):
                    continue
                for key in ("fields", "relations", "memories"):
                    if not isinstance(e.get(key), list):
                        e[key] = []
        return profile

    def list_projects(self) -> list[str]:
        d = self._profile_dir()
        if not d.exists():
            return []
        return sorted(p.stem for p in d.glob("*.json"))

    # ── 画像输入收集 ──
    def _collect_memories(self, project_id: str, limit: int = 200) -> dict:
        """收集业务记忆（scope=project + project_id）与通用技术记忆。"""
        swarm = self.mm.swarm
        business, tech = [], []
        for mid in swarm.get_all_memory_ids():
            item = swarm._store.get(mid)
            if not item:
                continue
            meta = item["metadata"]
            if int(meta.get("chunk_index", 0) or 0) > 0:
                continue  # 跳过分块子条目
            scope = meta.get("scope") or (
                "project" if meta.get("project_id") else "general")
            entry = {
                "memory_id": mid,
                "title": meta.get("title", ""),
                "category": meta.get("category", ""),
                "tags": _safe_split(meta.get("tags")),
                "created": meta.get("created", ""),
                "observation_type": meta.get("observation_type", ""),
                "knowledge_type": meta.get("knowledge_type", ""),
                "solution": meta.get("solution", "") or "",
            }
            if scope == "project" and meta.get("project_id") == project_id:
                business.append(entry)
            elif scope == "general":
                tech.append(entry)
        business.sort(key=lambda x: x["created"], reverse=True)
        tech.sort(key=lambda x: x["created"], reverse=True)
        return {"business": business[:limit], "tech": tech[:limit]}

    # ── Phase 2: 构建草稿 ──
    def build_draft(self, project_id: str, limit: int = 200,
                    llm_refine: Optional[bool] = None) -> dict:
        """从业务记忆生成画像草稿（规则骨架 + 可选 LLM 精炼）。"""
        if llm_refine is None:
            llm_refine = config.profile_llm_enabled
        memories = self._collect_memories(project_id, limit=limit)
        business = memories["business"]
        profile = {
            "project_id": project_id,
            "version": 0,
            "status": "draft",
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "domains": [],
            "flows": [],
            "shared_tech": {"stack": [], "tech_memories": []},
        }
        if business:
            profile["domains"] = self._rule_domains(business)
        profile["shared_tech"]["tech_memories"] = [
            m["memory_id"] for m in memories["tech"][:80]]
        profile["shared_tech"]["stack"] = self._extract_stack(memories["tech"])
        if llm_refine:
            try:
                refined = self._llm_refine(project_id, profile, business)
                if refined:
                    profile = refined
                    profile["status"] = "draft"
            except Exception as e:
                logger.warning("画像 LLM 精炼失败（%s），保留规则骨架", e)
        return profile

    @staticmethod
    def _domain_name(category: str) -> str:
        mapping = {
            "coding": "编码与接口",
            "architecture": "架构与领域模型",
            "debugging": "问题排查",
            "devops": "部署与运维",
            "config": "配置与环境",
            "security": "安全",
            "testing": "测试",
            "performance": "性能",
            "skill": "技能沉淀",
        }
        return mapping.get(category, category or "general")

    def _rule_domains(self, business: list[dict]) -> list[dict]:
        """规则骨架：按 category 分组为域，标题为实体候选并挂记忆。"""
        by_cat: dict[str, list[dict]] = {}
        for m in business:
            by_cat.setdefault(m["category"] or "general", []).append(m)
        domains = []
        for cat, mems in by_cat.items():
            mems = sorted(mems, key=lambda x: x["created"], reverse=True)
            domain = {
                "id": _slug(cat),
                "name": self._domain_name(cat),
                "description": "",
                "entities": [],
                "depends_on": [],
                "memories": [m["memory_id"] for m in mems[:100]],
            }
            seen: set[str] = set()
            for m in mems:
                key = m["title"][:48]
                if key in seen:
                    continue
                seen.add(key)
                domain["entities"].append({
                    "id": _slug(m["title"]),
                    "name": m["title"][:80],
                    "description": (m["solution"] or "")[:200],
                    "fields": [],
                    "relations": [],
                    "code_hint": "",
                    "memories": [m["memory_id"]],
                })
            domains.append(domain)
        # 按业务记忆数量降序，主域靠前
        domains.sort(key=lambda d: len(d["memories"]), reverse=True)
        return domains

    @staticmethod
    def _extract_stack(tech: list[dict], top: int = 12) -> list[str]:
        """从通用技术记忆 tags 提取高频技术栈关键词。"""
        from collections import Counter
        counter: Counter = Counter()
        for m in tech:
            for tag in m.get("tags", []):
                if len(tag) <= 24:
                    counter[tag] += 1
            title = m.get("title", "")
            for word in ("Laravel", "Flowable", "MySQL", "Redis", "Docker",
                         "Nginx", "PHP", "Vue", "Java", "Python", "Vite",
                         "CDN", "Elasticsearch", "Kafka", "RabbitMQ"):
                if word.lower() in title.lower():
                    counter[word] += 1
        return [w for w, _ in counter.most_common(top)]

    def _llm_refine(self, project_id: str, skeleton: dict,
                    business: list[dict]) -> Optional[dict]:
        """LLM 精炼：从业务记忆提炼真实领域/实体/关系，输出 JSON。"""
        from cerebrate.brain.llm import CerebrateLLM
        llm = CerebrateLLM()
        if not llm.is_available():
            return None
        mem_blocks = []
        for m in business[:40]:
            mem_blocks.append(
                f"- {m['memory_id']} | {m['category']} | {m['title']}")
        prompt = f"""你是企业级项目的领域架构师。基于以下项目「{project_id}」的业务记忆清单，
提炼该项目的业务画像（数据世界 + 流程世界）：
  - 静态结构：领域模块、数据实体、实体关系、依赖
  - 动态流程：核心业务流程如何运行（时序/状态流转/功能交互），类似产品经理的时序图/流程图/UI flow

## 输入：业务记忆（memory_id | 分类 | 标题）
{chr(10).join(mem_blocks)}

## 输出要求
只输出一个 JSON 对象（不要 markdown 代码块，不要解释），结构：
{{
  "domains": [
    {{
      "id": "域名(小写英文/中文)",
      "name": "域名",
      "description": "该域职责",
      "entities": [
        {{
          "id": "实体id",
          "name": "实体名",
          "description": "实体职责",
          "fields": [{{"name": "字段", "type": "类型", "desc": "含义"}}],
          "relations": [{{"to": "目标实体id", "type": "1:N|N:1|N:M", "via": "关联字段"}}],
          "code_hint": "代码入口提示",
          "memories": ["匹配的 memory_id"]
        }}
      ],
      "depends_on": ["依赖的其他域id"]
    }}
  ],
  "shared_tech": {{
    "stack": ["技术栈关键词"],
    "tech_memories": []
  }},
  "flows": [
    {{
      "id": "流程id",
      "name": "流程名",
      "trigger": "触发者/触发条件",
      "actors": ["参与角色/系统"],
      "steps": [
        {{
          "seq": 1,
          "actor": "执行者(角色/系统)",
          "action": "动作描述",
          "input": "输入",
          "output": "输出",
          "condition": "触发/流转条件",
          "detail": "实现提示(如服务名/接口)"
        }}
      ],
      "state_machine": {{
        "states": ["状态列表"],
        "transitions": [{{"from": "起始状态", "to": "目标状态", "on": "触发条件"}}]
      }},
      "depends_on": ["依赖的域/流程id"],
      "memories": ["匹配的 memory_id"]
    }}
  ]
}}

约束：
- 只使用输入中出现过的 memory_id
- 实体数 3-15 个；relations 只填确有其事的依赖
- flows 提炼 1-6 条核心流程（若记忆体现流程）；steps 按执行时序排列；state_machine 只填有依据的状态流转
- 数据世界必须真实：宁可少而准，不要编造
"""
        text = llm._chat_completion(
            [{"role": "user", "content": prompt}], max_tokens=6000,
            temperature=0.1)
        if not text:
            return None
        parsed = self._parse_json(text)
        if not parsed or not isinstance(parsed.get("domains"), list):
            return None
        if not isinstance(parsed.get("flows"), list):
            parsed["flows"] = []
        # 规则骨架兜底：LLM 未提炼流程时，为每个域生成最小流程占位
        if not parsed["flows"]:
            for d in parsed["domains"]:
                parsed["flows"].append({
                    "id": f"{d.get('id', 'domain')}-flow",
                    "name": f"{d.get('name', '')} 业务处理流程",
                    "trigger": "",
                    "actors": [],
                    "steps": [],
                    "state_machine": {"states": [], "transitions": []},
                    "depends_on": d.get("depends_on", []),
                    "memories": d.get("memories", [])[:20],
                })
        # 保留骨架中未被 LLM 覆盖的域（防丢失）
        skeleton_ids = {d["id"] for d in skeleton.get("domains", [])}
        refined_ids = {d.get("id") for d in parsed["domains"]}
        for d in skeleton.get("domains", []):
            if d["id"] not in refined_ids:
                parsed["domains"].append(d)
        parsed["project_id"] = project_id
        parsed["version"] = 0
        parsed["status"] = "draft"
        parsed["updated_at"] = datetime.now(timezone.utc).isoformat()
        return parsed

    @staticmethod
    def _parse_json(text: str) -> Optional[dict]:
        import re
        text = text.strip()
        # 去掉可能的 markdown 代码块围栏
        fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
        if fence:
            text = fence.group(1).strip()
        try:
            return json.loads(text)
        except Exception:
            start, end = text.find("{"), text.rfind("}")
            if start >= 0 and end > start:
                try:
                    return json.loads(text[start:end + 1])
                except Exception:
                    return None
            return None

    # ── Phase 3: 导航 ──
    def navigate(self, project_id: str, target: str) -> dict:
        """在画像中定位目标域/实体，返回路径 + 挂载记忆 + 依赖。"""
        profile = self.read(project_id)
        if not profile:
            return {"found": False, "project_id": project_id,
                    "reason": "no_profile",
                    "hint": f"项目 {project_id} 暂无业务画像，请先 POST /v1/project/profile 构建"}
        hits = []
        for domain in profile.get("domains", []):
            if _match(domain, target):
                hits.append({
                    "kind": "domain",
                    "path": f"/{domain.get('id', '')}",
                    "name": domain.get("name", ""),
                    "description": domain.get("description", ""),
                    "depends_on": domain.get("depends_on", []),
                    "memory_ids": domain.get("memories", [])[:50],
                    "entities": [e.get("id") for e in domain.get("entities", [])],
                })
            for entity in domain.get("entities", []):
                if _match(entity, target):
                    hits.append({
                        "kind": "entity",
                        "path": f"/{domain.get('id', '')}/{entity.get('id', '')}",
                        "name": entity.get("name", ""),
                        "description": entity.get("description", ""),
                        "relations": entity.get("relations", []),
                        "code_hint": entity.get("code_hint", ""),
                        "memory_ids": entity.get("memories", [])[:20],
                        "domain_id": domain.get("id", ""),
                    })
        if not hits:
            return {"found": False, "project_id": project_id,
                    "reason": "no_match", "target": target,
                    "domains": [d.get("id") for d in profile.get("domains", [])]}
        return {"found": True, "project_id": project_id, "target": target,
                "hits": hits[:20]}

    # ── Phase 4: 记忆挂载 ──
    def attach_memory(self, project_id: str, node_path: str,
                      memory_id: str) -> dict:
        """把业务记忆挂到画像节点（node_path 形如 domain 或 domain/entity）。"""
        profile = self.read(project_id)
        if not profile:
            return {"ok": False, "reason": "no_profile"}
        parts = [p for p in node_path.split("/") if p]
        attached = False
        for domain in profile.get("domains", []):
            if parts and domain.get("id") == parts[0]:
                if len(parts) == 1:
                    mems = domain.setdefault("memories", [])
                    if memory_id not in mems:
                        mems.append(memory_id)
                        attached = True
                else:
                    for ent in domain.get("entities", []):
                        if ent.get("id") == parts[1]:
                            mems = ent.setdefault("memories", [])
                            if memory_id not in mems:
                                mems.append(memory_id)
                                attached = True
                            break
                break
        if not attached:
            return {"ok": False, "reason": "node_not_found", "node_path": node_path}
        profile["version"] = int(profile.get("version", 0))  # save 内 +1
        self.save(project_id, profile)
        return {"ok": True, "project_id": project_id, "node_path": node_path,
                "memory_id": memory_id}

    # ── Markdown 渲染 ──
    def _render_markdown(self, profile: dict) -> str:
        lines = [
            f'<cerebrate-profile project="{profile.get("project_id", "")}" '
            f'version="{profile.get("version", 0)}" status="{profile.get("status", "")}">',
            "",
            f"# 业务画像（数据世界）: {profile.get('project_id', '')}",
            "",
            f"> 版本 {profile.get('version', 0)} | {profile.get('status', '')} "
            f"| 更新 {profile.get('updated_at', '')[:19]}",
            "",
        ]
        domains = profile.get("domains", [])
        if not domains:
            lines.append("_该项目暂无业务画像，请先 build draft。_")
        for domain in domains:
            lines.append(f"## 📦 {domain.get('name', domain.get('id', ''))}"
                         f" `/{domain.get('id', '')}`")
            if domain.get("description"):
                lines.append(f"> {domain['description']}")
            if domain.get("depends_on"):
                lines.append(f"- 依赖: {' → '.join(domain['depends_on'])}")
            entities = domain.get("entities", [])
            if entities:
                lines.append("")
                for ent in entities:
                    lines.append(f"### ▸ {ent.get('name', ent.get('id', ''))} "
                                 f"`/{domain.get('id', '')}/{ent.get('id', '')}`")
                    if ent.get("description"):
                        lines.append(f"  {ent['description']}")
                    rels = ent.get("relations", [])
                    if rels:
                        for r in rels:
                            lines.append(f"  - 🔗 {r.get('type', '')} → "
                                         f"{r.get('to', '')} "
                                         f"(via {r.get('via', '-')})")
                    if ent.get("code_hint"):
                        lines.append(f"  - 📄 代码入口: {ent['code_hint']}")
                    mems = ent.get("memories", [])
                    if mems:
                        lines.append(f"  - 🧠 业务记忆 {len(mems)} 条")
                lines.append("")
            mems = domain.get("memories", [])
            if mems:
                lines.append(f"- 域业务记忆 {len(mems)} 条")
            lines.append("")
        tech = profile.get("shared_tech", {})
        if tech.get("stack"):
            lines.append("## 🧰 项目技术栈（通用参考）")
            lines.append(", ".join(tech["stack"]))
            if tech.get("tech_memories"):
                lines.append(f"")
                lines.append(f"> 关联通用技术记忆 {len(tech['tech_memories'])} 条"
                             "（scope=general，跨项目可复用）")
            lines.append("")
        flows = profile.get("flows", [])
        if flows:
            lines.append("## 🔄 流程世界（业务流程如何运行）")
            for f in flows:
                lines.append(f"### ▶ {f.get('name', f.get('id', ''))} "
                             f"`/{f.get('id', '')}`")
                if f.get("trigger"):
                    lines.append(f"- 触发: {f['trigger']}")
                if f.get("actors"):
                    lines.append(f"- 参与: {', '.join(f['actors'])}")
                steps = f.get("steps", [])
                if steps:
                    lines.append("- 时序:")
                    for s in steps:
                        cond = f" [{s.get('condition')}]" if s.get("condition") else ""
                        lines.append(
                            f"  {s.get('seq', 0)}. {s.get('actor', '')} "
                            f"→ {s.get('action', '')}{cond} "
                            f"({s.get('output', '')})"
                            + (f" · {s.get('detail', '')}" if s.get("detail") else ""))
                sm = f.get("state_machine", {})
                if sm.get("states"):
                    lines.append(f"- 状态机: {' → '.join(sm['states'])}")
                for t in sm.get("transitions", []):
                    lines.append(f"  - {t.get('from')} → {t.get('to')}"
                                 f" (on {t.get('on', '-')})")
                if f.get("depends_on"):
                    lines.append(f"- 依赖: {' → '.join(f['depends_on'])}")
                if f.get("memories"):
                    lines.append(f"- 关联业务记忆 {len(f['memories'])} 条")
                lines.append("")
        lines.append("</cerebrate-profile>")
        return "\n".join(lines)
