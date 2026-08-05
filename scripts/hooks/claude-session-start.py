#!/usr/bin/env python3
"""Cerebrate 会话开始注入 hook — SessionStart 事件。

注入三块（失败静默跳过，绝不阻塞会话）:
  1. 记忆状态 + 最近记忆（原有）
  2. 业务画像概览（当前项目：域/流程/校验状态）
  3. 三段式工作流契约（实事求是：代码仓=事实，记忆=参考，禁止背诵）
"""
import json
import os
import sys
import urllib.request

ENV_PATH = os.path.expanduser("~/Documents/project/Cerebrate/.env")
SERVER_URL = os.environ.get("CEREBRATE_SERVER_URL", "http://127.0.0.1:8765")


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


def api_get(path, token, timeout=6):
    req = urllib.request.Request(SERVER_URL + path,
                                 headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def api_post(path, payload, token, timeout=6):
    req = urllib.request.Request(
        SERVER_URL + path, data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + token,
                 "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


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
    cwd = data.get("cwd") or os.getcwd()
    token = load_token()
    if not token:
        sys.exit(0)
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
    # 1. 记忆状态
    try:
        sense = api_get("/v1/sense", token)
        if sense.get("status") == "ok":
            d = sense["data"]
            sc = d.get("memory_scope", {})
            lines.append("[Cerebrate] health=%s | 记忆=%s条 | 通用=%s 项目=%s"
                         % (d.get("health", "?"), d.get("total_memories", "?"),
                            sc.get("general", "?"), sc.get("project", "?")))
    except Exception:
        pass
    # 1.5 调度信号（感知脑虫状况 → 综合调度记忆查询时机：可先代码后记忆交叉印证）
    try:
        status = api_get("/v1/status", token)
        if status.get("status") == "ok":
            d = status["data"]
            emb = d.get("embedding", {})
            llm = d.get("llm", {})
            qc = d.get("query_cache", {})
            lines.append(
                "[调度信号] recommended=%s | embedding=%s | llm=%s | 查询缓存命中率=%s%%"
                % (d.get("recommended", "?"), emb.get("mode", "?"),
                   "可用" if llm.get("available") else "不可用",
                   round((qc.get("hit_rate") or 0) * 100)))
    except Exception:
        pass
    # 2. 当前项目画像概览（宏观俯瞰）
    project_id = os.path.basename(os.path.normpath(cwd))
    if project_id and project_id not in (".", "/", "~"):
        for pid in {project_id, project_id.lower()}:  # 目录名大小写兜底
            try:
                res = api_post("/v1/project/profile",
                               {"project": pid, "action": "read",
                                "level": "summary"}, token)
                if res.get("status") == "ok" and res.get("data", {}).get("found"):
                    d = res["data"]
                    s = d.get("summary", {})
                    lines.append("[业务画像:%s] 域=%s 流程=%s | %s"
                                 % (pid, s.get("domain_count", 0),
                                    s.get("flow_count", 0),
                                    "、".join(x.get("name", "") for x in
                                              s.get("domains", [])[:8])))
                    break
            except Exception:
                continue
        # 协作感知：当前项目活跃工作（谁在处理什么）
        for pid in {project_id, project_id.lower()}:
            try:
                res = api_post("/v1/project/work",
                               {"project": pid, "action": "list"}, token)
                if res.get("status") == "ok":
                    data = res["data"]
                    if data.get("active_count", 0) > 0:
                        parts = []
                        for c in data.get("claims", [])[:6]:
                            parts.append("%s@%s:%s" % (
                                c.get("agent_id", "?"),
                                c.get("branch", "?"),
                                c.get("module", "?") or c.get("intent", "?")))
                        lines.append("[协作:%s] %d 个活跃工作 | %s"
                                     % (pid, data["active_count"],
                                        "; ".join(parts)))
                    break
            except Exception:
                continue
    # 3. 工作流契约
    lines.append("[工作流·实事求是] 任务开工：① harvest-push --project <id> 本地分析并只推结构"
                 "(代码不离开本地；确需服务端访问代码再用 code-sync)；② project-profile level=summary 宏观俯瞰、"
                 "project-navigate 微观定位到真实代码文件；③ 基于当前代码仓具体分析，"
                 "记忆仅为参考(参考答案)，禁止背诵/照搬旧结论。")
    if not lines:
        sys.exit(0)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
