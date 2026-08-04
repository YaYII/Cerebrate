# Cerebrate 功能时序图（Sequence Diagrams）

> 生成日期：2026-08-04
> 数据来源：脑虫业务画像 flows（cerebrate 项目，version 3 confirmed，harvest-push 真实代码结构）
> 渲染：Markdown 支持 mermaid 即可可视化（GitHub / VS Code Markdown Preview 均支持）

## 0. 项目地图（宏观总览）

```mermaid
graph LR
    subgraph 数据世界
        A[代码养料收割 code-harvest] --> B[代码同步 code-sync]
        B --> C[业务画像 business-profile]
        B --> D[多人协作感知 collaboration]
    end
    subgraph 记忆世界
        E[虫群记忆 swarm-memory]
        F[浏览器扩展 browser-extension] --> E
    end
    G[cerebrate 服务端核心模块 27 实体] --> E
    H[clients 客户端] --> G
    I[tools 工具] --> G
```

---

## 1. 代码收割与验证定期化流程

```mermaid
sequenceDiagram
    autonumber
    participant HE as Harvest Engine
    participant VE as Verify Engine
    participant AI as AI Workflow
    participant REPO as 本地代码仓库

    Note over HE,REPO: 触发：定时到达或手动指令
    HE->>REPO: 扫描本地代码仓库（多语言增量收割代码结构）
    REPO-->>HE: 收割数据
    HE->>VE: 提交收割结果
    Note over VE: 触发条件：收割完成
    VE->>VE: 边界测试与定期校验
    VE-->>AI: 验证报告
    Note over AI: 条件：验证发现可优化项
    AI->>AI: 生成 draft/fix hints
    AI-->>AI: 注入 AI 工作流
```

## 2. 代码同步与画像联动流程

```mermaid
sequenceDiagram
    autonumber
    participant SS as Sync Service
    participant PG as Profile Generator
    participant CC as Consistency Checker
    participant SERVER as 脑虫服务器代码仓

    Note over SS,SERVER: 触发：harvest status=success
    SS->>SERVER: 增量同步收割数据
    SERVER-->>SS: 同步完成信号
    SS->>PG: 触发画像更新
    PG->>PG: 生成数据世界+流程世界画像
    PG-->>CC: 新版本业务画像
    CC->>CC: 校验画像与代码实际一致性
    CC-->>PG: 一致性报告
```

## 3. 多人协作冲突感知流程

```mermaid
sequenceDiagram
    autonumber
    participant DEV as Developer
    participant CD as Conflict Detector
    participant DB as 声明存储

    Note over DEV,CD: 触发：开发者提交工作声明
    DEV->>DB: 提交工作声明（范围+分支）
    DB-->>DEV: 已保存的工作声明
    CD->>DB: 检索其他声明 + 分支差异
    Note over CD: 条件：声明保存后
    CD->>CD: 冲突检测与分支差异分析
    CD-->>DEV: 冲突报告
    Note over DEV: 条件：存在冲突
    DEV->>DEV: 调整计划 / 解决冲突
```

## 4. 语义记忆检索与噪音规避流程（浏览器扩展）

```mermaid
sequenceDiagram
    autonumber
    participant UI as Content Script
    participant SM as SwarmMemory
    participant NF as Noise Filter

    Note over UI: 触发：用户点击图标或页面操作
    UI->>SM: 语义查询请求
    SM->>SM: 执行语义检索
    SM-->>NF: 原始记忆结果
    Note over NF: 条件：相似度低于阈值
    NF->>NF: 过滤低质量结果
    NF-->>UI: 高相关记忆卡
    UI->>UI: 渲染架构信息辅助导航
```

## 5. 业务画像导航流程

```mermaid
sequenceDiagram
    autonumber
    participant U as UI
    participant BP as Business Profile

    Note over U,BP: 触发：用户打开项目导航页面
    U->>BP: 请求业务画像数据
    BP-->>U: 数据世界实体 + 流程世界步骤
    U->>U: 渲染导航视图（架构与流程）
```

## 6. 记忆核心崩溃处理流程（运维/调试）

```mermaid
sequenceDiagram
    autonumber
    participant MC as Memory Core
    participant DBG as Debugger

    Note over MC: 触发：特定查询输入组合
    MC->>MC: 语义检索触发确定性崩溃
    MC-->>DBG: 崩溃日志与堆栈
    DBG->>DBG: 定位原因并修复
    DBG-->>MC: 修复补丁
```
