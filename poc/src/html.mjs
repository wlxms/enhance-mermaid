/**
 * html.mjs —— IR → H5
 *
 * 默认产物是「HTML 入口 + 外置渲染引擎」：dagre/viewer 放在
 * `~/.dsh-ehm/js/ehm-viewer-engine.js`，所有图共享；插件升级引擎后旧 HTML
 * 下次打开即加载新版本。传 `bakeEngine: true`（CLI `--bake`）才把引擎内联，
 * 生成完全自包含、可断网/分享的单文件。
 *
 * 页面外向动作由生成时写入的 jump actions 决定；浏览器不执行 shell。
 *
 * @module poc/src/html
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const POC = resolve(HERE, '..')
export const VIEWER = join(POC, 'viewer', 'ehm-viewer.js')
export const STYLE = join(POC, 'viewer', 'style.css')
export const DAGRE = join(POC, 'vendor', 'dagre.bundle.js')
/** 外置渲染引擎默认目录：插件/CLI 更新这里，旧 HTML 下次打开即加载新引擎。 */
export const ENGINE_DIR = join(homedir(), '.dsh-ehm', 'js')
export const ENGINE_FILE = join(ENGINE_DIR, 'ehm-viewer-engine.js')

/** Cowork 对 CallToolResult 内联数据的硬上限；超过就要瘦身。 */
export const INLINE_LIMIT = 64 * 1024

function readOrThrow(file, label) {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error(`读不到 ${label}: ${file} (${e.code || e.message})`)
  }
}

/**
 * 把「dagre + viewer」写成外置引擎文件，供 HTML 用 `<script src="file:///...">` 引用。
 * 同一个文件被所有导出的 HTML 共享；插件更新引擎后，旧 HTML 打开时自动加载新版本。
 * CSS 仍内联（很小，且换肤要跟 HTML 的主题属性走）。
 *
 * @param {{dir?:string, viewerJs?:string, dagreJs?:string}} [opts]
 * @returns {{dir:string,file:string,bytes:number,written:boolean}}
 */
export function ensureEngineFile(opts = {}) {
  const dir = opts.dir !== undefined ? resolve(opts.dir) : ENGINE_DIR
  const file = join(dir, 'ehm-viewer-engine.js')
  const viewerJs = opts.viewerJs ?? readOrThrow(VIEWER, 'viewer')
  const dagreJs = opts.dagreJs ?? readOrThrow(DAGRE, 'dagre bundle')
  const css = opts.css ?? readOrThrow(STYLE, 'style.css')
  const cssLiteral = JSON.stringify(css).replace(/<\/script/giu, '<\\/script')
  const code = `/* enhance-mermaid 外置渲染引擎（CSS + dagre + viewer）；由插件/CLI 自动更新。 */
(function () {
  try {
    if (document.querySelector('style[data-ehm-engine-style]')) return
    var style = document.createElement('style')
    style.setAttribute('data-ehm-engine-style', '')
    style.textContent = ${cssLiteral}
    ;(document.head || document.documentElement).appendChild(style)
  } catch (e) {}
})();
${dagreJs}
;
${viewerJs}
`
  mkdirSync(dir, { recursive: true })
  let prev = null
  try { prev = readFileSync(file, 'utf8') } catch { /* 首次写入 */ }
  if (prev === code) return { dir, file, bytes: Buffer.byteLength(code), written: false }
  // 原子替换：Host 路由可能和插件启动同步并发读，直接 writeFileSync 会读到半截 JS。
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  try {
    writeFileSync(tmp, code, 'utf8')
    renameSync(tmp, file)
  } catch {
    try { writeFileSync(file, code, 'utf8') } finally {
      try { unlinkSync(tmp) } catch { /* ignore */ }
    }
  }
  return { dir, file, bytes: Buffer.byteLength(code), written: true }
}

/** JSON → 可安全内联进 <script> 的字面量。 */
export function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

/**
 * 归一化跳转动作列表。支持：
 *   "post:https://..." / "https://..."（裸 http(s) URL 视为 post）
 *   "open:vscode://file/{absPath}:{line}:{column}"（裸其它 scheme 视为 open）
 *   "copy"
 * 或已经归一化的 `{ type:'post'|'open', url }` / `{ type:'copy' }`。
 * 注意：这是**动作配置**，不是 shell；静态 HTML 只能 fetch 或打开 URL scheme。
 */
