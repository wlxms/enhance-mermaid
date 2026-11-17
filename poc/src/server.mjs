/**
 * server.mjs —— ehm 的真实后端（长命进程）
 *
 * 职责（且仅这些）：
 *   ① 接收 `POST /api/render`：解析 UML 文本 + 按 roots 取代码 → 物化 IR → 生成 H5
 *   ② 按 `(scope, title)` 存快照；同 key 再请求 = 覆盖，URL 不变
 *   ③ 静态吐快照：`GET /e/<id>`（H5）、`GET /e/<id>.json`（结构化数据）
 *   ④ `POST /jump/<id>`：把页面的点击意图**转发**给该文档记录的 jumpEndpoint
 *
 * 明确不做：不做实时刷新、不留历史版本、不探测 IDE、不决定"跳到哪"。
 *
 * @module poc/src/server
 */

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseUml } from './parse-uml.mjs'
import { materialize } from './materialize.mjs'
import { toIr } from './to-ir.mjs'
import { buildHtml, byteSize } from './html.mjs'

/**
 * 版本唯一事实来源：仓库根 package.json（与 `ehm --version` 同源）。
 * 单独拷贝 poc/ 运行（没有 package.json）时退回内置默认值，不抛错。
 */
export const VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version
  } catch { /* 独立拷贝：用下面的默认值 */ }
  return '0.1.0'
})()

/**
 * 内存快照条数上限（IMPLEMENTATION-PLAN §5.1 冻结：LRU 64 条）。
 * 超出时淘汰最久未访问的快照；磁盘 `~/.ehm/docs/<id>.{json,html}` 不删。
 */
export const SNAPSHOT_LIMIT = 64

/** 状态目录：`~/.ehm`，可用 EHM_HOME 覆盖。 */
export function ehmHome() {
  return process.env.EHM_HOME ?? join(homedir(), '.ehm')
}

export function statePath() {
  return join(ehmHome(), 'server.json')
}

export function docsDir() {
  return join(ehmHome(), 'docs')
}

const IDLE_MS = 30 * 60 * 1000

/**
 * 渲染一份文档（纯函数：文本 + roots → { ir, html, diagnostics }）。
 * 门面、server、测试都调它，保证"只有一条物化路径"。
 *
 * strict=true 时歧义命中升级为 error 诊断（E_AMBIGUOUS），图仍然照出；
 * 退出码由调用方按"是否含 error 诊断"决定。
 */
export function renderDocument({ uml, roots = [], title, theme = 'dark', docId = null, jumpUrl = null, jumpActions = [], strict = false, direction = 'TB', htmlPath = null, sessionId = null, externalEngine = undefined, bakeEngine = false }) {
  if (typeof uml !== 'string' || uml.trim() === '') {
    throw new Error('缺少 uml 文本')
  }
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error('缺少 roots（至少一个 --root）')
  }
  const parsed = parseUml(uml)
  const diagnostics = [...parsed.diagnostics]
  if (parsed.model.entities.length === 0) {
    return { ir: null, html: null, diagnostics }
  }
  const mat = materialize(parsed.model, { roots, strict: strict === true })
  diagnostics.push(...mat.diagnostics)
  const ir = toIr(mat.model, { roots, title: title ?? parsed.model.entities[0]?.name, layoutHint: parsed.layoutHint })
  if (diagnostics.length > 0) ir.diagnostics = diagnostics
  const html = buildHtml(ir, { theme, title, docId, jumpUrl, jumpActions, roots, direction: direction === 'TB' || direction === 'tb' ? 'TB' : 'LR', htmlPath, sessionId, externalEngine, bakeEngine })
  // resolved: Map<相对路径, 绝对路径>，stale 快照据此记录渲染时的 mtime
  return { ir, html, diagnostics, files: mat.files, resolved: mat.resolved }
}

