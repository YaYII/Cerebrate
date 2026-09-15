/**
 * DSEDT（经科局）核验平台接入声明 —— 该系统的日志格式与消息规则，全部以数据形式声明。
 *
 * 本文件干什么：声明被观测系统的两种运行态日志格式，以及把日志消息映射为运行时事件的规则。
 * 本文件不干什么：不含任何解析逻辑（逻辑在 features/），不读写文件。
 *
 * 证据来源（全部来自真实代码与真实产物，不是推测）：
 * - 生产态格式：`backend/src/main/resources/logback-spring.xml` 第 4 行 `LOG_PATTERN`；
 * - 测试态格式：2026-09-14 真实测试运行产物 `build/test-results/test/*.xml` 的 system-out
 *   （实测格式为 `HH:mm:ss.SSS [thread] LEVEL logger -- msg`，**无日期、无 traceId 括号**）；
 * - 消息文案：`LoggableAspect`(第 80/82/98/101/104/112 行)、`TraceFilter`(第 80/92/99 行)、
 *   `StepTracer`(第 174/192/200/213/216 行)、`AuditLogger`(第 27/37 行)。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import type { RulePack } from '../features/rulePack'

/** 类名/方法名占位（容忍简名与全限定名两种写法）。 */
const IDENT = '[\\w.$]+'

/**
 * 分段耗时通用模式：`名称=数字ms`。
 *
 * 真实生产（2026-09-14，797ms 的 confirm-verify 请求）里，多种阶段日志共用这一写法：
 * `抢占+载入=24ms`、`结果缓存=63ms`、`RSA=40ms`、`①查碼(Redis命中)=5ms`。
 * 抽成常量避免每个规则各写一份。
 */
const SEGMENT_SPEC = {
  pattern: '(?<name2>[^\\s=]+)=(?<ms2>[\\d.]+)ms',
  nameGroup: 'name2',
  valueGroup: 'ms2',
  // 「合计」是汇总行不是阶段，混入热点排行会误导优化方向
  ignore: ['合计'],
}

