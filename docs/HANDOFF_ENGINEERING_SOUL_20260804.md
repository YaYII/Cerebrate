# 虫群灵魂机制交接文档（2026-08-04）

## 1. 任务背景与需求

用户需求：每一个接入虫群的 AI 系统，都自动获得「工程化思维灵魂」，成为虫群的一员。
因为不是每个人都会写 AI 工程化思维的灵魂，虫群必须配合统一的行为准则才能发挥作用。
灵魂 = 工程化思维行为习惯：**以证据和收集证据、不说空话、只讲证据、
用单元测试 / curl 测试验证结果，而不是推测**。

## 2. 已完成内容

### 2.1 服务端灵魂源（权威 doctrine）
- `cerebrate/server/api.py`：新增 `soul_set(payload)` / `soul_get()`
  - 灵魂 = `life_stage=doctrine, scope=general`（跨项目，对每个接入 AI 生效）
  - 写路径：origin.add → share_to_swarm → events.append("soul.set")
  - 绕过客户端白名单（`CLIENT_LIFE_STAGES={"nutrient","memory"}`），服务端权威操作
- `cerebrate/server/http.py`：新增路由
  - `POST /v1/soul/set`（写灵魂，需 token）
  - `GET /v1/soul`（读灵魂，过滤 tag=soul 或 title 含「灵魂」的 doctrine）
- `cerebrate/client/cli.py`：新增 `soul set --title --content/--content-file --agent`、`soul get`

### 2.2 灵魂内容
- `docs/ENGINEERING_SOUL.md`：五条铁律（证据优先 / 开工前调研 / 最小修改 / 验证结果 / 总结交接）+ 行为习惯（不说空话、只讲证据、收集证据、快速收敛、先理解再判定）
- 已写入服务端：memory_id=`10fffc0ef12111a9`（`python3 cerebrate.py soul set --content-file docs/ENGINEERING_SOUL.md`）

### 2.3 客户端自动注入
- `~/.claude/hooks/cerebrate-session-start.py`：新增「0. 灵魂」块（会话开始拉 `/v1/soul`，`soul_brief()` 提取铁律要点注入）
- `~/.qoder/hooks/cerebrate-memory-inject.py`：同样新增「0. 灵魂」块
- 两个 hook 均在**会话开始自动注入**，失败静默不阻塞

### 2.4 测试
- `tests/test_soul.py` 4 项：doctrine 写入 / soul_get 过滤 / doctrines 包含 / 客户端 propose 不能写 doctrine
- 全量回归：211 passed / 0 failed

### 2.5 Codex 侧灵魂注入（v2.2 追加）
- `~/.codex/AGENTS.md`：升级为 v2.2
  - 修正过时声明（v2.1「Cerebrate 已暂停」→ v2.2「已恢复 + 灵魂机制」）
  - 新增「0. 工程化思维灵魂」章节：五铁律（证据优先/开工前调研/最小修改/验证结果/总结交接）+ 行为习惯（不说空话/只讲证据/收集证据/快速收敛/先理解再判定）+ 服务端灵魂引用（`GET /v1/soul`）
  - 清理重复的 4.1 段落
  - Codex 每次会话自动加载本文件 → 灵魂全自动生效（无 hook 机制也能全自动）

### 2.6 codegraph 代码图谱重建
- 工具：reasonix codegraph v0.9.7（`~/.cache/reasonix/codegraph/v0.9.7/bin/codegraph`）
- 重建命令：`codegraph index /home/as-workstation01/Documents/project/Cerebrate`
- 结果：73 files（python 67 / ts 3 / yaml 3）、1577 nodes、3911 edges、DB 4.23MB
- 对比旧数据：57 files / 1176 nodes / 2532 edges（6 月 9 日）→ 全部更新到 8 月 4 日当前代码
- 验证：`codegraph query "soul_set"` 命中 `cerebrate/server/api.py:1266`（新代码已入图谱）
- 后续增量更新：`codegraph sync <path>`（daemon 或手动）

