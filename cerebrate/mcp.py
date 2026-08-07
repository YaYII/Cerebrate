#!/usr/bin/env python3
"""
Cerebrate MCP Server v5 — 虫群记忆系统 MCP 服务

通过 HTTP 访问独立运行的脑虫 Brain Server（可在 Docker 容器中），
而非本地实例化 BrainAPI。连接地址与鉴权令牌通过环境变量配置：
  CEREBRATE_SERVER_URL   — 脑虫服务地址，默认 http://127.0.0.1:8765
  CEREBRATE_SERVER_TOKEN — Bearer 鉴权令牌，留空则不鉴权
  CEREBRATE_TOKEN_FILE   — 本地持久化 token 文件路径（默认 ~/.cerebrate/token）
  CEREBRATE_ENTITY_STORE — 本地实体图谱文件路径（默认 ~/.cerebrate/entities.json）

认证（阶段3）：同事先执行一次 `python3 -m cerebrate.mcp login`（用户名 + Authenticator
TOTP 6 位码），token 保存到本地文件（chmod 600，唯一凭证，长期有效）；之后 MCP 自动使用。
优先级：环境变量 CEREBRATE_SERVER_TOKEN > 本地 token 文件。logout/status 查看登录态。

实体（本地 MCP 决策 2026-08-06）：实体抽取/衍生在本地执行（cerebrate_entity_extract），
实体数据不离开本地，服务端只接收实体名/标签等轻量结构作为记忆 tags/索引增强。
"""
import sys
import os
import json
import getpass
import argparse
from datetime import datetime, timezone
from pathlib import Path
import urllib.request
import urllib.error

# ── 修复：MCP 以绝对路径启动时 sys.path[0] 落在 cerebrate/ 目录，
#    导致 harvest-push 本地分析时 `import cerebrate` 失败
#    （错误 "No module named 'cerebrate'"）。把项目根目录加入 sys.path；
#    若脚本被单独拷贝到其他位置，父目录不在时该插入无副作用。──
_PROJECT_ROOT = os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# ── 获取物理用户身份（操作系统登录用户名），用于安全溯源 ──
try:
    _PHYSICAL_USER = os.environ.get("USER") or os.environ.get(
        "LOGNAME") or getpass.getuser()
except Exception:
    _PHYSICAL_USER = "unknown"

# ── 本地配置 env 文件（install-mcp.sh 生成于安装目录根，chmod 600）──
# 环境变量优先，env 文件兜底 → 同事 MCP 配置只需指向脚本，无需明文 token。
_MCP_ENV_FILE = os.environ.get("CEREBRATE_MCP_ENV", "").strip() or str(
    Path(_PROJECT_ROOT) / "cerebrate.env")


def _load_env_file() -> dict:
    """读取 MCP 本地配置 env 文件（KEY=VALUE，# 注释，支持引号）。"""
    try:
        path = Path(_MCP_ENV_FILE)
        if path.exists():
            out = {}
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                out[key.strip()] = val.strip().strip('"').strip("'")
            return out
    except Exception:
        pass
    return {}


_ENV_FILE = _load_env_file()
_SERVER_URL = (
    os.environ.get("CEREBRATE_SERVER_URL", "").strip()
    or _ENV_FILE.get("CEREBRATE_SERVER_URL", "").strip()
    or "http://127.0.0.1:8765")

# ── 本地持久化（认证阶段3 + 实体本地 MCP）─────────────────
_ENV_TOKEN_FILE = os.environ.get("CEREBRATE_TOKEN_FILE", "").strip()
_TOKEN_FILE = Path(_ENV_TOKEN_FILE) if _ENV_TOKEN_FILE else (
    Path.home() / ".cerebrate" / "token")
_ENV_ENTITY_STORE = os.environ.get("CEREBRATE_ENTITY_STORE", "").strip()
_ENTITY_STORE = Path(_ENV_ENTITY_STORE) if _ENV_ENTITY_STORE else (
    Path.home() / ".cerebrate" / "entities.json")


def _read_token_file() -> dict:
    """读取本地持久化 token（JSON: {token, user_id, saved_at}）。"""
    try:
        if _TOKEN_FILE.exists():
            return json.loads(_TOKEN_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _save_token(token: str, user_id: str = "") -> None:
    """持久化 token 到本地文件（chmod 600，仅本用户可读）。"""
    _TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "token": token,
        "user_id": user_id,
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }
    _TOKEN_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        _TOKEN_FILE.chmod(0o600)
    except Exception:
        pass


def _clear_token() -> None:
    try:
        if _TOKEN_FILE.exists():
            _TOKEN_FILE.unlink()
    except Exception:
        pass


def _load_effective_token() -> str:
    """优先环境变量，其次本地 env 文件，最后登录持久化 token。"""
    env = os.environ.get("CEREBRATE_SERVER_TOKEN", "").strip()
    if env:
        return env
    env_file_token = _ENV_FILE.get("CEREBRATE_SERVER_TOKEN", "").strip()
    if env_file_token:
        return env_file_token
    return _read_token_file().get("token", "")


_SERVER_TOKEN = _load_effective_token()


def _request(method: str, path: str, body: dict = None) -> dict:
    """向脑虫 Brain Server 发起 HTTP 请求，返回 v5 协议 JSON 信封。

    token 每次请求时动态解析（_load_effective_token）：登录后保存的 token
    在同一 MCP 进程内立即生效，无需重启（修复静态 _SERVER_TOKEN 陈旧问题）。
    """
    full_url = _SERVER_URL.rstrip("/") + path
    data = None
    headers = {"Content-Type": "application/json"}
    token = _load_effective_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        full_url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8") if e.fp else "{}"
        try:
            parsed = json.loads(err_body)
        except json.JSONDecodeError:
            parsed = {"status": "error",
                      "error": {"code": e.code, "message": err_body}}
        if e.code == 401 and not parsed.get("error", {}).get("hint"):
            hint = ("未认证：请先运行 `python3 -m cerebrate.mcp login` 登录"
                    "（或设置 CEREBRATE_SERVER_TOKEN）")
            parsed.setdefault("error", {})["hint"] = hint
        return parsed
    except urllib.error.URLError as e:
        return {"status": "error", "error": {"code": 503, "message": f"无法连接脑虫服务 {full_url}: {e.reason}"}}


