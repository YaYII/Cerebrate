# dsh-email — 邮件发送插件（QQ 邮箱 SMTP）

## 它解决什么问题

以往每次要发邮件，AI 都要反问用户三件事：**用哪个邮箱发、授权码是什么、发给谁**。
本插件把发件凭证与默认收件人固化进宿主配置，并注册一个开箱即用的 `email_send`
工具；同时向会话注入一条引导，让 AI 一开始就知道「我可以直接发邮件」。

- **凭证内置**：AI 永远不需要向用户索要 QQ 邮箱账号或 SMTP 授权码。
- **默认收件人**：用户没指定收件人时自动发给默认地址。
- **用户给了新地址就用新地址**：把新地址传进 `to` 参数即可，支持一次多个。

## 能力

| 能力 | 说明 |
| --- | --- |
| 工具 `email_send` | 通过 QQ 邮箱 SMTP 发送邮件（主题 + 正文 + 可选 HTML/抄送/附件） |
| 收件人回退 | `to` 省略或为空 → 使用配置的默认收件人；传入则以传入为准 |
| 多收件人 | `to` / `cc` 支持英文逗号、中文逗号、分号、空白混用，按小写去重 |
| 富文本 | 只给 `html` 时自动生成纯文本分支（multipart/alternative）提升送达率 |
| 附件 | 传本地文件绝对路径数组，最多 10 个，单文件默认上限 25 MB |
| 引导注入 | 首个 step 注入一条插件来源说明，AI 无需被提醒即知道该能力 |

## 装配

把下面这段合并进 dsh 部署的 patch 文件（本机为
`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-email
      name: '/home/as-workstation01/Documents/project/Cerebrate/dsh-plugins/dsh-email/lib/index.js'
      config:
        smtpHost: 'smtp.qq.com'
        smtpPort: 465
        smtpSecure: true
        sender: '475554053@qq.com'
        authCode: '<QQ 邮箱 SMTP 授权码>'
        senderName: 'DSH 邮件助手'
        defaultRecipient: 'yangying19911113@163.com'
        timeoutMs: 20000
        maxAttachmentBytes: 26214400
        injectGuidance: true
```

生效方式：本机实测编辑该 patch 后宿主会热加载插件行——工具与引导立即在
当前会话可用，无需重启 dsh 服务；若宿主环境未开启热加载，则重启后生效。

## 配置项

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `smtpHost` | `smtp.qq.com` | SMTP 服务器主机 |
| `smtpPort` | `465` | SMTP 端口（SSL） |
| `smtpSecure` | `true` | 是否使用隐式 SSL |
| `sender` | 空 | 发件邮箱账号 |
| `authCode` | 空 | QQ 邮箱 SMTP 授权码（非登录密码） |
| `senderName` | `DSH 邮件助手` | 发件人显示名 |
| `defaultRecipient` | 空 | 默认收件人；为空时引导会要求 AI 先问清收件人 |
| `timeoutMs` | `20000` | 连接/握手/socket 超时 |
| `maxAttachmentBytes` | `26214400` | 单附件体积上限（25 MB） |
| `injectGuidance` | `true` | 是否注入发信引导 |

> **授权码获取**：QQ 邮箱 → 设置 → 账号 → 开启 SMTP 服务 → 生成授权码。
> 授权码属敏感凭证，只写在部署侧 patch 与 `AGENTS.md` 之外的本地文件里，
> 仓库内的 `cordis.patch.yml` 只提供占位符。

## 工具参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `to` | 否 | 收件人，多个用英文逗号分隔；省略则用默认收件人 |
| `subject` | 是 | 邮件主题 |
| `body` | 否 | 纯文本正文；与 `html` 至少提供一个 |
| `html` | 否 | HTML 正文 |
| `cc` | 否 | 抄送地址 |
| `attachments` | 否 | 本地文件绝对路径数组（最多 10 个） |

成功返回投递回执：

```json
{
  "ok": true,
  "recipient": ["yangying19911113@163.com"],
  "recipientSource": "default",
  "messageId": "<...@qq.com>",
  "accepted": ["yangying19911113@163.com"],
  "rejected": [],
  "response": "250 OK: queued as."
}
```

失败返回中文可操作信息，**绝不抛异常**：

```json
{
  "ok": false,
  "error": "QQ 邮箱认证失败：授权码被拒绝，服务器响应：535 Login Fail",
  "hint": "登录 QQ 邮箱 → 设置 → 账号 → 开启 SMTP 服务后重新生成授权码，更新插件配置的 authCode 字段"
}
```

## 开发与验证

```bash
node scripts/check-all.mjs        # 门禁：注释 + 类型 + 测试 + 构建 + 产物纯净性
node scripts/check-bundle.mjs     # 单独校验产物未残留运行时外部依赖
```

真实发信（默认跳过，凭证只走环境变量）：

```bash
DSH_EMAIL_LIVE=1 DSH_EMAIL_LIVE_USER='475554053@qq.com' \
DSH_EMAIL_LIVE_CODE='<授权码>' DSH_EMAIL_LIVE_TO='收件人@example.com' \
  node node_modules/vitest/vitest.mjs run tests/live.spec.ts
```

## 架构

```
src/
├── index.ts              ← 装配层：email_send 工具注册 + 配置契约 + 引导注入
├── invariant.ts          ← 包自有的 invariant 伴侣（生命周期协议）
└── features/             ← 功能砖块（纯能力，禁止 import 装配层）
    ├── address.ts        ← 地址解析与收件人回退（纯计算，可毫秒级单测）
    ├── message.ts        ← 主题/正文/抄送/附件组装（纯计算）
    └── smtp.ts           ← SMTP 发送（唯一发起网络、唯一读本地文件）
```

产物 `lib/index.js` 单文件自包含（nodemailer 在构建期被内联），仅依赖 node
内置模块，部署侧无需为该插件准备 `node_modules`。
