# dsh-email 开发守则（AI 必读）

> 邮件发送插件的执行宪法。写代码前必读，写完跑完门禁才算完成。

## 铁律（违反即返工）

1. **注释一律简体中文**：文件头、函数说明、行内注释全部中文；英文注释 = P0 缺陷。
   专有名词（SMTP/QQ 邮箱/nodemailer/DSH/MIME 等）可保留英文；中文注释允许夹带
   英文技术词（sendMail/JSON 等），但注释主体必须是中文。
2. **解释「为什么」**：注释说明意图与约束，不重复代码本身。
3. **禁止**：死代码、注释掉的代码、TODO/FIXME 遗留、`any`（第三方类型泄漏的
   `any` 必须用本地接口收窄，见 smtp.ts 的 `SentInfo`）、`@ts-ignore`、默认导出。
4. **分层铁律**：功能是砖块、业务是组合。
   - `src/features/`（纯能力，禁止 import 装配层）：
     address.ts（地址解析与收件人回退——纯计算）、
     message.ts（主题/正文/抄送/附件组装——纯计算）、
     smtp.ts（SMTP 发送——本插件唯一发起网络与读文件的地方）。
   - `src/index.ts`（装配层）：唯一引用 features；只做工具注册、配置契约、引导注入。
   - 工具 execute 是薄壳：调用 features 能力 + 状态判断 + 错误归一化，不写业务逻辑。
5. **凭证不进源码**：`sender`/`authCode` 在代码里默认空串，真实值只存在于部署侧
   `~/.dsh/profiles/web/cordis.patch.yml`。仓库内的 `cordis.patch.yml` 只写占位符。
6. **依赖单向**：装配层 → 功能层；功能层之间允许互引（message 依赖 address）。
7. **错误路径中文可操作**：任何失败都归一化为 `{ ok: false, error, hint? }`，
   绝不抛异常让模型看到 stack；`describeSmtpError` 是唯一的翻译入口。
8. **命名表意**：`resolveRecipients` 不叫 `getTo`；`compileMail` 不叫 `build`。
9. **产物必须自包含**：nodemailer 放 devDependencies 由 tsdown 内联，禁止放进
   dependencies——否则产物外部化后，部署侧按绝对路径加载单个 `lib/index.js`
   会直接炸。该约束由 `scripts/check-bundle.mjs` 自动把关。

## 完成门禁（每次代码修改后必须全过）

```bash
node scripts/check-all.mjs   # 注释 + 类型 + 测试 + 构建 + 产物纯净性
```

门禁不过 = 任务未完成。先修复，再重新跑门禁，直到全绿。

## 真实发信验证（改完 SMTP 链路必须做）

单元测试不联网。凡改动发送链路，必须跑一次产物级真实验证：

```bash
DSH_EMAIL_LIVE_USER='发件QQ邮箱' DSH_EMAIL_LIVE_CODE='授权码' \
  node node_modules/vitest/vitest.mjs run tests/live.spec.ts
```

或直接用最小 Cordis 上下文驱动 `lib/index.js` 里的 `email_send`（产物级验证，
覆盖默认收件人与显式收件人两条分支）。判定标准是回执出现 `250 OK: queued as.`。

## 架构地图

```
src/
├── index.ts              ← 装配层：email_send 工具注册 + 配置契约 + 引导注入
├── invariant.ts          ← 包自有的 invariant 伴侣（生命周期协议）
└── features/             ← 功能砖块（纯能力，禁止 import 装配层）
    ├── address.ts        ← 地址解析与收件人回退（纯计算）
    ├── message.ts        ← 邮件内容组装（纯计算）
    └── smtp.ts           ← SMTP 发送（唯一网络 + 唯一读文件）
```

## 提交规范

`类型(模块): 中文描述`（feat/fix/refactor/docs/test/chore）；一个提交只做一件事。