# ── 工具定义 ────────────────────────────────────────────────


TOOLS = [
    {
        "name": "cerebrate_sense",
        "description": "【会话开始必须调用】感知虫群脑状态，返回健康状态、记忆总数、代理数、warnings。\n\n3-LAYER WORKFLOW（记忆检索，ALWAYS FOLLOW）:\n  1. cerebrate_search(query) → 紧凑索引（ID/标题/类型/评分/token成本，~50-100 tokens/条）\n  2. cerebrate_timeline(anchor=ID) → 时序上下文（前因后果）\n  3. cerebrate_detail(ids=[...]) → 只取筛选后的完整详情（~500-1000 tokens/条）\nNEVER 直接拉全文：先索引筛选，再按需取详情（省 50-75% token）。\n有问题先 cerebrate_search，再决定取哪些 detail。",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_help",
        "description": "获取 Cerebrate v5 API 发现文档，含所有可用命令、参数、返回格式。",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_doctrines",
        "description": "读取权威教条（doctrine 生命阶段的记忆）。",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_assess",
        "description": "脑虫元认知评估，返回偏见检测、类别健康度、代理贡献和改进建议。",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_query",
        "description": "【决策查询】返回完整内容 + 推荐动作（reuse/verify/new_experience）与 task 指令。\n【deprecated】读侧首选 cerebrate_search（索引层，省 token）；本工具保留给需要全文+决策的场景。\n决策矩阵:\n  recommendation=reuse (score>0.5) → 按 task.instructions 直接复用\n  recommendation=verify (score>0.2) → 参考后独立验证\n  recommendation=new_experience → 从零解决",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "问题描述"},
                "user": {"type": "string", "description": "用户ID", "default": "yangying"},
                "agent_id": {"type": "string", "description": "代理标识", "default": "codex"},
                "project_id": {"type": "string", "description": "项目ID（可选）", "default": ""},
                "scope": {"type": "string", "description": "记忆分类: general=只查通用记忆; project=项目记忆+通用记忆; all=跨项目全量（默认按 project_id 推断）", "default": "", "enum": ["", "general", "project", "all"]}
            },
            "required": ["query"]
        }
    },
    {
        "name": "cerebrate_search",
        "description": "【遇到问题第一步调用】渐进式披露第 1 层：紧凑索引（不含全文）。返回 memory_id/标题/类型/评分/token成本，让 agent 先扫描再决定取哪些详情。\nmode: hybrid=FTS精确+向量语义(默认); fts=仅精确关键词(错误码/命令/函数名); vector=仅向量语义",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "问题描述/关键词"},
                "agent_id": {"type": "string", "description": "代理标识", "default": "codex"},
                "project_id": {"type": "string", "description": "项目ID（可选）", "default": ""},
                "scope": {"type": "string", "description": "记忆分类: general=只查通用记忆; project=项目记忆+通用记忆; all=跨项目全量", "default": "", "enum": ["", "general", "project", "all"]},
                "category": {"type": "string", "description": "分类过滤（可选）", "default": ""},
                "mode": {"type": "string", "description": "检索模式: hybrid=混合(默认); fts=仅全文精确; vector=仅向量语义", "default": "hybrid", "enum": ["hybrid", "fts", "vector"]},
                "limit": {"type": "number", "description": "返回条数", "default": 20}
            },
            "required": ["query"]
        }
    },
    {
        "name": "cerebrate_timeline",
        "description": "【了解前因后果时调用】渐进式披露第 2 层：围绕 anchor 记忆的时序上下文。基于事件日志，返回该记忆前后的相关事件（提出/查询/复用/投票）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "anchor": {"type": "string", "description": "anchor 记忆 ID（不传则用 query 找 top1）", "default": ""},
                "query": {"type": "string", "description": "查询词（anchor 缺省时自动找 top1）", "default": ""},
                "project_id": {"type": "string", "description": "项目ID（可选）", "default": ""},
                "scope": {"type": "string", "description": "记忆分类", "default": "", "enum": ["", "general", "project", "all"]},
                "depth_before": {"type": "number", "description": "anchor 前取几条事件", "default": 3},
                "depth_after": {"type": "number", "description": "anchor 后取几条事件", "default": 3}
            }
        }
    },
    {
        "name": "cerebrate_detail",
        "description": "【筛选后按需调用】渐进式披露第 3 层：按 ids 批量取完整详情（含 content/facts/concepts/evidence）。\n只对 search 筛选后确认相关的记忆调用，不要批量拉取所有结果。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ids": {"type": "array", "items": {"type": "string"}, "description": "要取详情的记忆 ID 数组"}
            },
            "required": ["ids"]
        }
    },    {
        "name": "cerebrate_propose",
        "description": "【解决问题后调用】提交新记忆到虫群。替代 v3 的 share。\nlife_stage 说明:\n  memory: 直接存入虫群(默认)\n  nutrient: 存入营养池，需共识投票升级为 memory\n可选 skill_markdown: SKILL.md（frontmatter+body）结构化技能，v5.6 借鉴腾讯",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "记忆标题"},
                "content": {"type": "string", "description": "详细内容：场景、排查、根因、方案、验证、命令"},
                "category": {"type": "string", "enum": ["coding", "debugging", "architecture", "devops", "performance", "security", "testing", "config", "skill"]},
                "tags": {"type": "string", "description": "逗号分隔的标签"},
                "agent_id": {"type": "string", "description": "代理标识", "default": "codex"},
                "problem": {"type": "string", "description": "原始问题"},
                "solution": {"type": "string", "description": "一句话方案"},
                "life_stage": {"type": "string", "enum": ["memory", "nutrient"], "description": "记忆生命阶段", "default": "memory"},
                "confidence": {"type": "number", "description": "信心分数 0-1", "default": 1.0},
                "validate": {"type": "boolean", "description": "是否触发免疫验证", "default": True},
                "project_id": {"type": "string", "description": "项目ID（可选）", "default": ""},
                "scope": {"type": "string", "description": "记忆分类: general=通用记忆; project=项目记忆（默认按 project_id 推断）", "default": "", "enum": ["", "general", "project"]},
                "supersedes": {"type": "string", "description": "血缘关系：逗号分隔的被取代记忆ID列表，声明当前记忆基于哪些旧记忆"},
                "observation_type": {"type": "string", "description": "观察类型（可选，缺省按 category 自动推导）: bugfix/decision/refactor/discovery/optimization/how-it-works/gotcha/problem-solution", "default": ""},
                "facts": {"type": "string", "description": "逗号分隔的事实清单（可选，缺省从 solution/problem 规则提取）", "default": ""},
                "concepts": {"type": "string", "description": "逗号分隔的概念标签（可选，缺省从 tags/category/标题 规则提取）", "default": ""},
                "auto_entities": {"type": "boolean", "description": "本地实体化衍生：自动把文本中抽出的实体名并入 tags（轻量结构，服务端不存实体数据）", "default": True},
                "skill_markdown": {"type": "string", "description": "SKILL.md 全文（frontmatter+body），结构化技能资产", "default": ""}
            },
            "required": ["title", "content", "tags", "problem", "solution"]
        }
    },
    {
        "name": "cerebrate_propose_skill",
        "description": "【deprecated → 用 cerebrate_propose（category=skill）】将可复用解决模式存为技能。保留兼容。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "技能标题，格式：'技能: <名称>'"},
                "content": {"type": "string", "description": "场景、排查步骤、根因、方案、验证、命令"},
                "tags": {"type": "string", "description": "必须包含 skill_<领域>"},
                "agent_id": {"type": "string", "default": "codex"},
                "problem": {"type": "string", "description": "原始问题"},
                "solution": {"type": "string", "description": "方案"},
                "validate": {"type": "boolean", "default": True}
            },
            "required": ["title", "content", "tags", "problem", "solution"]
        }
    },
    {
        "name": "cerebrate_propose_lesson",
        "description": "【deprecated → 用 cerebrate_propose（category=skill, tags=skill_lesson）】将错误教训存为记忆。保留兼容。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "'教训: <问题>'"},
                "content": {"type": "string", "description": "错误现象、原因、正确做法"},
                "tags": {"type": "string", "description": "必须包含 skill_lesson"},
                "agent_id": {"type": "string", "default": "codex"},
                "problem": {"type": "string", "description": "触发错误的问题"},
                "solution": {"type": "string", "description": "正确做法"},
                "validate": {"type": "boolean", "default": True}
            },
            "required": ["title", "content", "tags", "problem", "solution"]
        }
    },
    {
        "name": "cerebrate_use_start",
        "description": "【复用记忆时调用】开始跟踪记忆复用（向虫群反馈哪些记忆被使用了）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "memory_id": {"type": "string", "description": "被复用的记忆ID"},
                "agent": {"type": "string", "default": "codex"},
                "problem": {"type": "string", "description": "解决的问题"},
                "project_id": {"type": "string", "default": ""}
            },
            "required": ["memory_id", "agent", "problem"]
        }
    },
    {
        "name": "cerebrate_use_finish",
        "description": "【复用完成时调用】完成记忆复用跟踪，报告结果。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "usage_id": {"type": "string", "description": "use_start 返回的 usage_id"},
                "outcome": {"type": "string", "enum": ["success", "partial", "failure"]},
                "feedback": {"type": "string", "description": "使用反馈", "default": ""}
            },
            "required": ["usage_id", "outcome"]
        }
    },
    {
        "name": "cerebrate_register",
        "description": "【首次使用前调用】注册当前 AI 代理到虫群系统。自动上报物理用户身份用于安全溯源。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "agent_id": {"type": "string", "default": "codex"},
                "agent_type": {"type": "string", "default": "mcp"},
                "capabilities": {"type": "string", "default": "code_generation,debugging,refactoring,testing"},
                "physical_user": {"type": "string", "description": "物理用户（自动获取操作系统用户名）"}
            }
        }
    },
    {
        "name": "cerebrate_vote",
        "description": "对虫群中的记忆进行共识投票。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "memory_id": {"type": "string", "description": "记忆ID"},
                "agent": {"type": "string", "default": "codex"},
                "vote": {"type": "string", "enum": ["support", "oppose", "abstain"]},
                "evidence": {"type": "string", "description": "投票理由", "default": ""},
                "confidence": {"type": "number", "default": 1.0}
            },
            "required": ["memory_id", "agent", "vote"]
        }
    },
    {
        "name": "cerebrate_stats",
        "description": "查看虫群系统统计信息：记忆数、代理数、共识状态等。",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_recall",
        "description": "【会话开始调用】读取个人偏好和上下文缓存。",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_remember",
        "description": "【学到偏好时调用】写入个人偏好: user/key/value。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "user": {"type": "string", "description": "用户ID", "default": "yangying"},
                "key": {"type": "string", "description": "偏好键名"},
                "value": {"type": "string", "description": "偏好值"}
            },
            "required": ["key", "value"]
        }
    },
    {
        "name": "cerebrate_knowledge_search",
        "description": "【deprecated → 用 cerebrate_search】搜索权威知识库，查找策略、文档类知识。保留兼容。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词"},
                "topic": {"type": "string", "description": "按主题过滤（可选）"},
                "project_id": {"type": "string", "description": "项目ID（可选）", "default": ""},
                "scope": {"type": "string", "description": "记忆分类: general=只查通用; project=项目+通用; all=全量（默认按 project_id 推断）", "default": "", "enum": ["", "general", "project", "all"]}
            },
            "required": ["query"]
        }
    },
    {
        "name": "cerebrate_project_context",
        "description": "【项目上下文】为 scope=project 的项目生成/读取浓缩上下文文件（含该项目记忆 + 通用记忆概览，标签包裹，绝不覆盖手动内容）。\naction=build 生成/更新（默认）；action=read 读取已生成内容；action=list 列出已有项目。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "项目 ID"},
                "action": {"type": "string", "description": "build=生成/更新(默认); read=读取; list=列出", "default": "build", "enum": ["build", "read", "list"]},
                "limit": {"type": "integer", "description": "build 时收录记忆条数上限（默认 50，最大 200）", "default": 50}
            },
            "required": ["project"]
        }
    },
    {
        "name": "cerebrate_project_profile",
        "description": "【业务画像-数据世界】为项目构建/读取业务画像（领域树+实体关系+依赖导航，地图式分层：先宏观俯瞰再微观深挖，避免 AI 大面积扫代码/被文档淹没）。\naction=read 读取画像（默认；level=summary 宏观概览/level=graph 中观图谱/level=detail 微观完整）；action=list 列出已有画像项目；action=draft 从业务记忆构建草稿（llm_refine=true 时用 LLM 精炼）；action=save 保存人工确认版（profile 字段传画像 JSON）；action=attach 把业务记忆挂到画像节点（node_path + memory_id）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "项目 ID"},
                "action": {"type": "string", "description": "read=读取(默认); list=列出; draft=构建草稿; save=保存确认版; attach=挂载记忆", "default": "read", "enum": ["read", "list", "draft", "save", "attach"]},
                "level": {"type": "string", "description": "read 时披露层级: summary=宏观概览(域+依赖+实体数); graph=中观图谱(域+实体+关系); detail=微观完整(字段+记忆)", "default": "detail", "enum": ["summary", "graph", "detail"]},
                "llm_refine": {"type": "boolean", "description": "draft 时是否用 LLM 精炼（默认取服务端配置）", "default": False},
                "profile": {"type": "object", "description": "save 时传入的画像 JSON（domains/shared_tech 结构）"},
                "node_path": {"type": "string", "description": "attach 时的节点路径，如 domain 或 domain/entity"},
                "memory_id": {"type": "string", "description": "attach 时要挂载的记忆 ID"}
            },
            "required": ["project"]
        }
    },
    {
        "name": "cerebrate_project_navigate",
        "description": "【业务画像导航】在项目业务画像中定位目标域/实体（微观深挖），返回路径+挂载业务记忆+依赖关系+代码入口提示，供 AI 精准读取目标模块（避免全量扫描代码）。配合 cerebrate_project_profile(level=summary) 宏观俯瞰使用。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "项目 ID"},
                "target": {"type": "string", "description": "目标业务关键词，如「DOB 指派」「个案」「审批」"}
            },
            "required": ["project", "target"]
        }
    },
    {
        "name": "cerebrate_project_harvest",
        "description": "【本地代码分析·结构推送】在本地设备分析项目代码（AST 解析，代码不离开本地），只把结构结果（模块/类/端点/字段）push 给脑虫，作为业务画像的真实骨架（企业级精度：结构不从记忆推断）。\n传 dir 则本地分析并 push；不传 dir 则读取服务端已存结构。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "项目 ID"},
                "dir": {"type": "string", "description": "项目代码根目录（如 /home/as-workstation01/Documents/project/Cerebrate）"},
                "exts": {"type": "array", "items": {"type": "string"}, "description": "扫描的文件扩展名（默认 [\".py\"]）"}
            },
            "required": ["project"]
        }
    },
    {
        "name": "cerebrate_project_work",
        "description": "【多人协作感知】工作声明：告知脑虫「谁在哪个分支处理哪个功能」，脑虫知晓并检测冲突（同模块已被他人声明时返回冲突告知）。\naction=claim 声明（module 可为画像实体/模块路径）；action=release 释放；action=list 列出项目活跃工作（按分支）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "项目 ID"},
                "action": {"type": "string", "description": "claim=声明; release=释放; list=列出", "default": "list", "enum": ["claim", "release", "list"]},
                "branch": {"type": "string", "description": "git 分支（claim 时必传）"},
                "module": {"type": "string", "description": "正在处理的功能/模块/实体"},
                "intent": {"type": "string", "description": "处理意图简述"},
                "agent_id": {"type": "string", "description": "AI/开发者标识"}
            },
            "required": ["project"]
        }
    },
    {
        "name": "cerebrate_batch_process",
        "description": "【会话结束时调用】批量处理 IPC 队列中的待办请求。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "最大处理数量", "default": 50}
            }
        }
    },
    {
        "name": "cerebrate_ingest",
        "description": "【知识蒸馏吸入】将本地文档目录批量吸入脑虫知识库。扫描 MD/TXT/RST/YML/JSON 等文件，智能分块后写入权威知识库，支持增量去重。\n\n用法示例:\n  AI智能体: 调用 cerebrate_ingest 并传 dir=/path/to/docs project=my-project\n\n决策矩阵:\n  - 需要将大量文档灌入脑虫时直接调用此工具\n  - 配合 cerebrate_knowledge_search 验证知识是否已入库",
        "inputSchema": {
            "type": "object",
            "properties": {
                "dir": {"type": "string", "description": "要扫描的文档目录路径（绝对路径或相对路径）"},
                "project": {"type": "string", "description": "项目 ID（用于知识隔离，相同项目可集中检索）", "default": ""},
                "dry_run": {"type": "boolean", "description": "预览模式：扫描+分块但不写入知识库", "default": False},
                "verbose": {"type": "boolean", "description": "显示详细处理日志", "default": False}
            },
            "required": ["dir"]
        }
    },
    {
        "name": "cerebrate_knowledge_store",
        "description": "【存入知识】将一段文档内容直接存入脑虫权威知识库。不依赖文件路径，跨网络也可使用。\n\n用法示例:\n  AI智能体: 调用 cerebrate_knowledge_store title=\"xxx\" content=\"xxx\"\n\n与 cerebrate_ingest 的区别:\n  - ingest: 服务端扫描本地目录，自动分块\n  - knowledge_store: 直接接受内容，适合内网MCP客户端→公网脑虫场景",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "文档标题"},
                "content": {"type": "string", "description": "文档正文内容（纯文本或 Markdown）"},
                "topics": {"type": "string", "description": "主题标签，逗号分隔", "default": ""},
                "project": {"type": "string", "description": "项目 ID", "default": ""}
            },
            "required": ["title", "content"]
        }
    },
    {
        "name": "cerebrate_entity_extract",
        "description": "【本地实体化衍生】在本地抽取文本中的实体（命令/技术/项目/术语/联系方式），零 LLM 零成本。\n实体数据不离开本地（架构红线）；可选持久化到本地实体图谱（~/.cerebrate/entities.json）。\n服务端只接收实体名/标签等轻量结构（propose 时 auto_entities 自动把实体名并入 tags）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "要抽取实体的文本（如一段对话/记忆内容）"},
                "persist": {"type": "boolean", "description": "是否合并到本地实体图谱", "default": True},
                "top": {"type": "number", "description": "返回前 N 个实体（按出现次数降序）", "default": 30}
            },
            "required": ["text"]
        }
    },
    {
        "name": "cerebrate_auth_status",
        "description": "【认证引导】查看当前 MCP 登录态：token 来源（env=环境变量 / file=本地文件 / none=未登录）、user_id、可选网络校验（verify=true 调 /v1/auth/me 确认真实有效性）。\n会话开始若怀疑未登录，先调用本工具；已有 token 则直接使用，无需每次授权。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "verify": {"type": "boolean", "description": "是否联网校验 token 有效性", "default": False}
            }
        }
    },
    {
        "name": "cerebrate_auth_register",
        "description": "【认证引导·注册】新用户自助注册（服务端匿名可调）：username → 返回 bind_url 网页链接（网页用 JS 生成二维码，无需用户本地安装任何东西）。\n把 bind_url 发给用户：浏览器打开 → 手机 Authenticator 扫网页上的二维码 → 绑定完成。\n用户扫码后，让用户把 Authenticator 当前 6 位码告诉你，你再调 cerebrate_auth_login 完成登录。\n用户名须 3-32 位小写字母/数字/下划线/连字符；重复注册返回 registered=false。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "username": {"type": "string", "description": "用户名（3-32 位小写字母/数字/_-）"}
            },
            "required": ["username"]
        }
    },
    {
        "name": "cerebrate_auth_login",
        "description": "【认证引导·登录】用户名 + Authenticator 当前 6 位码 → 服务端验证 → 长期 user token 保存到本地（~/.cerebrate/token，chmod 600，唯一凭证）。\n之后 MCP 自动带 token，无需每次授权；换机后重新登录一次即可。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "username": {"type": "string", "description": "用户名"},
                "code": {"type": "string", "description": "Authenticator 当前 6 位码（用户提供）"}
            },
            "required": ["username", "code"]
        }
    },
    {
        "name": "cerebrate_auth_rebind",
        "description": "【认证引导·管理员】为已注册用户重新生成绑定链接（bind_url 网页二维码）。\n仅 master token 可调（普通用户被服务端 403）。用于：注册后链接过期 / 换设备重新绑定。\n返回 bind_url 后发给用户：浏览器打开 → Authenticator 扫码 → 报 6 位码 → cerebrate_auth_login。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "username": {"type": "string", "description": "已注册用户名"}
            },
            "required": ["username"]
        }
    },
    {
        "name": "cerebrate_auth_logout",
        "description": "【认证引导·登出】删除本地持久化 token（服务端 token 仍有效，下次登录复用）。",
        "inputSchema": {"type": "object", "properties": {}}
    },
]