function shortId(scope, title) {
  return createHash('sha1').update(`${scope}\u0000${title}`, 'utf8').digest('hex').slice(0, 12)
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function html(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * 启动服务端。
 * @param {{port?:number, host?:string, quiet?:boolean}} [opts]
 * @returns {Promise<{port:number, url:string, close:()=>Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const port = opts.port ?? 0
  const host = opts.host ?? '127.0.0.1'
  const startedAt = Date.now()

  /**
   * 内存快照（LRU）：Map 的迭代顺序 = 访问顺序（最久未访问在最前）。
   * 每条快照额外记录 generatedAt 与渲染时每个源文件的绝对路径 + mtimeMs，供 /stale 比对。
   * @type {Map<string, {id:string, key:string, scope:string, title:string, html:string, ir:object,
   *   jumpEndpoint:string|null, generatedAt:string, files:Array<{file:string, abs:string, mtimeMs:number|null}>}>}
   */
  const snapshots = new Map()
  let lastHit = Date.now()

  /** 按 id 找快照（不改变顺序）。 */
  const findById = (id) => {
    for (const snap of snapshots.values()) if (snap.id === id) return snap
    return null
  }
  /** 访问即刷新 LRU 顺序：先删再插 → 移到 Map 末尾（最近访问）。 */
  const touch = (snap) => {
    snapshots.delete(snap.key)
    snapshots.set(snap.key, snap)
  }
  /** 内存 LRU：超出上限淘汰最久未访问的；磁盘文件保留。 */
  const evictLru = () => {
    while (snapshots.size > SNAPSHOT_LIMIT) {
      const oldest = snapshots.keys().next().value
      snapshots.delete(oldest)
    }
  }

  const persist = (snap) => {
    const dir = docsDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${snap.id}.json`), JSON.stringify(snap.ir), 'utf8')
    writeFileSync(join(dir, `${snap.id}.html`), snap.html, 'utf8')
  }

  const server = createServer(async (req, res) => {
    lastHit = Date.now()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = decodeURIComponent(url.pathname)

    try {
      // ---- 健康检查 ----
      if (req.method === 'GET' && path === '/healthz') {
        return json(res, 200, { ok: true, name: 'ehm', version: VERSION, docs: snapshots.size, uptimeMs: Date.now() - startedAt })
      }

      // ---- 渲染 ----
      if (req.method === 'POST' && path === '/api/render') {
        const raw = await readBody(req)
        let body
        try { body = JSON.parse(raw) } catch { return json(res, 400, { ok: false, error: 'body 不是合法 JSON' }) }
        const scope = body.scope ?? 'default'
        const title = body.title ?? 'untitled'
        // strict=true：材料化时把歧义命中（W_AMBIGUOUS）升级为 error（E_AMBIGUOUS），图仍然照出
        const strict = body.strict === true
        const id = shortId(scope, title)
        const jumpUrl = `/jump/${id}`
        let rendered
        try {
          rendered = renderDocument({
            uml: body.uml,
            roots: body.roots ?? [],
            title,
            theme: body.theme ?? 'dark',
            docId: id,
            jumpUrl,
            jumpActions: Array.isArray(body.jumpActions) ? body.jumpActions : [],
            strict,
            direction: body.direction ?? 'TB',
            // ehm server 通过 http 提供页面，不能加载 file:// 引擎；服务端一律烘焙。
            bakeEngine: true,
          })
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message })
        }
        if (rendered.ir === null) {
          return json(res, 422, { ok: false, error: 'UML 解析后没有任何实体', diagnostics: rendered.diagnostics })
        }
        // 快照期记录每个 evidence 文件的 mtime：/stale 比对"渲染那一刻"与"现在"
        const sourceFiles = [...(rendered.resolved ?? new Map()).entries()].map(([file, abs]) => {
          let mtimeMs = null
          try { mtimeMs = statSync(abs).mtimeMs } catch { /* 渲染后立刻被删：missing 由 /stale 报 */ }
          return { file, abs, mtimeMs }
        })
        const snap = {
          id,
          key: `${scope}\u0000${title}`,
          scope,
          title,
          html: rendered.html,
          ir: rendered.ir,
          jumpEndpoint: typeof body.jumpEndpoint === 'string' ? body.jumpEndpoint : null,
          generatedAt: rendered.ir.meta?.generatedAt ?? new Date().toISOString(),
          files: sourceFiles,
        }
        snapshots.delete(snap.key) // 同 key 覆盖：先删再插，保证 Map 顺序 = 最近访问
        snapshots.set(snap.key, snap)
        evictLru()
        persist(snap)
        return json(res, 200, {
          ok: true,
          strict,
          id,
          url: `http://${host}:${server.address().port}/e/${id}`,
          dataUrl: `http://${host}:${server.address().port}/e/${id}.json`,
          dataPath: join(docsDir(), `${id}.json`),
          title,
          scope,
          stats: {
            entities: rendered.ir.entities.length,
            relations: rendered.ir.relations.length,
            sites: rendered.ir.relations.reduce((n, r) => n + (r.sites?.length ?? 0), 0),
            htmlBytes: byteSize(rendered.html),
            irBytes: byteSize(rendered.ir),
          },
          diagnostics: rendered.diagnostics,
        })
      }

      // ---- 页面 / 数据 / 过期检查 ----
      const page = /^\/e\/([a-f0-9]{6,32})$/u.exec(path)
      if (req.method === 'GET' && page) {
        const snap = findById(page[1])
        if (!snap) return html(res, 404, '<h1>404</h1><p>该文档已不存在（服务端重启后需重新 render）</p>')
        touch(snap)
        return html(res, 200, snap.html)
      }
      const dataRe = /^\/e\/([a-f0-9]{6,32})\.json$/u.exec(path)
      if (req.method === 'GET' && dataRe) {
        const snap = findById(dataRe[1])
        if (!snap) return json(res, 404, { ok: false, error: 'not found' })
        touch(snap)
        return json(res, 200, snap.ir)
      }
      // 过期可见（IMPLEMENTATION-PLAN §5.1）：对比渲染时记录的 mtime，不推送、不重建
      const staleRe = /^\/e\/([a-f0-9]{6,32})\/stale$/u.exec(path)
      if (req.method === 'GET' && staleRe) {
        const snap = findById(staleRe[1])
        if (!snap) return json(res, 404, { ok: false, error: 'not found' })
        touch(snap)
        let changed = false
        const files = (snap.files ?? []).map((f) => {
          const entry = {
            file: f.file,
            mtime: null,
            snapshotMtime: f.mtimeMs === null ? null : new Date(f.mtimeMs).toISOString(),
          }
          try {
            const now = statSync(f.abs)
            entry.mtime = new Date(now.mtimeMs).toISOString()
            if (f.mtimeMs === null || now.mtimeMs !== f.mtimeMs) changed = true
          } catch {
            entry.missing = true
            changed = true
          }
          return entry
        })
        return json(res, 200, { changed, checkedAt: new Date().toISOString(), files })
      }

      // ---- 跳转转发 ----
      const jumpRe = /^\/jump\/([a-f0-9]{6,32})$/u.exec(path)
      if (req.method === 'POST' && jumpRe) {
        const snap = findById(jumpRe[1])
        if (!snap) return json(res, 404, { ok: false, forwarded: false, error: 'unknown document' })
        touch(snap)
        if (!snap.jumpEndpoint) {
          return json(res, 200, { ok: false, forwarded: false, reason: 'no-jump-endpoint' })
        }
        const raw = await readBody(req, 64 * 1024)
        let intent
        try { intent = JSON.parse(raw) } catch { intent = {} }
        try {
          const upstream = await fetch(snap.jumpEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(intent),
            signal: AbortSignal.timeout(5000),
          })
          return json(res, 200, { ok: true, forwarded: true, status: upstream.status, message: '已交给宿主处理' })
        } catch (e) {
          return json(res, 200, { ok: false, forwarded: true, error: e.message })
        }
      }

      // ---- 关闭 ----
      if (req.method === 'POST' && path === '/api/shutdown') {
        json(res, 200, { ok: true })
        setTimeout(() => shutdown(), 50)
        return
      }

      return json(res, 404, { ok: false, error: `未知路径 ${path}` })
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
    }
  })

  let closing = false
  const shutdown = () => {
    if (closing) return
    closing = true
    // 必须在 server.close() 之前取端口：close 之后 address() 为 null，状态文件会残留成 stale
    const boundPort = server.address()?.port
    try { server.close() } catch { /* ignore */ }
    try {
      const sp = statePath()
      if (existsSync(sp)) {
        const cur = JSON.parse(readFileSync(sp, 'utf8'))
        if (cur.port === boundPort) writeFileSync(sp, JSON.stringify({ stopped: true, at: new Date().toISOString() }), 'utf8')
      }
    } catch { /* ignore */ }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })

  const actualPort = server.address().port
  const baseUrl = `http://${host}:${actualPort}`

  mkdirSync(docsDir(), { recursive: true })
  writeFileSync(statePath(), JSON.stringify({
    port: actualPort,
    host,
    baseUrl,
    pid: process.pid,
    version: VERSION,
    startedAt: new Date(startedAt).toISOString(),
  }, null, 2), 'utf8')

  // 空闲自退（避免孤儿进程）
  const idleTimer = setInterval(() => {
    if (Date.now() - lastHit > IDLE_MS) shutdown()
  }, 60_000)
  idleTimer.unref?.()

  const close = () => new Promise((resolve) => {
    shutdown()
    setTimeout(resolve, 60)
  })

  return { port: actualPort, host, url: baseUrl, close }
}

export default { startServer, renderDocument, statePath, ehmHome, docsDir, VERSION, SNAPSHOT_LIMIT }
