/**
 * facade.mjs —— ehm 门面（短命进程，每次调用一个）
 *
 * 它必须极薄：解析不到 UML、读不了源码、不打包 dagre、不持有任何状态。
 * 只做四件事：
 *   ① 读状态文件找到后端
 *   ② 后端没跑就 detached 拉起
 *   ③ 把渲染请求转发过去
 *   ④ 把结果打印成 JSON / 人类可读
 *
 * @module poc/src/facade
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { statePath, VERSION } from './server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '..', 'bin', 'ehm.mjs')

function readState() {
  const p = statePath()
  if (!existsSync(p)) return null
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'))
    if (!v || v.stopped === true || typeof v.port !== 'number') return null
    return v
  } catch {
    return null
  }
}

async function health(baseUrl, timeoutMs = 800) {
  try {
    const r = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return null
    const body = await r.json()
    return body && body.ok ? body : null
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 找到可用的后端；没有就拉一个起来。
 * @param {{quiet?:boolean, waitMs?:number}} [opts]
 * @returns {Promise<{baseUrl:string, port:number, spawned:boolean}>}
 */
export async function ensureServer(opts = {}) {
  const quiet = opts.quiet === true
  const waitMs = opts.waitMs ?? 8000

  const existing = readState()
  if (existing) {
    const h = await health(existing.baseUrl)
    if (h) return { baseUrl: existing.baseUrl, port: existing.port, spawned: false }
  }

  // 拉起后端：detached + 忽略 stdio，门面退出后它继续活着
  const child = spawn(process.execPath, [BIN, 'serve', '--port', '0'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  })
  child.unref()
  if (!quiet) process.stderr.write(`ehm: 后端未运行，已拉起（pid ${child.pid}）\n`)

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(80)
    const st = readState()
    if (!st) continue
    const h = await health(st.baseUrl)
    if (h) return { baseUrl: st.baseUrl, port: st.port, spawned: true }
  }
  throw new Error(`后端启动超时（${waitMs}ms）。可手动运行 \`ehm serve\` 查看报错。`)
}

/**
 * 通过后端渲染一份文档。
 * strict=true 时后端把歧义命中升级为 error 诊断（结果里仍带 url）。
 * @param {{uml:string, roots:string[], title?:string, scope?:string, jumpEndpoint?:string, theme?:string, quiet?:boolean, strict?:boolean}} doc
 */
export async function renderRemote(doc) {
  const { baseUrl, port } = await ensureServer({ quiet: doc.quiet })
  const body = {
    uml: doc.uml,
    roots: doc.roots,
    title: doc.title ?? 'untitled',
    scope: doc.scope ?? 'default',
    theme: doc.theme ?? 'dark',
    ...(doc.jumpEndpoint !== undefined ? { jumpEndpoint: doc.jumpEndpoint } : {}),
    ...(doc.strict === true ? { strict: true } : {}),
    ...(doc.direction !== undefined ? { direction: doc.direction } : {}),
  }
  const r = await fetch(`${baseUrl}/api/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const result = await r.json()
  return { ...result, baseUrl, port, httpStatus: r.status }
}

/** 查询后端状态（不拉起）。 */
export async function serverStatus() {
  const st = readState()
  if (!st) return { running: false }
  const h = await health(st.baseUrl)
  return h ? { running: true, ...st, health: h } : { running: false, staleState: st }
}

/** 要求后端退出。 */
export async function stopServer() {
  const st = readState()
  if (!st) return { stopped: false, reason: 'not-running' }
  try {
    const r = await fetch(`${st.baseUrl}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) })
    const ok = r.ok
    await sleep(150)
    return { stopped: ok, port: st.port }
  } catch (e) {
    return { stopped: false, reason: e.message }
  }
}

export { VERSION }
export default { ensureServer, renderRemote, serverStatus, stopServer }
