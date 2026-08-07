#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Cerebrate MCP Server v5 — Node.js 版（零依赖，node >= 16）
//
// 用途：团队记忆 MCP 客户端。通过 stdio 与 AI 客户端通信，
// 通过 HTTP 访问脑虫服务（本地或公网 https://<域名>/cerebrate）。
//
// 配置（优先级：环境变量 > 本地 env 文件 cerebrate.env > 默认）：
//   CEREBRATE_SERVER_URL   — 脑虫服务地址
//   CEREBRATE_SERVER_TOKEN — Bearer 鉴权令牌
//   CEREBRATE_MCP_ENV      — 自定义 env 文件路径（默认脚本同目录 cerebrate.env）
//
// CLI: node mcp.js login|logout|status [--username X] [--code Y]
// ─────────────────────────────────────────────────────────────
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const readline = require("readline");
const child_process = require("child_process");

// ── 配置 ────────────────────────────────────────────────────
// npm 全局/npx 安装后脚本位于 node_modules 缓存目录（不可写），
// env 配置文件统一放到用户主目录 ~/.cerebrate-mcp/cerebrate.env
// （与 install-mcp.sh 的 INSTALL_DIR 一致；CEREBRATE_MCP_ENV 可覆盖）。
const MCP_ENV_FILE =
  process.env.CEREBRATE_MCP_ENV ||
  path.join(os.homedir(), ".cerebrate-mcp", "cerebrate.env");

function loadEnvFile() {
  try {
    if (!fs.existsSync(MCP_ENV_FILE)) return {};
    const out = {};
    for (const line of fs.readFileSync(MCP_ENV_FILE, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      out[s.slice(0, i).trim()] = s
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
    return out;
  } catch (e) {
    return {};
  }
}

const ENV_FILE = loadEnvFile();
const SERVER_URL =
  (process.env.CEREBRATE_SERVER_URL || ENV_FILE.CEREBRATE_SERVER_URL || "")
    .replace(/\/+$/, "") || "http://127.0.0.1:8765";
const TOKEN_FILE =
  process.env.CEREBRATE_TOKEN_FILE ||
  path.join(os.homedir(), ".cerebrate", "token");
const PHYSICAL_USER =
  process.env.USER || process.env.LOGNAME || os.userInfo().username || "unknown";

function envToken() {
  return (
    process.env.CEREBRATE_SERVER_TOKEN ||
    ENV_FILE.CEREBRATE_SERVER_TOKEN ||
    ""
  ).trim();
}

function readTokenFile() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    }
  } catch (e) {}
  return {};
}

function saveToken(token, user_id) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify(
      {
        token,
        user_id: user_id || "",
        saved_at: new Date().toISOString(),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

function clearToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch (e) {}
}

function effectiveToken() {
  return envToken() || readTokenFile().token || "";
}

// ── HTTP 客户端（零依赖）────────────────────────────────────
function httpRequest(method, urlPath, body, token) {
  const url = SERVER_URL + urlPath;
  const mod = url.startsWith("https") ? https : http;
  const data = body != null ? JSON.stringify(body) : null;
  return new Promise((resolve) => {
    const req = mod.request(
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            resolve({ status: "error", error: { code: res.statusCode, message: buf } });
          }
        });
      }
    );
    req.on("error", (e) =>
      resolve({ status: "error", error: { code: 503, message: "无法连接脑虫服务 " + url + ": " + e.message } })
    );
    if (data) req.write(data);
    req.end();
  });
}