export function normalizeJumpActions(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const raw of input) {
    if (raw === null || raw === undefined) continue
    let action = null
    if (typeof raw === 'string') {
      const spec = raw.trim()
      if (spec === '') continue
      if (/^copy$/iu.test(spec)) action = { type: 'copy' }
      else if (/^post:/iu.test(spec)) action = { type: 'post', url: spec.slice(5).trim() }
      else if (/^open:/iu.test(spec)) action = { type: 'open', url: spec.slice(5).trim() }
      else if (/^https?:\/\//iu.test(spec)) action = { type: 'post', url: spec }
      else if (/^[a-z][a-z0-9+.-]*:/iu.test(spec)) action = { type: 'open', url: spec }
    } else if (typeof raw === 'object') {
      if (raw.type === 'copy') action = { type: 'copy' }
      else if ((raw.type === 'post' || raw.type === 'open') && typeof raw.url === 'string') {
        action = { type: raw.type, url: raw.url.trim() }
      }
    }
    if (action === null) throw new Error('无法识别的 jump action: ' + JSON.stringify(raw))
    if (action.type === 'post') {
      if (!/^https?:\/\//iu.test(action.url)) throw new Error('jump post 地址必须是 http(s): ' + action.url)
    } else if (action.type === 'open') {
      if (action.url === '') throw new Error('jump open 地址不能为空')
      if (/^(javascript|data|vbscript):/iu.test(action.url)) throw new Error('拒绝危险的 jump open scheme: ' + action.url)
    }
    out.push(action)
    if (out.length >= 20) throw new Error('jump actions 不能超过 20 条')
  }
  return out
}

function escapeHtml(s) {
  return String(s).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/gu, '&quot;')
}