# ── 工具调用实现 ────────────────────────────────────────────


def _handle_call(name: str, args: dict) -> dict:
    try:
        if name == "cerebrate_sense":
            return _request("GET", "/v1/sense")

        elif name == "cerebrate_help":
            return _request("GET", "/v1/help")

        elif name == "cerebrate_doctrines":
            return _request("GET", "/v1/doctrines")

        elif name == "cerebrate_assess":
            return _request("GET", "/v1/brain/assess")

        elif name == "cerebrate_search":
            return _request("POST", "/v1/search", {
                "query": args["query"],
                "agent_id": args.get("agent_id", "codex"),
                "project_id": args.get("project_id", ""),
                "scope": args.get("scope", ""),
                "category": args.get("category", ""),
                "mode": args.get("mode", "hybrid"),
                "limit": int(args.get("limit", 20)),
            })

        elif name == "cerebrate_timeline":
            return _request("POST", "/v1/timeline", {
                "anchor": args.get("anchor", ""),
                "query": args.get("query", ""),
                "project_id": args.get("project_id", ""),
                "scope": args.get("scope", ""),
                "depth_before": int(args.get("depth_before", 3)),
                "depth_after": int(args.get("depth_after", 3)),
            })

        elif name == "cerebrate_detail":
            return _request("POST", "/v1/memories/detail", {
                "ids": args.get("ids", [])
            })

        elif name == "cerebrate_query":
            return _request("POST", "/v1/query", {
                "query": args["query"],
                "user": args.get("user", "yangying"),
                "agent_id": args.get("agent_id", "codex"),
                "project_id": args.get("project_id", ""),
                "scope": args.get("scope", ""),
                "detail": bool(args.get("detail", True)),
            })

        elif name == "cerebrate_propose":
            tags_raw = args.get("tags", "")
            tags = [t.strip() for t in tags_raw.split(",")
                    if t.strip()] if tags_raw else []
            # 本地实体化衍生：把文本中抽出的实体名并入 tags（轻量结构，服务端不存实体数据）
            if args.get("auto_entities", True):
                try:
                    from cerebrate.entity import extract_entities
                    _text = f"{args.get('title', '')}\n{args.get('content', '')}"
                    for ent in extract_entities(_text)[:30]:
                        name = ent["name"].strip()
                        if (name and len(name) <= 30 and name.lower()
                                not in {t.lower() for t in tags}):
                            tags.append(name)
                except Exception:
                    pass  # 本地实体抽取失败不阻塞 propose
            return _request("POST", "/v1/memories/propose", {
                "title": args["title"],
                "content": args["content"],
                "category": args.get("category", "general"),
                "tags": ",".join(tags[:20]),
                "agent_id": args.get("agent_id", "codex"),
                "problem": args.get("problem", ""),
                "solution": args.get("solution", ""),
                "life_stage": args.get("life_stage", "memory"),
                "confidence": args.get("confidence", 1.0),
                "validate": args.get("validate", True),
                "project_id": args.get("project_id", ""),
                "scope": args.get("scope", ""),
                "supersedes": args.get("supersedes", ""),
                "observation_type": args.get("observation_type", ""),
                "facts": args.get("facts", ""),
                "concepts": args.get("concepts", ""),
                "skill_markdown": args.get("skill_markdown", ""),
                "physical_user": args.get("physical_user") or _PHYSICAL_USER,
            })

        elif name == "cerebrate_propose_skill":
            return _request("POST", "/v1/memories/propose", {
                "title": args["title"],
                "content": args["content"],
                "category": "skill",
                "tags": args["tags"],
                "agent_id": args.get("agent_id", "codex"),
                "problem": args.get("problem", ""),
                "solution": args.get("solution", ""),
                "life_stage": "memory",
                "confidence": 1.0,
                "validate": args.get("validate", True),
                "physical_user": args.get("physical_user") or _PHYSICAL_USER,
            })

        elif name == "cerebrate_propose_lesson":
            return _request("POST", "/v1/memories/propose", {
                "title": args["title"],
                "content": args["content"],
                "category": "skill",
                "tags": f"skill_lesson,{args['tags']}",
                "agent_id": args.get("agent_id", "codex"),
                "problem": args.get("problem", ""),
                "solution": args.get("solution", ""),
                "life_stage": "memory",
                "confidence": 1.0,
                "validate": args.get("validate", True),
                "physical_user": args.get("physical_user") or _PHYSICAL_USER,
            })

        elif name == "cerebrate_use_start":
            return _request("POST", "/v1/usages/start", {
                "memory_id": args["memory_id"],
                "agent": args["agent"],
                "problem": args["problem"],
                "project_id": args.get("project_id", "")
            })

        elif name == "cerebrate_use_finish":
            return _request("POST", "/v1/usages/finish", {
                "usage_id": args["usage_id"],
                "outcome": args["outcome"],
                "feedback": args.get("feedback", "")
            })

        elif name == "cerebrate_register":
            return _request("POST", "/v1/agents/register", {
                "agent_id": args.get("agent_id", "codex"),
                "agent_type": args.get("agent_type", "mcp"),
                "capabilities": args.get("capabilities", "code_generation,debugging,refactoring,testing").split(","),
                "physical_user": args.get("physical_user") or _PHYSICAL_USER,
            })

        elif name == "cerebrate_vote":
            return _request("POST", "/v1/consensus/vote", {
                "memory_id": args["memory_id"],
                "agent": args["agent"],
                "vote": args["vote"],
                "evidence": args.get("evidence", ""),
                "confidence": args.get("confidence", 1.0),
            })

        elif name == "cerebrate_stats":
            envelope = _request("GET", "/v1/sense")
            if envelope.get("status") != "ok":
                return envelope
            sense = envelope.get("data", {})
            return {"status": "ok", "data": {
                "total_memories": sense.get("total_memories", 0),
                "total_agents": sense.get("total_agents", 0),
                "agent_ids": sense.get("agent_ids", []),
                "warnings": sense.get("warnings", []),
                "llm": sense.get("llm", {}),
                "consensus": sense.get("consensus", {}),
                "health": sense.get("health", "unknown"),
            }}

        elif name == "cerebrate_recall":
            return _request("GET", "/v1/personal")

        elif name == "cerebrate_remember":
            return _request("POST", "/v1/personal", {
                "user": args.get("user", "yangying"),
                "key": args["key"],
                "value": args["value"]
            })

        elif name == "cerebrate_knowledge_search":
            from urllib.parse import urlencode
            q = args.get("query", "")
            qparams = {"q": q}
            if args.get("topic"):
                qparams["topic"] = args["topic"]
            if args.get("project_id"):
                qparams["project_id"] = args["project_id"]
            if args.get("scope"):
                qparams["scope"] = args["scope"]
            return _request("GET", f"/v1/knowledge?{urlencode(qparams)}")

        elif name == "cerebrate_project_context":
            return _request("POST", "/v1/project/context", {
                "project": args.get("project", ""),
                "action": args.get("action", "build"),
                "limit": args.get("limit", 50),
            })

        elif name == "cerebrate_project_profile":
            return _request("POST", "/v1/project/profile", {
                "project": args.get("project", ""),
                "action": args.get("action", "read"),
                "level": args.get("level", "detail"),
                "llm_refine": args.get("llm_refine", False),
                "profile": args.get("profile"),
                "node_path": args.get("node_path", ""),
                "memory_id": args.get("memory_id", ""),
            })

        elif name == "cerebrate_project_navigate":
            return _request("POST", "/v1/project/navigate", {
                "project": args.get("project", ""),
                "target": args.get("target", ""),
            })

        elif name == "cerebrate_project_harvest":
            dir_raw = args.get("dir", "")
            if not dir_raw:
                # 无 dir：读取服务端已存的结构
                return _request("POST", "/v1/project/harvest", {
                    "project": args.get("project", ""),
                    "dir": "",
                })
            # 有 dir：本地 AST 分析（代码不离开本地），只把结构 push 给脑虫
            from pathlib import Path
            from cerebrate.tools.code_harvest import (
                harvest_project, _safe_branch)
            from cerebrate.tools.code_sync import _git_branch
            root = Path(dir_raw).resolve()
            if not root.is_dir():
                return {"status": "error",
                        "error": {"code": 400,
                                  "message": f"目录不存在: {root}"}}
            project_id = args.get("project", "")
            branch = _safe_branch(_git_branch(root))
            exts = tuple(args.get("exts")) if args.get("exts") else None
            harvest = harvest_project(root, project_id=project_id, exts=exts)
            return _request("POST", "/v1/harvest/push", {
                "project": project_id,
                "branch": branch,
                "harvest": harvest,
                "auto_profile": True,
            })

        elif name == "cerebrate_project_work":
            return _request("POST", "/v1/project/work", {
                "project": args.get("project", ""),
                "action": args.get("action", "list"),
                "branch": args.get("branch", ""),
                "module": args.get("module", ""),
                "intent": args.get("intent", ""),
                "agent_id": args.get("agent_id", ""),
            })

        elif name == "cerebrate_batch_process":
            return _request("POST", "/v1/batch/process", {
                "limit": args.get("limit", 50)
            })

        elif name == "cerebrate_ingest":
            return _request("POST", "/v1/ingest", {
                "dir": args["dir"],
                "project": args.get("project", ""),
                "dry_run": args.get("dry_run", False),
                "verbose": args.get("verbose", False),
            })

        elif name == "cerebrate_knowledge_store":
            topics_raw = args.get("topics", "")
            topics = [t.strip() for t in topics_raw.split(
                ",") if t.strip()] if topics_raw else []
            return _request("POST", "/v1/knowledge", {
                "title": args["title"],
                "content": args["content"],
                "topics": topics,
                "source": "mcp-knowledge-store",
                "is_policy": False,
                "author": args.get("author", "mcp-client"),
                "project_id": args.get("project", ""),
            })

        elif name == "cerebrate_entity_extract":
            from cerebrate.entity import extract_and_update
            result = extract_and_update(
                args.get("text", ""),
                store_path=_ENTITY_STORE,
                persist=args.get("persist", True),
                top=int(args.get("top", 30)),
            )
            return {"status": "ok", "data": result}

        elif name == "cerebrate_auth_status":
            env_token = os.environ.get("CEREBRATE_SERVER_TOKEN", "").strip()
            local = _read_token_file()
            if env_token:
                source, user_id, has_token = "env", "", True
            elif local.get("token"):
                source, user_id, has_token = (
                    "file", local.get("user_id", ""), True)
            else:
                source, user_id, has_token = "none", "", False
            verified_user = None
            verified_role = None
            if args.get("verify") and has_token:
                me = _request("GET", "/v1/auth/me")
                if me.get("status") == "ok":
                    vdata = me.get("data", {})
                    verified_user = vdata.get("user_id", "")
                    verified_role = vdata.get("role", "")
            return {"status": "ok", "data": {
                "has_token": has_token,
                "source": source,
                "user_id": user_id,
                "verified_user": verified_user,
                "verified_role": verified_role,
                "token_file": str(_TOKEN_FILE),
            }}

        elif name == "cerebrate_auth_register":
            username = args.get("username", "").strip()
            result = _request("POST", "/v1/auth/register", {
                "username": username})
            if result.get("status") != "ok":
                return result
            data = result.get("data", {})
            if data.get("registered"):
                # 绑定页 URL 由客户端拼接（服务端在容器内不知道公网地址）
                if data.get("bind_token"):
                    data["bind_url"] = (
                        f"{_SERVER_URL.rstrip('/')}/v1/auth/bind"
                        f"?token={data['bind_token']}")
                data["hint"] = ("把 bind_url 发给用户：浏览器打开网页 → "
                                "网页显示二维码 → Authenticator 扫码绑定；"
                                "绑定后请用户提供当前 6 位码再调 "
                                "cerebrate_auth_login")
            return {"status": "ok", "data": data}

        elif name == "cerebrate_auth_login":
            username = args.get("username", "").strip()
            code = args.get("code", "").strip()
            result = _request("POST", "/v1/auth/login", {
                "username": username, "code": code})
            if result.get("status") != "ok":
                return result
            data = result.get("data", {})
            token = data.get("token", "")
            user_id = data.get("user_id", username)
            if token:
                _save_token(token, user_id)
            data["token_saved"] = bool(token)
            data["token_file"] = str(_TOKEN_FILE)
            data["hint"] = ("登录成功，token 已本地持久化（唯一凭证）；"
                            "之后直接使用，无需每次授权")
            return {"status": "ok", "data": data}

        elif name == "cerebrate_auth_rebind":
            username = args.get("username", "").strip()
            result = _request("POST", "/v1/auth/rebind", {
                "username": username})
            if result.get("status") != "ok":
                return result
            data = result.get("data", {})
            if data.get("bind_token"):
                data["bind_url"] = (
                    f"{_SERVER_URL.rstrip('/')}/v1/auth/bind"
                    f"?token={data['bind_token']}")
                data["hint"] = ("把 bind_url 发给用户：浏览器打开 → "
                                "Authenticator 扫码 → 报 6 位码 → "
                                "cerebrate_auth_login")
            return {"status": "ok", "data": data}

        elif name == "cerebrate_auth_logout":
            _clear_token()
            return {"status": "ok",
                    "data": {"logged_out": True,
                             "message": "本地 token 已删除"}}

        else:
            return {"status": "error", "error": {"code": -1, "message": f"未知工具: {name}"}}

    except KeyError as e:
        return {"status": "error", "error": {"code": 400, "message": f"缺少必填参数: {e}"}}
    except Exception as e:
        return {"status": "error", "error": {"code": 500, "message": str(e)}}


