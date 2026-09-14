# dsh-mail-bridge — 邮件 ↔ 会话桥（数字员工）

## 它是什么

把邮箱变成 **DSH 会话的远程输入通道**：每个对话就是一个 AI 分身（session），
邮件自带会话身份；主人或对端回复哪封邮件，就唤醒哪个分身，让它带着自己的上下文
继续干活——而不是把邮件丢给一个什么都不清楚的通用 agent。

主人邮箱是指挥中枢：**数字员工是主人邮箱的延伸**。

## 信任模型（不是白名单）

| 来源 | 地位 |
| --- | --- |
| `owner` 主人邮箱 | 最高权限，来信即指令；无线程时新建分身承接 |
| `allowedSenders` 配置数组 | 显式授权可直接触发 |
| **出站建立信任** | 我们主动发过邮件的对端——自动回读「已发送」登记，其回复即可触发 |
| 陌生地址 | 先规则预筛、再交宿主模型识别：广告忽略，有意义的**摘要上报主人** |

> 为什么信任来自「出站建立」：邮件是我们主动发出去的，对方只是回复；
> 给谁发过邮件，谁就有资格回复——比维护静态白名单更符合真实协作。

## 线程镜像（核心机制）

一次对话的往来始终是**同一串回复**，而不是每轮甩一封新邮件：

```
分身回信 → In-Reply-To: <线程末梢>   References: <累积链>
           Subject: Re: <主题基> [#<会话标签>]
对端回复 → 邮件客户端自动带上 In-Reply-To
          → 主题标签为主、线程头查表兜底 → 定位到同一个分身
```

实测约束（决定了实现方式）：

- QQ 会**重写 Message-ID**，所以发出后必须**回读「已发送」**才能拿到真实 ID；
  该 ID 既用于建立出站信任，也是下一封回信的线程末梢。
- QQ **不支持 plus 子地址**（`user+tag@qq.com` 被 550 拒收），
  因此会话标签只能走主题 `[#xxxxxx]` 与线程头，不能走子地址。

## 工具

| 工具 | 用途 |
| --- | --- |
| `mail_reply(body, attachments?)` | **以回复方式**回信，自动接在同一线程；仅绑定了邮件线程的分身可用 |
| `mail_threads()` | 查看所有邮件线程与 session 的绑定关系 |
| `mail_status()` | IMAP 连接、收件箱/已发送水位、已知线程数、出站信任联系人数 |

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `imapHost` / `imapPort` / `imapSecure` | `imap.qq.com` / `993` / `true` | 收信 |
| `inboxMailbox` / `sentMailbox` | `INBOX` / `Sent Messages` | 收件箱与已发送目录名 |
| `reconnectMs` | `15000` | 断线重连间隔 |
| `pollIntervalMs` | `30000` | 兜底扫描间隔（IDLE 实测延迟约 40 秒，必须留安全网；0=关闭） |
| `fetchLimit` | `20` | 单轮最多处理多少封积压 |
| `smtpHost` / `smtpPort` / `smtpSecure` | `smtp.qq.com` / `465` / `true` | 回信 |
| `sender` / `authCode` / `senderName` | 空 / 空 / `DSH 数字员工` | 发件凭证（仓库示例只写占位符） |
| `owner` | 空 | 主人邮箱：指令来源 + 陌生来信上报去向 |
| `allowedSenders` | `[]` | 显式授权数组 |
| `followerPreset` | 空 | 新建分身挂载的 agent preset（空=用宿主默认模型路由） |
| `followerCwd` | 空 | 新建分身的工作目录（空=宿主进程当前目录） |
| `reportStrangers` | `true` | 陌生来信是否摘要上报主人 |
| `classifyStrangers` | `true` | 是否用宿主模型识别陌生来信 |
| `statePath` | `$DSH_HOME/storages/dsh-mail-bridge/state.json` | 状态文件 |
| `injectGuidance` | `true` | 是否注入邮件桥引导 |

## 收到的邮件如何被处理

| 来信 | 处理 |
| --- | --- |
| 指令/回复命中线程标签或线程头 | 唤醒对应分身（活会话 `followup`，否则 `resume` 续接同一对话） |
| 主人来信且无线程 | **新建分身**，分配会话标签，回信即入同一线程 |
| 授权/出站建立信任的对端，新话题 | 同上，新建分身 |
| 陌生地址 | 规则预筛 → 模型识别 → 广告忽略 / 摘要上报主人 |

## 开发与验证

```bash
node scripts/check-all.mjs        # 门禁：注释 + 类型 + 单测 + 构建 + 产物纯净性
node scripts/check-bundle.mjs     # 单独校验产物未残留运行时外部依赖
```

产物 `lib/index.js` 单文件自包含（imapflow / mailparser / nodemailer 构建期内联），
仅依赖 node 内置模块——部署侧按绝对路径加载该文件即可，无需 node_modules。

## 架构

```
src/
├── index.ts              ← 装配层：收信循环 + 路由 + 唤醒 + 工具 + 引导注入
├── invariant.ts          ← invariant 伴侣（生命周期协议占位）
└── features/             ← 功能砖块（纯能力，禁止 import 装配层）
    ├── trust.ts          ← 信任判定（纯计算）
    ├── thread.ts         ← 会话标签与路由判定（纯计算）
    ├── classify.ts       ← 陌生来信识别（纯计算：规则 + 提示词 + 结果解析）
    ├── mime.ts           ← 报文解析（mailparser 封装，纯解析无网络）
    ├── store.ts          ← 状态持久化（纯状态变换 + 原子写盘）
    ├── mailbox.ts        ← IMAP 连接与拉取（唯一收信网络出口）
    └── outbox.ts         ← 线程回信（唯一发信网络出口）
```

## 已知限制

- 新建的分身会话未挂载到工作区（`workspaceRegistry.attachSession` 未接入），
  因此不会自动出现在侧边栏的某个工作区里。
- 邮件正文超过 20000 字会被截断后才喂给模型；附件目前只把元信息写进提示词，
  不落盘也不转交内容。
