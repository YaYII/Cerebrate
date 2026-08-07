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

---

# 追加（2026-08-06 第二十轮）：v5.0.1 发布 + 安装命令实测 + 标准 CLI 修复

## 用户要求（2026-08-06）
自己实测安装命令是否可用。

## 实测结果（全部通过）
1. `npx -y cerebrate-mcp`（免安装）：initialize + tools/list 正常 ✅
2. `npm install -g cerebrate-mcp`：bin 生成于 node 全局路径 ✅
3. `cerebrate-mcp setup --url --token`：写 env + 打印配置片段 ✅
4. stdio sense 真实调用：1474 条记忆 healthy ✅

## 修复（git 09c41d7，v5.0.1 已发布）
- **`cerebrate-mcp --version`/`--help` 无输出缺陷**：原 CLI 未处理这两个参数，
  直接进入 stdio 模式卡住 → 修复为输出版本/用法（硬编码版本号，兼容公网单独下载 mcp.js 无 package.json 场景）
- initialize serverInfo 同步 5.0.1

## npm 发布与缓存坑（新增）
- `npm publish` 成功但 `npm install -g <pkg>@latest` 报 ETARGET "No matching version found"：
  npm 本地缓存旧 registry 元数据 → **`npm cache clean --force` 后重装即可**
- registry 根路径 CDN 可能短暂返回旧版本，以 `curl <pkg> | dist-tags.latest` 为准

## 发布记录
- cerebrate-mcp@5.0.0（2026-08-06 首发）
- cerebrate-mcp@5.0.1（2026-08-06，--version/--help 修复）
- 发布命令：cd 项目根 && npm publish（~/.npmrc 已配 token）

---

# 追加（2026-08-06 第二十一轮）：脑虫与 MCP 版本号统一 5.0.1 + 安装后链接脑虫全链路测试

## 用户要求（2026-08-06）
1. 脑虫的版本号和 MCP 的版本号保持一致
2. 测试刚安装的 MCP 链接脑虫是否正常使用，发现问题就修复

## 版本统一（git fbbf877，已 push）
发现不一致：VERSION 文件/服务端 mcp_transport/mcp.py 仍是 5.0.0，npm 包已是 5.0.1。
统一 5 处为 **5.0.1**：
- VERSION 文件：cerebrate-mcp-v5.0.1（/mcp/VERSION 下载端点）
- cerebrate/server/mcp_transport.py SERVER_INFO → 5.0.1（HTTP MCP 端点）
- cerebrate/mcp.py serverInfo → 5.0.1（Python stdio 客户端）
- mcp.js / package.json（已 5.0.1，无需改）

## 安装后链接脑虫全链路测试（全局安装的 cerebrate-mcp 5.0.1）
| 测试 | 结果 |
|---|---|
| cerebrate-mcp --version | 5.0.1 ✅ |
| initialize（本地 stdio） | serverInfo 5.0.1 ✅ |
| sense（本地 stdio） | ok，1475 条记忆 healthy ✅ |
| search（本地 stdio） | ok，命中已有记忆 ✅ |
| propose 写入（本地 stdio） | ok，memory_id 178f8225516fecd8 ✅ |
| HTTP /v1/mcp initialize（本地） | 5.0.1 ✅ |
| HTTP /v1/mcp initialize（公网） | 5.0.1 ✅ |
| /mcp/VERSION 下载 | cerebrate-mcp-v5.0.1 ✅ |
| 公网 stdio（全局 MCP + 公网 URL） | initialize 5.0.1 + sense 1477 条 ✅ |

注意：search "npm publish 2FA" count=0 是关键词未命中（向量/FTS 无匹配），换通用词 "Cerebrate MCP 标准接入" count=2 命中——链路正常，非缺陷。

## 修复项
- 版本号不一致（5 处统一 5.0.1）
- （此前已修）--version/--help 标准 CLI 参数（v5.0.1 发布）

## 下一步建议
- npm 包已是 5.0.1，无需重发；后续改版时 5 处版本号 + package.json + mcp.js 硬编码同步

---

# 追加（2026-08-06 第二十二轮）：系统镜像版本与 MCP 版本统一 5.0.1

## 用户要求（2026-08-06）
升级为 MCP 版本一样的版本号，统一一点。

