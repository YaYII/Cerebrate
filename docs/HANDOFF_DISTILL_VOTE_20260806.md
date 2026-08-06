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

> 更正（2026-08-06 第十三轮）：隔离约定已被「删除 LLM 用例 + conftest 禁用」取代，见第十三轮。

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

---

# 追加（2026-08-06 第十轮）：认证阶段3 + 归档防删 + 实体本地 MCP + 容器一致性

按未完成工作清单推进 P1（用户：按照计划进行处理，记得自己测试）。

## 1. 认证阶段3：MCP 客户端登录流程（git 待提交）
- **CLI**：`python3 -m cerebrate.mcp login|logout|status`
  - login：用户名 + Authenticator TOTP 码（交互输入）→ POST /v1/auth/login → token 存本地
  - logout：删本地 token；status：查看登录态与 token 来源
- **本地 token 持久化**：`~/.cerebrate/token`（JSON，chmod 600，含 user_id）；`CEREBRATE_TOKEN_FILE` 可覆盖路径
- **生效优先级**：环境变量 CEREBRATE_SERVER_TOKEN > 本地 token 文件（现状不变，兼容旧配置）
- **401 提示**：_request 对 401 响应附加「请先 python3 -m cerebrate.mcp login 登录」hint
- **同事开通流程**：管理员 register（发 otpauth_uri）→ 同事加 Authenticator → 同事 login 一次 → 之后 MCP 自动带 token

## 2. 归档防删：OriginLog 保留策略（git 待提交）
- `CEREBRATE_ORIGIN_RETENTION_DAYS` 默认 **0 = 永不删除**（符合「任何记忆都有原始归档，防止被删除」）
- `origin.cleanup_expired`：days<=0 → 直接跳过（skipped=True，不删任何记录）
- `scheduler._cleanup_loop`：改读 config.origin_retention_days（不再硬编码 365）
- **纵深防御**：http 层手动端点 /v1/origins/cleanup 仍保留 180 天最低保留 + 先备份再删除（显式管理动作可做，自动清理默认关）

## 3. 实体本地 MCP（Mem0 借鉴决策落地）
- **新模块 `cerebrate/entity.py`**：纯规则实体抽取（零 LLM、零付费）——技术关键词/驼峰/下划线/URL/邮箱/引号术语/已知图谱识别
- **本地实体图谱**：`~/.cerebrate/entities.json`（实体名→{type,count,first_seen,last_seen}，原子写，cap 2000）
- **MCP 工具 `cerebrate_entity_extract`**：本地抽取 + 可选持久化，实体数据不离开本地（架构红线）
- **propose 集成**：`auto_entities`（默认 True）把文本中抽出的实体名并入 tags（≤20），服务端只收实体名/标签轻量结构
- **修复真实 bug**：已知图谱识别与关键词规则重复计数 → known 命中且 seen 已有则跳过（真实复测 docker 1+1=2 正确）

## 4. 容器一致性验证
- `docker compose build && docker compose up -d`（正解流程），容器 healthy
- 容器内代码验证：entity.py 计数修复 / config retention / mcp _cli_login 全部存在
- 真实冒烟：sense healthy（1450 条，deepseek-v4-flash）✅；CLI 真实登录（as-workstation01）✅；logout ✅；防删 skip ✅

## 5. 测试
- 新增 3 个测试文件：test_mcp_login（10）、test_entity_extract（18）、test_origin_retention（6），共 34 例
- 全量回归：**280 passed, 2 skipped**（skipped=LLM 隔离，省钱规则）

