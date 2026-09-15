/**
 * 摄取内核回归测试 —— 语料全部取自 2026-09-14 DSEDT 项目真实测试运行的 system-out。
 *
 * 本文件干什么：固化「格式锁定会静默失效」这一实证，并锁住新内核的四条不可退让行为：
 * ① 格式声明化后可命中真实日志；② 续行不拉低解析率；③ 解析失效必须显式失败；
 * ④ 每条事实必须带可回跳的证据行号。
 * 本文件不干什么：不访问网络、不读被观测项目（语料内联，保证可复现）。
 *
 * 运行：node --import tsx --test tests/*.spec.ts
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { ingestLogText, NO_CASE } from '../src/features/ingest'
import { compileLogFormat, parseLogLine } from '../src/features/logFormat'
import { DSEDT_PACK } from '../src/packs/dsedtJavaLogback'

/** 真实测试态日志样本（原样抄自 system-out，未做改写）。 */
const REAL_TEST_LINES = [
  '14:48:34.653 [Test worker] WARN com.dsedt.verification.service.business.impl.VerificationServiceImpl -- 待归档登记失败(忽略，依赖 confirm/手工兜底): orderNo=ORD-617b19fb698a4d059617ee56f250046d',
  '14:48:34.654 [Test worker] INFO com.dsedt.verification.service.business.impl.VerificationServiceImpl -- 核验单据已创建: orderNo=ORD-617b19fb698a4d059617ee56f250046d, 商户=M001',
  '14:48:34.655 [Test worker] INFO com.dsedt.verification.service.business.impl.VerificationServiceImpl -- 建单已落库(UNVERIFIED): orderNo=ORD-617b19fb698a4d059617ee56f250046d',
  '14:48:38.378 [Test worker] ERROR com.dsedt.verification.service.functional.impl.HttpClientServiceImpl -- 核验服务[DSEDT_PROD]调用失败',
  'java.lang.RuntimeException: Connection timeout',
  '\tat org.springframework.web.client.RestTemplate.postForObject(RestTemplate.java:418)',
  '\tat com.dsedt.verification.service.functional.impl.HttpClientServiceImpl.httpProxyVerify(HttpClientServiceImpl.java:114)',
].join('\n')

/** 生产态日志样本（按 logback-spring.xml 的 LOG_PATTERN 构造，用于验证第二种运行态）。 */
const REAL_PROD_LINES = [
  '2026-09-11 16:34:41.123 [http-nio-8080-exec-1] [1dba9372-a7e3-47b2-a6e0-23d09e59837c] INFO  c.d.v.filter.TraceFilter - → 请求进入 POST /api/h5/verify 来源IP=10.0.0.1',
  '2026-09-11 16:34:41.150 [http-nio-8080-exec-1] [1dba9372-a7e3-47b2-a6e0-23d09e59837c] INFO  c.d.v.aspect.LoggableAspect - → VerificationServiceImpl.verify | refId=REF001',
  '2026-09-11 16:34:41.205 [http-nio-8080-exec-1] [1dba9372-a7e3-47b2-a6e0-23d09e59837c] INFO  c.d.v.aspect.LoggableAspect - ← VerificationServiceImpl.verify | 55ms | result=SUCCESS',
  '2026-09-11 16:34:41.208 [http-nio-8080-exec-1] [1dba9372-a7e3-47b2-a6e0-23d09e59837c] INFO  c.d.v.filter.TraceFilter - ← 请求结束 POST /api/h5/verify 状态=200 耗时=85ms',
].join('\n')