## 交付（git a83c9bb，已 push）
- docker-compose.yml image: **cerebrate:v5 → cerebrate:5.0.1**
- docs/DEPLOY.md 同步
- 容器重建：镜像 cerebrate:5.0.1（旧 cerebrate:v5 已删除）
- **协议标识 meta.protocol 保持 v5**（API 协议版本，测试断言依赖，不随 MCP 版本变更）

## 版本全貌（当前完全一致）
| 项 | 版本 |
|---|---|
| Docker 镜像 tag | cerebrate:5.0.1 |
| 服务端 HTTP MCP 端点 | 5.0.1 |
| /mcp/VERSION 文件 | cerebrate-mcp-v5.0.1 |
| npm 包 / mcp.js / mcp.py | 5.0.1 |
| 协议标识（meta.protocol） | v5（协议级，不变） |

## 验证
- 容器 healthy；MCP initialize（本地+公网）均 5.0.1
- meta.protocol 仍 v5（无破坏）；sense ok healthy
- /v1/status 无 token 401 是生产预期行为（需 Bearer）

---

# 追加（2026-08-06 第二十三轮）：操作手册更新（npm 标准安装 + 版本升级流程）

## 用户要求（2026-08-06）
1. 确认是否同步到远程服务
2. 操作手册是否写清楚

## 核实结果
- 远程同步确认：本地 master = 远程 origin/master（f45728c 已同步，工作区干净）
- **发现操作手册落后**：MCP_GUIDE.md 仍写旧一键安装（curl + install.sh）、Python 依赖描述；
  DEPLOY.md 构建段未标注镜像 tag 与版本升级流程

## 交付（git f2ae5a1，已 push）
- docs/MCP_GUIDE.md（同事操作手册）：一键安装改为 **npm install -g cerebrate-mcp + cerebrate-mcp setup**；
  客户端配置改为 HTTP 标准接入（claude mcp add --transport http）+ stdio npx；标注版本 5.0.1
- docs/DEPLOY.md：构建段标注镜像 tag cerebrate:5.0.1、协议 v5 不变说明、版本升级流程（5 处同步清单）

## 操作手册索引（给同事/下一个 AI）
| 文档 | 用途 |
|---|---|
| docs/MCP_GUIDE.md | 同事安装/配置 MCP（npm + setup）|
| docs/DEPLOY.md | 服务端部署/升级/版本统一 |
| docs/HANDOFF_DISTILL_VOTE_20260806.md | 全量交接记录 |
| README.md（npm 包内） | 同事 npm 安装指引 |

---

# 追加（2026-08-06 第二十四轮）：Node 版本地代码分析 harvest + 超时验证 + 版本 5.0.2

## 用户要求（2026-08-06）
1. 超时的问题解决了吗（思考依赖 MCP）
2. MCP 代码实例化功能是否可以使用

## 调研发现（证据）
- 超时历史已修复：服务"卡死"（第十七轮，预热+healthcheck 宽容）、LLM 蒸馏（nginx 900s）
- **Node 版 mcp.js project_harvest 缺陷**：有 dir 时直接报"Node 版不支持本地 harvest"
  → 代码实例化（harvest）在 npm 包（同事用的）里不可用！

## 修复（git dabf1fb，v5.0.2 已发布 npm + 容器）
- mcp.js 新增 **harvestProjectLocal()** 轻量零依赖解析器：
  扫描目录（SKIP_DIRS/SKIP_FILES 与 Python 版一致）→ .py/.js/.ts/.java/.kt/.php
  正则解析模块/类/函数/端点/数据模型 → 产出与 Python 版 code_harvest 兼容结构 →
  push /v1/harvest/push（代码不离开本地，只推结构）
- project_harvest case：有 dir 走本地分析；无 dir 读服务端结构
- 版本统一 5.0.2：package.json / mcp.js / mcp_transport / mcp.py / VERSION / 镜像 tag

## 验证（真实执行）
| 项 | 结果 |
|---|---|
| sense 耗时（预热后） | **0.064s**（无超时）|
| harvest 本地分析（Node 版） | ok，47 文件/47 模块/1 数据模型/47 端点，12.8s |
| harvest 服务端读取（无 dir） | ok，stats 一致 |
| 实体化 entity_extract | ok，0.12s，实体正确 |
| 全局版（registry 5.0.2）harvest | ok（代码实例化可用）|
| 版本一致 | 服务端 5.0.2 = 客户端 5.0.2 = 镜像 cerebrate:5.0.2 |