# ── MCP stdio 协议实现 ──────────────────────────────────────

def _send(msg: dict):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


# ── 客户端 CLI（认证阶段3：login / logout / status）─────────


def _cli_login(args) -> int:
    """用户名 + Authenticator TOTP 码登录，token 持久化到本地。"""
    username = (args.username or "").strip()
    if not username:
        username = input("用户名: ").strip()
    code = (args.code or "").strip()
    if not code:
        # TOTP 码虽非密码，仍用 getpass 防止肩窥
        code = getpass.getpass("Authenticator 6 位码: ").strip()
    result = _request("POST", "/v1/auth/login", {
        "username": username, "code": code})
    if result.get("status") != "ok":
        print(f"登录失败: {result.get('error', {}).get('message', result)}")
        return 1
    data = result.get("data", {})
    token = data.get("token", "")
    user_id = data.get("user_id", username)
    if not token:
        print("登录失败: 服务端未返回 token")
        return 1
    _save_token(token, user_id)
    print(f"登录成功: {user_id}")
    print(f"token 已保存: {_TOKEN_FILE}（chmod 600，唯一凭证，长期有效）")
    print("提示: 妥善保存 token；换机后运行本命令重新登录即可（无需重新注册）")
    return 0


def _cli_logout(args) -> int:
    """删除本地持久化 token（服务端 token 仍有效，下次登录复用）。"""
    if _read_token_file().get("token"):
        _clear_token()
        print("已退出登录（本地 token 已删除）")
    else:
        print("当前未登录（本地无 token）")
    return 0


