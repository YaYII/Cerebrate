# @deepseek-ai/dsh-code-architecture

代码架构自检插件（注册进 DSH，供 AI 自检）。

## 设计哲学

- **功能是砖块**：功能层（utils/core/shared）原子、可复用、不随业务改变、只增不减。
- **业务是组合**：业务层（services/controllers）只做编排组合，自由重组。
- **AOP 观测**：函数调用链与耗时是 debug 的第一手证据，不靠猜。

## 工具

| 工具 | 说明 |
|---|---|
| `arch_check` | 静态架构自检：注释语言（必须中文）/命名规范/重复功能/功能业务分离/依赖方向，P0/P1 阻塞级 |
| `arch_aop` | AOP 执行观测：注入探针实测函数调用链 + 耗时热点 Top10 + 异常点，定位瓶颈 |
| `arch_guide` | 架构哲学指引（功能砖块/业务组合/AOP 思维） |
| `arch_fingerprint` | 架构指纹 + 漂移检测（文件/分层/依赖方向，防 AI 代码漂移） |
| `qa_metrics` | 质量指标（圈复杂度/注释率/测试存在性，阈值门禁） |
| `qa_mutation` | 变异测试（注入 6 类变异体跑测试，抓纸糊测试，变异分数） |
| `qa_gherkin` | Gherkin/BDD 场景生成（业务行为 Given/When/Then） |
| `qa_report` | 质量聚合报告（信心指数 + 门禁通过/不通过） |

## 使用

```bash
# 自检代码规范
arch_check project=/path/to/project

# 实测业务流转与耗时（定位瓶颈）
arch_aop project=/path/to/project entry=src/index.ts

# 架构哲学
arch_guide
```

## 开发规范

- **CODE_STANDARDS.md** —— 项目宪法（注释中文/架构模式/命名/门禁）
- **AGENTS.md** —— AI 开发守则
- **门禁**：`pnpm check`（注释语言 → 类型 → 测试 → 构建）

## License

MIT
