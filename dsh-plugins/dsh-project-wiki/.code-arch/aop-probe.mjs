
/** AOP 探针：包裹入口模块导出，输出调用树与耗时（JSON 到 stdout 末尾）。 */
const records = []
let seq = 0
let depth = 0
const wrap = (ns, prefix) => {
  const out = {}
  for (const [k, v] of Object.entries(ns)) {
    if (typeof v === 'function') {
      out[k] = async (...args) => {
        const start = Date.now()
        depth++
        const mySeq = ++seq
        let threw = false
        try {
          return await v.apply(ns, args)
        } catch (e) {
          threw = true
          throw e
        } finally {
          records.push({ name: prefix + k, seq: mySeq, ms: Date.now() - start, start, threw, depth })
          depth--
        }
      }
    } else {
      out[k] = v
    }
  }
  return out
}
const mod = await import("file:///home/as-workstation01/Documents/project/Cerebrate/dsh-plugins/dsh-project-wiki/src/evolve.ts")
const wrapped = wrap(mod.default ?? mod, '')
// 触发入口：优先 default 函数；否则尝试具名业务入口（processOrder/process/main/run/start/execute）
const ENTRY_NAMES = ['default', 'processOrder', 'process', 'main', 'run', 'start', 'execute', 'handler']
let entryFn = null
for (const n of ENTRY_NAMES) {
  if (typeof wrapped[n] === 'function') { entryFn = wrapped[n]; break }
}
if (entryFn && process.env.AOP_CALL_ENTRY === '1') {
  try { await entryFn() } catch {}
}
process.stdout.write('\n__AOP_RESULT__' + JSON.stringify(records) + '\n')