// ── 本地实体抽取（规则移植自 cerebrate/entity.py，数据不离开本地）──
const TECH_KEYWORDS = [
  "docker", "git", "nginx", "ngrok", "postgres", "mysql", "redis", "chromadb",
  "sqlite", "flowable", "laravel", "deepseek", "qoder", "claude", "codex",
  "trae", "mcp", "totp", "bge", "fts", "llm", "api", "cli", "json", "yml",
  "yaml", "ast", "sse", "http", "https", "tls", "jira", "github", "gitlab",
  "kubernetes", "k8s", "pytest", "unittest", "hmac", "sha1", "base32",
  "chroma", "embedding", "reranker", "swarm", "doctrine", "nutrient",
  "verified_skill", "cerebrate", "origin_log", "docstore", "metastore",
  "fulltext", "rerank", "bpmn", "curl", "pip", "npm", "ssh", "make",
  "kubectl", "sudo", "python3", "postgresql", "mariadb", "celery",
  "rabbitmq", "kafka",
];
const RE_CAMEL = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;
const RE_SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/g;
const RE_URL = /https?:\/\/[^\s"'<>]+/g;
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const RE_QUOTED = /["']([^"']{2,40})["']/g;
const RE_SHA = /^[0-9a-f]{8,}$/;
const RE_NUM = /^[\d.]+$/;

function boundary(pattern) {
  return `(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`;
}

function extractEntities(text, known) {
  text = text || "";
  if (!text.trim()) return [];
  known = known || {};
  const seen = new Map();
  const add = (name, type) => {
    if (!name || name.length > 40) return;
    if (RE_SHA.test(name) || RE_NUM.test(name)) return;
    const key = name.toLowerCase();
    const k = known[key];
    const t = k && k.type ? k.type : type;
    if (seen.has(key)) {
      seen.get(key).count++;
    } else {
      seen.set(key, { name, type: t, count: 1 });
    }
  };
  for (const m of text.matchAll(RE_URL)) add(m[0].trim(), "url");
  for (const m of text.matchAll(RE_EMAIL)) add(m[0].trim(), "contact");
  for (const kw of TECH_KEYWORDS) {
    const re = new RegExp(boundary(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "gi");
    for (const m of text.matchAll(re)) add(m[0], "tech");
  }
  for (const m of text.matchAll(RE_CAMEL)) add(m[0], "tech");
  for (const m of text.matchAll(RE_SNAKE)) add(m[0], "tech");
  for (const m of text.matchAll(RE_QUOTED)) add(m[1].trim(), "term");
  for (const [key, info] of Object.entries(known)) {
    if (!info || seen.has(key)) continue;
    const name = info.name || key;
    const re = new RegExp(boundary(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "i");
    if (re.test(text)) add(name, info.type || "other");
  }
  return Array.from(seen.values()).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

// ── 本地代码分析（harvest，零依赖轻量解析器）────────────────
// 产出结构与 Python 版 code_harvest.harvest_project 兼容；
// 代码不离开本地，只把结构 push 给脑虫（业务画像真实骨架）。
const HARVEST_SKIP_DIRS = new Set([
  ".git", "__pycache__", ".venv", "venv", "node_modules", "vendor",
  "dist", "build", ".codex", ".qoder", ".claude", "data", "profiles",
  "harvest", "context", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  "tests", "test", "docs_build",
]);
const HARVEST_SKIP_FILES = new Set([
  "__init__.py", "setup.py", "conftest.py",
  ".env", ".env.example", ".env.local",
]);

function harvestGitBranch(root) {
  try {
    const out = child_process
      .execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: root, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
    return (out && out !== "HEAD" ? out : "master").replace(/[^0-9a-zA-Z._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "default";
  } catch (e) {
    return "default";
  }
}

function parsePythonFile(text, fileRel) {
  const classes = [], functions = [], endpoints = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cm = line.match(/^\s*class\s+(\w+)/);
    if (cm) {
      const prev = (lines[i - 1] || "").trim();
      const isData = /@dataclass/.test(prev);
      classes.push({ name: cm[1], kind: isData ? "data_model" : "class", fields: [], file: fileRel, doc: "" });
      continue;
    }
    const dm = line.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
    if (dm) {
      functions.push({ name: dm[1], file: fileRel, doc: "" });
      continue;
    }
    // 端点：@app.route("@app.get("/x") 等装饰器（下一行是 def 时）
    const ed = line.match(/^\s*@[\w.]+\.(route|get|post|put|delete|patch)\(\s*["']([^"']+)["']/);
    if (ed) {
      const next = (lines[i + 1] || "").match(/^\s*(?:async\s+)?def\s+(\w+)/);
      const method = ed[1].toUpperCase();
      endpoints.push({ method: method === "ROUTE" ? "ANY" : method, path: ed[2], handler: next ? next[1] : "handler", file: fileRel });
    }
  }
  // Cerebrate http.py 风格: if method == "POST" and path == "/v1/xxx":
  for (const m of text.matchAll(/path\s*==\s*["'](\/v\d\/[^"']+)["']/g)) {
    endpoints.push({ method: "HTTP", path: m[1], handler: "dispatch", file: fileRel });
  }
  return { classes: classes.slice(0, 80), functions: functions.slice(0, 80), endpoints: endpoints.slice(0, 50) };
}

function parseGenericFile(text, fileRel) {
  const classes = [], functions = [], endpoints = [];
  for (const m of text.matchAll(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm)) {
    classes.push({ name: m[1], kind: "class", fields: [], file: fileRel, doc: "" });
  }
  for (const m of text.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)) {
    functions.push({ name: m[1], file: fileRel, doc: "" });
  }
  // JS/Express 风格端点: app.get("/x", ...) / router.post
  for (const m of text.matchAll(/(?:app|router|route)\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g)) {
    endpoints.push({ method: m[1].toUpperCase(), path: m[2], handler: "handler", file: fileRel });
  }
  return { classes: classes.slice(0, 80), functions: functions.slice(0, 80), endpoints: endpoints.slice(0, 50) };
}

function parseJavaFile(text, fileRel) {
  const classes = [], functions = [], endpoints = [];
  for (const m of text.matchAll(/(?:public\s+|private\s+|protected\s+)?(?:abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/g)) {
    classes.push({ name: m[1], kind: "class", fields: [], file: fileRel, doc: "" });
  }
  for (const m of text.matchAll(/(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\],\s]+\s+(\w+)\s*\(/g)) {
    functions.push({ name: m[1], file: fileRel, doc: "" });
  }
  for (const m of text.matchAll(/@(?:Get|Post|Put|Delete|Patch|Request)Mapping\(\s*["']([^"']+)["']/g)) {
    endpoints.push({ method: "HTTP", path: m[1], handler: "spring-mapping", file: fileRel });
  }
  return { classes: classes.slice(0, 80), functions: functions.slice(0, 80), endpoints: endpoints.slice(0, 50) };
}

function parsePhpFile(text, fileRel) {
  const classes = [], functions = [], endpoints = [];
  for (const m of text.matchAll(/^\s*class\s+(\w+)/gm)) {
    classes.push({ name: m[1], kind: "class", fields: [], file: fileRel, doc: "" });
  }
  for (const m of text.matchAll(/^\s*function\s+(\w+)\s*\(/gm)) {
    functions.push({ name: m[1], file: fileRel, doc: "" });
  }
  return { classes: classes.slice(0, 80), functions: functions.slice(0, 80), endpoints: endpoints.slice(0, 50) };
}

function parseTextFile(fileRel) {
  return { classes: [], functions: [], endpoints: [], title: fileRel.split("/").pop() };
}

function harvestProjectLocal(rootArg, projectId, exts) {
  const root = path.resolve(rootArg);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("目录不存在: " + root);
  }
  const modules = [], dataModels = [], endpoints = [];
  let fileCount = 0;
  const extSet = exts && exts.length ? new Set(exts.map((e) => (e.startsWith(".") ? e : "." + e))) : null;

  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).split(path.sep);
      if (ent.isDirectory()) {
        if (HARVEST_SKIP_DIRS.has(ent.name) || rel.some((p) => HARVEST_SKIP_DIRS.has(p))) continue;
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        if (HARVEST_SKIP_FILES.has(ent.name)) continue;
        if (extSet && !extSet.has(path.extname(ent.name))) continue;
        if (fileCount >= 2000) return;
        fileCount++;
        const fileRel = rel.join("/");
        let info = null;
        try {
          const raw = fs.readFileSync(full);
          if (raw.includes(0)) continue; // 二进制跳过
          const text = raw.toString("utf8").slice(0, 200000);
          const ext = path.extname(ent.name).toLowerCase();
          if (ext === ".py") info = parsePythonFile(text, fileRel);
          else if (ext === ".js" || ext === ".ts" || ext === ".jsx" || ext === ".tsx") info = parseGenericFile(text, fileRel);
          else if (ext === ".java" || ext === ".kt") info = parseJavaFile(text, fileRel);
          else if (ext === ".php") info = parsePhpFile(text, fileRel);
          else info = parseTextFile(fileRel);
        } catch (e) {
          continue;
        }
        if (!info) continue;
        modules.push({
          path: fileRel,
          module: path.basename(ent.name, path.extname(ent.name)),
          classes: info.classes.map((c) => c.name),
          functions: info.functions.map((f) => f.name),
        });
        for (const c of info.classes) {
          if (c.kind === "data_model") {
            dataModels.push({ name: c.name, fields: c.fields, file: c.file });
          }
        }
        for (const ep of info.endpoints) endpoints.push(ep);
      }
    }
  };
  walk(root, 0);

  // 端点去重
  const seen = new Set();
  const uniqEndpoints = endpoints.filter((ep) => {
    const key = ep.method + ep.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    project_id: projectId,
    root,
    harvested_at: new Date().toISOString(),
    files_scanned: fileCount,
    modules,
    data_models: dataModels,
    endpoints: uniqEndpoints.slice(0, 300),
    stats: {
      files: fileCount,
      modules: modules.length,
      data_models: dataModels.length,
      endpoints: uniqEndpoints.length,
    },
  };
}

// ── 工具定义（33 个，与 Python 版一致）──────────────────────
const TOOLS = [
  { name: "cerebrate_sense", description: "【会话开始必须调用】感知虫群脑状态，返回健康状态、记忆总数、代理数、warnings。", inputSchema: { type: "object", properties: {} } },
  { name: "cerebrate_help", description: "获取 Cerebrate v5 API 发现文档。", inputSchema: { type: "object", properties: {} } },
  { name: "cerebrate_doctrines", description: "读取权威教条（doctrine 生命阶段的记忆）。", inputSchema: { type: "object", properties: {} } },
  { name: "cerebrate_assess", description: "脑虫元认知评估，返回偏见检测、类别健康度、代理贡献。", inputSchema: { type: "object", properties: {} } },
  { name: "cerebrate_query", description: "【决策查询】返回完整内容 + 推荐动作（reuse/verify/new_experience）。", inputSchema: { type: "object", properties: { query: { type: "string" }, user: { type: "string", default: "yangying" }, agent_id: { type: "string", default: "codex" }, project_id: { type: "string", default: "" }, scope: { type: "string", enum: ["", "general", "project", "all"], default: "" } }, required: ["query"] } },
  { name: "cerebrate_search", description: "【遇到问题第一步调用】渐进式披露第1层：紧凑索引。mode: hybrid/fts/vector。", inputSchema: { type: "object", properties: { query: { type: "string" }, agent_id: { type: "string", default: "codex" }, project_id: { type: "string", default: "" }, scope: { type: "string", enum: ["", "general", "project", "all"], default: "" }, category: { type: "string", default: "" }, mode: { type: "string", enum: ["hybrid", "fts", "vector"], default: "hybrid" }, limit: { type: "number", default: 20 } }, required: ["query"] } },
  { name: "cerebrate_timeline", description: "【前因后果】围绕 anchor 记忆的时序上下文。", inputSchema: { type: "object", properties: { anchor: { type: "string", default: "" }, query: { type: "string", default: "" }, project_id: { type: "string", default: "" }, scope: { type: "string", enum: ["", "general", "project", "all"], default: "" }, depth_before: { type: "number", default: 3 }, depth_after: { type: "number", default: 3 } } } },
  { name: "cerebrate_detail", description: "【按需取详情】按 ids 批量取完整详情。", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
  { name: "cerebrate_propose", description: "【解决问题后调用】提交新记忆到虫群。life_stage: memory(默认)/nutrient。auto_entities 默认把本地实体并入 tags。", inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, category: { type: "string", enum: ["coding", "debugging", "architecture", "devops", "performance", "security", "testing", "config", "skill"] }, tags: { type: "string" }, agent_id: { type: "string", default: "codex" }, problem: { type: "string", default: "" }, solution: { type: "string", default: "" }, life_stage: { type: "string", enum: ["memory", "nutrient"], default: "memory" }, confidence: { type: "number", default: 1.0 }, validate: { type: "boolean", default: true }, project_id: { type: "string", default: "" }, scope: { type: "string", enum: ["", "general", "project"], default: "" }, supersedes: { type: "string", default: "" }, observation_type: { type: "string", default: "" }, facts: { type: "string", default: "" }, concepts: { type: "string", default: "" }, auto_entities: { type: "boolean", default: true } }, required: ["title", "content", "tags", "problem", "solution"] } },
  { name: "cerebrate_propose_skill", description: "【deprecated】将可复用解决模式存为技能。", inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, tags: { type: "string" }, agent_id: { type: "string", default: "codex" }, problem: { type: "string", default: "" }, solution: { type: "string", default: "" }, validate: { type: "boolean", default: true } }, required: ["title", "content", "tags", "problem", "solution"] } },
  { name: "cerebrate_propose_lesson", description: "【deprecated】将错误教训存为记忆。", inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, tags: { type: "string" }, agent_id: { type: "string", default: "codex" }, problem: { type: "string", default: "" }, solution: { type: "string", default: "" }, validate: { type: "boolean", default: true } }, required: ["title", "content", "tags", "problem", "solution"] } },
  { name: "cerebrate_use_start", description: "【复用记忆时调用】开始跟踪记忆复用。", inputSchema: { type: "object", properties: { memory_id: { type: "string" }, agent: { type: "string", default: "codex" }, problem: { type: "string" }, project_id: { type: "string", default: "" } }, required: ["memory_id", "agent", "problem"] } },
  { name: "cerebrate_use_finish", description: "【复用完成】报告复用结果。", inputSchema: { type: "object", properties: { usage_id: { type: "string" }, outcome: { type: "string", enum: ["success", "partial", "failure"] }, feedback: { type: "string", default: "" } }, required: ["usage_id", "outcome"] } },
  { name: "cerebrate_register", description: "【首次使用】注册当前 AI 代理。", inputSchema: { type: "object", properties: { agent_id: { type: "string", default: "codex" }, agent_type: { type: "string", default: "mcp" }, capabilities: { type: "string", default: "code_generation,debugging,refactoring,testing" }, physical_user: { type: "string" } } } },
  { name: "cerebrate_vote", description: "对虫群记忆进行共识投票。", inputSchema: { type: "object", properties: { memory_id: { type: "string" }, agent: { type: "string", default: "codex" }, vote: { type: "string", enum: ["support", "oppose", "abstain"] }, evidence: { type: "string", default: "" }, confidence: { type: "number", default: 1.0 } }, required: ["memory_id", "agent", "vote"] } },
  { name: "cerebrate_stats", description: "查看虫群系统统计信息。", inputSchema: { type: "object", properties: {} } },
  { name: "cerebrate_recall", description: "读取个人偏好和上下文缓存。", inputSchema: { type: "object", properties: {} } },
  { name: "cerebrate_remember", description: "写入个人偏好。", inputSchema: { type: "object", properties: { user: { type: "string", default: "yangying" }, key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } },
  { name: "cerebrate_knowledge_search", description: "【deprecated → cerebrate_search】搜索权威知识库。", inputSchema: { type: "object", properties: { query: { type: "string" }, topic: { type: "string", default: "" }, project_id: { type: "string", default: "" }, scope: { type: "string", enum: ["", "general", "project", "all"], default: "" } }, required: ["query"] } },
  { name: "cerebrate_project_context", description: "【项目上下文】生成/读取浓缩上下文。", inputSchema: { type: "object", properties: { project: { type: "string" }, action: { type: "string", enum: ["build", "read", "list"], default: "build" }, limit: { type: "integer", default: 50 } }, required: ["project"] } },
  { name: "cerebrate_project_profile", description: "【业务画像】数据世界+流程世界。action: read(默认)/list/draft/save/attach。", inputSchema: { type: "object", properties: { project: { type: "string" }, action: { type: "string", enum: ["read", "list", "draft", "save", "attach"], default: "read" }, level: { type: "string", enum: ["summary", "graph", "detail"], default: "detail" }, llm_refine: { type: "boolean", default: false }, profile: { type: "object" }, node_path: { type: "string", default: "" }, memory_id: { type: "string", default: "" } }, required: ["project"] } },
  { name: "cerebrate_project_navigate", description: "【画像导航】定位目标域/实体。", inputSchema: { type: "object", properties: { project: { type: "string" }, target: { type: "string" } }, required: ["project", "target"] } },
  { name: "cerebrate_project_harvest", description: "【本地代码分析·结构推送】传 dir 本地分析 push 结构；不传读服务端结构。", inputSchema: { type: "object", properties: { project: { type: "string" }, dir: { type: "string" }, exts: { type: "array", items: { type: "string" } } }, required: ["project"] } },
  { name: "cerebrate_project_work", description: "【多人协作】工作声明 claim/release/list。", inputSchema: { type: "object", properties: { project: { type: "string" }, action: { type: "string", enum: ["claim", "release", "list"], default: "list" }, branch: { type: "string", default: "" }, module: { type: "string", default: "" }, intent: { type: "string", default: "" }, agent_id: { type: "string", default: "" } }, required: ["project"] } },
  { name: "cerebrate_batch_process", description: "【会话结束】批量处理 IPC 队列待办请求。", inputSchema: { type: "object", properties: { limit: { type: "integer", default: 50 } } } },
  { name: "cerebrate_ingest", description: "【知识蒸馏吸入】将本地文档目录批量吸入知识库。", inputSchema: { type: "object", properties: { dir: { type: "string" }, project: { type: "string", default: "" }, dry_run: { type: "boolean", default: false }, verbose: { type: "boolean", default: false } }, required: ["dir"] } },
  { name: "cerebrate_knowledge_store", description: "【存入知识】直接存入权威知识库。", inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, topics: { type: "string", default: "" }, project: { type: "string", default: "" } }, required: ["title", "content"] } },
  { name: "cerebrate_entity_extract", description: "【本地实体化衍生】在本地抽取文本实体（零 LLM 零成本），数据不离开本地。", inputSchema: { type: "object", properties: { text: { type: "string" }, persist: { type: "boolean", default: true }, top: { type: "number", default: 30 } }, required: ["text"] } },
  { name: "cerebrate_auth_status", description: "【认证引导】查看登录态（token 来源 env/env文件/登录/无）+ 可选 verify 联网校验。", inputSchema: { type: "object", properties: { verify: { type: "boolean", default: false } } } },
  { name: "cerebrate_auth_register", description: "【认证引导·注册】新用户自助注册 → bind_url 网页二维码扫码绑定。", inputSchema: { type: "object", properties: { username: { type: "string" } }, required: ["username"] } },
  { name: "cerebrate_auth_login", description: "【认证引导·登录】用户名 + Authenticator 6 位码 → token 保存本地。", inputSchema: { type: "object", properties: { username: { type: "string" }, code: { type: "string" } }, required: ["username", "code"] } },
  { name: "cerebrate_auth_rebind", description: "【认证引导·管理员】已注册用户重新生成绑定链接（仅 master token）。", inputSchema: { type: "object", properties: { username: { type: "string" } }, required: ["username"] } },
  { name: "cerebrate_auth_logout", description: "【认证引导·登出】删除本地持久化 token。", inputSchema: { type: "object", properties: {} } },
];

