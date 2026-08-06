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

---

# 追加（2026-08-06 第四轮）：远程推送 + 工程完成里程碑

## 已完成
- git push origin master 成功：`0920245..f9a9995 master -> master`（5 个提交全推）
- 本地 = 远程 = 镜像 = 容器，四者完全一致
- 虫群里程碑记忆：34429f122521bc34（quality 1.0）

## 本轮全部提交（已推远程）
| 提交 | 内容 |
|---|---|
| d5d3e3e | 按需蒸馏+共识投票端到端 |
| b10f62e | 蒸馏异步化（任务队列+TTL） |
| 5938faa | 冗余清理（删 14 方法+归档 4 脚本，-190 行） |
| 9abc7a4 | 交接文档更新 |
| f9a9995 | deploy.sh 分支修复+镜像构建部署 |

## 虫群记忆索引（本轮相关，共 6 条）
- 34429f122521bc34 里程碑：完美化工程完成（quality 1.0）
- 98fa93a7e87e57c0 蒸馏+共识投票技能（cerebrate）
- d4bcdb9fc946a41d query_swarm index_only 性能教训（general）
- 5b91411ab694aee5 冗余识别清理方法（general）
- c6e70569923dade1 部署 docker compose build+up（cerebrate）
- 78e5d540309cc13b 自愿奉献原则（general）

## 最终状态
- 服务在线（容器 healthy），蒸馏异步可用（提交→task_id→查询）
- 全量测试 233/233
- 部署正解：改代码 → 测试 → commit → `docker compose build && docker compose up -d` → push

---

# 追加（2026-08-06 第五轮）：公网网关（Nginx 路径路由 + ngrok 穿透）

## 架构
公网用户 → ngrok 隧道 → 本地 Nginx 网关容器(80) → /cerebrate/ → Cerebrate(8765)

## 文件
- docker/nginx-gateway/nginx.conf：反向代理配置（/cerebrate/ 剥离前缀转发 cerebrate:8765，proxy_read_timeout 900s 适配蒸馏）
- scripts/tunnel-gateway.sh：start/stop/status 一键管理

## 使用
```bash
./scripts/tunnel-gateway.sh start    # 启动网关+隧道，打印公网 URL
./scripts/tunnel-gateway.sh status   # 查当前 URL
```
当前公网: https://finale-earthworm-iciness.ngrok-free.dev/cerebrate/v1/sense

## 关键点
- Nginx 容器 join cerebrate_default 网络，用容器名 cerebrate:8765 访问（无需改 Cerebrate 端口映射）
- ngrok 免费版域名随机，重启会变（status 查看新 URL）；付费可固定域名
- 其他项目扩展：改 nginx.conf 加 location /<项目>/，重启网关
- 蒸馏长请求：proxy_read_timeout 900s 必须（nginx 默认 60s 会断）

---

# 追加（2026-08-06 第六轮）：用户认证体系 v1（TOTP 登录 + user token）

## 需求（用户确定）
- 不用设备绑定（换设备无法用），改用 Authenticator（TOTP）登录绑定"人"
- 登录后获取 token，token 长期有效，用户自己保存 = 唯一凭证
- 读共享；写/改记忆需 token 确定身份；查询优先自己的记忆

## 已完成（git b571fcf）
- cerebrate/server/auth.py：RFC 6238 TOTP（标准库零依赖）+ UserAuth（注册/登录/token 管理，JSON 持久化）
- API: POST /v1/auth/register（需 master token，管理员建用户）/ POST /v1/auth/login（匿名，TOTP 验证）
- 鉴权：master token（管理员，user_id=None）+ user token（物理用户）
- 验证：RFC 6238 标准向量通过；真实闭环（注册→TOTP登录→user token→读共享200）；无效 token 401
- 测试 tests/test_auth.py 10/10 + 回归 26/26

## 使用（给同事开通）
1. 管理员：POST /v1/auth/register {"username":"同事名"} → 拿到 otpauth_uri
2. 把 otpauth_uri 给同事加入 Authenticator（扫码）
3. 同事：POST /v1/auth/login {"username","code"} → 拿到 token（永久，自己保存）
4. 请求带 Authorization: Bearer <user token>

## 待办（下一阶段）
- 记忆 owner 字段 + 权限校验（只能改自己的记忆、可投票他人、读共享）
- 查询优先自己的记忆（搜索加权）
- MCP 客户端登录流程（mcp.py 集成 user token）
- 归档防删（OriginLog 保留策略）

---

# 追加（2026-08-06 第七轮）：LLM 测试隔离约定 + 认证阶段2

## LLM 测试隔离约定（省钱规则，git 5c780a7）
- **依赖真实 LLM API 的测试**必须加：
  `@unittest.skipUnless(os.environ.get("CEREBRATE_TEST_LLM") == "1", "需要真实 LLM API；设置 CEREBRATE_TEST_LLM=1 才运行（避免调用付费 API）")`