/** DSEDT 接入声明。 */
export const DSEDT_PACK: RulePack = {
  name: 'dsedt-java-logback',
  // 业务对象 = 单据号 orderNo。真实生产里它出现在建单/核验完成/主档收敛/异常等多种行中，
  // 故用包级抽取一次覆盖（逐条规则声明会漏）。抽到它，「一张单据的一生」才成立。
  //
  // 值边界必须同时满足两个相反的要求（均由 2026-09-15 真实流量实证）：
  // ① **不能截断应用自身的脱敏产物** `ORDER=ORD-22bd37…（已脱敏）`——
  //    截断会让掩码对解析器不可见，同一单据被拆成两个业务对象（实测踩过）；
  // ② **不能吞掉结构分隔符**——真实出现的三种污染形态：
  //    `orderNo=ORD-…}`（JSON 对象）、`orderNo=ORD-…&timestamp=1789454478504`（签名原文）、
  //    `orderNo=ORD-…, refId=…`。一旦吞掉，同一个单据号会以多个字符串进入对象集合，
  //    进而**污染掩码消歧的前缀候选集**，使本该唯一匹配的掩码件被判为「歧义」（实测 3 个候选 → 归并失败）。
  // 故字符类 = 「非空白、非列表分隔符、非括号引号、非键值/查询分隔符」。
  objectId: { pattern: 'orderNo=(?<obj>[^\\s,，;；|()（）{}\\[\\]<>"\'&=?]+)', group: 'obj' },
  formats: [
    {
      name: 'dsedt-prod',
      declaration: '%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] [%X{traceId:-        }] %-5level %logger{36} - %msg%n',
    },
    {
      name: 'dsedt-test',
      declaration: '%d{HH:mm:ss.SSS} [%thread] %-5level %logger{36} -- %msg%n',
    },
  ],
  rules: [
    {
      name: 'trace-request-in',
      phase: 'request-in',
      pattern: '^→ 请求进入 (?<method>\\S+) (?<path>\\S+) 来源IP=(?<ip>.*)$',
      label: '请求进入 {method} {path}',
      detail: 'method={method}\npath={path}\n来源IP={ip}',
      stackPush: true,
      actor: 'logger',
    },
    {
      name: 'trace-request-out',
      phase: 'request-out',
      // 真实生产：`← 请求结束 POST /api/h5/entry 状态=200 耗时=314ms`
      pattern: '^← 请求结束 (?<method>\\S+) (?<path>\\S+) 状态=(?<status>\\d+) 耗时=(?<cost>\\d+)ms$',
      label: 'HTTP {status}',
      detail: 'method={method}\npath={path}\n状态={status}',
      durationField: 'cost',
      // 成败是**区间判断**：2xx/3xx 成功，4xx/5xx 失败。
      // 少了它，`状态=500` 与 `状态=200` 都判成「未知」，接口退化在指纹里不可见。
      okField: 'status',
      okPattern: '^[23]\\d{2}$',
      actor: 'logger',
      stackPop: true,
    },
    {
      name: 'trace-response-body',
      phase: 'body',
      pattern: '^← 响应体 \\[(?<ctype>[^\\]]*)\\] (?<body>[\\s\\S]*)$',
      label: '响应体 [{ctype}]',
      detail: '{body}',
      actor: 'logger',
    },
    {
      name: 'trace-request-body',
      phase: 'body',
      pattern: '^(?<method>POST|GET|PUT|DELETE) (?<path>\\S+) 请求体: (?<body>[\\s\\S]*)$',
      label: '请求体 {method} {path}',
      detail: '{body}',
      actor: 'logger',
    },
    {
      name: 'audit-event',
      phase: 'audit',
      pattern: '^\\{"event".*$',
      label: '审计事件',
      actor: 'logger',
    },
    {
      name: 'aspect-exception',
      phase: 'exception',
      pattern: `^✗ (?<cls>${IDENT})\\.(?<method>${IDENT}) \\| (?<cost>\\d+)ms \\| (?<etype>[^:]+): (?<emsg>[\\s\\S]*)$`,
      label: '✗ {cls}.{method}',
      detail: '{etype}: {emsg}',
      durationField: 'cost',
      actor: 'logger',
      stackPop: true,
    },
    {
      name: 'aspect-return-with-result',
      phase: 'return',
      pattern: `^← (?<cls>${IDENT})\\.(?<method>${IDENT}) \\| (?<cost>\\d+)ms \\| result=(?<result>[\\s\\S]*)$`,
      label: '← {cls}.{method}',
      detail: 'result={result}',
      durationField: 'cost',
      actor: 'logger',
      stackPop: true,
    },
    {
      name: 'aspect-return-with-cost',
      phase: 'return',
      pattern: `^← (?<cls>${IDENT})\\.(?<method>${IDENT}) \\| (?<cost>\\d+)ms$`,
      label: '← {cls}.{method}',
      detail: '{cost}ms',
      durationField: 'cost',
      actor: 'logger',
      stackPop: true,
    },
    {
      name: 'aspect-return',
      phase: 'return',
      pattern: `^← (?<cls>${IDENT})\\.(?<method>${IDENT})$`,
      label: '← {cls}.{method}',
      actor: 'logger',
      stackPop: true,
    },
    {
      name: 'step-end',
      phase: 'step-end',
      pattern: '^← (?<name>.+?) (?<mark>✓|✗) \\| (?<cost>\\d+)ms \\| (?<summary>.*)$',
      label: '流程结束 {name} {mark}',
      detail: '{summary}',
      durationField: 'cost',
      actor: 'logger',
    },
    {
      name: 'step-detail',
      phase: 'step',
      pattern: '^\\s*\\[(?<idx>\\d+)\\.(?<no>\\d+)] (?<desc>.+?) (?<mark>→|✗) (?<cost>\\d+)ms(?: \\| (?<detail>.*))?$',
      label: '[{no}] {desc}',
      detail: '{mark} {cost}ms | {detail}',
      durationField: 'cost',
      actor: 'logger',
    },
    {
      // 真实日志：`核验完成: orderNo=…, verified=true, bindResult=SUCCESS, 核验耗时=5ms, 状态持有耗时=7ms`
      // 主耗时取「核验耗时」，另一项进详情（一行只产出一条事件，故取主耗时）
      // ⚠️ 刻意**不设置 label/detail**：改写标签会丢掉 `verified=true` 这类子串，
      //    而意图匹配正是按标签子串进行的——实测导致既有意图全部失配（回归测试当场抓到）。
      //    只捕获耗时、保留原文标签，既拿到耗时又不破坏语义匹配。
      // ⚠️ 相位刻意保持 `log`（而非 step）：改为 step 会让它参与「行为路径」判定，
      //    在多场景日志里产生噪音式「额外路径」误报（实测 8 条）。耗时捕获与相位无关，
      //    因此按最小修改原则只补数据、不动语义。
      name: 'verify-completed-duration',
      phase: 'log',
      pattern: '^核验完成: .*核验耗时=(?<cost>[\\d.]+)ms.*$',
      durationField: 'cost',
      actor: 'logger',
    },
    {
      // 真实日志：`confirm分段(慢): 抢占+载入=1ms 核验(含白名单+码+签名)=6ms 落库(主档+缓冲)=24ms
      //   响应+缓存+审计=2ms 终态发布=0ms 合计=33ms`
      // 分段抽取让「落库=24ms」这类热点**无需改动被观测系统**即可归因
      name: 'confirm-stage-breakdown',
      phase: 'slow',
      pattern: '^confirm分段.*合计=(?<total>\\d+)ms$',
      label: '核验确认-分段耗时',
      detail: '{0}',
      durationField: 'total',
      segments: SEGMENT_SPEC,
      actor: 'logger',
    },
    {
      // 真实生产：`complete分段(慢): 绑定判定=0ms 签名(私钥取用+RSA)=40ms 结果缓存=63ms 合计=103ms path=WHITELIST`
      name: 'complete-stage-breakdown',
      phase: 'slow',
      pattern: '^complete分段.*合计=(?<total>[\\d.]+)ms.*$',
      durationField: 'total',
      segments: SEGMENT_SPEC,
      actor: 'logger',
    },
    {
      // 真实生产：`signForMerchant分段(慢): 取私钥=0ms 解析=0ms RSA=40ms merchant=mpay pemLen=1703`
      // 无「合计」→ 只抽分段，不设总耗时（分段本身即证据）
      name: 'sign-stage-breakdown',
      phase: 'slow',
      pattern: '^signForMerchant分段.*$',
      segments: SEGMENT_SPEC,
      actor: 'logger',
    },
    {
      // 真实生产：`verifyCode逐步: ①查碼(Redis命中)=5ms qr=B8AC022E…`
      name: 'verifycode-stage',
      phase: 'slow',
      pattern: '^verifyCode逐步: .*$',
      segments: SEGMENT_SPEC,
      actor: 'logger',
    },
    {
      // 真实生产：`verifyCode总计: 23ms (①查碼+②快照+③核銷裁決)`
      name: 'verifycode-total',
      phase: 'slow',
      pattern: '^verifyCode总计: (?<total>[\\d.]+)ms.*$',
      durationField: 'total',
      actor: 'logger',
    },
    {
      name: 'aspect-enter-with-args',
      phase: 'call',
      pattern: `^→ (?<cls>${IDENT})\\.(?<method>${IDENT}) \\| (?<args>[\\s\\S]*)$`,
      label: '→ {cls}.{method}',
      detail: '{args}',
      actor: 'logger',
      stackPush: true,
    },
    {
      name: 'step-begin',
      phase: 'step',
      pattern: '^→ (?<name>.+)$',
      label: '流程开始 {name}',
      detail: '{name}',
      actor: 'logger',
    },
    {
      name: 'aspect-enter',
      phase: 'call',
      pattern: `^→ (?<cls>${IDENT})\\.(?<method>${IDENT})$`,
      label: '→ {cls}.{method}',
      actor: 'logger',
      stackPush: true,
    },
  ],
}