describe('格式声明化：根治格式锁定', () => {
  it('真实测试态日志可被声明式解析（179/390 行同源的格式）', () => {
    const format = compileLogFormat('t', '%d{HH:mm:ss.SSS} [%thread] %-5level %logger{36} -- %msg%n')
    const parsed = parseLogLine(REAL_TEST_LINES.split('\n')[0], format, 1)
    assert.notEqual(parsed, null)
    assert.equal(parsed?.level, 'WARN')
    assert.equal(parsed?.thread, 'Test worker')
    assert.ok(parsed?.message.startsWith('待归档登记失败'))
  })

  it('【反证】被观测项目原有硬编码正则对真实测试态日志 0 命中', () => {
    // 该正则逐字抄自 TraceLogParser.LINE（原实现把格式硬编码在此）
    const legacy = new RegExp(
      '^(\\d{4}-\\d{2}-\\d{2}) (\\d{2}:\\d{2}:\\d{2}\\.\\d{3}) \\[[^\\]]*\\] \\[([^\\]]*)\\] (\\w+)\\s+(\\S+) - (.*)$',
    )
    const hits = REAL_TEST_LINES.split('\n').filter((line) => legacy.test(line))
    assert.equal(hits.length, 0, '原实现应在测试态语料上零命中——这正是格式锁定的实证')
  })

  it('同一份声明同时支持两种运行态（生产态亦可命中并抽出 traceId）', () => {
    const result = ingestLogText(REAL_PROD_LINES, { source: 'prod', pack: DSEDT_PACK })
    assert.equal(result.formatUsed, 'dsedt-prod')
    assert.equal(result.coverage.recordLines, 4)
    assert.equal(result.coverage.orphanLines, 0)
    assert.equal(result.verdict, 'ok')
    assert.equal(result.caseCount, 1)
    assert.equal(result.cases[0].caseId, '1dba9372-a7e3-47b2-a6e0-23d09e59837c')
  })

  it('缺少消息体转换词的声明必须抛错，而不是静默产出空事实', () => {
    assert.throws(() => compileLogFormat('bad', '%d{HH:mm:ss.SSS} [%thread]'), /缺少消息体转换词/)
  })
})

describe('覆盖度：让 AI 知道自己没看到什么', () => {
  it('续行/堆栈不计入分母，不拉低解析率（防止告警疲劳）', () => {
    const result = ingestLogText(REAL_TEST_LINES, { source: 'test', pack: DSEDT_PACK })
    assert.equal(result.formatUsed, 'dsedt-test')
    assert.equal(result.coverage.recordLines, 4)
    assert.equal(result.coverage.continuationLines, 3)
    assert.equal(result.coverage.orphanLines, 0)
    assert.equal(result.coverage.ratio, 1)
    assert.equal(result.verdict, 'ok')
  })

  it('完全无法解析时必须显式失败并给出「不可作为依据」告警', () => {
    const result = ingestLogText('这不是日志\n随便两行文本\n', { source: 'garbage', pack: DSEDT_PACK })
    assert.equal(result.eventCount, 0)
    assert.equal(result.verdict, 'failed')
    assert.ok(result.warnings.some((item) => item.includes('不可作为')))
  })

  it('缺少链路标识时告警说明原因，而不是默默归入单一案例', () => {
    const result = ingestLogText(REAL_TEST_LINES, { source: 'test', pack: DSEDT_PACK })
    assert.equal(result.cases[0].caseId, NO_CASE)
    assert.ok(result.warnings.some((item) => item.includes('缺少链路标识')))
  })
})

describe('证据绑定：每条事实必须可回跳', () => {
  it('事件带真实行号与原文片段，且 ID 与文案无关', () => {
    const result = ingestLogText(REAL_TEST_LINES, { source: 'test', pack: DSEDT_PACK })
    const first = result.events[0]
    assert.equal(first.evidence.line, 1)
    assert.equal(first.id, 'test#1')
    assert.ok(first.evidence.snippet.includes('待归档登记失败'))
    const hit = result.events.find((event) => event.label.includes('核验单据已创建'))
    assert.equal(hit?.evidence.line, 2)
  })

  it('错误级别日志的失败标记为 false，未判定者为 null（未知不等于成功）', () => {
    const result = ingestLogText(REAL_TEST_LINES, { source: 'test', pack: DSEDT_PACK })
    const error = result.events.find((event) => event.level === 'ERROR')
    assert.equal(error?.ok, false)
    const info = result.events.find((event) => event.level === 'INFO')
    assert.equal(info?.ok, null)
  })
})