// ── 工具调用实现 ────────────────────────────────────────────
function splitTags(tags) {
  if (!tags) return [];
  return String(tags).split(",").map((t) => t.trim()).filter(Boolean);
}

async function handleCall(name, args) {
  args = args || {};
  try {
    switch (name) {
      case "cerebrate_sense": return await httpRequest("GET", "/v1/sense", null, effectiveToken());
      case "cerebrate_help": return await httpRequest("GET", "/v1/help", null, effectiveToken());
      case "cerebrate_doctrines": return await httpRequest("GET", "/v1/doctrines", null, effectiveToken());
      case "cerebrate_assess": return await httpRequest("GET", "/v1/brain/assess", null, effectiveToken());
      case "cerebrate_query": return await httpRequest("POST", "/v1/query", {
        query: args.query, user: args.user || "yangying", agent_id: args.agent_id || "codex",
        project_id: args.project_id || "", scope: args.scope || "", detail: true,
      }, effectiveToken());
      case "cerebrate_search": return await httpRequest("POST", "/v1/search", {
        query: args.query, agent_id: args.agent_id || "codex", project_id: args.project_id || "",
        scope: args.scope || "", category: args.category || "", mode: args.mode || "hybrid",
        limit: args.limit || 20,
      }, effectiveToken());
      case "cerebrate_timeline": return await httpRequest("POST", "/v1/timeline", {
        anchor: args.anchor || "", query: args.query || "", project_id: args.project_id || "",
        scope: args.scope || "", depth_before: args.depth_before || 3, depth_after: args.depth_after || 3,
      }, effectiveToken());
      case "cerebrate_detail": return await httpRequest("POST", "/v1/memories/detail", { ids: args.ids || [] }, effectiveToken());
      case "cerebrate_propose": {
        let tags = splitTags(args.tags);
        if (args.auto_entities !== false) {
          const ents = extractEntities((args.title || "") + "\n" + (args.content || ""));
          for (const e of ents.slice(0, 30)) {
            if (e.name && e.name.length <= 30 && !tags.some((t) => t.toLowerCase() === e.name.toLowerCase())) {
              tags.push(e.name);
            }
          }
        }
        return await httpRequest("POST", "/v1/memories/propose", {
          title: args.title, content: args.content, category: args.category || "general",
          tags: tags.slice(0, 20).join(","), agent_id: args.agent_id || "codex",
          problem: args.problem || "", solution: args.solution || "", life_stage: args.life_stage || "memory",
          confidence: args.confidence != null ? args.confidence : 1.0, validate: args.validate !== false,
          project_id: args.project_id || "", scope: args.scope || "", supersedes: args.supersedes || "",
          observation_type: args.observation_type || "", facts: args.facts || "", concepts: args.concepts || "",
          physical_user: args.physical_user || PHYSICAL_USER,
        }, effectiveToken());
      }
      case "cerebrate_propose_skill": return await httpRequest("POST", "/v1/memories/propose", {
        title: args.title, content: args.content, category: "skill", tags: args.tags,
        agent_id: args.agent_id || "codex", problem: args.problem || "", solution: args.solution || "",
        life_stage: "memory", confidence: 1.0, validate: args.validate !== false,
        physical_user: PHYSICAL_USER,
      }, effectiveToken());
      case "cerebrate_propose_lesson": return await httpRequest("POST", "/v1/memories/propose", {
        title: args.title, content: args.content, category: "skill", tags: "skill_lesson," + args.tags,
        agent_id: args.agent_id || "codex", problem: args.problem || "", solution: args.solution || "",
        life_stage: "memory", confidence: 1.0, validate: args.validate !== false,
        physical_user: PHYSICAL_USER,
      }, effectiveToken());
      case "cerebrate_use_start": return await httpRequest("POST", "/v1/usages/start", {
        memory_id: args.memory_id, agent: args.agent || "codex", problem: args.problem || "",
        project_id: args.project_id || "",
      }, effectiveToken());
      case "cerebrate_use_finish": return await httpRequest("POST", "/v1/usages/finish", {
        usage_id: args.usage_id, outcome: args.outcome, feedback: args.feedback || "",
      }, effectiveToken());
      case "cerebrate_register": return await httpRequest("POST", "/v1/agents/register", {
        agent_id: args.agent_id || "codex", agent_type: args.agent_type || "mcp",
        capabilities: (args.capabilities || "code_generation,debugging,refactoring,testing").split(","),
        physical_user: args.physical_user || PHYSICAL_USER,
      }, effectiveToken());
      case "cerebrate_vote": return await httpRequest("POST", "/v1/consensus/vote", {
        memory_id: args.memory_id, agent: args.agent || "codex", vote: args.vote,
        evidence: args.evidence || "", confidence: args.confidence != null ? args.confidence : 1.0,
      }, effectiveToken());
      case "cerebrate_stats": {
        const s = await httpRequest("GET", "/v1/sense", null, effectiveToken());
        if (s.status !== "ok") return s;
        const d = s.data || {};
        return { status: "ok", data: {
          total_memories: d.total_memories || 0, total_agents: d.total_agents || 0,
          agent_ids: d.agent_ids || [], warnings: d.warnings || [], llm: d.llm || {},
          consensus: d.consensus || {}, health: d.health || "unknown",
        } };
      }
      case "cerebrate_recall": return await httpRequest("GET", "/v1/personal", null, effectiveToken());
      case "cerebrate_remember": return await httpRequest("POST", "/v1/personal", {
        user: args.user || "yangying", key: args.key, value: args.value,
      }, effectiveToken());
      case "cerebrate_knowledge_search": {
        const q = new URLSearchParams({ q: args.query || "" });
        if (args.topic) q.set("topic", args.topic);
        if (args.project_id) q.set("project_id", args.project_id);
        if (args.scope) q.set("scope", args.scope);
        return await httpRequest("GET", "/v1/knowledge?" + q.toString(), null, effectiveToken());
      }
      case "cerebrate_project_context": return await httpRequest("POST", "/v1/project/context", {
        project: args.project || "", action: args.action || "build", limit: args.limit || 50,
      }, effectiveToken());
      case "cerebrate_project_profile": return await httpRequest("POST", "/v1/project/profile", {
        project: args.project || "", action: args.action || "read", level: args.level || "detail",
        llm_refine: !!args.llm_refine, profile: args.profile || null, node_path: args.node_path || "",
        memory_id: args.memory_id || "",
      }, effectiveToken());
      case "cerebrate_project_navigate": return await httpRequest("POST", "/v1/project/navigate", {
        project: args.project || "", target: args.target || "",
      }, effectiveToken());
      case "cerebrate_project_harvest": {
        if (!args.dir) return await httpRequest("POST", "/v1/project/harvest", {
          project: args.project || "", dir: "",
        }, effectiveToken());
        try {
          const harvest = harvestProjectLocal(
            args.dir, args.project || "",
            Array.isArray(args.exts) ? args.exts : null);
          return await httpRequest("POST", "/v1/harvest/push", {
            project: args.project || "",
            branch: harvestGitBranch(path.resolve(args.dir)),
            harvest,
            auto_profile: true,
          }, effectiveToken());
        } catch (e) {
          return { status: "error", error: { code: 400, message: "harvest 失败: " + (e.message || e) } };
        }
      }
      case "cerebrate_project_work": return await httpRequest("POST", "/v1/project/work", {
        project: args.project || "", action: args.action || "list", branch: args.branch || "",
        module: args.module || "", intent: args.intent || "", agent_id: args.agent_id || "",
      }, effectiveToken());
      case "cerebrate_batch_process": return await httpRequest("POST", "/v1/batch/process", {
        limit: args.limit || 50,
      }, effectiveToken());
      case "cerebrate_ingest": return await httpRequest("POST", "/v1/ingest", {
        dir: args.dir, project: args.project || "", dry_run: !!args.dry_run, verbose: !!args.verbose,
      }, effectiveToken());
      case "cerebrate_knowledge_store": return await httpRequest("POST", "/v1/knowledge", {
        title: args.title, content: args.content,
        topics: splitTags(args.topics), source: "mcp-knowledge-store",
        is_policy: false, author: "mcp-client", project_id: args.project || "",
      }, effectiveToken());
      case "cerebrate_entity_extract": {
        const ents = extractEntities(args.text || "");
        return { status: "ok", data: {
          entities: ents.slice(0, args.top || 30), source: "local",
          persisted: false, store_size: 0, store_path: "",
        } };
      }
      case "cerebrate_auth_status": {
        const envT = envToken();
        const local = readTokenFile();
        let source = "none", has = false, uid = "";
        if (envT) { source = "env"; has = true; }
        else if (local.token) { source = "login"; has = true; uid = local.user_id || ""; }
        let verified = null, role = null;
        if (args.verify && has) {
          const me = await httpRequest("GET", "/v1/auth/me", null, effectiveToken());
          if (me.status === "ok") { verified = me.data.user_id || ""; role = me.data.role || ""; }
        }
        return { status: "ok", data: {
          has_token: has, source, user_id: uid, verified_user: verified, verified_role: role,
          token_file: TOKEN_FILE,
        } };
      }
      case "cerebrate_auth_register": {
        const r = await httpRequest("POST", "/v1/auth/register", { username: (args.username || "").trim() });
        if (r.status === "ok" && r.data && r.data.registered) {
          if (r.data.bind_token) {
            r.data.bind_url = SERVER_URL + "/v1/auth/bind?token=" + r.data.bind_token;
            r.data.hint = "把 bind_url 发给用户：浏览器打开网页 → Authenticator 扫码 → 报 6 位码 → cerebrate_auth_login";
          }
        }
        return r;
      }
      case "cerebrate_auth_login": {
        const r = await httpRequest("POST", "/v1/auth/login", {
          username: (args.username || "").trim(), code: (args.code || "").trim(),
        });
        if (r.status === "ok" && r.data && r.data.token) {
          saveToken(r.data.token, r.data.user_id || args.username);
          r.data.token_saved = true;
          r.data.token_file = TOKEN_FILE;
          r.data.hint = "登录成功，token 已本地持久化（唯一凭证）；之后直接使用，无需每次授权";
        }
        return r;
      }
      case "cerebrate_auth_rebind": {
        const r = await httpRequest("POST", "/v1/auth/rebind", { username: (args.username || "").trim() });
        if (r.status === "ok" && r.data && r.data.bind_token) {
          r.data.bind_url = SERVER_URL + "/v1/auth/bind?token=" + r.data.bind_token;
          r.data.hint = "把 bind_url 发给用户：浏览器打开 → Authenticator 扫码 → 报 6 位码 → cerebrate_auth_login";
        }
        return r;
      }
      case "cerebrate_auth_logout": clearToken();
        return { status: "ok", data: { logged_out: true, message: "本地 token 已删除" } };
      default: return { status: "error", error: { code: -1, message: "未知工具: " + name } };
    }
  } catch (e) {
    return { status: "error", error: { code: 500, message: String(e && e.message || e) } };
  }
}