## 6. 遗留 / 注意
- `tests/prod_test.py`（生产冒烟脚本，自带启动服务端）认证后未带 token 会 401——不在常规单测内，需手动跑时补 Authorization
- 实体抽取当前为规则级；后续可选 LLM 实体抽取增强（需 CEREBRATE_TEST_LLM 约定）
- Mem0 其余借鉴（时序推理/多信号融合）仍搁置（P3）
- 本次新增代码文件：cerebrate/entity.py；改动：mcp.py / config.py / origin.py / scheduler.py / tests/*

## 虫群记忆索引（第十轮）
- 523e2f03b9e018e9 技能: Cerebrate 第十轮 P1 — MCP登录流程 / 归档防删 / 实体本地MCP（scope=project, cerebrate）

---

# 追加（2026-08-06 第十一轮）：MCP 认证接入（AI 引导用户注册/登录）

## 需求（用户确认的交互模型）
用户在对话中把结果输入给 AI，AI 帮用户完成认证：
1. AI 先调 cerebrate_auth_status → 已有 token 直接使用，不再授权
2. 无 token → AI 问用户「注册还是登录」
3. 注册：AI 调 cerebrate_auth_register 拿 otpauth_uri（每个用户独立绑定码）→ 用户 Authenticator 扫码/手动输密钥 → 用户把当前 6 位码告诉 AI
4. AI 调 cerebrate_auth_login（用户名+码）→ token 存本地 → 之后自动带 token

## 服务端（git 待提交）
- **register 匿名化**：POST /v1/auth/register 加入免认证白名单（与 login 并列）——同事无 token 才能自助注册；
  注册只生成 otpauth_uri 不产生可用 token，篡改仍受 owner 模型约束（只能改自己的记忆）
- **GET /v1/auth/me**：校验 token 返回 {user_id, role}（user token→role=user；master token→role=admin），供 status 联网校验
- **用户名格式校验**：auth.py 新增 `^[a-z0-9_-]{3,32}$`（防滥用抢占），非法拒绝

## MCP 客户端（git 待提交）
新增 4 个认证工具（工具总数 27→31）：
- cerebrate_auth_status：token 来源（env/file/none）+ user_id + 可选 verify（联网调 /v1/auth/me 校验真实性 + role）
- cerebrate_auth_register：username → otpauth_uri + secret + 扫码提示（hint）
- cerebrate_auth_login：username + code → 验证 → token 存本地 ~/.cerebrate/token → token_saved + hint
- cerebrate_auth_logout：清本地 token

## 二维码方案（零依赖）
- qrcode 库未装（不引入依赖）：工具返回 otpauth_uri + secret 文本
- 用户两种方式：Authenticator「扫码」（从 otpauth URI 生成二维码）或「手动输入」32 位 Base32 密钥

## 测试与验证
- 新增 tests/test_mcp_auth_tools.py（9 例：status 三来源/verify/register/login 成功失败/logout）
- test_auth.py 新增用户名格式校验（5 例非法 + 2 例合法）
- 全量回归：**290 passed, 2 skipped**
- 真实冒烟（容器）：匿名注册 smoke-user → 拿 otpauth_uri ✅；非法用户名被拒 ✅；TOTP 登录 → token ✅；
  /v1/auth/me → user_id=smoke-user, role=user ✅；master token → role=admin ✅；冒烟用户已从 users.json 清理不留痕

## 给同事的使用流程
1. 装 Cerebrate MCP（本机），配置 CEREBRATE_SERVER_URL（公网/内网）
2. 对话里说「我要注册 用户名=xxx」→ AI 展示 otpauth_uri → Authenticator 添加
3. 把当前 6 位码告诉 AI → AI 登录 → 之后直接用，无需再授权
4. 换机：重新登录一次即可（无需重新注册）

## 虫群记忆索引（第十一轮）
- b4dc44b0557721af 技能: Cerebrate MCP 认证接入 — AI引导注册/登录 + 匿名register + /v1/auth/me（scope=project, cerebrate）

## 第十一轮补充：演示发现并修复「静态 token 陈旧」bug（git 2fd3bfa）
- **现象**：真实演示第 6 步 cerebrate_auth_status verify 返回 verified_user=null——
  _request 用进程启动时的静态 _SERVER_TOKEN，登录后保存的 token 在**同一 MCP 进程内不生效**
  （同事登录后，后续 search/propose 仍会 401）
- **修复**：_request 每次请求时 `_load_effective_token()`（环境变量 > 本地文件），登录后立即生效，无需重启
- **测试**：RequestDynamicTokenTests 2 例（文件 token 生效 / 环境变量优先级不变）
- **重演示验证**：第 6 步 verified_user=demo-user, role=user ✅；演示用户已清理不留痕

---

# 追加（2026-08-06 第十二轮）：网页二维码绑定页（bind_url，客户端零依赖）

## 需求（用户确认）
- MCP 注册应返回一个**可点击的 URL**（bind_url），用户点开网页 → 网页用 **JS 生成二维码** → Authenticator 扫码绑定
- 二维码生成功能不放用户本地（无需装 qrcode）；网页 JS 生成，简单
- 下次用户直接提供「用户名 + 绑定码（TOTP 6 位）」即可登录（已实现）

## 实现（git 待提交）
### 服务端
- **绑定页**：`GET /v1/auth/bind?token=xxx`（免认证）返回完整 HTML：
  - 内联 qrcode-generator JS（`cerebrate/server/static/qrcode.min.js`，MIT，56KB，无外部 CDN 依赖）
  - `cerebrate/server/static/bind.html` 模板：展示二维码 + secret 文本（手动输入备选）+ 操作指引
  - `Cache-Control: no-store`（页面含 secret）
- **短期绑定 token**：auth.py `create_bind_session`（30 分钟 TTL）——URL 不暴露 secret；
  `consume_bind_session` 换取 otpauth_uri（过期/无效返回错误页）
- api.py `register_user` 返回 bind_token；`auth_bind_page(token)` 渲染 HTML（错误页兜底）
- http.py 新增 `_send_raw`（非 JSON 信封响应）

### MCP 客户端
- `cerebrate_auth_register`：返回 **bind_url**（客户端用配置的 _SERVER_URL 拼接公网地址——
  服务端在容器内不知道公网 URL）+ hint 引导（打开链接扫码 → 报 6 位码 → login）
- 本地无任何二维码依赖（qrcode 仅演示用本机 pip，非项目依赖）

## 测试与验证
- test_auth.py 新增 bind session 生命周期（生成/消费/无效/过期/未知用户）3 例
- test_mcp_auth_tools.py 更新 register 用例（bind_url 拼接 + 无 token 无 bind_url）
- 全量回归：**295 passed, 2 skipped**
- 真实冒烟（容器）：注册 → bind_url ✅；打开绑定页含 qrcode JS + otpauth 数据 + secret ✅；
  无效 token → 错误页 ✅；扫码后 TOTP 登录 → token_saved ✅；status verify → role=user ✅；
  demo-user 已清理不留痕（现存 as-workstation01、同事甲）

## 给同事的最终流程
1. 对话里说「我要注册 用户名=xxx」→ AI 返回 **bind_url 链接**
2. 用户点开链接 → 网页显示二维码 → 手机 Authenticator 扫码绑定
3. 用户把当前 6 位码告诉 AI → AI 登录 → token 本地保存
4. 之后直接用，无需再授权；换机重新登录一次

## 虫群记忆索引（第十二轮）
- a35de3d73a1cd0fd 技能: Cerebrate 网页二维码绑定页 — bind_url 客户端零依赖扫码绑定（scope=project, cerebrate）

---

# 追加（2026-08-06 第十三轮）：删除 LLM 测试用例 + conftest 根治（零付费）

## 背景（用户反馈：每次测试都花钱）
用户要求删除所有使用 LLM 的测试用例，避免测试消耗 DeepSeek 费用。

## 证据：花钱根因（比 2 个 skip 用例严重得多）
- `cerebrate/config.py` 模块级 `_load_dotenv()` 在 import 时把 `.env` 的
  `DEEPSEEK_API_KEY` 写回 os.environ（`if key not in os.environ` 不覆盖）
- 测试中 **48 处 propose_memory 未显式 validate=False（默认 True）** →
  每次测试都会调 `CerebrateLLM().validate_memory()` → 真实 DeepSeek API → 烧钱
- 结论：只要 cerebrate.config 被 import（任何测试方式），.env 的 key 都会被加载

## 处理（git 待提交）
### 1. 删除 2 个真实 LLM 用例（按用户要求）
- tests/test_chunking_upgrade.py `test_answer_api_available`（api.answer 调真实 LLM）
- tests/test_structured_fields.py `test_title_compress_rule_fallback`（CerebrateLLM().compress_title）
- 两个用例连同 `@skipUnless(CEREBRATE_TEST_LLM)` 标记一并删除；不再有 CEREBRATE_TEST_LLM 引用

### 2. conftest 根治（tests/conftest.py 新增）
- 先 `import cerebrate.config` 触发 _load_dotenv（.env 写回仅此一次）
- 再清除 `ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY`
- 此后任何测试路径 CerebrateLLM.is_available() = False → 规则保底 → 零付费
- **保留** mock 掉 LLM 的测试（test_distill_async，patch CerebrateLLM，不花钱、是蒸馏核心回归）

## 验证
- 探针测试：注入假 key 后 is_available=False 断言通过（pytest 加载 conftest 生效）
- 全量回归：**295 passed, 0 skipped**（297−2 删除；假 key 注入下跑通 = 无真实调用）

## 约定（取代第七轮隔离约定）
- 测试一律不得调用真实 LLM（conftest 强制）；新增测试若涉及 LLM 必须 mock，否则将被 conftest 禁用路径覆盖

## 虫群记忆索引（第十三轮）
- d332f9499dc8f771 教训: 测试烧钱根因 — config._load_dotenv写回LLM key + conftest根治（scope=project, cerebrate）

---

# 追加（2026-08-06 第十四轮）：管理员角色隔离（修复权限 BUG）

## 背景
完整模拟「注册→绑定→登录→授权」流程发现 2 个真实权限 BUG（用户确认修复）：
- **C1 隐私**：普通 user token 可 GET /v1/auth/users 列出全部用户
- **C2 严重**：普通 user token 可 POST /v1/soul/set 改写虫群灵魂（doctrine）——
  注释写明「服务端专属通道」但 http 层只校验「有无 token」，无 admin/user 角色隔离。
  模拟中真实覆盖了灵魂（内容变「测试占位」），已从 docs/ENGINEERING_SOUL.md 恢复。

## 修复（git 待提交）：http.py 管理员角色隔离
- **管理端点集合** `_ADMIN_ENDPOINTS`（黑名单式）：auth/users、soul/set、knowledge(写)、
  knowledge/distill、distill、fulltext/rebuild、memories/dedup-check、evolve、answer、
  code/sync、harvest/push、project/harvest、project/branch-diff、ingest、batch/process、
  origins/cleanup、logs(GET) —— 普通 user token 调用返回 **403**
- **`_check_auth` 新增 `self.is_admin`**：master token → admin；本地开发无鉴权模式 → admin（不破坏开发）；
  user token → 非 admin
- **profile save/attach 特判**：project/profile action=save/attach 需 admin；read/draft/list 任意登录（不破坏团队读画像）
- `_handle` 增加 `PermissionError → 403` 分支
- **约定**：未来新增管理/花钱/全局写端点必须加入 _ADMIN_ENDPOINTS，防止权限旁路

## 验证
- 新增 tests/test_http_permissions.py（起真实 HTTP server）：无 token 401 / user token 读 200 /
  9 个管理端点 403 / propose 200（写保留）/ master token 200 / profile save 403 + read 允许 —— 6/6
- 全量回归：**301 passed, 0 skipped**（295+6）
- 真实容器验证：user token 调 auth/users/soul/set/distill/evolve/answer/logs 全部 **403** ✅；
  sense 200 ✅；master token auth/users/soul/set 200 ✅；propose 长内容 200 ✅
- 灵魂已恢复（含「铁律」「工程化思维」，souls=1）；测试用户已清理（现存 as-workstation01、同事甲）

## 虫群记忆索引（第十四轮）
- a314b891e70928b3 技能: Cerebrate 管理员角色隔离 — 管理端点 user token 403（修复权限BUG）（scope=project, cerebrate）

---

# 追加（2026-08-06 第十五轮）：重新绑定端点 rebind + 同事甲开通

## 背景
实际给「同事甲」开通时发现：他注册后从未绑定，注册时 bind_token 早已过期（30min TTL），
而 register 对已存在用户返回 registered=false 且不生成 bind_token → **重新绑定死锁**。

## 实现（git 待提交）
- **服务端** `POST /v1/auth/rebind`（admin-only，加入 _ADMIN_ENDPOINTS）：
  api.rebind_user 为已注册用户重新生成 bind_token（30min 有效），不重置 TOTP secret
- **CLI**：`python3 cerebrate.py auth-rebind <username>`（需 CEREBRATE_SERVER_TOKEN=master）
- **MCP**：cerebrate_auth_rebind（管理员用，普通用户被服务端 403 保护）
- **测试**：test_http_permissions 新增 rebind（admin 200 / user 403 / 未注册 400）；
  test_mcp_auth_tools 新增 rebind handler 2 例

## 同事甲开通记录（真实）
- 状态：已注册（secret 存在）、未绑定（无登录 token）
- 生成绑定链接（公网 ngrok）：https://finale-earthworm-iciness.ngrok-free.dev/cerebrate/v1/auth/bind?token=...
- 公网绑定页 200 含二维码 JS ✅；二维码 PNG 已生成
- ✅ **开通完成（2026-08-06）**：同事甲扫码报码 878962 → 登录 200 → /v1/auth/me role=user →
  /v1/sense healthy（1459 条）→ tokens.json 已存同事甲 token（绑定成功）
- 同事甲 user token 已记入 ~/.codex/private_notes.md（唯一凭证，转交同事甲本地保存）

## 虫群记忆索引（第十五轮）
- 9b3f066c33ff7484 技能: Cerebrate rebind 重新绑定端点 + 同事甲真实开通全流程（scope=project, cerebrate）

---

# 追加（2026-08-06 第十六轮）：MCP 交付物（同事一键安装 + 功能文档）

## 交付内容
### 1. scripts/install-mcp.sh（一键安装，git bb59224）
同事执行一条命令完成安装：
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/YaYII/Cerebrate/master/scripts/install-mcp.sh)" -- \
  --url <脑虫地址> --token <user token>
```
功能：检测 Python 3.8+（纯标准库零依赖）→ clone/下载仓库 → 校验 mcp.py/entity.py →
生成 cerebrate.env（URL+token，chmod 600）→ 自检 → 打印 4 客户端（Codex/Claude/Qoder/opencode）配置片段。

### 2. cerebrate/mcp.py 增强
- 支持从**安装目录 cerebrate.env** 读取 URL/token（环境变量优先，env 文件兜底）
- 同事 MCP 配置只需指向脚本路径，**无需明文 token**（地址变化只改 env 文件）
- `_cli_status` 显示准确 token 来源（环境变量/本地配置/登录持久化）

### 3. docs/MCP_GUIDE.md（功能文档）
- 33 个 MCP 工具分组：🟢读/日常 13 · 🟡写/协作 9 · 🔴管理 6（服务端 admin 保护 403）
- 安装 / 配置 / 使用示例 / 认证权限 / FAQ

## 验证
- env 文件解析/优先级/兜底单测 + status 来源单测（15 例 test_mcp_login）
- 全量回归 **308 passed**
- 端到端：从 GitHub 重新 clone（含新代码）→ 安装脚本 → env 文件生效
  （status 显示公网 URL，cerebrate_sense 用同事甲 token 公网读到 healthy/1460 条）✅
- 修复：env 默认路径从 ~/.cerebrate-mcp 改为安装目录根（--dir 自定义目录也能读）

## 给同事的开通三步
1. 管理员：注册/rebind 生成账号 + 提供 URL 和 user token（如同事甲已开通）
2. 同事：执行上面 curl 安装命令（填自己的 URL + token）
3. 同事：粘贴脚本输出的配置片段到 AI 客户端 → 重启 → 对话先调 cerebrate_sense

## 虫群记忆索引（第十六轮）
- b311c061995c4a70 技能: Cerebrate MCP 交付 — 同事一键安装脚本 + 功能文档 + env文件配置（scope=project, cerebrate）

---

# 追加（2026-08-06 第十七轮）：Node版MCP直接安装 + 服务"卡死"根因修复

## 用户方向（2026-08-06）
- **不要 docker 容器化安装**——MCP 需要本地实体化抽取 + 用户代码库分析（harvest）能力，必须访问本机文件系统
- **Node.js 一定有**（python 不一定装）→ Node 版 MCP 直接本机安装
- 下载走**公网域名**（https://...ngrok-free.dev/cerebrate/mcp/mcp.js），不经 GitHub

## 交付（git 822ed89）
### 1. mcp.js（Node 版 MCP server，零依赖，node>=16）
- 33 个工具完整移植（sense/search/propose/entity_extract/auth_* 等）
- 本地实体抽取（规则移植自 entity.py）+ 认证 CLI（login/logout/status）
- 配置：环境变量 > 安装目录 cerebrate.env > 默认
- 验证：MCP stdio initialize/tools-list(33)/sense 真实调用通过

### 2. 公网下载端点（服务端）
- GET /mcp/mcp.js、/mcp/install.sh、/mcp/Dockerfile.mcp、/mcp/VERSION（免认证）
- Dockerfile 新增 COPY mcp.js/VERSION/Dockerfile.mcp/install.sh（容器内静态托管）

### 3. install-mcp.sh（Node 优先直接安装）
- 检测 node → 从 $URL/mcp/mcp.js 下载 → node --check 校验 → 生成 cerebrate.env → 自检 → 打印 4 客户端配置片段
- 无 node 回退 Python 模式；Docker 方式已从推荐中移除

## 服务"卡死"根因与修复（重要运维经验）
**现象**：多次 rebuild/restart 后容器 unhealthy、/v1/sense 60-180s 超时、CPU 250%+
**排查**：空库 sense 1.2s（代码正常）→ get_all_stats 2.6s（数据非卡点）→ 完整 sense 31.1s（新进程首次冷加载完成、第二次 0s 缓存）→ 定位为**首次 sense 冷加载（embedding/consensus ~31s）被 healthcheck(4s) 与并发请求同时触发 → 初始化锁竞争 → 表现卡死**
**修复**：
- serve() 后台线程预热 api.sense()（填 _sense_cache，避免并发触发初始化）
- Dockerfile HEALTHCHECK：timeout 5s→60s、start-period 60s→150s、内部 timeout 4→55s
- 验证：预热后 sense **0.043s**、公网 healthy、下载端点 OK

## 遗留/注意
- 首次启动仍需 ~90-150s 预热（模型+共识冷加载），期间 healthcheck starting（不再 unhealthy）
- verify_loop 首轮仍会跑（interval 只影响后续）；容器内无宿主机代码仓，画像校验意义有限（.env 已设 interval=99999，不进 git）
- 同事开通命令（Node 直接安装）：
  bash -c "$(curl -fsSL https://finale-earthworm-iciness.ngrok-free.dev/cerebrate/mcp/install.sh)" -- --url https://finale-earthworm-iciness.ngrok-free.dev/cerebrate --token <token>

---

# 追加（2026-08-06 第十八轮）：服务端标准 MCP Streamable HTTP 端点 /v1/mcp

## 用户要求（2026-08-06）
- **按 MCP 生态标准规范接入**，不能自造非标准安装功能
- 标准 = Streamable HTTP（2025-03-26 规范）：单一 POST/GET 端点、JSON-RPC、
  `claude mcp add --transport http <name> <url>` / Codex config.toml `url =`

## 交付（git fa065a0，已 push）
### 1. cerebrate/server/mcp_transport.py（新，标准 MCP 端点实现）
- `handle_mcp_rpc()`：initialize / ping / tools/list / tools/call（通知返回 None）
- 29 个工具 JSON Schema（与 mcp.py/mcp.js 对齐，含 auth_login 新增）
- `_invoke_tool()`：参数转换 + 统一信封（成功包 `{status:ok,data}`，与 mcp.py 走 REST 的信封一致）
- 权限把关 `_auth_gate()`：管理工具仅 master（auth_rebind/knowledge_store/ingest/project_harvest/batch_process）；写工具需登录（propose/remember/vote/use_start/use_finish/entity_extract）；project_work claim/release 需登录（list 放行）
- 实体工具（entity_extract）在 HTTP 远程端点返回错误提示（本地 MCP 才有，数据不离开本地）

### 2. cerebrate/server/http.py 接入
- `/v1/mcp` 分支：**自行解析身份，不强制 401**（允许匿名调用自助注册/登录工具）
  - `_parse_mcp_auth()`：Bearer user token → current_user；master → is_admin；无 token（本地无 master）→ admin；无 token（生产）→ 匿名
- POST：读 JSON-RPC（支持单对象/批量数组）→ 通知 202、响应 JSON
- GET：405（规范允许）；Accept 只收 text/event-stream 时回 SSE 帧
- 关键设计修正：摘要草稿曾写「免认证白名单」→ 已否决（管理工具会裸奔）；改为身份解析 + 工具级权限把关

### 3. tests/test_mcp_http_transport.py（16 用例）
- initialize/ping/tools-list/sense 匿名、propose 匿名 403 / user 200
- auth_register/auth_login 匿名自助、管理工具匿名/user 403 / master 200
- 通知 202、批量数组、未知方法 -32601、GET 405、解析错误 -32700

## 验证（全部真实执行）
- 全量回归 **325 passed**（新增 16 例）
- 容器重建 + 预热后 curl：sense 匿名 200（1469 条记忆）、auth_register 匿名注册 ✅、
  propose 匿名 403 ✅、auth_rebind master 200 / 匿名 403 ✅、通知 202 ✅、批量 ✅、GET 405 ✅
- 公网 ngrok `/cerebrate/v1/mcp` ping 200 ✅
- **标准接入决定性验证**：`claude mcp add --transport http cerebrate-test <公网>/cerebrate/v1/mcp --header "Authorization: Bearer <同事甲token>"` → `claude mcp get` 显示 **✔ Connected** ✅（验证后已移除测试配置）
- user token 完整链路：register → TOTP login → token → propose 写记忆 ✅
- master propose 失败原因与 REST 一致（`physical_user is required`，master 是系统级凭证非个人用户，写记忆须 user token）—— 行为一致性确认，非 bug

## 标准接入方式（同事/自己）
### Claude Code（HTTP，零安装，推荐）
```bash
claude mcp add --transport http cerebrate https://<域名>/cerebrate/v1/mcp \
  --header "Authorization: Bearer <你的user token>"
```
### Codex（config.toml）
```toml
[mcp_servers.cerebrate]
url = "https://<域名>/cerebrate/v1/mcp"
# token 走环境变量 CEREBRATE_SERVER_TOKEN（或客户端支持的 env）
```
### 本地 stdio（Qoder/opencode/Trae 若只支持 stdio）
```bash
node mcp.js                # Node 版（下载自 <域名>/mcp/mcp.js）
python3 -m cerebrate.mcp   # Python 版
```
（本地 stdio 保留实体化 + harvest 能力；HTTP 端点无实体/无本地代码分析）

## 关键决策与理由
1. **HTTP 端点必须认证**：否决「免认证白名单」——管理工具（注册/rebind/ingest/knowledge_store）会裸奔；但也不走 `_check_auth()`（无 token 直接 401 会挡住自助注册/登录）→ 自解析身份 + 工具级 `_auth_gate`
2. **统一信封**：API 层返回裸 data，MCP 端点统一包 `{status,data}`（对齐 mcp.py 走 REST 的信封），客户端看到的 text 一致
3. **master ≠ 个人用户**：master 写记忆被拒（physical_user required）与 REST 一致，是既有安全模型，非回归

## 遗留/下一步
- npm 包化 mcp.js（package.json + bin/）尚未做——若同事需要 `npx @yayii/cerebrate-mcp` 标准 stdio 接入，下一步做
- ngrok 域名随机重启会变；接入命令中的域名需更新（或用固定域名）
- `/v1/mcp` 生产可加 Origin 校验（当前无 CORS，仅同源/无浏览器场景，风险低）

## 虫群记忆索引（第十八轮）
- 待提交：技能「Cerebrate MCP 标准接入（Streamable HTTP /v1/mcp）」scope=project cerebrate

---

# 追加（2026-08-06 第十九轮）：npm 包化 cerebrate-mcp（标准 npm 安装）

## 用户要求（2026-08-06）
把 MCP 推送到 npm 仓库，别人 `npm install`/`npx` 即完成安装，直接复制配置片段到工具即可用。

## 交付（git ea81677，已 push）
### 1. package.json（新）
- name: **cerebrate-mcp**（全局名，registry 未占用），version 5.0.0
- bin: `cerebrate-mcp` → mcp.js；零依赖（仅 Node 内置模块），engines node>=16
- files: mcp.js + README.md（npm pack 实测 4 文件含 LICENSE）

### 2. mcp.js 关键改造
- **env 默认路径改为 `~/.cerebrate-mcp/cerebrate.env`**（原 SCRIPT_DIR/cerebrate.env；
  npm 安装后脚本在 node_modules 缓存目录不可写；新路径与 install-mcp.sh INSTALL_DIR 一致，兼容）
- **新增 `setup` 命令**：`cerebrate-mcp setup --url <url> --token <token>`（非交互）
  或 `cerebrate-mcp setup`（交互）→ 写 env（chmod 600）→ 打印 Claude Code/Codex/stdio
  三套配置片段，复制即用

### 3. README.md（新）
安装（npm i -g cerebrate-mcp / npx -y cerebrate-mcp）、setup、三客户端接入、
配置优先级（环境变量 > ~/.cerebrate-mcp/cerebrate.env > 默认）、CLI、安全

## 验证（真实执行）
- `npm pack`：4 文件（LICENSE/README/mcp.js/package.json），12.1 kB ✅
- 临时 prefix 全局安装：`npm install -g --prefix $TMP ./tgz` → bin 生成 ✅
- `cerebrate-mcp setup --url --token`：写 env + 打印三套配置 ✅
- stdio：initialize OK + sense 真实调用（1471 条记忆 healthy）✅
- 注意：本机 shell 有 CEREBRATE_SERVER_URL=127.0.0.1:8765 环境变量（优先于 env 文件），
  这是设计优先级（环境变量 > env > 默认），非 bug

## 发布步骤（需要 npm 账号，未登录）
```bash
npm login          # 或 npm adduser；需要用户自己的 npm 账号
npm publish        # 在 Cerebrate 项目根执行，发布 cerebrate-mcp@5.0.0
```
发布后同事用法：
```bash
npm install -g cerebrate-mcp
cerebrate-mcp setup --url https://<域名>/cerebrate --token <user token>
# 复制输出的配置片段到 AI 客户端
```

## 遗留/注意
- 发布需用户 npm 账号（本机未登录，无凭据，不能代办发布）
- 首次发布后版本升级：改 package.json version → npm publish
- ngrok 域名变化时同事只需重跑 setup --url 更新 env

---

# 追加（2026-08-06 第十九轮补充）：npm 发布成功 cerebrate-mcp@5.0.0

## 发布结果
- **cerebrate-mcp@5.0.0 已发布到 npm registry**（https://registry.npmjs.org/cerebrate-mcp）
- 发布账号：**yangying1991**（granular token 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，
  bypass 2FA；token 在 private_notes.md）
- 版本升级：改 package.json version → npm publish（~/.npmrc 已配置 token）

## npm 发布踩坑（2026-08-06，重要）
1. npm 10+ 强制 Web OAuth 登录（CLI 密码直登被禁）：`npm login` 会打印一次性授权 URL，
   需浏览器打开完成授权；授权后 `npm whoami` 验证
2. npm 新策略：**发布必须 2FA 或 granular token with bypass 2FA**；Web login 产生的
   token 发布仍会 403（E403 two-factor authentication required）
3. **Granular Access Token 创建**：选「Only select packages and scopes」（不是组织），
   添加 cerebrate-mcp 包、权限 Read and write、勾选 Bypass 2FA
4. 用户误把 2FA 恢复码（64 位 hex）当 token 发来——恢复码不能用于发布（全部 401）
5. 真正可用的 token 是 `npm_` 开头（granular）；发布账号可能 ≠ 登录账号（whoami 为准）

## 同事安装（已验证全链路）
```bash
npm install -g cerebrate-mcp        # 或 npx -y cerebrate-mcp
cerebrate-mcp setup --url https://<域名>/cerebrate --token <user token>
# 复制输出的 Claude Code / Codex / stdio 配置片段 → 粘贴到工具 → 重启即用
```
验证证据：registry latest 端点正常、npm install 成功、setup 写 env + 打印配置、
stdio sense 真实调用（1472 条记忆 healthy）

## 虫群记忆索引（第十九轮补充）
- 待提交：技能「Cerebrate MCP npm 发布」（含 npm 10 登录/2FA/发布踩坑）
