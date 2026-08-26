# @deepseek-ai/dsh-code-review

AI 代码审查助手（DSH 原生插件）。AI 写完代码后自动执行**静态规范 / 格式化 / 测试 /
程序级性能基准 / 函数级热点剖析**五类审查，生成 Markdown 诊断报告并执行 **Quality Gate**
判定；未通过时按报告修复 → 重新诊断，直到通过或达到轮次上限。

多语言架构参考 MegaLinter / SonarQube 的设计：每种语言在**工具链注册表**里登记
lint/format/test/profile 命令模板，统一输出归一化为语言无关的结构（SARIF 风格）。

## 六个工具

| 工具 | 用途 | 回答的问题 |
| --- | --- | --- |
| `code_review_lint` | 静态规范 + 类型检查（JS/TS: eslint + tsc；Java/Python/PHP 走注册表） | 代码规范、P0/P1 阻塞问题 |
| `code_review_format` | 格式化检查 / 修复（prettier --check / --write + eslint --fix） | 格式是否合规 |
| `code_review_bench` | 程序级基准：N 次运行 p50/p90/均值 + 内存峰值(RSS) | **程序运行消耗多少性能** |
| `code_review_profile` | 函数级剖析：v8 --cpu-prof / cProfile → 热点函数 Top10 | **性能 bug 在哪** |
| `code_review_test` | 测试执行 + 覆盖率（vitest / pytest / mvn / phpunit） | 测试是否全绿 |
| `code_review_report` | 聚合全部结果 + 上轮基线对比 + Quality Gate + Markdown 报告 | 本轮是否通过 |

## 工具链注册表（按语言）

| 语言 | 探测 | lint | format | test | profile |
| --- | --- | --- | --- | --- | --- |
| JS/TS | package.json | eslint | prettier | vitest | node --cpu-prof |
| Java/Spring | pom.xml / build.gradle | checkstyle | mvn spotless:check | mvn test | JFR（模板预置，解析器待接入） |
| Python | requirements.txt / pyproject.toml | ruff | black | pytest | cProfile |
| PHP | composer.json | phpcs | php-cs-fixer | phpunit | Xdebug（模板预置，解析器待接入） |

新增语言 = 在 `src/languages.ts` 的 `TOOLCHAINS` 加一段配置，报告引擎与循环逻辑零改动。

## 审查闭环（审查 → 修复 → 再诊断）

```
Round N: lint + format + test + bench + profile → report
  → Quality Gate 判定：
      无 P0/P1 遗留 ∧ 格式合规 ∧ 测试全绿（可配覆盖率阈值）
      ∧ 性能回归 < 阈值（默认 +10%）∧ 优雅性分达标（可选）
  → 通过 ✅  → 交付 report-latest.md
  → 未通过 ❌ → AI 按报告修复 P0/P1 与性能热点 → Round N+1
  → 轮次上限（默认 5）→ 交付最终报告与剩余问题
```

产物全部落盘 `<项目>/.code-review/`：

- `report-<N>.md` — 每轮诊断报告（问题清单 / 性能基准 / 热点 / 测试 / gate 明细）
- `report-latest.md` — 最新报告
- `baseline.json` — 性能基线（跨轮对比，回归检测的数据源）
- `state.json` — 轮次状态
- `last-*.json` — 各工具最近一次结果（可断点续跑）

## 挂载

用户 profile 补丁层 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加：

```yaml
# dsh-code-review: AI 代码审查闭环（静态/格式化/测试/性能基准/热点剖析/诊断报告）
- insert:
    - id: code-review
      name: '/home/as-workstation01/Documents/project/Cerebrate/dsh-plugins/dsh-code-review/lib/index.js'
      config:
        artifactsDir: '.code-review'
        injectGuidance: true
```

（本仓库 `cordis.patch.yml` 提供同样的内容。）

## Agent preset（推荐用法）

`code-review` preset 已基于 `standard` 复制并定制（`~/.dsh/.agent-presets/code-review/`）：
完整编码 Agent + 审查工具 + persona 审查闭环指令。挂载插件后，在会话选择器中选
「代码审查模式」即可让 AI 每次写完代码自动走完整审查闭环。

## 开发

```bash
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown → lib/
pnpm test        # vitest run（21 个用例：解析器/基准/报告/gate/真实 cpuprofile fixture/端到端闭环）
```

依赖通过 symlink 指向 deepseek-harness 仓库（同 dsh-obsidian 模式）。

## 设计要点

- **确定性优先**：lint/测试/性能数字全部由确定性工具产出（CodeRabbit vs SonarQube 的分层思想），AI 只负责优雅性评审与修复。
- **输出归一化**：各语言工具输出 → 统一 `Finding[]` / `BenchResult` / `ProfileResult` / `TestResult`，报告引擎语言无关。
- **噪音控制**：bench 首轮标记冷启动并排除；多次取 p50（线性插值）；报告注明运行环境。
- **防失控**：所有子进程有超时（默认 60s）+ 输出截断（64 KiB 头尾保留）。
- **状态可续**：所有中间产物落盘 JSON，任何一轮中断后可从 artifacts 恢复。