// ── MCP stdio 协议 ──────────────────────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function runMcp() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    line = line.trim();
    if (!line) return;
    let req;
    try { req = JSON.parse(line); } catch (e) { return; }
    const id = req.id;
    const method = req.method || "";
    const params = req.params || {};
    if (id == null) return; // 通知不响应
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cerebrate-mcp-v5-node", version: "5.1.0" },
      } });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const result = await handleCall(params.name || "", params.arguments || {});
      const isError = result.status === "error";
      send({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError,
      } });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "未知方法: " + method } });
    }
  });
}

// ── CLI（setup / login / logout / status）──────────────────

function writeEnvConfig(url, token) {
  const dir = path.dirname(MCP_ENV_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    "# Cerebrate MCP 本地配置（setup 生成，chmod 600）",
    "# 格式: KEY=VALUE；环境变量优先于此文件",
    "CEREBRATE_SERVER_URL=" + url,
  ];
  if (token) lines.push("CEREBRATE_SERVER_TOKEN=" + token);
  fs.writeFileSync(MCP_ENV_FILE, lines.join("\n") + "\n", "utf8");
  try { fs.chmodSync(MCP_ENV_FILE, 0o600); } catch (e) {}
  console.log("\n✓ 已保存配置: " + MCP_ENV_FILE);
  console.log("  服务地址: " + url);
  console.log("  token: " + (token ? "已配置" : "未配置（只读接口可用）") + "\n");
  console.log("── 复制下面对应客户端的配置到你的工具 ──");
  console.log("\n【Claude Code】（HTTP 标准接入，推荐）");
  console.log(`claude mcp add --transport http cerebrate ${url}/v1/mcp \\`);
  console.log(`  --header "Authorization: Bearer ${token || "<你的token>"}"`);
  console.log("\n【Codex】（config.toml）");
  console.log(`[mcp_servers.cerebrate]`);
  console.log(`url = "${url}/v1/mcp"`);
  if (token) console.log(`# token 走环境变量 CEREBRATE_SERVER_TOKEN=${token}`);
  console.log("\n【stdio 客户端（Qoder/opencode/Trae）】");
  console.log("命令: npx -y cerebrate-mcp");
  if (token) console.log("环境变量: CEREBRATE_SERVER_URL=" + url);
  console.log("           CEREBRATE_SERVER_TOKEN=" + (token || "<你的token>"));
  console.log("\n完成后重启 AI 客户端，对话先调用 cerebrate_sense 即可。");
}

