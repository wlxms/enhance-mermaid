#!/usr/bin/env node
/**
 * style-studies.mjs —— 在同一个 compaction 图上生成 3 个视觉方向样张。
 * 只用于设计比较，不改生产样式；正式采用哪个方向后再落到 style.css。
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const POC = resolve(HERE, '..')
const ROOT = resolve(POC, '..')
const OUT = join(POC, 'shots')
const DEMO = join(ROOT, 'dist', 'style-study.html')
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p))
const W = 1500
const H = 900
const PORT = 9337

mkdirSync(OUT, { recursive: true })
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`, '--user-data-dir=' + join(tmpdir(), 'ehm-style-studies'), 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
chrome.stderr.on('data', () => {})
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function getWsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* retry */ }
    await delay(120)
  }
  throw new Error('CDP not ready')
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id)
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
      } else if (m.method) this.events.push(m)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}
const connect = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url)
  ws.addEventListener('open', () => resolve(new CDP(ws)))
  ws.addEventListener('error', (e) => reject(new Error(e.message)))
})

const STYLE_CSS = {
  blueprint: `
.ehm-root {
  --ehm-bg:#071018; --ehm-bg2:#0a1620; --ehm-bg3:#0e1e2a; --ehm-card:#0b1822; --ehm-head:#0a1b26;
  --ehm-head-text:#d8f4ff; --ehm-head-muted:#79a9b9;
  --ehm-text1:#d8f4ff; --ehm-text2:#a9cbd6; --ehm-text3:#7298a7; --ehm-text4:#4f7180;
  --ehm-accent:#53d4ff; --ehm-accent-bright:#8ce6ff; --ehm-accent-soft:rgba(83,212,255,.10); --ehm-accent-on:#03131c; --ehm-accent-ink:#8ce6ff;
  --ehm-border1:rgba(83,212,255,.11); --ehm-border2:rgba(83,212,255,.28); --ehm-border3:rgba(83,212,255,.5);
  --ehm-edge-call:rgba(83,212,255,.95); --ehm-edge-inherit:rgba(177,205,214,.7); --ehm-edge-depend:rgba(91,134,148,.65); --ehm-edge-compose:rgba(83,212,255,.55);
  --ehm-arrow-hollow:#071018; --ehm-hot:#a8edff; --ehm-label-bg:#071018; --ehm-label-border:#2b6b80; --ehm-label-text:#c3eef9;
  --ehm-grid:rgba(83,212,255,.12); --ehm-grid-major:rgba(83,212,255,.055); --ehm-bubble-bg:#06111a; --ehm-bubble-head:#0a1b26; --ehm-code:#d8f4ff;
}
.ehm-stage { background-image: radial-gradient(circle at 1px 1px,var(--ehm-grid) 1px,transparent 0), linear-gradient(90deg,var(--ehm-grid-major) 1px,transparent 1px), linear-gradient(0deg,var(--ehm-grid-major) 1px,transparent 1px); }
.ehm-bar { border-top-color:var(--ehm-accent); background:#071018; }
.ehm-brand-name { background:var(--ehm-accent); color:#03131c; }
.ehm-btn[data-ehm-action="sidebar"] { background:var(--ehm-accent); border-color:var(--ehm-accent); color:#03131c; }
.ehm-card { border-color:var(--ehm-border2); background:var(--ehm-card); }
.ehm-head { background:var(--ehm-head); border-bottom-color:var(--ehm-border3); }
.ehm-head::before { width:2px; }
.ehm-kind-abstract .ehm-head::before { width:2px; background:repeating-linear-gradient(180deg,var(--ehm-accent) 0 2px,transparent 2px 5px); }
.ehm-kind-service .ehm-head::before { width:3px; background:var(--ehm-accent); }
.ehm-kind-module .ehm-head::before { width:2px; background:repeating-linear-gradient(180deg,var(--ehm-accent) 0 6px,transparent 6px 9px); }
.ehm-kind-function .ehm-head::before { width:2px; background:var(--ehm-head-muted); }
.ehm-kind-class .ehm-head::before { width:1px; background:var(--ehm-head-muted); }
.ehm-row:hover { background:rgba(83,212,255,.1); }
.ehm-row:hover::before { background:var(--ehm-accent); }
.ehm-port { fill:#071018; stroke-width:1.3; }
.ehm-label-bg { fill:#071018; stroke:#2b6b80; }
.ehm-label-text { fill:#c3eef9; }
.ehm-bubble { background:#06111a; border-color:var(--ehm-border3); }
.ehm-bubble.locked { border-color:var(--ehm-accent); box-shadow:7px 7px 0 rgba(83,212,255,.12),7px 7px 0 1px var(--ehm-accent); }
`,
  carbon: `
.ehm-root {
  --ehm-bg:#0a0a0a; --ehm-bg2:#111111; --ehm-bg3:#1a1a1a; --ehm-card:#151515; --ehm-head:#1f1f1f;
  --ehm-head-text:#f4f4f4; --ehm-head-muted:#9a9a9a;
  --ehm-text1:#f4f4f4; --ehm-text2:#c6c6c6; --ehm-text3:#8d8d8d; --ehm-text4:#6f6f6f;
  --ehm-accent:#0f62fe; --ehm-accent-bright:#4589ff; --ehm-accent-soft:rgba(15,98,254,.15); --ehm-accent-on:#ffffff; --ehm-accent-ink:#78a9ff;
  --ehm-border1:#252525; --ehm-border2:#393939; --ehm-border3:#525252;
  --ehm-edge-call:rgba(69,137,255,.95); --ehm-edge-inherit:rgba(244,244,244,.68); --ehm-edge-depend:rgba(141,141,141,.7); --ehm-edge-compose:rgba(69,137,255,.55);
  --ehm-arrow-hollow:#0a0a0a; --ehm-hot:#f1c21b; --ehm-label-bg:#161616; --ehm-label-border:#525252; --ehm-label-text:#f4f4f4;
  --ehm-grid:rgba(255,255,255,.07); --ehm-grid-major:rgba(255,255,255,.025); --ehm-bubble-bg:#0d0d0d; --ehm-bubble-head:#1a1a1a; --ehm-code:#f4f4f4;
}
.ehm-bar { border-top-color:var(--ehm-accent); }
.ehm-brand-name { background:var(--ehm-accent); color:#fff; }
.ehm-btn[data-ehm-action="sidebar"] { background:var(--ehm-accent); border-color:var(--ehm-accent); color:#fff; }
.ehm-card { background:var(--ehm-card); border-color:var(--ehm-border2); border-top:2px solid var(--ehm-accent); }
.ehm-head { background:var(--ehm-head); border-bottom-color:var(--ehm-border3); }
.ehm-head::before { width:2px; background:var(--ehm-accent); }
.ehm-kind-abstract .ehm-head::before { background:#8d8d8d; width:1px; }
.ehm-kind-service .ehm-head::before { background:var(--ehm-accent); width:3px; }
.ehm-kind-module .ehm-head::before { background:#78a9ff; width:2px; }
.ehm-kind-function .ehm-head::before { background:#525252; width:1px; }
.ehm-kind-class .ehm-head::before { background:var(--ehm-accent); width:2px; }
.ehm-row:hover { background:rgba(15,98,254,.16); }
.ehm-row:hover::before { background:var(--ehm-accent); }
.ehm-label-bg { fill:#161616; stroke:#525252; }
.ehm-label-text { fill:#f4f4f4; }
.ehm-wire.hot .ehm-wire-line, .ehm-wire.hot .ehm-port { stroke:var(--ehm-hot); }
.ehm-wire.hot .ehm-port { fill:var(--ehm-hot); }
.ehm-time, .ehm-stamp { letter-spacing:.16em; }
`,
  editorial: `
.ehm-root.ehm-theme-light {
  --ehm-bg:#f2efe6; --ehm-bg2:#e9e5da; --ehm-bg3:#ddd8ca; --ehm-card:#fbfaf5; --ehm-head:#11110f;
  --ehm-head-text:#fbf7ea; --ehm-head-muted:#bdb6a6;
  --ehm-text1:#11110f; --ehm-text2:#47443d; --ehm-text3:#6f6a5f; --ehm-text4:#989182;
  --ehm-accent:#e2521f; --ehm-accent-bright:#ff6b35; --ehm-accent-soft:#f3d9cd; --ehm-accent-on:#fff7ee; --ehm-accent-ink:#b33c12;
  --ehm-border1:#ded8c7; --ehm-border2:#c4bdac; --ehm-border3:#a59d8a;
  --ehm-edge-call:rgba(226,82,31,.9); --ehm-edge-inherit:rgba(17,17,15,.7); --ehm-edge-depend:rgba(111,106,95,.75); --ehm-edge-compose:rgba(226,82,31,.55);
  --ehm-arrow-hollow:#fbfaf5; --ehm-hot:#b33c12; --ehm-label-bg:#fbfaf5; --ehm-label-border:#a59d8a; --ehm-label-text:#27241f;
  --ehm-grid:rgba(17,17,15,.07); --ehm-grid-major:rgba(17,17,15,.025); --ehm-bubble-bg:#11110f; --ehm-bubble-head:#1a1916; --ehm-code:#f2eadb;
}
.ehm-bar { border-top-color:var(--ehm-accent); background:#f2efe6; }
.ehm-brand-name { background:#11110f; color:#fbf7ea; }
.ehm-btn[data-ehm-action="sidebar"] { background:var(--ehm-accent); border-color:var(--ehm-accent); color:#fff7ee; }
.ehm-card { background:var(--ehm-card); border-color:var(--ehm-border2); }
.ehm-head { background:var(--ehm-head); border-bottom-color:var(--ehm-accent); }
.ehm-head::before { width:3px; background:var(--ehm-accent); }
.ehm-kind-abstract .ehm-head::before { background:repeating-linear-gradient(180deg,var(--ehm-accent) 0 2px,transparent 2px 5px); }
.ehm-kind-service .ehm-head::before { width:3px; }
.ehm-kind-module .ehm-head::before { width:2px; background:#8d8679; }
.ehm-kind-function .ehm-head::before { width:2px; background:#8d8679; }
.ehm-kind-class .ehm-head::before { width:1px; background:#8d8679; }
.ehm-row:hover { background:var(--ehm-accent-soft); }
.ehm-row:hover::before { background:var(--ehm-accent); }
.ehm-port { fill:var(--ehm-card); stroke-width:1.2; }
.ehm-label-bg { fill:var(--ehm-label-bg); stroke:var(--ehm-label-border); }
.ehm-label-text { fill:var(--ehm-label-text); }
`,
  graphite: `
.ehm-root {
  --ehm-bg:#11100e; --ehm-bg2:#171513; --ehm-bg3:#1e1c18; --ehm-card:#171614; --ehm-head:#201d19;
  --ehm-head-text:#e8e2d4; --ehm-head-muted:#a79d8b;
  --ehm-text1:#e8e2d4; --ehm-text2:#c7bfae; --ehm-text3:#938a7b; --ehm-text4:#6f675b;
  --ehm-accent:#b0894f; --ehm-accent-bright:#c9a36a; --ehm-accent-soft:rgba(176,137,79,.12); --ehm-accent-on:#16120b; --ehm-accent-ink:#d2b27a;
  --ehm-border1:#2a2722; --ehm-border2:#403b32; --ehm-border3:#5b5446;
  --ehm-edge-call:rgba(216,208,192,.88); --ehm-edge-inherit:rgba(216,208,192,.55); --ehm-edge-depend:rgba(150,143,130,.45); --ehm-edge-compose:rgba(176,137,79,.5);
  --ehm-arrow-hollow:#11100e; --ehm-hot:#e0c08a; --ehm-label-bg:#11100e; --ehm-label-border:#4a4438; --ehm-label-text:#d7cfc0;
  --ehm-grid:rgba(216,208,192,.075); --ehm-grid-major:rgba(216,208,192,.028); --ehm-bubble-bg:#0e0d0c; --ehm-bubble-head:#191713; --ehm-code:#e8e2d4;
}
.ehm-bar { border-top-color:var(--ehm-accent); background:#11100e; }
.ehm-brand-name { background:var(--ehm-head-text); color:#11100e; }
.ehm-btn { border-color:var(--ehm-border2); color:var(--ehm-head-text); }
.ehm-btn[data-ehm-action="sidebar"] { background:var(--ehm-head-text); border-color:var(--ehm-head-text); color:#11100e; }
.ehm-btn[data-ehm-action="sidebar"]:hover { background:#fff8e9; border-color:#fff8e9; color:#11100e; }
.ehm-card { background:var(--ehm-card); border-color:var(--ehm-border2); }
.ehm-head { background:var(--ehm-head); border-bottom-color:var(--ehm-border3); }
.ehm-head::before { width:2px; background:var(--ehm-head-text); }
.ehm-kind-abstract .ehm-head::before { background:repeating-linear-gradient(180deg,var(--ehm-head-text) 0 2px,transparent 2px 5px); }
.ehm-kind-service .ehm-head::before { width:3px; background:var(--ehm-head-text); }
.ehm-kind-module .ehm-head::before { width:2px; background:repeating-linear-gradient(180deg,var(--ehm-head-text) 0 6px,transparent 6px 9px); }
.ehm-kind-function .ehm-head::before { width:1px; background:var(--ehm-head-muted); }
.ehm-kind-class .ehm-head::before { width:2px; background:var(--ehm-head-muted); }
.ehm-row:hover { background:var(--ehm-accent-soft); }
.ehm-row:hover::before { background:var(--ehm-accent); }
.ehm-port { fill:var(--ehm-card); stroke-width:1.3; }
.ehm-label-bg { fill:var(--ehm-label-bg); stroke:var(--ehm-label-border); }
.ehm-label-text { fill:var(--ehm-label-text); }
.ehm-wire.hot .ehm-wire-line, .ehm-wire.hot .ehm-port { stroke:var(--ehm-hot); }
.ehm-wire.hot .ehm-port { fill:var(--ehm-hot); }
`,
}

