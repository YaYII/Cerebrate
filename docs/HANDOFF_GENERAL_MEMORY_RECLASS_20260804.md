# 通用记忆归类交接文档（2026-08-04）

## 1. 任务背景与需求

用户要求：「通过记忆熟悉当前系统，然后把相关记忆尤其是通用记忆中的记忆进行处理：属于对应项目的放进项目里，真正通用的留在通用里」。

背景：Cerebrate v5.2 已实现 scope 隔离（通用/项目），但**历史记忆全部沉淀在通用分类**（写入时未带 project_id），导致通用记忆查询包含大量项目专属内容，污染跨项目检索。本次任务 = 对 635 条通用记忆做一次全面归类。

## 2. 已完成内容

### 2.1 现状盘点（ChromaDB 权威数据）
- 总记忆 720 条（swarm 集合），更新前：通用 635 / 项目 85（ihm-backend 57、ipim 20、verification-platform 8）
- scope/project_id 只存在 ChromaDB 元数据（`embedding_metadata` 表）；docstore JSON 不存 scope

### 2.2 归类执行
- **移动到项目共 152 条**：
  - ihm-backend 92（DOB/Flowable/Laravel/IHM 业务与栈记忆 37 + DOB 蒸馏知识库 55 块）
  - Cerebrate 51（架构概览/六层模块/MCP/知识蒸馏/SwarmMemory 复用/[自动经验] 架构介绍）
  - ipim 6（IPIM 常见问题/三层分离部署/UAT NAS/正式服 PRO/多前端 UAT/ICCA-UFI）
  - verification-platform 3（核验记录两缺陷/仪表盘不一致/基础设施排查教训）
- **保持通用 483 条**：跨项目可复用技能（MySQL/Nginx/Docker/安全扫描/Vite/Java 规范）、跨项目蒸馏知识库（Docker 容器化部署 KB、工程实战反模式 KB、多系统架构整合 KB）、Chrome 扩展/WordService 等未注册项目记忆、测试类记忆

### 2.3 执行方式（零向量风险）
- 备份：`cerebrate-data/chroma_data.bak_20260804_100103`、`fulltext.sqlite3.bak_20260804_100103`、`knowledge_fulltext.sqlite3.bak_20260804_100103`
- 停服 → 直接 sqlite 更新 `embedding_metadata`（UPDATE project_id 152 条 + UPDATE/INSERT scope 152 条）→ 重启 → POST /v1/fulltext/rebuild（405 条，0 失败）
- **刻意未走 ChromaStore API**：`core/storage.py` 的 `__init__` 有 `except Exception → delete_collection` 清库风险路径，任何 embedding function 不匹配都会清空全部向量；直接 sqlite 元数据更新零 embedding、零清库风险

## 3. 关键决策与理由

| 决策 | 理由 |
|---|---|
| 明确项目绑定 → 项目 | DOB/Flowable/Laravel 属 ihm-backend 技术栈与业务；Cerebrate 架构属 Cerebrate 项目 |
| 可复用技能 → 通用 | Nginx/CDN/MySQL/Docker Swarm 教训是通用技术，放进项目反而降低跨项目复用价值 |
| 跨项目蒸馏 KB（多系统整合等）→ 通用 | 标题虽含 IHM/IPIM/Cerebrate，但内容是三系统综合知识，属通用 |
| 未注册项目（Chrome 扩展、WordService）→ 通用 | 不擅自新建 project_id，避免命名漂移 |
| 直接 sqlite 更新而非 Chroma API | 规避 delete_collection 风险（见 2.3） |

## 4. 遗留问题

1. **Cerebrate project_id 大小写**：本次使用 `Cerebrate`（与仓库名一致）；现有项目 id 均为小写（ihm-backend/ipim/verification-platform）。如统一小写需批量改 51 条。
2. **未注册项目记忆仍留在通用**：Chrome 扩展（Markdown Reader）约 27 条、WordService 1 条，如用户确认应归入某项目可再迁移。
3. **测试/占位记忆**：`_swarm_stats`、`端到端原始记忆测试`、`v5.3 渐进式披露真实测试` 等仍在通用，属垃圾记忆，可考虑清理（本任务未删任何数据）。
4. **备份保留**：三个 `.bak_20260804_100103` 保留作回滚保险，确认无误后可删除。

## 5. 下一步建议

1. 用 `/v1/search` 抽查各项目查询是否符合预期（本次已验证：scope=general 不含项目记忆；项目查询 = 项目 + 通用）
2. 如对个别归类有异议：`/tmp/reclass_map.json` 是本次移动清单（memory_id → project_id），可针对性调整
3. 建议为未注册项目（Chrome 扩展等）确定 project_id 规范后再迁移
4. 定期跑 `/v1/sense` 看 scope 分布健康度

## 6. 关键文件与命令索引

- 分类脚本产物：`/tmp/reclass_map.json`（移动清单）、`/tmp/general_review.txt`（635 条审查清单）、`/tmp/reclass_update.sql`（SQL 更新脚本）
- 验证命令：
  ```bash
  TOKEN=$(grep CEREBRATE_SERVER_TOKEN ~/Documents/project/Cerebrate/.env | cut -d= -f2)
  curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/v1/sense
  curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"query":"Flowable DOB 重指派","project_id":"ihm-backend"}' http://127.0.0.1:8765/v1/search
  ```
- 回滚：若需恢复，停容器 → 用备份目录替换 chroma_data → 重启 → 重建 FTS
