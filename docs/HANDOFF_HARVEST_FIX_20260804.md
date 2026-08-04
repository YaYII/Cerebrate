# 交接：harvest 结构与画像修复（2026-08-04）

> 关联提交：`6eb2aa2` fix(harvest): Java 注释类名误匹配 + 无 dir 回读分支版结构
> 触发场景：DSEDT 核验平台（verification-platform）代码结构推送脑虫时发现两处缺陷

## 1. 背景与需求

把 DSEDT 核验平台（Spring Boot / Java）代码结构推送到脑虫，供其他 AI 通过业务画像导航定位真实代码。过程中发现：

- `navigate` 返回的实体 `code_hint` 错位（MpayController 指向 SignRequired.java）
- MCP `harvest` 不传 dir 回读已推结构失败

## 2. 根因与改动

### 2.1 code_hint 错位（cerebrate/tools/code_harvest.py + project_profile.py）

**根因**：`_harvest_java` 用正则匹配 `class|interface|enum|record`，会把**注释/Javadoc 中提到的类名**误识别为当前文件类。例：`annotation/SignRequired.java` 注释里提到 MpayController，导致该文件 classes 混入 `['MpayController','SignRequired']`；`_harvest_domains` 只按模块内去重，第一个（字母序更早的 annotation 目录）实体 code_hint 指向注释文件。

**改动**：
- 新增 `_strip_java_comments()`：解析前剥离 `//` 行注释与 `/* */` 块注释（字符串字面量保留）
- `_harvest_java` 解析前应用注释剥离
- `_harvest_domains` 实体去重从「模块内」升级为「跨模块全局」（`seen_entities`）

### 2.2 无 dir 回读失败（cerebrate/server/api.py project_harvest）

**根因**：harvest_push 存分支版 `harvest/{project_id}/{branch}.json`（如 master.json），而 `load_harvest(project_id)` 无分支时只查旧路径 `harvest/{project_id}.json`，读不到。

**改动**：无 dir 时按 `default_branch` + `branches` 候选逐个尝试 `load_harvest(project_id, branch=...)`，命中即返回。

## 3. 验证证据

- 本地 `_harvest_java` 实测：`SignRequired.java` classes 由 `['MpayController','SignRequired']` → `['SignRequired']`
- 重新 harvest + push（215 文件 / 215 模块 / 68 端点，changed=true），promote 画像 v3 confirmed
- `navigate(project=verification-platform, target="Mpay")` → `/backend/mpaycontroller`，code_hint=`backend/src/main/java/com/dsedt/verification/controller/MpayController.java`（正确）
- 无 dir 回读：`POST /v1/project/harvest {"project":"verification-platform"}` → found:true, branch:master
- 服务在线：容器 healthy，`/v1/sense` healthy

## 4. 遗留问题

1. **Java data_models 提取为 0**：`_harvest_java` 未识别 `@Entity`/`@Table` 注解类，画像实体字段主要靠 LLM 补。可选增强（正则检测类声明前的持久化注解）。
2. **meta.default_branch 历史值为 "default"**：回读已兼容（候选分支遍历），但建议后续在 harvest_push 时把 `default_branch` 修正为真实分支（master）。
3. MCP 工具 `cerebrate_project_harvest` 的「不传 dir 读取」描述现在服务端已支持，但 MCP 客户端调用方式未单独验证（本次用 HTTP 直接验证）。

## 5. 关键文件与命令

- `cerebrate/tools/code_harvest.py`：`_strip_java_comments` / `_harvest_java` / `harvest_project`
- `cerebrate/tools/project_profile.py`：`_harvest_domains` / `build_draft`
- `cerebrate/server/api.py`：`project_harvest` / `harvest_push`
- 推送结构：`POST /v1/harvest/push`（本地 harvest_project → push，代码不离开本地）
- 画像管理：`POST /v1/project/profile` action=read/draft/read_draft/promote/save
- 重启服务：`docker restart cerebrate`（bind mount 热挂载，改 .py 后重启生效）
