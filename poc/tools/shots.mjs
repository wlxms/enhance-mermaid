#!/usr/bin/env node
/**
 * shots.mjs —— 用 headless Chrome 出「视觉验收截图」并做气泡遮挡断言
 *
 * 为什么不用 `chrome --screenshot` 直接拍：
 *   悬停气泡 / Alt 锁定 / 主题切换都需要**先执行 JS** 再截图。
 *   纯 --screenshot 只是加载完立刻拍，拍不到悬停态。
 *   这里用 --headless=new + --remote-debugging-port 走 CDP，发 Input.dispatchMouseEvent
 *   和 Runtime.evaluate，然后 Page.captureScreenshot。
 *
 * 气泡硬断言（P8-1：回归 v14「鼠标附近 + 不遮悬停元素」设计）：
 *   三类场景 —— 悬停实体头、悬停方法行、悬停连线标签 —— 分别断言：
 *     a) 气泡不与 owner 矩形相交（实体/方法行用元素 rect；连线用鼠标点 ±7px 局部锚点）；
 *     b) 气泡矩形到鼠标点的最近距离 ≤ 120px（水平/垂直取最近边后算欧氏距离）；
 *     c) 气泡不包含鼠标点；
 *     d) 气泡不压任何卡片（cardsOverlapped = []）；
 *     e) 气泡在视口内；
 *     f) 气泡里有真实源码；方法行 11 行代码保留自然高度（不得被压缩）。
 *   任何一项不满足 → 非零退出。
 *
 * P13 追加断言（无新增截图，仍保持 7 张 PNG）：
 *   · hover 气泡纯展示：滚轮不滚代码、不缩放画布；单击锁定后才允许滚 .ehm-bubble-scroll；
 *   · 独立窗口点击跳转：toast 可见 + 含 file:line:col；伪代理页（运行时注入 jumpUrl）POST 到 jumpUrl；
 *   · 方法含义 member.summary：有 summary 的方法气泡 header 显示该文本且标题是声明行，
 *     无 summary 的方法不出现空行；行文本前缀是 + - # ~ 可见性。
 *
 * 用法：node poc/tools/shots.mjs
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildHtml } from '../src/html.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const POC = resolve(HERE, '..')
const ROOT = resolve(POC, '..')
const SHOTS = join(POC, 'shots')
const argIdx = process.argv.indexOf('--html')
const DEMO = argIdx > 0 ? resolve(process.argv[argIdx + 1]) : join(ROOT, 'dist', 'ehm-demo.html')
const SHOT_PREFIX = argIdx > 0 ? 'rich-' : ''

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

if (!CHROME) {
  console.error('没找到 Chrome / Edge，跳过错图')
  process.exit(2)
}
if (!existsSync(DEMO)) {
  console.error('缺少 dist/ehm-demo.html，请先跑 node poc/bin/ehm.mjs render poc/samples/compaction.ehm.md --root D:/dsh-mydsh/deepseek-harness --out dist/ehm-demo.html')
  process.exit(2)
}
mkdirSync(SHOTS, { recursive: true })

const W = 1800
const H = 1400
const PORT = 9333

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--window-size=${W},${H}`,
  '--user-data-dir=' + join(tmpdir(), 'ehm-chrome-profile'),
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

chrome.stderr.on('data', () => {})

/* ── 极简 CDP 客户端 ── */

function delay(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function getWsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await delay(120)
  }
  throw new Error('CDP 端点没起来')
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject: rej } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message + ' ' + JSON.stringify(msg.error.data || '')))
        else res(msg.result)
      } else if (msg.method) {
        this.events.push(msg)
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

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => res(new CDP(ws)))
    ws.addEventListener('error', (e) => rej(new Error('WS 连接失败: ' + e.message)))
  })
}

/* ── 主流程 ── */

const shotLog = []