## 说明
- harvest 12.8s 本地分析（2000 文件上限内），Claude/Codex MCP 默认超时（60s+）内，无超时风险；
  超大项目（>2000 文件）只扫前 2000，可在参数 limit 扩展
- 服务端 MCP 端点（HTTP /v1/mcp）的 entity_extract 仍返回提示（本地 MCP 才有实体化，数据不离开本地）——
  这是架构设计：实体化/代码分析必须在本地 MCP（npm 包）执行

---

# 追加（2026-08-07 第二十五轮）：豆包视觉图像识别 skill（deepseek 视觉补充）

## 背景与约束（用户明确）
- 提供火山引擎豆包多模态 API Key，补充 **deepseek 无图像识别**的能力
- **铁律：绝不生图**——本 API 只用于图像识别（便宜）；生图用程序化构建
  （Python PIL/treejs/SVG/Matplotlib），不用多模态生成（贵）
- 定位：辅助技能，非主力；只做「图像识别 → 文本结果」，交给主模型继续推理

## API 事实（实测确认）
- endpoint: https://ark.cn-beijing.volces.com/api/v3/chat/completions（OpenAI 兼容）
- 可用视觉模型（key 已开通）：doubao-seed-2-1-pro-260628（主力精准）/
  doubao-seed-2-1-turbo-260628（备选快省）
- 未开通：doubao-seed-2-0-pro-260215 等（需 Ark 控制台激活，报 ModelNotOpen）
- 图片：base64 data URL（本地推荐，最可靠）或 http(s) URL（需火山服务器可达）
- key 明文只在 ~/.codex/private_notes.md（本机）；虫群记忆/交接文档不写明文

## 交付
- skill: ~/.codex/skills/doubao-vision/（SKILL.md + scripts/vision.py）
- 用法：python3 ~/.codex/skills/doubao-vision/scripts/vision.py <图片|URL|-> [提问] [--model X]
- 特性：stdin 输入、>1MB 自动 PIL 压缩（限宽 1024）、120s 超时 + 一次重试、
  key 读取（环境变量 DOUBAO_VISION_API_KEY > private_notes 兜底）

## 验证（真实执行）
- 测试图（矩形+圆形+文字）：pro 精准识别形状/颜色/文字 ✅
- 真实截图（vscode-database-client SQL 工具）：OCR 提取 SQL/按钮/分页精准（pro 25s / turbo 15s）✅
- URL 图片：wikimedia 曾超时（火山服务器下载失败），本地 base64 无此问题 ✅

## 遗留/注意
- key 在 private_notes.md；skill 脚本从 private_notes 兜底读取
- 生图能力（若未来需要）走 PIL/treejs/SVG 程序化构建，与豆包 API 无关

---

# 追加（2026-08-07 第二十六轮）：豆包视觉 skill 同步到 opencode

## 用户要求（2026-08-07）
把豆包视觉图像识别技能同步到 opencode 工具，方便 opencode 也能调用。

## 交付
- opencode skill 位置：`~/.config/opencode/skills/doubao-vision/SKILL.md`（全局）
- 格式：YAML frontmatter（name 必须小写连字符 `doubao-vision`，description 必填）
- **单一脚本来源**：opencode SKILL.md 直接引用 `~/.codex/skills/doubao-vision/scripts/vision.py`
  （不复制脚本，避免双份维护；与 Codex skill 共享同一实现）
- 铁律同步：只识别绝不生图（生图用 PIL/treejs/SVG 程序化构建）

## 验证（真实执行，opencode 1.18.14 + deepseek-v4-flash）
1. `opencode run "列出可用 skills"` → 发现 `doubao-vision` ✅
2. `opencode run "加载 doubao-vision 识别 /tmp/test_vision.png"` →
   - opencode 自动加载 Skill "doubao-vision"
   - 自动执行 vision.py 识别图片
   - deepseek-v4-flash 用识别结果回答（蓝色矩形 HelloCerebrate + 红色圆形 Circle+Square）✅

