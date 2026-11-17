/**
 * route-quality：小用例验证真实布线质量（相交 / 重叠 / 穿卡 / 斜线）。
 *
 * 渲染 poc/test/fixtures/route-overlap.ehm.md（三条边共享目标卡），headless Chrome 打开 H5，
 * 读 `window.__viewer.diagnose()`；任何一项非零 → exit 1。
 *
 * 用法: node poc/tools/route-quality.mjs [--direction tb|lr] [--keep]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderDocument } from '../src/server.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const FIXTURE = join(ROOT, 'poc/test/fixtures/route-overlap.ehm.md')
const args = process.argv.slice(2)
const direction = args.includes('--lr') ? 'LR' : 'TB'
const keep = args.includes('--keep')
const work = mkdtempSync(join(tmpdir(), 'ehm-route-quality-'))
const htmlPath = join(work, 'route-overlap.html')

const uml = readFileSync(FIXTURE, 'utf8')
const rendered = renderDocument({ uml, roots: [ROOT], title: 'route overlap probe', docId: 'route-probe', direction })
writeFileSync(htmlPath, rendered.html, 'utf8')

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9382
const profile = mkdtempSync(join(tmpdir(), 'ehm-route-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
  '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  '--window-size=1200,900', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] })
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* retry */ }
    await delay(150)
  }
  throw new Error('Chrome CDP 未就绪')
}
class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : res(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}
const ws = new WebSocket(await wsUrl())
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
const cdp = new CDP(ws)
const evalx = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') })
for (let i = 0; i < 100; i++) {
  if (await evalx('!!(window.__viewer && window.__viewer.diagnose)')) break
  await delay(200)
}
await delay(1200)
const diag = await evalx(`(function(){
  const d = window.__viewer ? window.__viewer.diagnose() : null
  if (!d) return { error: 'viewer not ready' }
  return {
    direction: window.__EHM_META__ && window.__EHM_META__.direction,
    cards: (window.__viewer.model && window.__viewer.model.entities || []).length,
    scene: d.scene,
    wireOnCard: d.wireOnCard || [],
    wireCrossings: d.wireCrossings || [],
    wireOverlaps: d.wireOverlaps || [],
    diagonalSegments: d.diagonalSegments || [],
    cardOverlaps: d.cardOverlaps || [],
  }
})()`)
console.log(JSON.stringify(diag, null, 2))
if (keep) console.log('html:', htmlPath)
const bad = diag.error || diag.wireOnCard.length || diag.wireCrossings.length || diag.wireOverlaps.length || diag.diagonalSegments.length || diag.cardOverlaps.length
try { await cdp.send('Browser.close') } catch { /* */ }
try { chrome.kill() } catch { /* */ }
if (bad) {
  console.error('route-quality: FAIL（真实相交/重叠/穿卡/斜线/卡片重叠必须全为 0）')
  process.exit(1)
}
console.log(`route-quality: PASS（${diag.direction} / ${diag.cards} cards / crossings=${diag.wireCrossings.length} overlaps=${diag.wireOverlaps.length} wireOnCard=${diag.wireOnCard.length} diagonal=${diag.diagonalSegments.length}）`)
process.exit(0)