- 默认跑测试 → 自动 skip（不花钱）；`CEREBRATE_TEST_LLM=1 python3 -m unittest ...` 才运行
- 已隔离：test_chunking_upgrade.test_answer_api_available、test_structured_fields.test_title_compress_rule_fallback
- **不隔离**：mock 掉 LLM 的测试（test_distill_async）、只调规则方法（_rule_*）的测试
- 新增 LLM 依赖测试一律遵守此约定

---

# 追加（2026-08-06 第八轮）：认证阶段2 — owner 身份优先 + 查询优先自己

## 完成（git 4a446a3）
1. **owner 身份优先**：propose 时以服务端认证的 _current_user 为准（防伪造 physical_user），未登录回退客户端自报，无身份拒绝写入
2. **查询优先自己**：search/query 把自己的记忆排前（physical_user==user 提前），读共享不变
3. **FTS owner 支持**：memories_meta/knowledge_meta 加 physical_user 列（建表+幂等迁移+写入+三处 SELECT）
4. **幂等迁移**：并发初始化重复 ALTER 报 duplicate column → catch 忽略（FTS5 初始化不再降级）
5. **投票放开**：可对他人记忆投票

## 验证
- 单测 tests/test_auth_permissions.py 5/5（身份优先/回退/无身份拒绝/优先自己/投票他人）
- 真实：user token 写入 → physical_user=as-workstation01 ✅；fts 搜到 + owner 正确
- 回归 51/51（skipped=1 LLM 隔离）

## 说明
- 旧记忆 physical_user 多为历史 agent 名（yangying 等），不强制归属（共享可读，owner 为空不参与"优先自己"）
- 查询优先自己只影响排序，不改变读权限（读仍共享）

---

# 追加（2026-08-06 第九轮）：Mem0 借鉴决策（实体→本地 MCP）+ 未完成工作清单

## Mem0 评估结论与实体方向决策

### 评估结论（Mem0，GitHub 55K star 长期记忆系统）
- Mem0 强在**检索侧**：实体链接（Entity Linking）、时序推理（Temporal Reasoning）、
  BM25+语义+实体多信号融合、ADD-only（只增不改）
- Cerebrate 强在**可信侧**：共识治理（投票晋升）、免疫验证、自愿奉献原则、可溯源
- 可借鉴方向三个：① 实体链接 ② 时序推理 ③ 多信号融合

### 用户决策（2026-08-06）：实体 → 本地 MCP 实现，服务端不存储
- **理由**：Mem0 是装在个人电脑上的（个人使用）；Cerebrate 是团队共享的（服务端）。
  团队共享存储放"结构/参考"，**实体数据不存服务端**——延续「代码不离开本地」架构红线。
- **MCP 天然是用户安装的**：实体抽取/链接/衍生逻辑放 MCP 客户端本地执行，
  实体数据留在用户本机，服务端只接收实体名/标签等轻量结构作为记忆 tags/索引增强。
- **落点**：`cerebrate/mcp.py` 新增本地实体化能力（如 cerebrate_entity_extract /
  本地实体图谱工具），本地派生实体 → 补充服务端缺失的实体检索能力。
- 其余借鉴方向（时序推理、多信号融合）本轮未选，搁置待评估。

## 未完成工作清单（统一汇总，2026-08-06 快照）

| # | 事项 | 状态 | 落点/做法 | 优先级 |
|---|---|---|---|---|
| 1 | push 远程（本地领先 8+1 个提交） | 本轮处理 | `git push origin master` | P0 |
| 2 | 认证阶段3：MCP 客户端登录流程 | 未做 | `cerebrate/mcp.py` 集成 user token + 本地持久化（当前只读 CEREBRATE_SERVER_TOKEN 环境变量）；同事配用户名+TOTP 自动登录 | P1 |
| 3 | 归档防删：OriginLog 保留策略 | 未做 | scheduler cleanup_loop 可能删旧 origin，需确认策略防原始记忆被删 | P1 |
| 4 | 实体链接（本地 MCP） | 方向已定，未实现 | `cerebrate/mcp.py` 本地实体抽取/衍生，服务端不存实体 | P1 |
| 5 | 容器=git=镜像一致性验证 | 未做 | auth.py 等新改动未验证 `docker compose build && docker compose up -d` | P1 |
| 6 | 蒸馏产物质量观察 | 观察中 | d7e485b65edabb87（nutrient）待投票晋升 verified_skill | P2 |
| 7 | Mem0 其余借鉴（时序推理/多信号融合） | 搁置 | 未选，待评估 | P3 |

说明：owner 身份优先、查询优先自己、投票放开已在第八轮完成，不再列入未完成。

## 虫群记忆索引（第九轮）
- 130caa89b34ffc53 Mem0 借鉴决策：实体链接走本地 MCP（服务端不存实体）（scope=project, cerebrate）