## opencode skills 机制要点（已确认）
- 全局：`~/.config/opencode/skills/<name>/SKILL.md`
- 项目：`.opencode/skills/<name>/SKILL.md`；也兼容 `.claude/skills/` `.agents/skills/`
- 必须 YAML frontmatter：name（小写连字符 ^[a-z0-9]+(-[a-z0-9]+)*$）、description（1-1024 字符）
- 配置加载一次，改配置需重启 opencode
- 权限控制：opencode.json `permission.skill` 可 allow/deny/ask

## 多工具覆盖现状
| 工具 | skill 位置 | 状态 |
|---|---|---|
| Codex | ~/.codex/skills/doubao-vision/ | ✅ |
| opencode | ~/.config/opencode/skills/doubao-vision/ | ✅ 新 |
| Claude Code | ~/.claude/skills/（若需） | 未配置（可用同一脚本） |
| Qoder | ~/.qoder/skills/（若需） | 未配置 |

---

# 追加（2026-08-07 第二十七轮）：豆包视觉 skill 模型降级链（不固定单一模型）

## 用户要求（2026-08-07）
不能固定一个模型——账号里多个视觉模型各有免费额度；超时/失败自动切下一个，
避免误导其他 AI 认为豆包不可用。

## 实测（关键发现）
系统实测 15 个候选 VLM 模型，**可用 8 个**（此前以为只有 2 个）：
- ✅ doubao-seed-2-1-pro-260628（主力，6s）
- ✅ doubao-seed-2-0-pro-260215（6s）
- ✅ doubao-seed-2-0-lite-260215 / doubao-seed-2-0-lite-260428（7-9s）
- ✅ doubao-seed-2-0-mini-260215（2.3s 最快）/ doubao-seed-2-0-mini-260428（3.2s）
- ✅ doubao-seed-2-1-turbo-260628（16s）
- ✅ doubao-seed-2-0-code-preview-260215（11s，code 模型也支持视觉）
- ❌ 404 不可用：doubao-seed-1-8/1-6 系列/1-5-vision-pro（models 列表可见但实际不存在）

## 交付（vision.py 降级链）
- MODEL_CHAIN 8 模型按优先级排序（pro → lite → mini → turbo → code-preview）
- 每个模型 45s 超时；失败/超时/额度耗尽 → sleep 1s → 切下一个
- 全部失败才报错并列出各模型失败原因（不再误判"豆包不可用"）
- `--model` 仍可指定单一模型（覆盖降级链）
- 两份 SKILL.md（Codex + opencode）已同步降级链说明

## 验证（真实执行）
- 降级链正常：默认主力成功 6.2s ✅
- **降级行为验证**：链首换假模型 → 失败自动切 doubao-seed-2-1-pro 成功 ✅
- opencode 重新调用：自动加载 skill + vision.py 识别成功 ✅

## 经验
- 火山 /models 列表 ≠ 全部可用（很多 404）；必须实测确认
- 模型状态可能变化（2-0-pro 之前 ModelNotOpen，后来可用）→ 降级链比写死模型健壮

---

# 追加（2026-08-07 第二十八轮）：借鉴 TencentDB Agent Memory 升级虫群（v5.1.0）

## 用户要求（2026-08-07）
深入学习腾讯开源团队记忆项目 TencentDB Agent Memory（GitHub 1.3 万+ star），
与我们的方案对比，借鉴参考升级虫群，让该项目成为虫群养分。

## 调研结论（代码级，已 clone 至 /home/as-workstation01/Documents/project/TencentDB-Agent-Memory）

### 腾讯方案核心（MemoryCore 14.8 万行 TS）
1. **L0→L3 分层蒸馏**：L0 原始对话 → L1 Atom（工具调用对 → 高密度摘要 JSON，
   score 0-10 表示可替代性）→ L1.5 任务生命周期判断 → L2 Scenario（Mermaid
   认知状态机，图表化压缩，token 降 61%）→ L3 Persona 长期画像
2. **Skill 资产（v2）**：SKILL.md frontmatter（name/description/version/resources/
   trigger/validation）+ body；appendVersion 版本化事务（hash 幂等 + 资源 copyTree）；
   conversation-add 异步提取队列（extract-worker/trigger-service/message-compressor）
