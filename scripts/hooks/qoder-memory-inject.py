#!/usr/bin/env python3
"""Cerebrate 记忆注入 hook — UserPromptSubmit 事件。
首条 prompt 时自动检索 Cerebrate 记忆并注入 AI 上下文（会话级节流）。
失败时静默跳过，绝不阻塞会话。
"""
import json
import os
import sys
import urllib.request

CONFIG = os.path.expanduser("~/.qoder/.cerebrate-injected-sessions")
ENV_PATH = os.path.expanduser("~/Documents/project/Cerebrate/.env")


def load_token():
    tok = os.environ.get("CEREBRATE_SERVER_TOKEN", "")
    if tok:
        return tok.strip()
    try:
        with open(ENV_PATH) as f:
            for line in f:
                if line.startswith("CEREBRATE_SERVER_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return ""


def api_get(path, token, timeout=5):
    url = os.environ.get("CEREBRATE_SERVER_URL", "http://127.0.0.1:8765") + path
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_post(path, payload, token, timeout=5):
    url = os.environ.get("CEREBRATE_SERVER_URL", "http://127.0.0.1:8765") + path
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def soul_brief(content, max_items=8):
    """从灵魂全文提取核心铁律要点（控制注入体积）。"""
    items = []
    for ln in content.splitlines():
        s = ln.strip()
        if not s:
            continue
        if s.startswith("## ") or s.startswith("### "):
            items.append(s.lstrip("#").strip())
        elif ("铁律" in s and (":" in s or "：" in s)) or s.startswith("禁止"):
            items.append(s)
        if len(items) >= max_items:
            break
    return "；".join(items)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    session_id = data.get("session_id", "")
    prompt = (data.get("prompt") or "").strip()
    cwd = data.get("cwd") or os.getcwd()

    # 会话级节流：每个会话只注入一次
    if session_id:
        marker = os.path.join(CONFIG, session_id)
        if os.path.exists(marker):
            sys.exit(0)
        try:
            os.makedirs(CONFIG, exist_ok=True)
            with open(marker, "w") as f:
                f.write("1")
        except Exception:
            pass

    token = load_token()
    if not token:
        sys.exit(0)

    # 项目 ID 从 cwd 推断
    project_id = os.path.basename(os.path.normpath(cwd))
    if not project_id or project_id in (".", "/", "~"):
        project_id = ""

    lines = []
    # 0. 工程化思维灵魂（虫群成员统一行为准则：证据优先、不空谈、测试验证）
    try:
        soul = api_get("/v1/soul", token)
        if soul.get("status") == "ok":
            souls = soul.get("data", {}).get("souls", [])
            if souls:
                title = souls[0].get("title", "工程化思维灵魂")
                brief = soul_brief(souls[0].get("content", ""))
                lines.append("[灵魂] %s | %s" % (title, brief))
    except Exception:
        pass
    try:
        sense = api_get("/v1/sense", token)
        if sense.get("status") == "ok":
            d = sense.get("data", {})
            scope = d.get("memory_scope", {})
            lines.append(
                "[Cerebrate 记忆] health=%s | 记忆=%s条 | 通用=%s 项目=%s"
                % (
                    d.get("health", "?"),
                    d.get("total_memories", "?"),
                    scope.get("general", "?"),
                    scope.get("project", "?"),
                )
            )
    except Exception:
        pass
    try:
        status = api_get("/v1/status", token)
        if status.get("status") == "ok":
            d = status.get("data", {})
            emb = d.get("embedding", {})
            llm = d.get("llm", {})
            qc = d.get("query_cache", {})
            lines.append(
                "[调度信号] recommended=%s | embedding=%s | llm=%s | 查询缓存命中率=%s%%"
                % (d.get("recommended", "?"), emb.get("mode", "?"),
                   "可用" if llm.get("available") else "不可用",
                   round((qc.get("hit_rate") or 0) * 100))
            )
    except Exception:
        pass

    # 用用户 prompt 检索相关记忆（项目维度：命中项目记忆+通用记忆）
    if prompt:
        try:
            res = api_post(
                "/v1/search",
                {
                    "query": prompt,
                    "agent_id": "qoder",
                    "project_id": project_id,
                    "scope": "project",
                    "mode": "hybrid",
                    "limit": 6,
                },
                token,
            )
            if res.get("status") == "ok":
                for m in res.get("data", {}).get("index", []):
                    t = m.get("title", "").strip()
                    if not t:
                        continue
                    meta = " / ".join(
                        x for x in [
                            m.get("observation_type") or m.get("category"),
                            "scope=" + (m.get("scope") or "?"),
                            "%.2f" % (m.get("score") or 0),
                        ] if x
                    )
                    lines.append("- [%s] %s (~%s tok)" % (meta, t, m.get("token_estimate", "?")))
        except Exception:
            pass


    # 当前项目业务画像概览（宏观俯瞰，cwd 大小写兜底）
    for pid in {project_id, project_id.lower()} if project_id else set():
        try:
            prof = api_post("/v1/project/profile",
                            {"project": pid, "action": "read", "level": "summary"},
                            token, timeout=6)
            if prof.get("status") == "ok" and prof.get("data", {}).get("found"):
                pd = prof["data"]
                s = pd.get("summary", {})
                lines.append("[业务画像:%s] 域=%s 流程=%s | %s"
                             % (pid, s.get("domain_count", 0),
                                s.get("flow_count", 0),
                                "、".join(x.get("name", "") for x in
                                          s.get("domains", [])[:8])))
                break
        except Exception:
            continue


    # 协作感知：当前项目活跃工作（谁在处理什么）
    for pid in ({project_id, project_id.lower()} if project_id else set()):
        try:
            wk = api_post("/v1/project/work",
                          {"project": pid, "action": "list"}, token, timeout=6)
            if wk.get("status") == "ok":
                wd = wk["data"]
                if wd.get("active_count", 0) > 0:
                    parts = ["%s@%s:%s" % (c.get("agent_id", "?"),
                                           c.get("branch", "?"),
                                           c.get("module", "?") or c.get("intent", "?"))
                             for c in wd.get("claims", [])[:6]]
                    lines.append("[协作:%s] %d 个活跃工作 | %s"
                                 % (pid, wd["active_count"], "; ".join(parts)))
                break
        except Exception:
            continue

    lines.append("[工作流·实事求是] 任务开工：① harvest-push --project <id> 本地分析代码并只推结构(代码不离开本地；确需服务端访问代码再用 code-sync)；"
                 "② project-profile level=summary 宏观俯瞰、project-navigate 微观定位到真实代码文件；"
                 "③ 基于当前代码仓具体分析，记忆仅为参考(参考答案)，禁止背诵/照搬旧结论。")

    if len(lines) <= 1:
        sys.exit(0)

    context = "# Cerebrate 记忆注入（自动）\n\n" + "\n".join(lines) + (
        "\n\n[记忆契约] 若需更多细节，调用 cerebrate_detail；本任务完成后用 cerebrate_propose 提交经验（必传 project_id）。"
    )

    out = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        }
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