### 2.7 项目级 AGENTS.md 补灵魂章节（v2.2 追加）
- `AGENTS.md`（Cerebrate 仓库根目录）：顶部新增「工程化思维灵魂」章节（五铁律 + 行为习惯 + 服务端引用）
- 说明：项目 AGENTS.md 原本是纯协议文档（Cerebrate Protocol v5，**不含** v2.1 过时声明——先前交接中的判断有误，已纠正）；补灵魂章节后，Codex 在 Cerebrate 项目会话时即使全局 AGENTS.md 未加载也能获得灵魂

## 3. 关键决策与理由

| 决策 | 理由 |
|---|---|
| 灵魂用 doctrine 承载（非新 life_stage） | 最小改动，doctrine 本就是「权威教条」，语义贴合灵魂；`/v1/doctrines` 读取已存在 |
| 服务端专属写入口（soul/set），客户端不能写 doctrine | 维护「客户端不能提交 doctrine」的权威规则，同时给用户一个简单操作入口 |
| scope=general（跨项目） | 灵魂是所有接入 AI 的统一准则，不属于任何单一项目 |
| hook 注入压缩版（soul_brief 提取铁律要点） | 控制每次会话注入体积（~250 token），全文存服务端可随时拉取 |

## 4. 遗留问题

- ~~`.codegraph/codegraph.db` 代码图谱库停留在 6 月 9 日~~ ✅ 已重建（2026-08-04，1577 nodes）
- ~~Codex 侧灵魂~~ ✅ 已同步进 `~/.codex/AGENTS.md`（v2.2）+ 项目 `AGENTS.md`（灵魂章节）
- 若未来要更新灵魂，重新 `soul set` 即可（写入新 doctrine；旧灵魂保留，`soul_get` 取第一条）

## 5. 下一步建议

- 让其他 AI（Claude Code / Qoder）实际开一个会话，确认注入的「[灵魂]」块生效
- 可选：把灵魂也同步进 Codex 的全局 AGENTS.md（~/.codex/AGENTS.md）或项目 AGENTS.md，使 Codex 侧自动生效
- 可选：`soul set` 支持覆盖语义（supersedes 旧灵魂），避免灵魂版本堆积

## 6. 关键文件与命令索引

```bash
# 写灵魂（服务端权威操作，需容器在线）
python3 cerebrate.py soul set --title "工程化思维灵魂（Engineering Soul）" \
  --content-file docs/ENGINEERING_SOUL.md --agent codex

# 读灵魂
python3 cerebrate.py soul get
curl -s http://127.0.0.1:8765/v1/soul -H "Authorization: Bearer $TOKEN"

# 读全部权威教条
python3 cerebrate.py doctrines

# codegraph 重建（reasonix codegraph v0.9.7）
~/.cache/reasonix/codegraph/v0.9.7/bin/codegraph status <项目路径>
~/.cache/reasonix/codegraph/v0.9.7/bin/codegraph index <项目路径>   # 全量重建
~/.cache/reasonix/codegraph/v0.9.7/bin/codegraph sync <项目路径>    # 增量更新

# 测试
CEREBRATE_DOCKER_SKIP_CHECK=1 python3 -m pytest tests/test_soul.py -q
CEREBRATE_DOCKER_SKIP_CHECK=1 python3 -m pytest tests/ -q --ignore=tests/prod_test.py

# hook 手动验证
echo '{"cwd":"/home/as-workstation01/Documents/project/Cerebrate"}' \
  | python3 ~/.claude/hooks/cerebrate-session-start.py
echo '{"session_id":"t1","prompt":"测试","cwd":"/home/as-workstation01/Documents/project/Cerebrate"}' \
  | python3 ~/.qoder/hooks/cerebrate-memory-inject.py
```

关键文件：
- `cerebrate/server/api.py`（soul_set/soul_get）
- `cerebrate/server/http.py`（/v1/soul、/v1/soul/set 路由）
- `cerebrate/client/cli.py`（soul 命令）
- `docs/ENGINEERING_SOUL.md`（灵魂模板，唯一内容源）
- `tests/test_soul.py`
- `~/.claude/hooks/cerebrate-session-start.py`、`~/.qoder/hooks/cerebrate-memory-inject.py`（客户端注入）
- `~/.codex/AGENTS.md`（Codex 侧灵魂，v2.2）
- `AGENTS.md`（项目根目录，灵魂章节 + Cerebrate Protocol v5）
- `.codegraph/codegraph.db`（代码图谱库，reasonix codegraph 生成）
