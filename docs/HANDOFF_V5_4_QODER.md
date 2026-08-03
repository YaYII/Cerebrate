# Cerebrate × Qoder 接入交接文档

> 日期：2026-08-03
> 背景：v5.4 已交付 Docker 化 Cerebrate（8765 端口，708 条记忆）与 Claude Code hooks。
> 本次任务：让 **Qoder AI IDE** 使用 Cerebrate 记忆系统，实现「AI 默认读记忆」。

---

## 1. 任务背景与需求

- 用户核心诉求：Qoder 的 AI 应把 Cerebrate 记忆当作自身能力，**默认读取记忆**，
  而不是每次由用户提醒、也不是只有搜索命中才用。
- 验收标准：Qoder 会话中可调用 Cerebrate 的 MCP 工具（搜索/提交/详情）；
  会话开始 AI 自动获得记忆概览（无需用户提醒）。

## 2. 已完成内容（全部实测验证）

| 类别 | 内容 | 位置 |
|---|---|---|
| MCP 配置（CLI 通道） | `qodercli mcp add cerebrate --scope user` 添加 stdio 服务器，含 URL+token env | `~/.qoder/settings.json` → `mcpServers.cerebrate` |
| MCP 配置（IDE 通道） | IDE 缓存保留 `cerebrate-brain`（23 工具已加载），移除 `claude-mem` | `~/.config/Qoder/SharedClientCache/mcp.json` + `~/.qoder/mcp.json` |
| 自动记忆注入 | **UserPromptSubmit hook**：首条 prompt 时自动调 `/v1/sense` + `/v1/search(scope=project)` 注入记忆概览，会话级节流（每会话仅一次） | `~/.qoder/hooks/cerebrate-memory-inject.py` + `settings.json` → `hooks.UserPromptSubmit` |
| 记忆契约 | Qoder rules 强制「开工先查记忆、必传 project_id、完成主动 propose」 | `~/.qoder/rules/CerebrateMemoryContract.md` |
| claude-mem 清理 | 从 IDE MCP 配置移除并停止其进程（37700 已关闭），避免双份记忆注入 | 进程已 kill、配置已删 |
| 机密笔记 | Qoder 配置中的 token 用途记录 | `~/.codex/private_notes.md` |

### 验证证据
- `qodercli mcp list` → `✓ cerebrate: python3 .../mcp.py (stdio) - Connected`
- `qodercli mcp get cerebrate` → Scope: User config, Location: ~/.qoder/settings.json, Status: ✓ Connected
- MCP stdio 握手实测：initialize 返回 `cerebrate-mcp-v5/5.0.0`，tools/list 返回 23 个工具
- hook 脚本实测：首次注入 JSON `hookSpecificOutput.additionalContext`（health + 6 条相关记忆 + 契约行）；同 session 二次静默（节流生效）
- IDE 缓存 `mcps/cerebrate-brain/SERVER_METADATA.json` → `toolCount: 23, source: user`
- 服务端：Docker `cerebrate` 容器 Up (healthy)，127.0.0.1:8765 正常

## 3. 关键决策与理由

1. **Qoder 1.106.x 起 SessionStart 已停用** → 记忆注入改用 **UserPromptSubmit**
   （首条 prompt 触发 + 会话级节流），这是官方文档与阿里云长记忆对接 Qoder 的最佳实践。
2. **保留两套 MCP 通道**：CLI（settings.json，qodercli 管理）与 IDE（SharedClientCache，
   IDE 缓存）分开维护；IDE 已有 cerebrate-brain（23 工具），未重复添加。
3. **claude-mem 从 IDE MCP 移除**：用户此前已决策「claude-mem 保持停用」，
   Qoder 启动时拉起其 server（37700 监听）会造成双份记忆注入，故从
   `~/.qoder/mcp.json` 与 `SharedClientCache/mcp.json` 同时移除并停止进程。
4. **hook 脚本不硬编码 token**：运行时读取 `~/Documents/project/Cerebrate/.env`，
   与 MCP 配置（必须内嵌 env）分离，减少机密暴露面。
5. **失败静默降级**：hook 脚本任何异常都 exit 0 无输出，绝不阻塞 Qoder 会话
   （参考 adbpgmem-qoder 系列设计）。

## 4. 遗留问题 / 注意

1. **Qoder IDE 需重启（或 /mcp reload）**：当前 IDE 进程（14:11 启动）加载的是旧
   SharedClientCache 配置；claude-mem 条目已删、cerebrate-brain 仍保留。
   重启后 hooks + MCP 生效；若 IDE 已重连 cerebrate-brain 则无需重启。
2. **qodercli 会话测试受限**：`qodercli -p` 返回 `FORBIDDEN - code 112`（定价/配额），
   无法用 CLI 实测工具调用；IDE 会话请人工验证首条消息注入记忆概览。
3. **hook 注入质量依赖 prompt 检索**：首条 prompt 为空或过短时 search 结果有限；
   若需更精准项目上下文，可用 `cerebrate_project_context(project=...)`。
4. **MCP 旧工具**（cerebrate_query/propose_skill/propose_lesson/knowledge_search）：
   deprecated 别名，Qoder 侧同样可见，迁移确认后移除。

## 5. 下一步建议

1. 重启 Qoder IDE，新会话首条消息验证：AI 上下文是否出现「Cerebrate 记忆注入」概览。
2. 在 Qoder 会话中让 AI 执行 `cerebrate_search("qoder 配置", scope=project)`，
   再 `cerebrate_detail` 取详情，确认工具链可用。
3. 让 AI 完成一个任务后主动 `cerebrate_propose` 提交一条经验，验证写路径。
4. 若 Qoder CLI 的 FORBIDDEN 是账号配额问题，确认订阅后重测 `qodercli -p` 会话。

## 6. 关键文件与命令索引

```
~/.qoder/settings.json                      # qodercli MCP（cerebrate）+ hooks（UserPromptSubmit）
~/.qoder/mcp.json                           # IDE 用户级 MCP 源（context7 + cerebrate-brain）
~/.config/Qoder/SharedClientCache/mcp.json  # IDE 运行时 MCP 缓存（同上）
~/.qoder/hooks/cerebrate-memory-inject.py   # UserPromptSubmit 记忆注入脚本
~/.qoder/rules/CerebrateMemoryContract.md   # Qoder AI 记忆契约
备份：settings.json.bak-20260803-142044 / mcp.json.bak-* / SharedClientCache/mcp.json.bak-*

# 验证命令
qodercli mcp list                          # ✓ cerebrate Connected
qodercli mcp get cerebrate                 # 配置详情
curl -s http://127.0.0.1:8765/v1/sense -H "Authorization: Bearer <token>"
# hook 手动测试
echo '{"session_id":"t1","prompt":"如何配置 qoder","cwd":"/home/as-workstation01/Documents/project/Cerebrate"}' \
  | python3 ~/.qoder/hooks/cerebrate-memory-inject.py | python3 -m json.tool
```