3. **Loadout + ACL**：Fixed Binding + ACL 四级可见性（private/team/restricted/agent）
4. **Wiki + CodeGraph**：文档→结构化页面+链接图谱（Karpathy LLM Wiki 思路）；
   代码→符号/调用关系/影响路径（复用 codegraph 项目）
5. **检索**：BM25 + 向量 + RRF 融合

### 我们已有优势（腾讯缺）
- 共识投票 + 免疫验证（dev.to 评论：腾讯「stores but doesn't adjudicate」）
- origin 不可变溯源、scope 隔离（general/project）
- TOTP 物理用户身份、代码不离开本地（harvest-push）
- 业务画像双视图（数据世界/流程世界）

### 本次借鉴落点（结合用户「追求简单化/增量演进」偏好，选高价值低风险两项）
| 借鉴点 | 腾讯做法 | 我们的实现 |
|---|---|---|
| ① RRF 融合检索 | BM25+向量+RRF | `cerebrate/core/rrf.py` 新增；api.search hybrid 改造 |
| ② Skill 结构化资产 | SKILL.md frontmatter+版本+触发+验证 | `cerebrate/core/skill_format.py` 新增；propose 支持 skill_markdown |

未采纳（遗留建议）：L0-L3 分层（大工程）、Mermaid 场景压缩（需对话采集管道）、
Loadout 装配（我们有 scope 已覆盖大部分）。

## 交付（v5.1.0，5 处版本同步）

### ① RRF 融合检索
- `cerebrate/core/rrf.py`：`reciprocal_rank_fusion(ranked_lists, k=60, limit)` 纯函数
  - 每路按排名 rank 计算 1/(k+rank)；同 memory_id 多路分累加（双路命中天然提升）
  - source 标记：fulltext / vector / hybrid（双路命中）
- `api.search` hybrid 分支：FTS5 + 向量两路召回 → RRF 融合（替代原简单拼接）
  - 原拼接问题：FTS 命中但向量分低会被挤掉；向量命中排末尾
- 测试：`tests/test_rrf.py`（5 用例：双路排前/单路不丢/limit/空输入/k 影响）

### ② Skill 结构化资产
- `cerebrate/core/skill_format.py`：SKILL.md frontmatter 解析 + 校验
  - 解析：`---` 围栏 → name/description/version/category/trigger/validation/resources/body
  - 校验：name 须 `^[a-z0-9][a-z0-9-]*$`（≤64）、description 必填（≤1024）、body ≤50000
  - 非 SKILL.md（无 frontmatter）返回 None → 按普通记忆处理（零破坏）
- `swarm.share` / `_build_metadata` / `manager.share_to_swarm`：新增 skill_fields 透传，
  metadata 落 skill_name/version/category/trigger/validation/resources/body
- `_item_to_dict` / `_to_index_entry` / `_aggregate_chunks`：详情/索引层输出 skill 字段
- `api.propose_memory`：支持 skill_markdown 参数（解析→校验→结构化入库）；
  空 title 自动用技能名；校验失败抛 ValueError
- MCP 工具 cerebrate_propose（mcp_transport.py + mcp.py）：新增 skill_markdown 参数
- 测试：`tests/test_skill_format.py`（8 用例：解析/默认版本/非skill返回None/校验/
  端到端 roundtrip/非法拒绝/普通记忆零影响）

### ③ 顺手修复 2 个既有 bug（自动进化崩溃根因）
- `evolution.py` _distill_and_persist + _distill_doctrines：
  `(m.get("origin_ids") or "").split(",")` → str/list 双类型兼容
  （分块聚合记忆 origin_ids 是 list，之前自动进化必崩）
- `evolution.py` _distill_doctrines：`success` 未定义 → 补 `success_count`
- 测试：`tests/test_evolution_origin_ids.py`（4 用例）

## 验证（真实执行）
1. 全量回归：342 passed（新增 17，无回归）
2. 服务重建：cerebrate:5.1.0 容器 healthy，/v1/sense ok（total 1495，bge）
3. RRF hybrid 检索实测：查询「豆包 视觉 图像识别」→ 双路命中 2 条排前（source=hybrid），
   单路命中随后（vector）✅
