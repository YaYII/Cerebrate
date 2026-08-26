#!/usr/bin/env node
/**
 * Obsidian → 脑虫 团队知识库同步桥（plugin-only，无 MCP）。
 *
 * 把 Obsidian vault 中的 Markdown 笔记按 frontmatter 语义沉淀进 Brain
 * 团队权威知识库：普通知识用 user token 写入，权威文档（frontmatter
 * authoritative: true 或路径位于 /_policy/）用 master token 写入。
 *
 * 用法:
 *   OBSIDIAN_API_KEY=xxx CEREBRATE_MASTER_TOKEN=xxx \
 *     node scripts/sync-vault-to-brain.mjs --root "团队知识库" --dry-run
 *
 * 选项:
 *   --root <path>       vault 内要同步的目录（默认 "团队知识库"）
 *   --dry-run           只列出将同步的笔记，不写入
 *   --limit <n>         最多同步 n 篇（默认全量）
 */
import https from 'node:https'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function log(...args) {
  if (args.length > 1 && typeof args[0] === 'string' && args[0].includes('%')) {
    const [fmt, ...rest] = args
    console.log('[sync] ' + fmt.replace(/%[sdj]/g, () => rest.shift()))
    return
  }
  console.log('[sync]', ...args)
}

/** Obsidian Local REST 请求（自签证书）。 */
function obsidian(method, path, opts = {}) {
  const base = process.env.OBSIDIAN_BASE_URL || 'https://127.0.0.1:27124'
  const key = process.env.OBSIDIAN_API_KEY
  return new Promise((resolve, reject) => {
    const url = new URL(base + path)
    // 直接传 url.pathname 避免二次编码：URL 对象再次序列化时会把已编码的
    // %XX 转成 %25XX；而 pathname 保留原始编码（含中文笔记名）。
    const req = https.request({
      hostname: url.hostname, port: url.port || undefined,
      protocol: url.protocol, path: url.pathname + url.search,
      method, rejectUnauthorized: false,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...opts.headers },
    }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: d }))
    })
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

/** Brain Server 请求。 */
async function brain(method, path, body) {
  const base = process.env.CEREBRATE_BRAIN_URL || 'http://127.0.0.1:8765'
  const token = method === 'POST' && path === '/v1/knowledge'
    ? (process.env.CEREBRATE_MASTER_TOKEN ?? '')
    : (process.env.CEREBRATE_USER_TOKEN ?? '')
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

/** 递归列出 vault 目录下的 .md 文件。 */
async function listNotes(root) {
  const dirs = [root]
  const notes = []
  while (dirs.length > 0) {
    const dir = dirs.shift()
    const p = '/vault/' + (dir === '' ? '' : dir.split('/').map(encodeURIComponent).join('/') + '/')
    const res = await obsidian('GET', p)
    if (res.status >= 300) continue
    let files = []
    try { files = JSON.parse(res.text).files ?? [] } catch { continue }
    for (const f of files) {
      const full = dir ? dir + '/' + f : f
      if (f.endsWith('/')) dirs.push(full)
      else if (f.endsWith('.md')) notes.push(full)
    }
  }
  return notes
}

/** 读取笔记并解析 frontmatter。 */
async function readNote(path) {
  const p = '/vault/' + path.split('/').map(encodeURIComponent).join('/')
  const res = await obsidian('GET', p)
  if (res.status >= 300) return null
  const text = res.text
  // 解析 YAML frontmatter（极简：--- 开头块逐行 key: value）
  const fm = {}
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4)
    if (end > 0) {
      const block = text.slice(4, end)
      for (const line of block.split('\n')) {
        const m = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line.trim())
        if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  }
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '')
  return { path, fm, body, title: fm.title ?? path.split('/').pop().replace(/\.md$/, '') }
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (name, dft) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : dft
  }
  const root = opt('--root', '团队知识库')
  const dryRun = args.includes('--dry-run')
  const limit = Number(opt('--limit', '0') || '0')

  log('列出 vault 笔记（root=%s）…', root)
  const notes = await listNotes(root)
  log('找到 %d 篇 .md 笔记', notes.length)

  let synced = 0, skipped = 0
  for (const path of notes.slice(0, limit || undefined)) {
    const note = await readNote(path)
    if (!note) { skipped++; continue }
    const authoritative = note.fm.authoritative === 'true' || path.includes('/_policy/')
    if (dryRun) {
      log('  [dry] %s  authoritative=%s  topics=%s', path, authoritative, note.fm.tags ?? '')
      continue
    }
    const res = await brain('POST', '/v1/knowledge', {
      title: note.title,
      content: note.body.trim(),
      topics: (note.fm.tags ?? '').split(',').map(s => s.trim()).filter(Boolean),
      scope: note.fm.scope ?? (note.fm.project ? 'project' : 'general'),
      project_id: note.fm.project ?? '',
      is_policy: authoritative,
      author: note.fm.author ?? 'obsidian-sync',
      source: 'obsidian:' + path,
    })
    if (res.status < 300) { synced++; log('  ✓ %s -> %s', path, res.data?.data?.doc_id ?? 'ok') }
    else { skipped++; log('  ✗ %s -> HTTP %s %s', path, res.status, JSON.stringify(res.data)) }
  }
  log('完成: 同步 %d 篇, 跳过/失败 %d 篇', synced, skipped)
}

main().catch((e) => { console.error('[sync] 失败:', e.message); process.exit(1) })