async function main() {
  const cdp = await connect(await getWsUrl())
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  })

  const fileUrl = 'file:///' + DEMO.replace(/\\/g, '/')
  const loaded = new Promise((res) => {
    const check = () => {
      if (cdp.events.some((e) => e.method === 'Page.loadEventFired')) res()
      else setTimeout(check, 60)
    }
    check()
  })
  await cdp.send('Page.navigate', { url: fileUrl })
  await loaded
  await delay(900)

  async function evaluate(expr) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr.slice(0, 120))
    return r.result.value
  }

  async function moveTo(x, y) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  }
  async function mouseDown(x, y, button = 'left') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
  }
  async function mouseUp(x, y, button = 'left') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
  }
  async function doubleClick(x, y) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 })
  }
  async function keyDown(key, code, keyCode, modifiers = 0) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers,
    })
  }
  async function keyUp(key, code, keyCode, modifiers = 0) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers,
    })
  }

  async function shoot(name) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = join(SHOTS, name)
    writeFileSync(file, Buffer.from(r.data, 'base64'))
    shotLog.push(file)
    console.log('  截图 →', name)
  }

  /**
   * 读气泡几何并算验收指标（悬停实体头 / 方法行 / 连线三类场景共用）。
   *
   * 口径：
   *   · ownerRect —— 实体头、字段行、方法行用**该元素**的屏幕矩形
   *     （气泡不许盖住被悬停的那一行）；连线用**鼠标点 ±7px 的 14×14 局部锚点**
   *     （不再用整条 <g> 的 bbox，见 ehm-viewer.js 的 wireOwnerRect）。
   *   · bubbleRectDist —— 气泡矩形到鼠标点的**最短距离**（先取水平/垂直最近边，
   *     再算欧氏距离，px）。验收阈值 ≤ 120px。
   */
  async function readBubbleMetrics(ownerSelector, mx, my, wireAnchor) {
    return evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      if (!b || !b.classList.contains('show')) return { shown: false }
      function rect(el){ var r = el.getBoundingClientRect(); return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height } }
      var br = rect(b)
      var owner
      if (${JSON.stringify(wireAnchor === true)}) {
        // 连线：鼠标点 ±7px 局部锚点
        owner = { left: ${mx} - 7, top: ${my} - 7, right: ${mx} + 7, bottom: ${my} + 7, width: 14, height: 14 }
      } else {
        var el = document.querySelector(${JSON.stringify(ownerSelector)})
        if (!el) return { shown: false, reason: 'owner-not-found' }
        owner = rect(el)
      }
      var hits = []
      var cardEls = document.querySelectorAll('.ehm-card')
      for (var i = 0; i < cardEls.length; i++) {
        var r = cardEls[i].getBoundingClientRect()
        if (br.left < r.right && br.right > r.left && br.top < r.bottom && br.bottom > r.top) {
          hits.push(cardEls[i].getAttribute('data-ehm-card'))
        }
      }
      var mxx = ${mx}, myy = ${my}
      var dx = Math.max(br.left - mxx, 0, mxx - br.right)
      var dy = Math.max(br.top - myy, 0, myy - br.bottom)
      var scroll = b.querySelector('.ehm-bubble-scroll')
      var placement = (window.__viewer && window.__viewer.bubblePlacement) ? window.__viewer.bubblePlacement() : null
      return {
        shown: true,
        bubble: { left: Math.round(br.left), top: Math.round(br.top), w: Math.round(br.width), h: Math.round(br.height) },
        owner: { left: Math.round(owner.left), top: Math.round(owner.top), right: Math.round(owner.right), bottom: Math.round(owner.bottom) },
        mouse: { x: mxx, y: myy },
        ownerOverlap: br.left < owner.right && br.right > owner.left && br.top < owner.bottom && br.bottom > owner.top,
        mouseInsideBubble: mxx >= br.left && mxx <= br.right && myy >= br.top && myy <= br.bottom,
        bubbleRectDist: Math.sqrt(dx * dx + dy * dy),
        cardsOverlapped: hits,
        inViewport: br.left >= 0 && br.top >= 0 && br.right <= window.innerWidth && br.bottom <= window.innerHeight,
        compressed: scroll ? scroll.scrollHeight > scroll.clientHeight + 2 : null,
        scrollH: scroll ? scroll.scrollHeight : null,
        clientH: scroll ? scroll.clientHeight : null,
        maxHeight: getComputedStyle(b).maxHeight,
        placement: placement,
        codeLines: b.querySelectorAll('.ehm-code-line').length,
        hotWires: document.querySelectorAll('.ehm-wire.hot').length,
        hotLabels: document.querySelectorAll('.ehm-label.hot').length,
        title: (b.querySelector('.ehm-bubble-title') || {}).textContent,
      }
    })()`)
  }

  /** 三类气泡场景共用的可失败断言：不压 owner、靠近鼠标、不含鼠标点、在视口内。 */
  const bubbleFailures = []
  function assertBubble(name, c) {
    if (!c || !c.shown) { bubbleFailures.push(name + '=未显示'); return }
    if (c.ownerOverlap) bubbleFailures.push(name + '.ownerOverlap=true（气泡盖住悬停元素）')
    if (c.mouseInsideBubble) bubbleFailures.push(name + '.mouseInsideBubble=true（气泡包含鼠标点）')
    if (!(c.bubbleRectDist <= 80)) bubbleFailures.push(name + '.bubbleRectDist=' + c.bubbleRectDist.toFixed(1) + '（>80px，气泡离鼠标太远）')
    if (c.inViewport !== true) bubbleFailures.push(name + '.inViewport=false（气泡超出视口）')
    if (!(c.codeLines > 0)) bubbleFailures.push(name + '.codeLines=0（气泡里没有真实源码）')
  }

  /** 找到元素在屏幕上的中心点（考虑画布 scale） */
  function centerOf(selector) {
    const expr = `(function(){
      var el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      var r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }
    })()`
    return evaluate(expr)
  }

  let bubbleCheck = null
  let methodCheck = null
  let methodFollow = null
  let wireCheck = null
  let lockCheck = null
  const diag = await evaluate('JSON.stringify(window.__viewer.diagnose())')
  const d = JSON.parse(diag)
  const routerCheck = await evaluate(`(function(){
    var r = window.EHMViewer.router
    return {
      verticalOverlap: r.pairRelation([[5,0],[5,40]], [[5,10],[5,30]]),
      horizontalOverlap: r.pairRelation([[0,5],[40,5]], [[10,5],[30,5]]),
      verticalSeparate: r.pairRelation([[5,0],[5,40]], [[9,10],[9,30]]),
      perpendicular: r.pairRelation([[5,0],[5,40]], [[0,20],[40,20]]),
      verticalNear: r.proximity([[5,0],[5,40]], [[13,0],[13,40]], 12),
      horizontalNear: r.proximity([[0,5],[40,5]], [[0,13],[40,13]], 12),
      nearSeparate: r.proximity([[5,0],[5,40]], [[25,0],[25,40]], 12)
    }
  })()`)
  console.log(`  router=${JSON.stringify(routerCheck)}`)
  console.log(`\n几何诊断: scene=${d.scene.width}x${d.scene.height} cards=${d.cards} segs=${d.segments} labels=${d.labels} k=${d.view.k}`)
  console.log(`  cardOverlaps=${d.cardOverlaps.length} diagonal=${d.diagonalSegments.length} wireOnCard=${d.wireOnCard.length} labelOnWire=${d.labelOnWire.length} textOverflow=${d.textOverflow.length}`)

  /* ── 1. 全图 ── */
  console.log('\n[1] 全图（深色）')
  await shoot(SHOT_PREFIX + '01-overview-dark.png')

  /* ── 2. 悬停类头 → 气泡 ── */
  console.log('\n[2] 悬停 BasicCompactionEngine 头部 → 代码气泡')
  const headPt = await centerOf('.ehm-card[data-ehm-card="BasicCompactionEngine"] .ehm-name-row')
  const HEAD_SEL = '.ehm-card[data-ehm-card="BasicCompactionEngine"] .ehm-head'
  if (headPt) {
    await moveTo(headPt.x - 30, headPt.y)
    await delay(260)
    await moveTo(headPt.x, headPt.y)
    await delay(520)
    // 场景一断言：不压被悬停的头、不包含鼠标点、靠近鼠标、不压任何卡片
    bubbleCheck = await readBubbleMetrics(HEAD_SEL, headPt.x, headPt.y, false)
    console.log('  实体头气泡:', JSON.stringify(bubbleCheck))
    await shoot(SHOT_PREFIX + '02-hover-entity-bubble.png')
  } else {
    console.log('  ⚠ 找不到卡片')
  }

  /* ── 2b. Alt 操作画布时必须先收起代码悬浮框 ── */
  const wireAltPt = await evaluate(`(function(){
    var cards = Array.from(document.querySelectorAll('.ehm-card')).map(function(c){ return c.getBoundingClientRect() })
    function inside(x,y){ return cards.some(function(r){ return x>=r.left && x<=r.right && y>=r.top && y<=r.bottom }) }
    var paths = document.querySelectorAll('.ehm-wire-line')
    for (var i=0;i<paths.length;i++){
      var p=paths[i], total=p.getTotalLength()
      for (var f=0.25; f<=0.76; f+=0.25){
        var pt=p.getPointAtLength(total*f), m=p.getScreenCTM()
        var x=pt.x*m.a+pt.y*m.c+m.e, y=pt.x*m.b+pt.y*m.d+m.f
        if (!inside(x,y)) return {x:x,y:y}
      }
    }
    return null
  })()`)
  const altBubbleBefore = await evaluate(`(function(){
    var b = document.querySelector('.ehm-bubble')
    return { shown: b.classList.contains('show'), locked: b.classList.contains('locked') }
  })()`)
  await keyDown('Alt', 'AltLeft', 18, 1)
  await delay(90)
  const altBubbleAfter = await evaluate(`(function(){
    var b = document.querySelector('.ehm-bubble')
    return { shown: b.classList.contains('show'), locked: b.classList.contains('locked') }
  })()`)
  let altHoverHeld = null
  if (headPt) {
    // Alt 按住期间，重新移入目标也不能再出气泡。
    await moveTo(headPt.x - 30, headPt.y)
    await delay(120)
    await moveTo(headPt.x, headPt.y)
    await delay(260)
    altHoverHeld = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      return { shown: b.classList.contains('show'), locked: b.classList.contains('locked') }
    })()`)
  }
  let altWireHeld = null
  if (wireAltPt) {
    // Alt 按住期间悬停到连线上也不能出代码框。
    await moveTo(60, 400)
    await delay(120)
    await moveTo(wireAltPt.x, wireAltPt.y)
    await delay(300)
    altWireHeld = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      return { shown: b.classList.contains('show'), locked: b.classList.contains('locked') }
    })()`)
  }
  await keyUp('Alt', 'AltLeft', 18, 0)
  let altHoverReleased = null
  if (headPt) {
    // 松开 Alt 后离开目标再重新移入，气泡恢复。
    await moveTo(60, 400)
    await delay(180)
    await moveTo(headPt.x, headPt.y)
    await delay(360)
    altHoverReleased = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      return { shown: b.classList.contains('show'), locked: b.classList.contains('locked') }
    })()`)
  }
  let altWireReleased = null
  if (wireAltPt) {
    // 松开 Alt 后悬停连线，连线代码框恢复。
    await moveTo(60, 400)
    await delay(150)
    await moveTo(wireAltPt.x, wireAltPt.y)
    await delay(320)
    altWireReleased = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      return { shown: b.classList.contains('show'), locked: b.classList.contains('locked') }
    })()`)
    await moveTo(60, 400)
    await delay(120)
  }
  const altBubbleCheck = {
    before: altBubbleBefore,
    after: altBubbleAfter,
    heldHover: altHoverHeld,
    releasedHover: altHoverReleased,
    heldWire: altWireHeld,
    releasedWire: altWireReleased,
    hidden: altBubbleBefore.shown && !altBubbleAfter.shown,
    heldSuppressed: altHoverHeld !== null && altHoverHeld.shown === false,
    releasedRestored: altHoverReleased !== null && altHoverReleased.shown === true,
    wireHeldSuppressed: altWireHeld !== null && altWireHeld.shown === false,
    wireReleasedRestored: altWireReleased !== null && altWireReleased.shown === true,
  }
  console.log('  Alt 收起/抑制气泡:', JSON.stringify(altBubbleCheck))

  /* ── 3. 悬停方法行 → 气泡（断言，不额外出图；04 锁定截图即该气泡） ── */
  console.log('\n[3] 悬停方法行 → 方法代码气泡')
  // 注意：行元素的 class 是 ehm-methods-row（复数 + s），旧代码写的 ehm-method-row 一直选不到，
  // 所以这条断言以前从未真正执行过。
  const METHOD_SEL = '.ehm-card[data-ehm-card="BasicCompactionEngine"] .ehm-methods-row'
  const methodPt = await centerOf(METHOD_SEL)
  if (methodPt) {
    await moveTo(methodPt.x - 200, methodPt.y)
    await delay(200)
    await moveTo(methodPt.x, methodPt.y)
    await delay(520)
    methodCheck = await readBubbleMetrics(METHOD_SEL, methodPt.x, methodPt.y, false)
    console.log('  方法行气泡:', JSON.stringify(methodCheck))
    // 鼠标沿同一行移动 40px：气泡必须继续跟手，不能跳到远处
    const followPt = { x: methodPt.x + 40, y: methodPt.y }
    await moveTo(followPt.x, followPt.y)
    await delay(360)
    methodFollow = await readBubbleMetrics(METHOD_SEL, followPt.x, followPt.y, false)
    methodFollow.followed = !!(methodCheck && methodFollow && methodFollow.bubble && methodCheck.bubble
      && methodFollow.bubble.left !== methodCheck.bubble.left)
    console.log('  同 owner 内跟手:', JSON.stringify(methodFollow))
    assertBubble('methodFollow', methodFollow)
    if (!methodFollow.followed) bubbleFailures.push('methodFollow 气泡没有跟随鼠标移动')
    await moveTo(methodPt.x, methodPt.y)
    await delay(260)
    // 11 行方法代码必须保留自然高度，不允许退回旧的「12% 步进缩高」
    if (methodCheck && methodCheck.shown) {
      if (methodCheck.compressed) bubbleFailures.push('methodBubble.compressed=true（自然高度被压缩，旧缩高逻辑回归）')
      if (!(methodCheck.bubble.h >= 180)) bubbleFailures.push('methodBubble.height=' + methodCheck.bubble.h + '（11 行代码应保留自然高度）')
    }
  } else {
    console.log('  ⚠ 找不到方法行')
  }

  /* ── 4. 单击选中 + 固定 ── */
  console.log('\n[4] 单击方法行 → 选中并固定代码框（点外部取消）')
  if (methodPt) {
    await mouseDown(methodPt.x, methodPt.y)
    await mouseUp(methodPt.x, methodPt.y)
    await delay(450)
    const clicked = await readBubbleMetrics(METHOD_SEL, methodPt.x, methodPt.y, false)
    const state = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      var scroll = b.querySelector('.ehm-bubble-scroll')
      var row = document.querySelector(${JSON.stringify(METHOD_SEL)})
      var card = row ? row.closest('.ehm-card') : null
      return {
        locked: b.classList.contains('locked'),
        rowSelected: !!(row && row.classList.contains('ehm-selected')),
        cardSelected: !!(card && card.classList.contains('ehm-selected')),
        canScroll: !!scroll,
      }
    })()`)
    lockCheck = Object.assign({}, clicked, state)
    if (clicked.ownerOverlap !== false) bubbleFailures.push('选中固定气泡盖住了被点击对象：' + JSON.stringify(clicked))
    console.log('  选中固定态:', JSON.stringify(lockCheck))
    await shoot(SHOT_PREFIX + '04-bubble-locked.png')

    // 点击气泡外部：固定气泡与选中态都应取消
    await mouseDown(60, 400)
    await mouseUp(60, 400)
    await delay(300)
    const outside = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      return { shown: b.classList.contains('show'), selected: document.querySelectorAll('.ehm-selected').length }
    })()`)
    if (outside.shown || outside.selected !== 0) bubbleFailures.push('点击气泡外部未取消：' + JSON.stringify(outside))
    lockCheck.outsideDeselect = outside
  } else {
    bubbleFailures.push('找不到可用于单击选中的方法行')
  }

  /* ── 5. 点外部关闭 ── */
  console.log('\n[5] 点击气泡外部 → 关闭')
  await mouseDown(60, 400); await mouseUp(60, 400)
  await delay(200)
  const closed = await evaluate("document.querySelector('.ehm-bubble').classList.contains('show')")
  console.log('  气泡仍显示 =', closed, '(期望 false)')

  /* ── 5a. 长代码 hover 气泡：离开 owner 后可保持/进入 + 滚轮滚代码（P13-A） ── */
  console.log('\n[5a] 长代码 hover 气泡：移出 owner 后保持 + 滚轮滚动代码、不缩放画布')
  const LONG_ROW_KEYS = [
    'BasicCompactionEngine#methods#3',
    'BasicCompactionEngine#methods#1',
    'ToolResultPruner#methods#0',
    'summarizeWithLlm#methods#0',
    'compactSurfaceRegion#methods#0',
    'commandCompact#methods#1',
  ]
  let longBubble = null
  for (const rowKey of LONG_ROW_KEYS) {
    const rowSel = `.ehm-row[data-ehm-row="${rowKey}"]`
    const rowPt = await centerOf(rowSel)
    if (!rowPt) continue
    await moveTo(60, 400); await delay(140)
    await moveTo(rowPt.x, rowPt.y); await delay(430)
    const info = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      if (!b.classList.contains('show')) return null
      var r = b.getBoundingClientRect()
      var s = b.querySelector('.ehm-bubble-scroll')
      if (!s || s.scrollHeight <= s.clientHeight + 2) return null
      return {
        rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
        scrollH: s.scrollHeight, clientH: s.clientHeight,
        title: (b.querySelector('.ehm-bubble-title') || {}).textContent,
        cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
        scrollTop: s.scrollTop,
        k: window.__viewer.diagnose().view.k,
        locked: b.classList.contains('locked'),
      }
    })()`)
    if (!info) continue

    // A) hover 态是纯展示：滚轮不滚代码，也不缩放画布
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: info.cx, y: info.cy, deltaX: 0, deltaY: 240 })
    await delay(200)
    const hoverAfter = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      var s = b.querySelector('.ehm-bubble-scroll')
      return { shown: b.classList.contains('show'), locked: b.classList.contains('locked'), scrollTop: s.scrollTop, k: window.__viewer.diagnose().view.k }
    })()`)

    // B) 单击锁定后，滚轮才允许滚代码
    await mouseDown(rowPt.x, rowPt.y)
    await mouseUp(rowPt.x, rowPt.y)
    await delay(300)
    const lockedBefore = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      var s = b.querySelector('.ehm-bubble-scroll')
      var r = b.getBoundingClientRect()
      return { shown: b.classList.contains('show'), locked: b.classList.contains('locked'), scrollTop: s.scrollTop,
        scrollH: s.scrollHeight, clientH: s.clientHeight,
        cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
        k: window.__viewer.diagnose().view.k }
    })()`)
    if (!lockedBefore || !lockedBefore.shown || !lockedBefore.locked) continue
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: lockedBefore.cx, y: lockedBefore.cy, deltaX: 0, deltaY: 240 })
    await delay(200)
    const lockedAfter = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      var s = b.querySelector('.ehm-bubble-scroll')
      return { shown: b.classList.contains('show'), locked: b.classList.contains('locked'), scrollTop: s.scrollTop, k: window.__viewer.diagnose().view.k }
    })()`)

    await mouseDown(60, 400); await mouseUp(60, 400)
    await delay(800)
    const hiddenAfterOutside = await evaluate("!(document.querySelector('.ehm-bubble').classList.contains('show'))")

    longBubble = {
      row: rowKey,
      bubble: info.rect,
      scrollH: lockedBefore.scrollH,
      clientH: lockedBefore.clientH,
      title: info.title,
      hover: { scrollTopBefore: info.scrollTop, scrollTopAfter: hoverAfter.scrollTop, kBefore: info.k, kAfter: hoverAfter.k, stillHover: hoverAfter.shown && !hoverAfter.locked },
      locked: { scrollTopBefore: lockedBefore.scrollTop, scrollTopAfter: lockedAfter.scrollTop, kBefore: lockedBefore.k, kAfter: lockedAfter.k },
      hiddenAfterOutside: hiddenAfterOutside,
    }
    break
  }
  console.log('  长气泡滚轮:', JSON.stringify(longBubble))

  /* ── 5b. 独立窗口点击跳转 → 可见 toast + 复制位置（P13-B） ── */
  console.log('\n[5b] 独立窗口点击跳转 → 可见反馈（toast + 复制位置）')
  let standaloneJump = null
  const jumpHeadPt = await centerOf('.ehm-card[data-ehm-card="BasicCompactionEngine"] .ehm-name-row')
  if (jumpHeadPt) {
    await moveTo(60, 400); await delay(140)
    await moveTo(jumpHeadPt.x, jumpHeadPt.y); await delay(220)
    // 单击是选中+固定；双击才是跳转
    await doubleClick(jumpHeadPt.x, jumpHeadPt.y)
    await delay(260)
    const b1 = await evaluate(`(function(){
      var ts = document.querySelectorAll('.ehm-toast'); var t = ts.length ? ts[ts.length - 1] : null
      var cs = t ? getComputedStyle(t) : null
      return {
        standalone: window.self === window.top,
        intent: window.__lastIntent || null,
        toast: t ? { shown: t.classList.contains('show'), opacity: cs.opacity, text: t.textContent } : null,
      }
    })()`)
    // B2：伪装「插件同源代理页的独立标签」——有 jumpUrl，点击后应复制 + 提示回 DSH 窗口，并 POST 记录意图
    await evaluate(`(function(){
      window.__origFetch = window.fetch
      window.__jumpFetch = []
      window.fetch = function (u, o) {
        window.__jumpFetch.push({ url: String(u), body: o ? String(o.body || '') : '' })
        return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, forwarded: true, message: '已交给 DSH 面板处理' }) } })
      }
      window.__EHM_META__.jumpUrl = '/ehm/jump-relay/abc'
      return true
    })()`)
    const proxyHeadPt = await centerOf('.ehm-card[data-ehm-card="CompactionEngine"] .ehm-name-row')
    await moveTo(proxyHeadPt.x, proxyHeadPt.y); await delay(180)
    await doubleClick(proxyHeadPt.x, proxyHeadPt.y)
    await delay(260)
    const b2 = await evaluate(`(function(){
      var ts = document.querySelectorAll('.ehm-toast'); var t = ts.length ? ts[ts.length - 1] : null
      var cs = t ? getComputedStyle(t) : null
      var fetches = (window.__jumpFetch || []).map(function (x) { return x.url })
      var body = (window.__jumpFetch || []).map(function (x) { return x.body })[0] || null
      var out = {
        intent: window.__lastIntent || null,
        toast: t ? { shown: t.classList.contains('show'), opacity: cs.opacity, text: t.textContent } : null,
        fetches: fetches, body: body,
      }
      window.fetch = window.__origFetch
      window.__EHM_META__.jumpUrl = null
      window.__jumpFetch = []
      return out
    })()`)
    standaloneJump = { b1: b1, b2: b2 }
    console.log('  独立窗口跳转:', JSON.stringify(standaloneJump))
    // 清掉 toast，避免跟后续截图串味
    await evaluate("document.querySelectorAll('.ehm-toast').forEach(function (x) { x.classList.remove('show') })")
    await moveTo(60, 400); await delay(160)
  }

  /* ── 5c. 方法含义（member.summary）+ 可见性前缀（P13-C） ── */
  console.log('\n[5c] 方法含义 member.summary + + - # ~ 可见性')
  await mouseDown(60, 400); await mouseUp(60, 400); await delay(180)
  const SUMMARY_TEXT = '【P13 测试】把会话交给语言模型生成结构化摘要（方法含义）'
  let memberSummary = null
  const injected = await evaluate(`(function(){
    var model = window.__viewer.model
    var ent = null
    for (var i = 0; i < model.entities.length; i++) if (model.entities[i].id === 'BasicCompactionEngine') ent = model.entities[i]
    if (!ent) return null
    var withSummary = ent.methods[0]
    var without = ent.methods[3]
    withSummary.summary = ${JSON.stringify(SUMMARY_TEXT)}
    without.summary = ''
    return {
      withSummary: { name: withSummary.name, summary: withSummary.summary, visibility: withSummary.visibility },
      without: { name: without.name, summary: without.summary, visibility: without.visibility },
    }
  })()`)
  if (injected) {
    await moveTo(60, 400); await delay(140)
    const withPt = await centerOf('.ehm-row[data-ehm-row="BasicCompactionEngine#methods#0"]')
    await moveTo(withPt.x, withPt.y); await delay(420)
    const withSummary = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      var sm = b.querySelector('.ehm-bubble-summary')
      return {
        shown: b.classList.contains('show'),
        title: (b.querySelector('.ehm-bubble-title') || {}).textContent,
        summary: sm ? sm.textContent : null,
        headRows: b.querySelectorAll('.ehm-bubble-head-row').length,
        h: Math.round(b.getBoundingClientRect().height),
      }
    })()`)
    const withoutPt = await centerOf('.ehm-row[data-ehm-row="BasicCompactionEngine#methods#3"]')
    await moveTo(withoutPt.x, withoutPt.y); await delay(420)
    const noSummary = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      return {
        shown: b.classList.contains('show'),
        summaryCount: b.querySelectorAll('.ehm-bubble-summary').length,
        title: (b.querySelector('.ehm-bubble-title') || {}).textContent,
      }
    })()`)
    await moveTo(60, 400); await delay(820)
    const visibility = await evaluate(`(function(){
      var model = window.__viewer.model
      var byId = {}
      for (var i = 0; i < model.entities.length; i++) byId[model.entities[i].id] = model.entities[i]
      var rows = document.querySelectorAll('.ehm-row[data-ehm-row]')
      var counts = {}, mismatches = [], badPrefix = []
      for (var j = 0; j < rows.length; j++) {
        var d = rows[j].getAttribute('data-ehm-row')
        var parts = d.split('#')
        var ent = byId[parts[0]]
        if (!ent) continue
        var list = parts[1] === 'fields' ? ent.fields : ent.methods
        var m = list[parseInt(parts[2], 10)]
        var text = (rows[j].querySelector('.ehm-row-text') || {}).textContent || ''
        var ch = text.charAt(0)
        if ('+-#~'.indexOf(ch) < 0) badPrefix.push(d + ':' + text.slice(0, 24))
        if (m && m.visibility) {
          counts[m.visibility] = (counts[m.visibility] || 0) + 1
          if (ch !== m.visibility) mismatches.push(d + ':' + ch + '!=' + m.visibility)
        }
      }
      return { total: rows.length, counts: counts, mismatches: mismatches, badPrefix: badPrefix }
    })()`)
    memberSummary = { injected: injected, withSummary: withSummary, noSummary: noSummary, visibility: visibility }
    console.log('  方法含义:', JSON.stringify(memberSummary))
  }

  /* ── 6. 悬停连线 + 标签 ── */
  console.log('\n[6] 悬停连线标签 → 关系证据气泡')
  const wirePt = await evaluate(`(function(){
    var lb = document.querySelector('.ehm-label')
    if (!lb) return null
    var r = lb.getBoundingClientRect()
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }
  })()`)
  let wireInfo = null
  if (wirePt) {
    await moveTo(wirePt.x - 150, wirePt.y - 100)
    await delay(200)
    await moveTo(wirePt.x, wirePt.y)
    await delay(560)
    // 场景三断言：连线用「鼠标点 ±7px 局部锚点」当 owner（不再用整条 <g> 的 bbox）
    wireCheck = await readBubbleMetrics(null, wirePt.x, wirePt.y, true)
    wireInfo = wireCheck
    console.log('  连线气泡:', JSON.stringify(wireInfo))
    await shoot(SHOT_PREFIX + '05-hover-wire-bubble.png')
  }

  /* ── 7. 主题菜单：5 套内置主题 ── */
  console.log('\n[7] 主题菜单：DSH 深/浅、Graphite、Editorial、Carbon')
  await keyDown('Escape', 'Escape', 27, 0)
  await keyUp('Escape', 'Escape', 27, 0)
  await delay(120)
  await mouseDown(60, 400); await mouseUp(60, 400)
  await delay(120)
  await evaluate("document.querySelector('[data-ehm-action=\"theme\"]').click()")
  await delay(220)
  const themeMenu = await evaluate(`(function(){
    var menu = document.querySelector('.ehm-theme-menu')
    return {
      open: !!(menu && menu.classList.contains('open')),
      count: menu ? menu.querySelectorAll('[data-ehm-skin]').length : 0,
      options: menu ? [...menu.querySelectorAll('[data-ehm-skin]')].map(function (x) { return x.getAttribute('data-ehm-skin') }) : [],
      current: window.__viewer.getSkin(),
    }
  })()`)
  console.log('  主题菜单:', JSON.stringify(themeMenu))
  await shoot(SHOT_PREFIX + '06-theme-menu.png')
  await mouseDown(60, 500); await mouseUp(60, 500)
  await delay(150)
  const themeMenuClosed = await evaluate("!document.querySelector('.ehm-theme-menu').classList.contains('open')")
  console.log('  点外部关闭主题菜单 =', themeMenuClosed)
  async function chooseSkin(id) {
    await evaluate("document.querySelector('[data-ehm-action=\"theme\"]').click()")
    await delay(120)
    await evaluate(`document.querySelector('.ehm-theme-item[data-ehm-skin="${id}"]').click()`)
    await delay(300)
  }
  await chooseSkin('dsh-light')
  await evaluate('window.__viewer.fit()')
  await delay(220)
  await shoot(SHOT_PREFIX + '06-overview-light.png')
  const lightOk = await evaluate("document.querySelector('.ehm-root').classList.contains('ehm-theme-light') && window.__viewer.getSkin() === 'dsh-light'")
  console.log('  DSH 浅色生效 =', lightOk)

  const skinChecks = {}
  for (const skin of ['graphite', 'carbon', 'editorial']) {
    await chooseSkin(skin)
    await evaluate('window.__viewer.fit()')
    await delay(220)
    skinChecks[skin] = await evaluate(`(function(){
      var root = document.querySelector('.ehm-root')
      return { skin: window.__viewer.getSkin(), attr: root.getAttribute('data-ehm-skin'), theme: window.__viewer.getTheme() }
    })()`)
    await shoot(SHOT_PREFIX + `09-theme-${skin}.png`)
    console.log('  主题', skin, '=', JSON.stringify(skinChecks[skin]))
  }
  await chooseSkin('dsh-dark')
  await evaluate('window.__viewer.fit()')
  await delay(180)

  /* ── 8. 折叠方法（viewer API；顶栏已不再放这个按钮） ── */
  console.log('\n[8] 折叠方法模式（API）')
  await evaluate("window.__viewer.setMethodsMode('collapsed')")
  await delay(500)
  await evaluate('window.__viewer.fit()')
  await delay(250)
  const collapsed = await evaluate('JSON.stringify(window.__viewer.diagnose())')
  const cd = JSON.parse(collapsed)
  console.log(`  折叠后 scene=${cd.scene.width}x${cd.scene.height} 重叠=${cd.cardOverlaps.length} 压线=${cd.labelOnWire.length} 溢出=${cd.textOverflow.length}`)
  await shoot(SHOT_PREFIX + '07-methods-collapsed.png')

  /* ── 9. 工具栏「在侧栏打开」/ Alt+拖拽平移 / Alt+滚轮缩放 ── */
  console.log('\n[9] 工具栏、Alt+左键拖拽平移、Alt+滚轮缩放')
  const toolbarCheck = await evaluate(`(function(){
    var bar = document.querySelector('.ehm-bar')
    var sidebar = bar ? bar.querySelector('[data-ehm-action="sidebar"]') : null
    var collapse = bar ? bar.querySelector('[data-ehm-action="collapse"]') : null
    return { hasSidebar: !!sidebar, hasCollapse: !!collapse, text: sidebar ? sidebar.textContent : '' }
  })()`)
  console.log('  工具栏:', JSON.stringify(toolbarCheck))
  await evaluate("document.querySelector('[data-ehm-action=\"sidebar\"]').click()")
  await delay(180)
  await evaluate('window.__viewer.fit()')
  await delay(200)
  const panBefore = await evaluate('({x: window.__viewer.diagnose().view.x, y: window.__viewer.diagnose().view.y})')
  // 双击空白不应重置画布
  await doubleClick(80, 420)
  await delay(180)
  const viewAfterBlankDbl = await evaluate('({x: window.__viewer.diagnose().view.x, y: window.__viewer.diagnose().view.y})')
  const dblBlankCheck = { before: panBefore, after: viewAfterBlankDbl, unchanged: viewAfterBlankDbl.x === panBefore.x && viewAfterBlankDbl.y === panBefore.y }
  console.log('  双击空白保持视图:', JSON.stringify(dblBlankCheck))
  const relationTarget = await evaluate(`(function(){
    var rels = window.__viewer.model.relations
    for (var i = 0; i < rels.length; i++) {
      var t = window.__viewer.relationMethodTarget(rels[i].id)
      if (t && (t.kind === 'method' || t.kind === 'field')) return { rel: rels[i].id, target: t }
    }
    return null
  })()`)
  console.log('  双击线条关联方法:', JSON.stringify(relationTarget))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 80, y: 420, button: 'left', buttons: 1, clickCount: 1, modifiers: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 470, button: 'left', buttons: 1, modifiers: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 150, y: 470, button: 'left', buttons: 0, clickCount: 1, modifiers: 1 })
  await delay(200)
  const panAfter = await evaluate('({x: window.__viewer.diagnose().view.x, y: window.__viewer.diagnose().view.y})')
  const panCheck = { before: panBefore, after: panAfter, moved: panAfter.x !== panBefore.x || panAfter.y !== panBefore.y }
  console.log('  Alt 拖拽:', JSON.stringify(panCheck))
  await evaluate('window.__viewer.fit()')
  await delay(160)
  // 回归：Alt 拖拽之后普通单击仍应能选中并固定（drag.moves 不能长期残留）
  await evaluate("window.__viewer.setMethodsMode('expanded')")
  await delay(300)
  await evaluate('window.__viewer.fit()')
  await delay(160)
  const postPanRow = await centerOf('.ehm-methods-row')
  let postPanSelect = null
  if (postPanRow) {
    await mouseDown(postPanRow.x, postPanRow.y)
    await mouseUp(postPanRow.x, postPanRow.y)
    await delay(260)
    postPanSelect = await evaluate(`(function(){
      var b = document.querySelector('.ehm-bubble')
      return { locked: b.classList.contains('locked'), selected: document.querySelectorAll('.ehm-selected').length }
    })()`)
    console.log('  拖拽后单击选中:', JSON.stringify(postPanSelect))
    await mouseDown(60, 400); await mouseUp(60, 400); await delay(180)
  }

  const zoomPt = await centerOf('.ehm-card[data-ehm-card="BasicCompactionEngine"]')
  // 选中气泡若仍显示会拦截滚轮（设计如此）；缩放测试前先确保气泡清掉。
  await evaluate("document.querySelector('.ehm-bubble').classList.remove('show')")
  const zoomBefore = await evaluate('window.__viewer.diagnose().view.k')
  if (zoomPt) {
    for (let i = 0; i < 5; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: zoomPt.x, y: zoomPt.y, deltaX: 0, deltaY: -120, modifiers: 1,
      })
      await delay(80)
    }
  }
  await delay(300)
  const zoomAfter = await evaluate('window.__viewer.diagnose().view.k')
  const zoomCheck = { before: zoomBefore, after: zoomAfter, zoomed: zoomAfter > zoomBefore }
  console.log('  Alt 滚轮缩放:', JSON.stringify(zoomCheck))
  await shoot(SHOT_PREFIX + '08-zoom-detail.png')

  /* ── IR 级方法端点回归：sample.ir.json 自带 from.member/to.member；CLI/UML 不产出 ── */
  let methodEndpointCheck = null
  try {
    const ir = JSON.parse(readFileSync(join(ROOT, 'spec', 'sample.ir.json'), 'utf8'))
    const methodHtml = join(tmpdir(), 'ehm-method-endpoints.html')
    writeFileSync(methodHtml, buildHtml(ir, { theme: 'dark', title: 'method endpoints', direction: 'TB', bakeEngine: true }), 'utf8')
    await cdp.send('Page.navigate', { url: 'file:///' + methodHtml.replace(/\\/g, '/') })
    await delay(1800)
    methodEndpointCheck = await evaluate('JSON.stringify(window.__viewer.diagnose())').then((s) => {
      const md = JSON.parse(s)
      return {
        methodPorts: md.methodPorts,
        wireEndpoints: md.wireEndpoints,
        wireOnCard: md.wireOnCard,
        wireOnAnyCard: md.wireOnAnyCard,
        sharedStarts: md.sharedStarts,
        sharedEnds: md.sharedEnds,
        wireOverlaps: md.wireOverlaps,
        wireTouches: md.wireTouches,
        wireProximities: md.wireProximities,
      }
    })
    console.log('  方法级端点:', JSON.stringify(methodEndpointCheck))
  } catch (e) {
    methodEndpointCheck = { error: e && e.message ? e.message : String(e) }
    console.log('  方法级端点: ERROR', methodEndpointCheck.error)
  }

  /* ── 汇总 ── */
  const summary = {
    shots: shotLog.map((p) => p.replace(ROOT + '\\', '').replace(/\\/g, '/')),
    geometry: {
      scene: d.scene, cards: d.cards, segments: d.segments, labels: d.labels, viewK: d.view.k,
      fanoutPack: d.fanoutPack || null,
      cardOverlaps: d.cardOverlaps.length,
      diagonalSegments: d.diagonalSegments.length,
      wireOnCard: d.wireOnCard.length,
      wireOnAnyCard: (d.wireOnAnyCard || []).length,
      sharedStarts: (d.sharedStarts || []).length,
      sharedEnds: (d.sharedEnds || []).length,
      wireProximities: (d.wireProximities || []).length,
      wireCrossings: (d.wireCrossings || []).length,
      wireOverlaps: (d.wireOverlaps || []).length,
      wireTouches: (d.wireTouches || []).length,
      wireEndpointBad: (d.wireEndpoints ? d.wireEndpoints.bad.length : 0),
      wireEndpointsChecked: d.wireEndpoints ? d.wireEndpoints.checked : 0,
      methodPortsChecked: d.methodPorts ? d.methodPorts.checked : 0,
      labelOnCard: d.labelOnCard.length,
      labelOnWire: d.labelOnWire.length,
      labelOutOfBounds: d.labelOutOfBounds.length,
      textOverflow: d.textOverflow.length,
      heightDrift: d.heightDrift.length,
      rowPitchDeviation: d.rowPitchDeviation.length,
    },
    // 气泡断言口径：bubbleRectDist = 气泡矩形到鼠标点的最短距离（px），阈值 ≤ 80
    bubbleThresholds: { bubbleRectDistMax: 80 },
    entityBubble: bubbleCheck || null,
    altBubble: altBubbleCheck || null,
    methodBubble: methodCheck || null,
    methodFollow: methodFollow || null,
    wireBubble: wireInfo || null,
    bubble: bubbleCheck || null, // 兼容旧字段名
    lockedBubble: lockCheck || null,
    outsideClickClosed: closed === false,
    lightThemeOk: lightOk === true,
    themeMenu: themeMenu,
    themeMenuClosed: themeMenuClosed,
    skinChecks: skinChecks,
    panCheck: panCheck,
    zoomCheck: zoomCheck,
    sidePanel: toolbarCheck,
    doubleClickBlank: dblBlankCheck,
    relationMethodTarget: relationTarget,
    postPanSelect: postPanSelect,
    // P13-A：长代码 hover 气泡可达性 + 滚轮滚代码（不缩放画布）
    longBubble: longBubble || null,
    // P13-B：独立窗口点击跳转的可见反馈（b1 = 无 jumpUrl；b2 = 伪代理页有 jumpUrl）
    standaloneJump: standaloneJump || null,
    // P13-C：方法含义 member.summary 显示 + 可见性前缀
    memberSummary: memberSummary || null,
    collapsedGeometry: {
      scene: cd.scene, cardOverlaps: cd.cardOverlaps.length, labelOnWire: cd.labelOnWire.length,
    },
    methodEndpointCheck,
    router: routerCheck,
  }
  writeFileSync(join(SHOTS, 'shots-report.json'), JSON.stringify(summary, null, 2), 'utf8')
  console.log('\n汇总写入 poc/shots/shots-report.json')

  /* ── 视觉验收硬断言：任何一项不达标都让工具非零退出，而不是只在屏幕上打印 ── */
  const failures = []
  const zero = (label, n) => { if (n !== 0) failures.push(`${label}=${n}`) }
  // 正交线段关系自检：竖线重叠曾经漏判（只测了横线），这里固定住。
  if (routerCheck.verticalOverlap !== 2) failures.push('router.verticalOverlap=' + routerCheck.verticalOverlap)
  if (routerCheck.horizontalOverlap !== 2) failures.push('router.horizontalOverlap=' + routerCheck.horizontalOverlap)
  if (routerCheck.verticalSeparate !== 0) failures.push('router.verticalSeparate=' + routerCheck.verticalSeparate)
  if (routerCheck.perpendicular !== 1) failures.push('router.perpendicular=' + routerCheck.perpendicular)
  if (routerCheck.verticalNear !== 4) failures.push('router.verticalNear=' + routerCheck.verticalNear)
  if (routerCheck.horizontalNear !== 4) failures.push('router.horizontalNear=' + routerCheck.horizontalNear)
  if (routerCheck.nearSeparate !== 0) failures.push('router.nearSeparate=' + routerCheck.nearSeparate)
  zero('cardOverlaps', d.cardOverlaps.length)
  zero('diagonalSegments', d.diagonalSegments.length)
  zero('wireOnCard', d.wireOnCard.length)
  zero('wireOnAnyCard', (d.wireOnAnyCard || []).length)
  zero('sharedStarts', (d.sharedStarts || []).length)
  zero('sharedEnds', (d.sharedEnds || []).length)
  zero('wireProximities', (d.wireProximities || []).length)
  // 高扇出叶子层打包必须生效，并且真的变窄（否则布局退化为一张超宽图）。
  if (!d.fanoutPack || d.fanoutPack.applied !== true) failures.push('fanoutPack.notApplied')
  else if (d.scene.width >= d.fanoutPack.oldWidth * 0.8) failures.push('fanoutPack.notNarrower')
  zero('wireCrossings', (d.wireCrossings || []).length)
  zero('wireOverlaps', (d.wireOverlaps || []).length)
  zero('wireTouches', (d.wireTouches || []).length)
  zero('wireEndpointBad', d.wireEndpoints ? d.wireEndpoints.bad.length : 0)
  // CLI/UML 链路没有 relation member，方法级端口检查必须为 0；方法级只在直接 IR 回归里验证。
  if (d.methodPorts && d.methodPorts.checked !== 0) failures.push('cliMethodPortsChecked=' + d.methodPorts.checked)
  if (methodEndpointCheck === null || methodEndpointCheck.error) {
    failures.push('methodEndpointCheck:' + (methodEndpointCheck && methodEndpointCheck.error ? methodEndpointCheck.error : 'null'))
  } else {
    const mp = methodEndpointCheck.methodPorts || { checked: 0, bad: [] }
    const we = methodEndpointCheck.wireEndpoints || { checked: 0, bad: [] }
    if (mp.checked === 0) failures.push('methodPorts.checked=0')
    if ((mp.bad || []).length > 0) failures.push('methodPorts.bad=' + mp.bad.length)
    if ((we.bad || []).length > 0) failures.push('methodWireEndpointBad=' + we.bad.length)
    if ((methodEndpointCheck.wireOnCard || []).length > 0) failures.push('methodWireOnCard=' + methodEndpointCheck.wireOnCard.length)
    if ((methodEndpointCheck.wireOnAnyCard || []).length > 0) failures.push('methodWireOnAnyCard=' + methodEndpointCheck.wireOnAnyCard.length)
    if ((methodEndpointCheck.sharedStarts || []).length > 0) failures.push('methodSharedStarts=' + methodEndpointCheck.sharedStarts.length)
    if ((methodEndpointCheck.sharedEnds || []).length > 0) failures.push('methodSharedEnds=' + methodEndpointCheck.sharedEnds.length)
    // 方法级 IR 样例强制方法行端口，行距本身可能小于 MIN_WIRE_GAP；
    // 这里只断言共享端点/穿卡/重叠，不把“贴线”当方法端口回归失败。
    if ((methodEndpointCheck.wireOverlaps || []).length > 0) failures.push('methodWireOverlaps=' + methodEndpointCheck.wireOverlaps.length)
  }
  zero('labelOnCard', d.labelOnCard.length)
  zero('labelOnWire', d.labelOnWire.length)
  zero('labelOutOfBounds', d.labelOutOfBounds.length)
  zero('textOverflow', d.textOverflow.length)
  zero('heightDrift', d.heightDrift.length)

  // 三类悬停场景：实体头 / 方法行 / 连线，逐项断言
  //   a) 不与被悬停元素（或连线局部锚点）相交；b) 气泡矩形到鼠标 ≤ 120px；
  //   c) 不包含鼠标点；d) 不压任何卡片；e) 不超出视口；f) 气泡里有真实源码。
  assertBubble('entityBubble', bubbleCheck)
  if (!altBubbleCheck.hidden) failures.push('Alt 未收起代码悬浮框')
  if (!altBubbleCheck.heldSuppressed) failures.push('Alt 按住期间仍出现代码悬浮框')
  if (!altBubbleCheck.releasedRestored) failures.push('松开 Alt 后代码悬浮框未恢复')
  if (!altBubbleCheck.wireHeldSuppressed) failures.push('Alt 按住期间悬停连线仍出现代码框')
  if (!altBubbleCheck.wireReleasedRestored) failures.push('松开 Alt 后连线代码框未恢复')
  assertBubble('methodBubble', methodCheck)
  assertBubble('wireBubble', wireCheck)
  for (const f of bubbleFailures) failures.push(f)
  const fmtBubble = (c) => (c && c.shown)
    ? `dist=${c.bubbleRectDist.toFixed(1)}px ownerOverlap=${c.ownerOverlap} mouseInside=${c.mouseInsideBubble} cards=${c.cardsOverlapped.length} scale=${c.bubble.w}x${c.bubble.h}`
    : '未显示'
  console.log('\n气泡断言: entity[' + fmtBubble(bubbleCheck) + '] method[' + fmtBubble(methodCheck) + '] wire[' + fmtBubble(wireCheck) + ']')

  /* ── P13-A：长代码 hover 气泡可达性 + 滚轮滚代码（不缩放画布） ── */
  if (!longBubble) failures.push('longBubble=找不到可滚动的长代码 hover 气泡')
  else {
    if (!(longBubble.scrollH > longBubble.clientH + 2)) failures.push('longBubble 不可滚动 scrollH=' + longBubble.scrollH + ' clientH=' + longBubble.clientH)
    if (!(longBubble.hover.scrollTopAfter <= longBubble.hover.scrollTopBefore + 1)) failures.push('hover 态滚轮居然滚了代码（应纯展示）：' + longBubble.hover.scrollTopBefore + '→' + longBubble.hover.scrollTopAfter)
    if (Math.abs(longBubble.hover.kAfter - longBubble.hover.kBefore) > 1e-9) failures.push('hover 态滚轮缩放了画布（k ' + longBubble.hover.kBefore + '→' + longBubble.hover.kAfter + '）')
    if (longBubble.hover.stillHover !== true) failures.push('hover 态滚轮后气泡不再显示')
    if (!(longBubble.locked.scrollTopAfter > longBubble.locked.scrollTopBefore + 8)) failures.push('锁定态滚轮没有滚代码（' + longBubble.locked.scrollTopBefore + '→' + longBubble.locked.scrollTopAfter + '）')
    if (Math.abs(longBubble.locked.kAfter - longBubble.locked.kBefore) > 1e-9) failures.push('锁定态滚轮同时缩放了画布（k ' + longBubble.locked.kBefore + '→' + longBubble.locked.kAfter + '）')
    if (longBubble.hiddenAfterOutside !== true) failures.push('点击外部后锁定气泡未关闭')
    if (!longBubble.title) failures.push('longBubble.title 缺失')
  }

  /* ── P13-B：独立窗口点击跳转必须有可见反馈（b1 无 jumpUrl / b2 伪代理页有 jumpUrl） ── */
  if (!standaloneJump) failures.push('standaloneJump=未测到独立窗口跳转')
  else {
    const j1 = standaloneJump.b1, j2 = standaloneJump.b2
    if (!j1 || !j1.standalone) failures.push('standaloneJump.b1 不是独立窗口')
    if (!j1 || !j1.intent || !j1.intent.file) failures.push('standaloneJump.b1 点击未触发 onJump（__lastIntent 缺失）')
    if (!j1 || !j1.toast || !j1.toast.shown) failures.push('standaloneJump.b1 toast 未显示（独立窗口点击无可见反馈）')
    else {
      if (!(Number(j1.toast.opacity) > 0.5)) failures.push('standaloneJump.b1 toast opacity=' + j1.toast.opacity + '（不可见）')
      if (j1.intent && j1.toast.text.indexOf(j1.intent.file + ':' + j1.intent.line) < 0) failures.push('standaloneJump.b1 toast 未包含位置 ' + j1.intent.file + ':' + j1.intent.line)
    }
    if (!j2 || !j2.intent) failures.push('standaloneJump.b2 点击未触发 onJump')
    if (!j2 || !j2.toast || !j2.toast.shown || !(Number(j2.toast.opacity) > 0.5)) failures.push('standaloneJump.b2 toast 不可见（代理页独立窗口无反馈）')
    else {
      if (!/DSH|宿主|已交给|已记录/u.test(j2.toast.text)) failures.push('standaloneJump.b2 toast 未提示宿主处理：' + j2.toast.text)
    }
    if (!j2 || !Array.isArray(j2.fetches) || j2.fetches.indexOf('/ehm/jump-relay/abc') < 0) failures.push('standaloneJump.b2 未 POST 到 jumpUrl（fetches=' + JSON.stringify(j2 && j2.fetches) + '）')
    else if (!j2.body || j2.body.indexOf('"file"') < 0) failures.push('standaloneJump.b2 POST body 不是跳转 intent')
  }

  /* ── P13-C：方法含义（member.summary）显示 + + - # ~ 可见性前缀 ── */
  if (!memberSummary) failures.push('memberSummary=未测到 member.summary 渲染')
  else {
    const w = memberSummary.withSummary, n = memberSummary.noSummary, v = memberSummary.visibility
    if (!w || !w.shown) failures.push('memberSummary.withSummary 气泡未显示')
    else {
      if (w.summary !== SUMMARY_TEXT) failures.push('memberSummary.summary 未显示（得到 ' + JSON.stringify(w.summary) + '）')
      if (!w.title || w.title.indexOf(memberSummary.injected.withSummary.name) < 0) failures.push('memberSummary.title 不是成员声明行：' + w.title)
      if (w.headRows !== 1) failures.push('memberSummary.headRows=' + w.headRows + '（header 结构异常）')
    }
    if (!n || !n.shown) failures.push('memberSummary.noSummary 气泡未显示')
    else if (n.summaryCount !== 0) failures.push('memberSummary.noSummary 出现了 summary 空行（count=' + n.summaryCount + '）')
    if (!v) failures.push('visibility=未采集')
    else {
      if (v.mismatches && v.mismatches.length > 0) failures.push('visibility.mismatches=' + v.mismatches.join(','))
      if (v.badPrefix && v.badPrefix.length > 0) failures.push('visibility.badPrefix=' + v.badPrefix.join(','))
    }
  }
  const fmtLong = longBubble
    ? `hover scroll ${longBubble.hover.scrollTopBefore}→${longBubble.hover.scrollTopAfter} (k ${longBubble.hover.kBefore}→${longBubble.hover.kAfter}); locked scroll ${longBubble.locked.scrollTopBefore}→${longBubble.locked.scrollTopAfter}; hiddenAfterOutside=${longBubble.hiddenAfterOutside}`
    : '未测到'
  const fmtJump = standaloneJump
    ? `b1=${JSON.stringify(standaloneJump.b1.toast && standaloneJump.b1.toast.text)} b2=${JSON.stringify(standaloneJump.b2.toast && standaloneJump.b2.toast.text)}`
    : '未测到'
  const fmtSummary = memberSummary
    ? `text=${JSON.stringify(memberSummary.withSummary && memberSummary.withSummary.summary)} vis=${JSON.stringify(memberSummary.visibility && memberSummary.visibility.counts)}`
    : '未测到'
  console.log('\nP13 断言: longBubble[' + fmtLong + '] jump[' + fmtJump + '] summary[' + fmtSummary + ']')

  if (!lockCheck || lockCheck.locked !== true) failures.push('单击选中未固定气泡')
  if (lockCheck && lockCheck.rowSelected !== true) failures.push('单击后方法行未选中（ehm-selected）')
  if (!panCheck || panCheck.moved !== true) failures.push('Alt+左键拖拽未平移画布')
  if (!zoomCheck || zoomCheck.zoomed !== true) failures.push('Alt+滚轮未缩放画布')
  if (!toolbarCheck || toolbarCheck.hasSidebar !== true || toolbarCheck.hasCollapse === true) failures.push('工具栏缺少「在侧栏打开」或仍残留折叠方法按钮')
  if (!dblBlankCheck || dblBlankCheck.unchanged !== true) failures.push('双击空白重置了画布')
  if (!relationTarget) failures.push('双击线条没有解析到关联方法目标')
  if (!postPanSelect || postPanSelect.locked !== true || postPanSelect.selected < 1) failures.push('Alt 拖拽后单击选中失效')
  if (closed !== false) failures.push('outsideClickClosed=false（点外部没关掉气泡）')
  if (lightOk !== true) failures.push('lightThemeOk=false')
  if (!themeMenu || themeMenu.open !== true || themeMenu.count !== 5) failures.push('主题菜单未打开或不是 5 套主题')
  if (themeMenuClosed !== true) failures.push('点击菜单外未关闭主题菜单')
  if (themeMenu && themeMenu.current !== 'dsh-dark') failures.push('默认主题不是 DSH 深色')
  for (const skin of ['graphite', 'carbon', 'editorial']) {
    if (!skinChecks[skin] || skinChecks[skin].skin !== skin || skinChecks[skin].attr !== skin) failures.push('主题切换失败：' + skin)
  }
  if (failures.length > 0) throw new Error('视觉验收失败：' + failures.join('；'))

  await cdp.send('Browser.close').catch(() => {})
  chrome.kill()
}

main().then(() => {
  console.log('\n完成。')
  process.exit(0)
}).catch((e) => {
  console.error('失败:', e && e.stack ? e.stack : e)
  chrome.kill()
  process.exit(1)
})