function cli(argv) {
  const cmd = argv[2];
  if (cmd === "--version" || cmd === "-v") {
    // 硬编码版本（与 initialize serverInfo 一致；mcp.js 可被公网单独下载，
    // 同目录不一定有 package.json，不能 require 它）
    console.log("5.1.0");
    return;
  }
  if (cmd === "--help" || cmd === "-h") {
    console.log("Cerebrate MCP v5 (Node) — 用法:");
    console.log("  cerebrate-mcp                 # 作为 MCP server（stdio）运行");
    console.log("  cerebrate-mcp setup           # 首次配置（URL + token，自动打印各客户端配置）");
    console.log("  cerebrate-mcp login           # 用户名 + Authenticator 码登录");
    console.log("  cerebrate-mcp logout|status   # 登出 / 查看状态");
    console.log("  cerebrate-mcp --version       # 版本");
    return;
  }
  if (cmd === "setup") {
    let urlArg = "", tokenArg = "";
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === "--url") urlArg = argv[++i] || "";
      if (argv[i] === "--token") tokenArg = argv[++i] || "";
    }
    if (urlArg) {
      // 非交互：setup --url <url> [--token <token>]（脚本/CI 友好）
      writeEnvConfig(urlArg.replace(/\/+$/, ""), tokenArg);
      return;
    }
    // 交互引导：URL + token → 写 ~/.cerebrate-mcp/cerebrate.env → 打印配置片段
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const ask = (q, def) =>
      new Promise((res) => rl.question(q + (def ? ` [${def}]` : "") + ": ", res));
    (async () => {
      const urlRaw = (await ask("脑虫服务地址 (URL)")).trim();
      const url = (urlRaw || ENV_FILE.CEREBRATE_SERVER_URL || "").replace(/\/+$/, "");
      const token = (await ask("你的 user token（唯一凭证；留空=只读）")).trim();
      if (!url) {
        console.log("✗ 未提供服务地址，退出");
        process.exit(1);
      }
      writeEnvConfig(url, token);
      rl.close();
    })();
  } else if (cmd === "login") {
    let username = "", code = "";
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === "--username") username = argv[++i] || "";
      if (argv[i] === "--code") code = argv[++i] || "";
    }
    (async () => {
      const r = await handleCall("cerebrate_auth_login", { username, code });
      if (r.status !== "ok") { console.log("登录失败:", (r.error && r.error.message) || r); process.exit(1); }
      console.log("登录成功:", r.data.user_id);
      console.log("token 已保存:", TOKEN_FILE, "（唯一凭证，长期有效）");
    })();
  } else if (cmd === "logout") {
    clearToken();
    console.log("已退出登录（本地 token 已删除）");
  } else if (cmd === "status") {
    const local = readTokenFile();
    if (envToken()) console.log("token 来源: 环境变量 CEREBRATE_SERVER_TOKEN（优先）");
    else if (local.token) console.log("token 来源: 登录持久化（已登录: " + (local.user_id || "?") + "）");
    else console.log("token 来源: 未配置（只读接口可用；写记忆需先登录）");
    console.log("服务地址:", SERVER_URL);
    console.log("token 文件:", TOKEN_FILE);
  } else {
    console.log("Cerebrate MCP v5 (Node) — 用法:");
    console.log("  node mcp.js                 # 作为 MCP server（stdio）运行");
    console.log("  node mcp.js setup           # 首次配置（URL + token，自动打印各客户端配置）");
    console.log("  node mcp.js login           # 用户名 + Authenticator 码登录");
    console.log("  node mcp.js logout|status   # 登出 / 查看状态");
    console.log("  node mcp.js --version       # 版本");
  }
}

if (require.main === module) {
  if (process.argv.length > 2 && ["setup", "login", "logout", "status", "--version", "-v", "--help", "-h"].includes(process.argv[2])) {
    cli(process.argv);
  } else {
    runMcp();
  }
}