def _cli_status(args) -> int:
    """查看登录态与生效 token 来源。"""
    info = _read_token_file()
    env = os.environ.get("CEREBRATE_SERVER_TOKEN", "").strip()
    if env:
        print("token 来源: 环境变量 CEREBRATE_SERVER_TOKEN（优先）")
    elif _ENV_FILE.get("CEREBRATE_SERVER_TOKEN", "").strip():
        print(f"token 来源: 本地配置 {_MCP_ENV_FILE}")
    elif info.get("token"):
        print(f"token 来源: 登录持久化（已登录: {info.get('user_id', '?')}）")
    else:
        print("token 来源: 未配置（只读接口可用；写记忆需先登录）")
    print(f"服务地址: {_SERVER_URL}")
    print(f"token 文件: {_TOKEN_FILE}")
    print(f"实体图谱: {_ENTITY_STORE}")
    return 0


def _run_cli(argv: list) -> int:
    parser = argparse.ArgumentParser(
        prog="cerebrate-mcp",
        description="Cerebrate MCP 客户端工具（登录/登出/状态）")
    sub = parser.add_subparsers(dest="command", required=True)

    p_login = sub.add_parser("login", help="用户名 + TOTP 码登录")
    p_login.add_argument("--username", default="",
                         help="脑虫用户名（管理员已注册）")
    p_login.add_argument("--code", default="",
                         help="Authenticator 6 位码（不传则交互输入）")

    sub.add_parser("logout", help="删除本地 token")
    sub.add_parser("status", help="查看登录态")

    args = parser.parse_args(argv)
    if args.command == "login":
        return _cli_login(args)
    if args.command == "logout":
        return _cli_logout(args)
    return _cli_status(args)