4. Skill 结构化 propose 实测：提交 SKILL.md → skill=True；详情层 name=rrf-fusion
   version=1.0 trigger/validation 完整；索引层 skill 摘要可见 ✅

## 版本
- VERSION: cerebrate-mcp-v5.1.0（5 处同步：VERSION/mcp_transport/mcp.py/mcp.js 两处/
  package.json + 镜像 tag cerebrate:5.1.0 + DEPLOY.md）
- 协议 meta.protocol 保持 v5 不变（API 协议版本与产品版本是两个维度）

## 关键文件
- 新增：`cerebrate/core/rrf.py`、`cerebrate/core/skill_format.py`
- 修改：`cerebrate/memory/swarm.py`（skill_fields）、`cerebrate/memory/manager.py`、
  `cerebrate/memory/evolution.py`（2 bug）、`cerebrate/server/api.py`（RRF+skill_markdown）、
  `cerebrate/server/mcp_transport.py`、`cerebrate/mcp.py`
- 测试：`tests/test_rrf.py`、`tests/test_skill_format.py`、`tests/test_evolution_origin_ids.py`

## 遗留/下一步建议
1. （可选）L0→L3 分层蒸馏：需对话采集管道（offload ingest），大工程，评估后再动
2. （可选）Mermaid 场景压缩：腾讯最新卖点（token 降 61%），需短期记忆子系统
3. （可选）Skill 版本化 appendVersion：当前只是版本字段，无版本树；团队多人改技能时再上
4. （可选）Loadout 装配：等团队规模扩大、角色分化明显时再评估

---

# 追加（2026-08-07 第二十九轮）：蒸馏窗口机制（v5.1.1，仅本地 0:00-1:00 低谷期）

## 用户要求（2026-08-07）
蒸馏行为只在每天 0 点-1 点之间启动（API 费用低谷期），其他时间禁止蒸馏省钱。

## 设计（统一窗口机制，config.py in_evolution_window）
- **时区**：本地 Asia/Macau UTC+8（全年无夏令时 → 固定偏移，不依赖系统 TZ）
- **窗口**：默认本地 0:00-1:00（可配置 CEREBRATE_EVOLUTION_WINDOW_START/END_HOUR）
- **逃生门**：force=true（管理员显式）/ evolution_window_enabled=false（测试/运维）跳过窗口
- **覆盖范围**（所有蒸馏触发路径）：
  1. scheduler 自动调度（_evolve_loop）→ 窗口外跳过
  2. evolution.evolve(force=False) → 窗口外 skipped=outside_evolution_window
  3. 按需蒸馏同步（/v1/knowledge/distill → distill_knowledge_on_demand）→ 窗口外拒绝
  4. 按需蒸馏异步（/v1/distill → api.distill）→ 窗口外拒绝入队（status=rejected）
- **force=true**：以上 3/4 路径也支持（payload.force），管理员显式强制时绕过窗口

## 交付文件
- cerebrate/config.py：新增 4 个窗口配置 + in_evolution_window(now=None) 统一判断函数
  （支持跨天窗口如 22:00-02:00；window 关闭恒 True）
- cerebrate/server/scheduler.py：_in_evolution_window 改用统一函数
- cerebrate/memory/evolution.py：evolve() 窗口检查改用统一函数（force=True 保留）
- cerebrate/server/api.py：distill_knowledge_on_demand + distill 入口加窗口拦截
- tests/conftest.py：测试默认 evolution_window_enabled=False（不受当前小时影响）
- tests/test_evolution_window.py：9 用例（纯函数 5 + API 层 4）

## 验证（真实执行，当前本地 12:46 窗口外）
1. 窗口外同步按需蒸馏 → distilled=false + reason=蒸馏窗口未开放 ✅
2. 窗口外异步蒸馏 → status=rejected + reason=拒绝入队 ✅
3. 窗口外 evolve(force=False) → skipped=outside_evolution_window ✅
4. force=true 异步 → status=queued → done（绕过窗口进入实际流程，主题不存在→信息不足）✅
5. 全量回归 351 passed（新增 9，无回归）

## 版本
- VERSION: cerebrate-mcp-v5.1.1（5 处同步：VERSION/mcp_transport/mcp.py/mcp.js 两处/
  package.json + 镜像 tag cerebrate:5.1.1 + DEPLOY.md）