async function main() {
  const cdp = await connect(await getWsUrl())
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: 'file:///' + DEMO.replace(/\\/g, '/') })
  await delay(1200)
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
  await evaluate("document.querySelector('[data-ehm-action=\"theme\"]') && document.querySelector('.ehm-root').classList.contains('ehm-theme-light')")
  await evaluate("window.__viewer.setTheme('dark'); window.__viewer.fit()")
  await delay(500)

  for (const [name, css] of Object.entries(STYLE_CSS)) {
    await evaluate(`(function(){
      var old = document.getElementById('ehm-style-study'); if (old) old.remove()
      var s = document.createElement('style'); s.id='ehm-style-study'; s.textContent = ${JSON.stringify(css)}
      document.head.appendChild(s)
      var root = document.querySelector('.ehm-root')
      if (${JSON.stringify(name)} === 'editorial') { window.__viewer.setTheme('light'); root.setAttribute('data-ehm-style','editorial') }
      else { window.__viewer.setTheme('dark'); root.setAttribute('data-ehm-style', ${JSON.stringify(name)}) }
      window.__viewer.fit()
      return true
    })()`)
    await delay(350)
    // 将图向上移到标题附近，裁掉大片空白
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: W / 2, y: H / 2, button: 'left', buttons: 1, clickCount: 1, modifiers: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: W / 2, y: H / 2 - 240, button: 'left', buttons: 1, modifiers: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: W / 2, y: H / 2 - 240, button: 'left', buttons: 0, clickCount: 1, modifiers: 1 })
    await delay(350)
    const png = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: 560, scale: 1 } })
    writeFileSync(join(OUT, `style-${name}.png`), Buffer.from(png.data, 'base64'))
    console.log('shot', name)
  }
  try { await cdp.send('Browser.close') } catch { /* */ }
  chrome.kill()
}
main().catch((e) => { console.error(e); chrome.kill(); process.exit(1) })



