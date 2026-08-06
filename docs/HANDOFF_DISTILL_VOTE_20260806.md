# 交接文档：按需蒸馏 + 共识投票（distill-and-vote）

日期: 2026-08-06
作者: codex
状态: 已实现并真实数据验证

## 1. 任务背景与需求

用户要求「开启记忆蒸馏，针对记忆开启投票」——把相似的记忆蒸馏为一个
细节完整的新记忆/技能候选，走共识投票决定是否晋升为正式技能；
信息不足以形成完整技能时（LLM skip 判断）不产出。

## 2. 已完成内容

### 新端点 POST /v1/distill（cerebrate/server/api.py → distill_and_vote）
端到端流程（复用全部现有机制，零改动内核）：
1. 标题级查重（防大综合库误拦截，见下）
2. 搜索相似记忆（index_only=True 只查索引元数据，快）
3. LLM 蒸馏（llm.distill_knowledge，flash 模型，skip=信息不足不产出）
4. 构建论文级文档（EvolutionEngine._build_knowledge_document + 原始附录，信息零丢失）
5. 候选入营养池（life_stage=nutrient, category=distilled_skill, supersedes/origin_ids 血缘）
6. 自动发起支持投票（cerebrate-evolution 或指定 agent）
7. 返回共识快照；投票达 quorum → 自动晋升 verified_skill

### 路由（cerebrate/server/http.py）
POST /v1/distill → api.distill_and_vote

### CLI（cerebrate/client/cli.py）
`python3 cerebrate.py distill --topic "xx" [--limit N] [--no-vote] [--force] [--scope all|general|project] [--project X] [--agent-id Y]`

### 环境变更（不进 git）
- .env: CEREBRATE_LLM_MODEL=deepseek-v4-pro → deepseek-v4-flash（用户要求，省 3 倍成本）
- 容器已 docker cp 同步 3 个代码文件并重启

## 3. 关键决策与理由

- **候选入营养池而非直接 verified_skill**：尊重「自愿+共识」理念（用户 2026-08-06 强调），
  蒸馏产物需社区投票晋升，不自动成为权威技能。
- **标题级查重**：语义查重会被自动进化生成的大综合库（b2caf8334ecfffee，tags 含一切）
  对任意主题误拦截；改为「标题包含主题关键词」才判定同主题。
- **index_only=True**：query_swarm 不带 index_only 会全量加载内容+reranker，1104 条记忆下
  单次 60s+ 超时；加 index_only 后 15s 内返回（完整内容按需 get_swarm_memory）。
- **origin_ids 类型兼容**：get_swarm_memory 返回的 origin_ids 可能是 list（如 b2caf），
  str.split 会 AttributeError；已做 str/list 双兼容。

## 4. 遗留问题

1. **LLM 蒸馏耗时 2-5 分钟**（flash 约 2 分钟，pro 更慢）：HTTP 同步阻塞，客户端 curl 超时
   需设 ≥600s；体验优化（异步任务/进度查询）未做。
2. **容器代码是 docker cp 注入**：recreate 容器会丢失！已确认 recreate 后需重新
   docker cp 3 文件（api.py/http.py/cli.py）再 restart。后续 deploy.sh 构建镜像时应包含。
3. 自动进化（_distill_and_persist）仍直接生成 verified_skill（不走投票）——与按需蒸馏
   行为不一致，属既有设计，未改动。

## 5. 下一步建议

- 观察蒸馏产物质量（929b60093f179ddc 已验证为 verified_skill）
- 可选：distill 异步化（任务队列 + 状态查询），解决长耗时阻塞
- 可选：deploy.sh 集成（把 distill 端点纳入镜像构建）

## 6. 关键命令索引

```bash
# 蒸馏+自动投票（推荐默认）
python3 cerebrate.py --url http://127.0.0.1:8765 distill --topic "记忆去重"

# 只生成候选不投票
python3 cerebrate.py --url http://127.0.0.1:8765 distill --topic "xx" --no-vote

# 补投支持票（触发共识晋升）
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:8765/v1/consensus/vote \
  -d '{"memory_id":"<MID>","agent":"claude-code","vote":"support","evidence":"...","confidence":0.9}'

# 查共识快照
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/v1/consensus/<MID>

# 容器代码同步（recreate 后必做）
docker cp cerebrate/server/api.py cerebrate:/app/cerebrate/server/api.py
docker cp cerebrate/server/http.py cerebrate:/app/cerebrate/server/http.py
docker cp cerebrate/client/cli.py cerebrate:/app/cerebrate/client/cli.py
docker restart cerebrate
```