- 协议 meta.protocol 保持 v5 不变

## 经验
- 用户省钱诉求 → 定时任务窗口机制：统一判断函数 + 可配置 + force 逃生门 + 测试默认关窗，
  四者缺一不可（统一判断避免三处逻辑漂移；force 逃生门保管理员/测试；测试关窗防当前时刻影响）

---

# 追加（2026-08-07 第三十轮）：实现三大遗留借鉴点（v5.2.0）

## 用户要求（2026-08-07）
把上轮遗留的三个腾讯借鉴点都安排实现：Mermaid 场景压缩、Skill 版本化、Loadout 装配。

## ① Mermaid 场景压缩（短期记忆子系统）
### 借鉴（腾讯 L2 认知状态机）
腾讯把长任务工具调用记录压缩为 Mermaid flowchart TD 认知状态机（token 降 61%）：
节点 = 阶段名 + status(done/doing/paused/blocked) + 结论摘要 + 时间戳；增量 replace/write。
### 我们的实现
- `cerebrate/memory/scene.py`（新）：SceneStore 文件系统 JSON 存储
  - ingest 追加原始事件（零 LLM 成本，实时可用）；上限 200 条
  - get 返回最近 50 条事件 + Mermaid 图 + 元数据；list/delete 生命周期
  - session_id 严格校验（防路径穿越）
- `cerebrate/brain/llm.py`：generate_scene_mmd（LLM 生成/更新 Mermaid 认知状态机）
- API：`POST /v1/scene/ingest` `GET /v1/scene/{session_id}` `POST /v1/scene/compress`
  `GET /v1/scene/list` `POST /v1/scene/delete`
- compress 受蒸馏窗口约束（0-1 点，force 逃生门）——Mermaid 是 LLM 调用，省钱

## ② Skill 版本化 appendVersion
### 借鉴（腾讯 appendNextVersion 版本树）
技能有版本树（head + 历史），appendVersion 事务：content_hash 幂等、资源 copyTree、owner 校验。
### 我们的实现
- `swarm.append_skill_version`：幂等（content_hash 相同返回 head）、版本号 = 版本数+1
  （v1→v2→v3）、skill_versions 保存完整历史、同步更新 head 结构化字段
- `swarm.skill_versions`：读版本历史
- API：`POST /v1/skills/append-version` `POST /v1/skills/versions`
- 权限：physical_user 必填（规避篡改）

## ③ Loadout 装配
### 借鉴（腾讯 Fixed Binding + ACL）
按身份装配记忆资产（private/team/restricted/agent）。
### 我们的实现（结合已有 scope/用户体系，轻量版）
- `personal.set_loadout/get_loadout`：用户装配（bound_projects/preferred_scope/bound_tags）
- API：`POST /v1/loadout` `GET /v1/loadout?user=`
- 检索自动应用：`_apply_loadout_defaults` 在 search/query 开头调用——
  未显式传参时用装配值（单绑定项目→project_id、preferred_scope→scope、
  bound_tags 并入 tags）；显式传参不覆盖；无用户/无装配行为不变

## MCP 工具（29 → 37，8 个新）
scene_ingest/scene_get/scene_compress/scene_list、skill_append_version/skill_versions、
loadout_set/loadout_get；写工具入 _WRITE_TOOLS（需登录）

## 验证（真实执行，HTTP + MCP 全通过）
1. 场景：ingest→get→list→delete 全链路 ✅；MCP scene_get 200 ✅
2. Skill 版本化：append v1 + 幂等 ✅；versions 列表 ✅
3. Loadout：set + get（带 user query 参数）✅
4. 全量回归 364 passed（新增 13：test_scene 5 / test_skill_versions 4 / test_loadout 4）

## 版本
- VERSION: cerebrate-mcp-v5.2.0（5 处同步 + 镜像 tag cerebrate:5.2.0 + DEPLOY.md）
- 协议 meta.protocol 保持 v5 不变

## 踩坑记录
- GET /v1/scene/list 曾被 startswith("/v1/scene/") 抢先当 session_id → 特判前置修复
- GET 分支无 payload 变量（UnboundLocalError）→ 用 params 传参修复
- Loadout 存 dict 被 remember str() 转单引号 repr → 改存 JSON 字符串