/** ISO 时间 → 角标可读文本（本地时区，`2026-11-11 14:35:27`）。 */
function stampTime(iso) {
  const d = new Date(String(iso))
  if (Number.isNaN(d.getTime())) return String(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 页面里的跳转脚本。动作只有三类：
 *   post  — fetch 一个宿主/本地 helper 地址
 *   open  — 打开 IDE/自定义 URL scheme（vscode://、cursor://、idea://…）
 *   copy  — 复制 file:line:column
 * 模板占位符 {file} / {absPath} / {fileUrl} / {line} / {column} / {symbol}。
 * 浏览器不能执行 shell；需要执行命令时必须由 post 目标的 helper 处理。
 */
function interactionScript({ jumpActions, jumpUrl, roots, theme }) {
  const actions = Array.isArray(jumpActions) && jumpActions.length > 0
    ? jumpActions
    : (typeof jumpUrl === 'string' && jumpUrl !== '' ? [{ type: 'post', url: jumpUrl }] : [])
  const rootList = Array.isArray(roots) ? roots : []
  return `
  'use strict'
  var app = document.getElementById('ehm-app')
  var ir = window.__EHM_IR__
  var JUMP_ACTIONS = ${inlineJson(actions)}
  var ROOTS = ${inlineJson(rootList)}
  var THEME = ${JSON.stringify(theme)}

  function toast(msg, kind) {
    var el = document.createElement('div')
    el.className = 'ehm-toast show' + (kind ? ' ehm-toast-' + kind : '')
    el.textContent = msg
    document.body.appendChild(el)
    setTimeout(function () { el.classList.add('ehm-toast-out') }, 2600)
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el) }, 3200)
  }

  function locationText(t) {
    if (!t || !t.file) return '(未知位置)'
    return t.file + ':' + t.line + (t.column ? ':' + t.column : '')
  }

  function absPathFor(file) {
    var f = String(file || '').replace(/\\\\/g, '/')
    if (f === '') return ''
    if (/^[A-Za-z]:\\//.test(f) || f.charAt(0) === '/') return f
    if (ROOTS.length === 0) return f
    var root = String(ROOTS[0] || '').replace(/\\\\/g, '/').replace(/\\/+$/, '')
    return root + '/' + f.replace(/^\\/+/, '')
  }

  function fileUrlFor(abs) {
    var p = String(abs || '').replace(/\\\\/g, '/')
    if (/^[A-Za-z]:\\//.test(p)) return 'file:///' + p
    return 'file://' + (p.charAt(0) === '/' ? '' : '/') + p
  }

  function expand(template, t) {
    var file = String((t && t.file) || '').replace(/\\\\/g, '/')
    var abs = absPathFor(file)
    var fileUrl = fileUrlFor(abs)
    var map = {
      file: encodeURI(file),
      absPath: encodeURI(abs),
      fileUrl: encodeURI(fileUrl),
      line: String((t && t.line) || 1),
      column: String((t && t.column) || 1),
      symbol: encodeURIComponent(String((t && t.symbol) || '')),
    }
    return String(template || '').replace(/\\{([a-zA-Z]+)\\}/g, function (m, key) {
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : m
    })
  }

  function openExternal(url) {
    var scheme = String(url || '').match(/^([a-z][a-z0-9+.-]*):/i)
    if (!scheme) return false
    if (/^(javascript|data|vbscript)$/i.test(scheme[1])) return false
    try {
      var a = document.createElement('a')
      a.href = url
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      if (a.parentNode) a.parentNode.removeChild(a)
      return true
    } catch (e) {
      return false
    }
  }

  function copyText(t) {
    var text = locationText(t)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true }, function () { return false })
    }
    return Promise.resolve(false)
  }

  function copyFallback(t) {
    var text = locationText(t)
    copyText(t).then(function (ok) {
      toast((ok ? '已复制 ' : '跳转位置 ') + text, ok ? 'ok' : undefined)
    })
  }

  function postOne(url, t) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(t),
    }).then(function (r) { return r.json() }).then(function (res) {
      return { ok: !!(res && res.forwarded), message: res && res.message }
    }).catch(function () {
      return { ok: false, message: '' }
    })
  }

  function onJump(t) {
    window.__lastIntent = t
    // 嵌入 DSH 时把意图交给父窗口（本地 HTML / Blob iframe 没有 HTTP 后端）。
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'ehm:jump', target: t }, '*')
    } catch (e) { /* ignore */ }
    // 兼容运行时改 __EHM_META__.jumpUrl（旧 DSH 代理页/测试会这样注入）；静态动作优先。
    var actions = JUMP_ACTIONS
    if (actions.length === 0 && window.__EHM_META__ && typeof window.__EHM_META__.jumpUrl === 'string' && window.__EHM_META__.jumpUrl) {
      actions = [{ type: 'post', url: window.__EHM_META__.jumpUrl }]
    }
    if (actions.length === 0) { copyFallback(t); return }

    var posts = []
    var opens = []
    var wantsCopy = false
    for (var i = 0; i < actions.length; i++) {
      var action = actions[i]
      if (action.type === 'post') posts.push(action.url)
      else if (action.type === 'open') opens.push(expand(action.url, t))
      else if (action.type === 'copy') wantsCopy = true
    }

    // 外部协议必须在同一个用户手势里同步触发；fetch 放到后面，不阻塞 IDE 打开。
    var opened = 0
    for (var k = 0; k < opens.length; k++) if (openExternal(opens[k])) opened += 1
    if (wantsCopy) void copyText(t)

    var pending = []
    for (var j = 0; j < posts.length; j++) pending.push(postOne(posts[j], t))
    if (pending.length === 0) {
      if (wantsCopy) toast('已复制 ' + locationText(t), 'ok')
      return
    }
    Promise.all(pending).then(function (results) {
      var success = null
      for (var n = 0; n < results.length; n++) if (results[n].ok) { success = results[n]; break }
      if (success) {
        toast(success.message || ('已交给宿主处理：' + locationText(t)), 'ok')
      } else if (wantsCopy) {
        toast('跳转请求失败，已复制 ' + locationText(t), 'ok')
      } else if (opened === 0) {
        copyFallback(t)
      } else {
        toast('跳转请求失败，已尝试打开外部程序')
      }
    })
  }

  if (!ir) {
    app.innerHTML = '<div class="ehm-fallback">IR 缺失：内联数据没有解析出来。</div>'
    return
  }
  if (!window.EHMViewer || typeof window.EHMViewer.render !== 'function') {
    app.innerHTML = '<div class="ehm-fallback">渲染引擎未加载（EHMViewer 不存在）。<br>'
      + '独立打开请确认 <code>~/.dsh-ehm/js/ehm-viewer-engine.js</code> 存在；'
      + 'DSH 侧栏请重启 DSH Host 后刷新（旧 Host 没有 <code>/ehm/engine.js</code> 路由）。</div>'
    return
  }
  try {
    app.replaceChildren()
    window.__viewer = window.EHMViewer.render(ir, app, {
      theme: THEME,
      methodsMode: 'expanded',
      onJump: onJump,
    })
    var diag = window.__viewer.diagnose()
    window.__EHM_DIAG__ = diag
    var pre = document.createElement('pre')
    pre.id = 'ehm-diag'
    pre.style.display = 'none'
    pre.textContent = JSON.stringify(diag)
    document.body.append(pre)
  } catch (e) {
    app.innerHTML = '<div class="ehm-fallback">渲染失败：' +
      String(e && e.message ? e.message : e).replace(/[<>&]/g, '') + '</div>'
    if (window.console) console.error(e)
  }

  // 生成时间角标跟随 viewer 主题（卡片是浅色时角标也换深色文字；角标 pointer-events:none 不挡交互）
  function syncStampTheme() {
    var stamp = document.querySelector('.ehm-stamp')
    if (!stamp) return
    var root = document.querySelector('.ehm-root')
    var light = root ? root.classList.contains('ehm-theme-light')
      : document.documentElement.getAttribute('data-ehm-theme') === 'light'
    stamp.classList.toggle('ehm-stamp-light', light)
  }
  syncStampTheme()
  var stampRoot = document.querySelector('.ehm-root')
  if (stampRoot && typeof MutationObserver === 'function') {
    new MutationObserver(syncStampTheme).observe(stampRoot, { attributes: true, attributeFilter: ['class'] })
  }
`
}

/**
 * 生成单文件 H5。
 * @param {object} ir
 * @param {{ theme?:'dark'|'light', title?:string, jumpUrl?:string|null,
 *           jumpActions?:Array<string|{type:'post'|'open'|'copy',url?:string}>,
 *           roots?:string[], docId?:string,
 *           viewerJs?:string, css?:string, dagreJs?:string,
 *           externalEngine?:boolean|string, bakeEngine?:boolean }} [opts]
 * @returns {string}
 */
export function buildHtml(ir, opts = {}) {
  const theme = opts.theme === 'light' ? 'light' : 'dark'
  const viewerJs = opts.viewerJs ?? readOrThrow(VIEWER, 'viewer')
  const css = opts.css ?? readOrThrow(STYLE, 'style.css')
  const dagreJs = opts.dagreJs ?? readOrThrow(DAGRE, 'dagre bundle')
  const externalEngine = opts.bakeEngine === true
    ? false
    : opts.externalEngine === false
      ? false
      : true
  let engineFile = null
  let engineUrl = null
  if (externalEngine) {
    const engine = ensureEngineFile({
      dir: typeof opts.externalEngine === 'string' ? opts.externalEngine : undefined,
      viewerJs,
      dagreJs,
      css,
    })
    engineFile = engine.file
    engineUrl = pathToFileURL(engine.file).href
  }
  const jumpActions = normalizeJumpActions(opts.jumpActions ?? [])
  const roots = Array.isArray(opts.roots) ? opts.roots.map((r) => String(r)) : []

  const meta = (ir && ir.meta) || {}
  const title = opts.title ?? meta.title ?? 'EHM'
  // 布局方向：TB（纵向为主，适合右侧栏与纵向内联）是默认；显式 LR 才横向。
  const direction = opts.direction === 'LR' || opts.direction === 'lr' ? 'LR' : 'TB'
  const entityCount = Array.isArray(ir?.entities) ? ir.entities.length : 0
  const relationCount = Array.isArray(ir?.relations) ? ir.relations.length : 0
  const bg = theme === 'light' ? '#fafaf8' : '#0e0d0c'
  // 生成时间角标（§5.1「页面显示生成时间角标，不推送」）：取 IR 的 generatedAt，缺失时用当前时间
  const generatedAt = typeof meta.generatedAt === 'string' && meta.generatedAt !== '' ? meta.generatedAt : new Date().toISOString()
  const docId = opts.docId ?? null
  const stampLabel = `生成于 ${stampTime(generatedAt)}${docId ? ' · ' + docId : ''}`

  const dataLiteral = inlineJson(ir).replace(/<\/script/giu, '<\\/script')

  return `<!DOCTYPE html>
<html lang="zh-CN" data-ehm-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · enhance-mermaid</title>
<style>
html, body { margin: 0; padding: 0; height: 100%; background: ${bg}; }
#ehm-app { height: 100vh; }
.ehm-fallback {
  font-family: Inter, "Helvetica Neue", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  color: #c6bba7; padding: 28px; font-size: 13px; line-height: 1.7;
}
.ehm-fallback code { font-family: "JetBrains Mono", "IBM Plex Mono", Consolas, monospace; color: #96b0ff; }
.ehm-toast {
  position: fixed; right: 20px; bottom: 20px; z-index: 9999;
  max-width: 60vw; padding: 10px 14px; border-radius: 0;
  font: 11px/1.5 "JetBrains Mono", "IBM Plex Mono", Consolas, monospace;
  color: #f5ecda; background: #1c1a17;
  border: 1px solid #4a4439; box-shadow: 7px 7px 0 rgba(0,0,0,.32);
  transition: opacity .35s ease, transform .35s ease;
}
.ehm-toast-ok { border-color: #96b0ff; }
.ehm-toast-out { opacity: 0; transform: translateY(6px); }
/* 生成时间角标：固定左下、低对比、pointer-events:none（不挡卡片/气泡交互） */
.ehm-stamp {
  position: fixed; left: 16px; bottom: 10px; z-index: 4;
  pointer-events: none; user-select: none; white-space: nowrap;
  font: 500 8.5px/1.4 "JetBrains Mono", "IBM Plex Mono", Consolas, monospace;
  letter-spacing: .12em; text-transform: uppercase; color: rgba(236,226,207,.42);
}
.ehm-stamp.ehm-stamp-light { color: rgba(10,10,10,.42); }
</style>
<style>
${css}
</style>
</head>
<body>
<div id="ehm-app"><div class="ehm-fallback">正在渲染图…（若长时间无变化，请打开控制台查看报错）</div></div>
<div class="ehm-stamp${theme === 'light' ? ' ehm-stamp-light' : ''}" data-ehm-stamp title="${escapeHtml(stampLabel)}">${escapeHtml(stampLabel)}</div>

<script>
/* ══ IR（内联 JSON —— 不 fetch、不读文件） ══ */
window.__EHM_IR__ = ${dataLiteral};
window.__EHM_META__ = ${inlineJson({ theme, title, entityCount, relationCount, docId, jumpUrl: opts.jumpUrl ?? null, jumpActions, roots, direction, generatedAt, htmlPath: opts.htmlPath ?? null, sessionId: opts.sessionId ?? null, enginePath: engineFile })}; 
</script>

${engineUrl !== null
    ? `<script src="${escapeAttr(engineUrl)}"></script>`
    : `<script>\n/* ══ dagre bundle（62KB，Apache-2.0） ══ */\n${dagreJs}\n</script>

<script>
/* ══ viewer ══ */
${viewerJs}
</script>`}

<script>
(function () {${interactionScript({ jumpActions, jumpUrl: opts.jumpUrl ?? null, roots, theme })}})()
</script>
</body>
</html>
`
}

/** 静态导出用：把 IR 里的代码正文全部剥掉（只留 file/line）。 */
export function slimIr(ir) {
  const clone = JSON.parse(JSON.stringify(ir))
  const strip = (holder) => {
    const ev = holder?.evidence
    if (ev && typeof ev === 'object') {
      holder.evidence = { file: ev.file, line: ev.line }
      if (ev.endLine !== undefined) holder.evidence.endLine = ev.endLine
      holder.evidence.slim = true
    }
  }
  for (const ent of clone.entities ?? []) {
    strip(ent)
    for (const f of ent.fields ?? []) strip(f)
    for (const m of ent.methods ?? []) strip(m)
  }
  for (const rel of clone.relations ?? []) strip(rel)
  if (clone.meta) clone.meta.evidenceMode = 'slim'
  return clone
}

export function byteSize(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

export default { buildHtml, slimIr, byteSize, inlineJson, INLINE_LIMIT, ensureEngineFile, ENGINE_DIR, ENGINE_FILE }