---

# 追加（2026-08-06 第二轮）：蒸馏异步化 + 冗余清理

## 已完成

### 蒸馏异步化（git b10f62e）
- POST /v1/distill 改为异步提交，立即返回 task_id（原同步 2-5 分钟阻塞）
- GET /v1/distill/{task_id} 查询 queued/running/done/error
- 串行执行器（单 worker）：并发蒸馏曾导致存储层锁死（容器 CPU 380%、新请求全卡）
- 任务 TTL 清理（1h）：修复内存无限增长（内存态，重启重提）
- CLI distill 默认轮询等待，--async 只提交
- 测试 tests/test_distill_async.py 8/8
- test_http_brain_server.py 加 CEREBRATE_DOCKER_SKIP_CHECK=1（Docker 容器运行时测试可起独立服务端）
- 真实验证：Flowable 5 条 → d7e485b65edabb87（nutrient）；异步提交 11s 返回

### 冗余清理（git 5938faa，-190 行）
A 级死代码 14 个方法删除（核心+测试 0 引用，全量回归 233/233 OK）：
  llm.py(suggest_tags/_llm_suggest_tags/detect_conflicts)、swarm.py(list_tags)、
  manager.py(get_swarm_stats/get_swarm_categories)、evolution.py(get_history)、
  docstore.py(find_by_title/list_by_type)、mind.py(set_focus/report_action/suggest_improvement)、
  decision.py(quick_query)、embedding.py(encode_document)
B 级历史脚本归档 docs/archive/（保留可追溯）：
  tools/curate.py（被 curate_v3.py 替代）、migrate_docstore.py/v2（迁移完成）、evolve_full.py

## 关键经验（冗余识别方法）
- api.py 死方法检查：grep api def vs http self.api 调用差集 + 手动验证
- 模块方法死代码检查：正则扫描 + 全项目引用计数（含 tests/tools）
- 注意连带：删 suggest_tags 连带 _llm_suggest_tags；保留 C 级（delete_memory/get_content/get_metadata/get_available_ids，测试引用）
- 容器同步：11 个改动文件需 docker cp + restart（recreate 会丢）

## 遗留
- 蒸馏仍 2-5 分钟（异步已解阻塞，产物质量待观察）
- 容器与 git 一致靠 docker cp（无镜像构建流程，deploy.sh 未集成）

---

# 追加（2026-08-06 第三轮）：deploy.sh 镜像构建集成（消除 docker cp 隐患）

## 问题
容器代码此前靠 docker cp 同步，recreate 会丢；deploy.sh 本已支持 `docker compose up -d --build`
（Dockerfile COPY 当前 git 代码），但平时改代码走了 docker cp 快路径，从未真正构建镜像 → 容器与 git 不一致隐患。

## 修复
- deploy.sh 分支 bug：`git pull --ff-only origin main` → `origin master`（实际远程分支是 master，main 会拉取失败）
- 执行 `docker compose build`（缓存命中 4s）+ `docker compose up -d`（recreate 用新镜像）

## 验证
- 容器内代码 = git：distill 异步化存在（distill/distill_status）、死代码已删（suggest_tags/encode_document=0）、归档生效
- 冒烟：sense 200 / search 200 / 蒸馏异步提交 queued
- 容器 healthy

## 部署流程（此后正确姿势）
改代码 → 测试 → git commit → `docker compose build && docker compose up -d`（或 ./scripts/deploy.sh --no-pull）
不再需要 docker cp！recreate 也不会丢代码。

## 注意
- 根目录 tools/（curate/migrate/evolve_full，已归档 docs/archive/）与 cerebrate/tools/（ingest/code_sync/project_profile 等包内工具）是两个不同目录，勿混淆