## 关键文件
- 新增：cerebrate/memory/scene.py、tests/test_scene.py、tests/test_skill_versions.py、
  tests/test_loadout.py
- 修改：llm.py（generate_scene_mmd）、swarm.py（版本化）、personal.py（loadout）、
  manager.py（scene/loadout）、api.py（5+2+2 端点 + _apply_loadout_defaults）、
  http.py（路由）、mcp_transport.py（8 工具）

## 遗留/下一步建议
1. Scene 压缩后的短期记忆 → 任务结束时自动蒸馏为长期技能（接 distill 窗口）
2. Skill 版本 diff 展示（当前只存 hash/描述，未存逐版全文）
3. Loadout 检索加权（当前只是默认值注入，未做装配项目/标签加权排序）

---

# 追加（2026-08-07 第三十一轮）：实现三项遗留建议（v5.2.1）

## 用户要求（2026-08-07）
按交接文档的遗留建议自主实施：① Scene 蒸馏为长期技能 ② Skill 版本 diff
③ Loadout 检索加权。用户授权自主判断（"你自己的记忆，你比我们更清楚如何管理"）。

## ① Scene 蒸馏为长期技能（scene_distill）
### 实现
- `llm.distill_scene_to_skill(scene)`：把场景（事件流 + Mermaid 图 + 元数据）
  LLM 蒸馏为 SKILL.md 结构化技能，输出 {title, skill_markdown, problem, solution}
- `api.scene_distill`：窗口检查（0-1 点，force 逃生门）→ 安全溯源优先
  （physical_user 必填，先于 LLM 检查）→ LLM 蒸馏 → 复用 propose_memory 入库
  → cleanup=true 可选删除场景
- API：POST /v1/scene/distill；MCP：cerebrate_scene_distill（写工具需登录）

## ② Skill 版本 diff（skill_diff）
### 实现
- `append_skill_version` 的版本 entry 增加 content 全文快照（≤50KB）
- `api.skill_diff`：difflib.unified_diff 行级对比，缺省对比最近两版；
  返回 added/removed 计数 + diff 行（≤200）；旧版本无快照时提示不抛异常
- API：POST /v1/skills/diff；MCP：cerebrate_skill_diff

## ③ Loadout 检索加权（_apply_loadout_boost）
### 实现
- `api._apply_loadout_boost(items, user)`：装配绑定项目命中 → score+0.15，
  装配绑定标签命中 → score+0.08；稳定排序（同分保持原相对顺序），不丢未命中项
- 接入 search/query：在 _prioritize_own（优先自己的记忆）之后应用
- 无用户/无装配 → 原样返回（零破坏）

## 验证（真实执行 + 全量回归）
1. Skill diff：v2→v3 正确识别 `+第三步：按 1/(k+rank) 融合。`（added=1）✅
2. scene_distill：窗口外正确拦截（reason=蒸馏窗口未开放）✅
3. 全量回归 371 passed（新增 7：test_scene 2 / test_skill_versions 2 / test_loadout 3）

## 版本
- VERSION: cerebrate-mcp-v5.2.1（5 处同步 + 镜像 tag cerebrate:5.2.1 + DEPLOY.md）
- 协议 meta.protocol 保持 v5 不变

## 关键文件
- 修改：llm.py（distill_scene_to_skill）、swarm.py（版本快照 content）、
  api.py（scene_distill/skill_diff/_apply_loadout_boost）、http.py（2 路由）、
  mcp_transport.py（2 工具，29→39 累计）
- 测试：test_scene.py / test_skill_versions.py / test_loadout.py（累计 20 用例）

## 设计决策
- 安全溯源优先于 LLM 调用：scene_distill 先校验 physical_user 再调 LLM（防匿名耗 LLM 费）
- 版本快照存全文而非 hash：技能正文 ≤50KB 可接受，为 diff 提供基础
- Loadout 加权用固定加分（0.15/0.08）而非重算 RRF：简单可预期、稳定排序

## 经验
三个建议都是"补完闭环"：场景有"沉淀出口"、版本有"对比能力"、装配有"排序影响"。
实现原则延续：最小改动、零破坏（旧版本无快照/无装配都优雅降级）、可测试。