def main():
    # 客户端 CLI 分发：python3 -m cerebrate.mcp login|logout|status
    if len(sys.argv) > 1 and sys.argv[1] in ("login", "logout", "status"):
        sys.exit(_run_cli(sys.argv[1:]))

    # MCP server 不得在收到 initialize 前主动发消息，握手由客户端发起。
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        req_id = req.get("id")
        method = req.get("method", "")
        params = req.get("params", {})

        # JSON-RPC 通知（无 id，如 notifications/initialized、notifications/cancelled）
        # 按规范不得返回任何响应，统一忽略。
        if req_id is None:
            continue

        if method == "initialize":
            client_version = params.get("protocolVersion", "2024-11-05")
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": client_version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "cerebrate-mcp-v5", "version": "5.1.1"}
                }
            })
        elif method == "ping":
            # MCP 心跳：必须回空 result，否则客户端判定连接异常
            _send({"jsonrpc": "2.0", "id": req_id, "result": {}})
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            tool_name = params.get("name", "")
            tool_args = params.get("arguments", {})
            result = _handle_call(tool_name, tool_args)
            is_error = result.get("status") == "error"
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}],
                    "isError": is_error
                }
            })
        else:
            # JSON-RPC 标准错误码 -32601 Method not found
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"未知方法: {method}"}
            })


if __name__ == "__main__":
    main()
