# dsh-mail-bridge 开发守则（AI 必读）

> 邮件↔会话桥的执行宪法。写代码前必读，写完跑完门禁才算完成。

## 铁律（违反即返工）

1. **注释一律简体中文**：文件头、函数说明、行内注释全部中文；英文注释 = P0 缺陷。
   专有名词（IMAP/IDLE/SMTP/MIME/DSH/session/agent 等）可保留英文；中文注释允许
   夹带英文技术词（fetch/UID/socket 等），但注释主体必须是中文。
2. **解释「为什么」**：注释说明意图与约束，不重复代码本身。本插件尤其要把
   **实测踩出来的约束**写进注释（见第 9 条），否则后来者一定会重蹈覆辙。
3. **禁止**：死代码、注释掉的代码、TODO/FIXME 遗留、`any`、`@ts-ignore`、默认导出。
4. **分层铁律**：功能是砖块、业务是组合。
   - `src/features/`（纯能力，禁止 import 装配层）：
     trust（信任判定，纯计算）、thread（会话标签与路由，纯计算）、
     classify（陌生来信识别，纯计算）、mime（报文解析，无网络）、
     store（状态持久化）、mailbox（唯一收信网络出口）、outbox（唯一发信网络出口）。
   - `src/index.ts`（装配层）：唯一引用 features；只做收信循环、路由编排、
     会话唤醒、工具注册、引导注入。
5. **凭证不进源码**：`sender`/`authCode` 在代码里默认空串，真实值只存在于部署侧
   `~/.dsh/profiles/web/cordis.patch.yml`。仓库内示例只写占位符。
6. **依赖单向**：装配层 → 功能层；功能层之间允许互引（mime → 无、thread → 无）。
7. **错误路径中文可操作**：网络失败只降级为结构化信息 + 日志，绝不把 stack 抛给模型。
8. **命名表意**：`routeMessage` 不叫 `route`；`fetchSince` 不叫 `pull`。
9. **产物必须自包含**：imapflow / mailparser / nodemailer 一律放 devDependencies
   由 tsdown 内联，禁止放进 dependencies——部署侧按绝对路径加载单个 `lib/index.js`，
   外部化即加载失败。由 `scripts/check-bundle.mjs` 自动把关。

## 实测约束（改代码前务必先读）

1. **QQ 会重写 Message-ID**：我们自己设的 `<dsh-xxx@qq.com>` 到达时会变成
   `<tencent_...@qq.com>`。因此「发出后立刻记下真实 Message-ID」只能靠
   **回读「已发送」**（`syncOutbound`），线程末梢与出站信任都由它维护。
2. **QQ 不支持 plus 子地址**：`475554053+tag@qq.com` 会被 550 拒收，
   会话标识只能走主题 `[#xxxxxx]` 与 In-Reply-To/References。
3. **In-Reply-To / References 会原样保留**（已实测），所以线程路由可行。
4. **IDLE 推送延迟约 40 秒**，且长连接会静默失效：`pollIntervalMs` 周期兜底扫描
   不是可选优化，是正确性要求，不要删。
5. **不要在 fetch 迭代中途 `break`**：会遗留未消费的下载流，imapflow 从此判定
   「连接忙」，auto-IDLE 不再武装，推送彻底失效。必须用**有界区间**
   `${from}:${to}` 而不是 `${from}:*` + break。
6. **`N:*` 语义**：即使没有新邮件也至少返回最后一封，必须按 `uid > sinceUid` 过滤。
7. **Session 类型未公开历史事件访问器**：引导注入的幂等只能靠进程内
   `WeakSet`（宿主重启后重复注入一次是无害的）。
8. **禁止在插件上下文访问 `ctx.agent`**：Cordis 会抛
   `cannot get property "agent" without inject`——而且收信回调本就没有调用方 agent。
   新建/续接分身的模型路由**只能**取自
   `ctx.get('agentDefaultModel')?.currentSelection()`（官方配方，见 webhook/session.ts）。
9. **失败不立即丢弃**：收信循环只在**成功后**推进水位；失败按
   `MAX_DELIVERY_ATTEMPTS` 重试，超限才放弃并推进，避免瞬时故障丢信或毒邮件阻塞。
10. **调试插件请查 `/tmp/dsh-web.log`**：dsh web 由 dsh-public.sh 以
    `setsid nohup ... > /tmp/dsh-web.log 2>&1` 启动，插件日志**不在 journalctl**。
11. **自动回复必须带 `Auto-Submitted: auto-replied`（RFC 3834）并识别它**：
    否则「分身回信 → 落回本邮箱 → 被当作对端回复 → 再唤醒分身 → 再回信」会形成
    无限自回环（把回信地址设为自身时必然发生）。outbox 发送时置该头，
    index 收到该头即忽略，从协议层阻断环路。

12. **新建分身必须挂到工作区**（`workspaceRegistry.resolveByPath(cwd).attachSession(id)`）：
    否则分身建好了却在侧边栏完全看不见，用户会以为「发邮件没任何反应」，
    而实际上分身正在后台干活——这个坑真实发生过，属可用性问题而非功能问题。

## 完成门禁（每次代码修改后必须全过）

```bash
node scripts/check-all.mjs   # 注释 + 类型 + 测试 + 构建 + 产物纯净性
```

## 真实链路验证（改完收信/路由/回信必须做）

单元测试不连网。改动收信或路由后，必须用真实邮箱跑一遍完整闭环：

```bash
QQ_USER='<发件邮箱>' QQ_CODE='<授权码>' node <端到端验证脚本>
```

判定标准：主人来信（无标签）→ 新建分身；带 `[#标签]` 回复 → **唤醒同一分身**
（新建总数不增加）；`mail_reply` 回信后线程末梢变成回读到的 `tencent_` 真实 ID。

## 架构地图

```
src/
├── index.ts              ← 装配层：收信循环 + 路由 + 唤醒 + 三个工具 + 引导
├── invariant.ts          ← invariant 伴侣
└── features/             ← 功能砖块（纯能力，禁止 import 装配层）
    ├── trust.ts          ← 主人/授权/出站建立/陌生 四档信任
    ├── thread.ts         ← 会话标签、主题基、四类路由判定
    ├── classify.ts       ← 陌生来信：规则预筛 + 提示词 + 结果解析
    ├── mime.ts           ← mailparser 封装（RFC2047/附件/线程头）
    ├── store.ts          ← 线程绑定、Message-ID 索引、UID 水位、联系人
    ├── mailbox.ts        ← IMAP 长连接 + IDLE + 有界拉取
    └── outbox.ts         ← 线程回信（In-Reply-To / References）
```

## 提交规范

`类型(模块): 中文描述`（feat/fix/refactor/docs/test/chore）；一个提交只做一件事。

## arch_check 的两条已知误报（不要为它们改代码）

1. `N1 index.ts: name 建议全大写` —— `export const name` 是 Cordis 插件的**契约导出名**，
   框架按此读取，改成全大写即插件失效。
2. `S1 classify.ts: 功能层出现业务词汇「发票」` —— 命中的是垃圾邮件特征词表，
   它是**识别砖块自身的数据**（通用广告/诈骗特征），不是绑定具体业务。
   删词会直接削弱广告识别能力。