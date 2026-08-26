# dsh-code-architecture 开发守则（AI 必读）

> 项目宪法 CODE_STANDARDS.md 的执行入口。写代码前必读，写完后跑完门禁才算完成。

## 铁律
1. 注释一律简体中文（英文 = P0 缺陷）。
2. 注释解释「为什么」。禁死代码/TODO/any/@ts-ignore/默认导出。
3. 功能是砖块、业务是组合：功能层原子可复用、不绑业务；业务层只编排。
4. 功能层禁止 import 业务层；功能层禁止业务专属词汇。
5. 契约与实现分离、依赖单向、命名表意。

## 完成门禁
```bash
pnpm check   # 注释语言 + tsc + vitest + tsdown，全过才算完成
```
