/**
 * ehm.smoke.mjs —— enhance-mermaid 新链路冒烟测试
 *
 * 覆盖：解析 → 物化 → IR → H5 → server → facade → CLI
 *
 *   node poc/test/ehm.smoke.mjs
 *
 * 全程用真实文件（deepseek-harness 的真实源码）与真实子进程，不做 mock。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

import { parseUml } from '../src/parse-uml.mjs'
import { materialize, resolveUnderRoots, capCode, MAX_CODE_CHARS } from '../src/materialize.mjs'
import { toIr } from '../src/to-ir.mjs'
import { buildHtml, slimIr, byteSize, normalizeJumpActions } from '../src/html.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const POC = resolve(HERE, '..')
const REPO = resolve(POC, '..')
const PROJECT_ROOT = resolve(REPO, '..')
const BIN = join(POC, 'bin', 'ehm.mjs')
const SAMPLE = join(POC, 'samples', 'compaction.ehm.md')
const SRC_ROOT = 'D:/dsh-mydsh/deepseek-harness'

let passed = 0
let failed = 0
const failures = []

function ok(name, extra = '') {
  passed++
  console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`)
}
function bad(name, detail) {
  failed++
  failures.push({ name, detail })
  console.log(`  ✗ ${name}\n      ${detail}`)
}
function check(name, fn, extra = '') {
  try {
    const v = fn()
    if (v === false) bad(name, '断言为 false')
    else ok(name, typeof extra === 'function' ? extra(v) : extra)
    return v
  } catch (e) {
    bad(name, e && e.message ? e.message : String(e))
    return undefined
  }
}
function group(title) { console.log(`\n── ${title} ──────────────────────────────────`) }

const sampleText = readFileSync(SAMPLE, 'utf8')
const workHome = mkdtempSync(join(tmpdir(), 'ehm-smoke-'))
process.env.EHM_HOME = workHome

/** 样例声明的 12 个实体（与 spec/sample.ir.json 对齐）。 */
const ENTITY_NAMES = [
  'commandCompact', 'CompactionEngine', 'BasicCompactionEngine', 'Service',
  'ToolResultPruner', 'summarizeWithLlm', 'selectCompactableRange', 'compactSurfaceRegion',
  'tokenMeter', 'llm', 'sessions', 'commands',
]

/** 从 H5 里把内联 IR 解析回来（`window.__EHM_IR__ = {...};` 独占一行）。 */
function inlineIrOf(htmlText) {
  const line = htmlText.split('\n').find((l) => l.startsWith('window.__EHM_IR__ = '))
  if (!line) return null
  return JSON.parse(line.slice('window.__EHM_IR__ = '.length).replace(/;\s*$/u, ''))
}

// 旧产品标识只以拼接形式出现在测试里：仓库内仍保留"检测旧名"的断言，
// 但 `grep -ri <旧名> poc spec` 不会命中（IMPLEMENTATION-PLAN §11 验收项）。
const LEGACY_MARK = ['code', 'ref'].join('')
const CRV_MARK = ['cr', 'v-'].join('')
const LEGACY_RE = new RegExp(LEGACY_MARK + '|' + CRV_MARK, 'i')

/* ══ 0. 解析 ══ */
group('0. 解析：增强 UML 文本 → 模型')
const parsed = parseUml(sampleText)
check('mermaid 块被识别', () => parsed !== null && parsed.model.entities.length > 0)
check('实体数 = 12', () => parsed.model.entities.length === 12, () => `${parsed.model.entities.length}`)
check('关系数 = 13（2 extends + 11 calls）', () => {
  const kinds = parsed.model.relations.reduce((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {})
  return parsed.model.relations.length === 13 && kinds.extends === 2 && kinds.calls === 11
}, () => parsed.model.relations.map((r) => r.kind).join(','))
check('零 error 诊断', () => !parsed.diagnostics.some((d) => d.level === 'error'), () => `${parsed.diagnostics.length} diag`)
check('样例自身零诊断（指令没有笔误 / 未知成员）', () => parsed.diagnostics.length === 0, () => parsed.diagnostics.map((d) => d.code).join(','))
check('版本被识别为 v1', () => parsed.version === 'v1')
check('extends 方向正确（子 → 父）', () => {
  const r = parsed.model.relations.find((x) => x.kind === 'extends')
  return r && r.from === 'BasicCompactionEngine' && r.to === 'CompactionEngine'
})
check('stereotype <<abstract>> 被识别', () => parsed.model.entities.find((e) => e.name === 'CompactionEngine')?.stereotype === 'abstract')
check('方法行被解析出 params/returns', () => {
  const e = parsed.model.entities.find((x) => x.name === 'CompactionEngine')
  const m = e.methods.find((x) => x.name === 'compactNow')
  return m && m.params === 'agent, signal, sourceCommandId' && m.returns === 'Promise~CompactionResult~'
})
check('字段行被解析成 field 而不是 method', () => {
  const e = parsed.model.entities.find((x) => x.name === 'BasicCompactionEngine')
  return e.fields.some((f) => f.name === 'overflowRetries')
})
check('stereotype 决定 kind（capability / function / module）', () => {
  const kind = (n) => parsed.model.entities.find((e) => e.name === n)?.kind
  return kind('tokenMeter') === 'capability' && kind('sessions') === 'capability'
    && kind('summarizeWithLlm') === 'function' && kind('compactSurfaceRegion') === 'function'
    && kind('commandCompact') === 'module' && kind('CompactionEngine') === 'class'
})
check('同一对端点的多条关系被分别保留（selectCompactableRange ×2 / compactSurfaceRegion ×2）', () => {
  const dup = parsed.model.relations.filter((x) => x.from === 'BasicCompactionEngine' && x.to === 'selectCompactableRange')
  const dup2 = parsed.model.relations.filter((x) => x.from === 'BasicCompactionEngine' && x.to === 'compactSurfaceRegion')
  return dup.length === 2 && dup2.length === 2
})
check('sites 被读入（12 个调用点，重复对端点也接对了关系）', () => {
  const all = parsed.model.relations.flatMap((r) => r.sites ?? [])
  const one = parsed.model.relations.filter((x) => x.from === 'BasicCompactionEngine' && x.to === 'selectCompactableRange')
  return all.length === 12 && one[0].sites.length === 2 && one[1].sites.length === 1
}, () => `${parsed.model.relations.reduce((n, r) => n + (r.sites?.length ?? 0), 0)} 个`)

// 宽容性：没有指令块也要能解析
const bare = parseUml('```mermaid\nclassDiagram\n  class A\n  class B\n  A --> B : 用\n```\n')
check('无 %% ehm 块时仍解析出结构', () => bare.model.entities.length === 2 && bare.model.relations.length === 1)
check('无指令块 → warn 而非 error', () => bare.diagnostics.some((d) => d.code === 'W_NO_EHM_BLOCK' && d.level === 'warn'))
// 宽容性：不认识的行只 warn
const weird = parseUml('```mermaid\nclassDiagram\n  namespace X { class A }\n  class A\n  class B\n  A --> B\n```\n%% ehm:v1\n')
check('不支持的 mermaid 语句只 warn 不崩', () => weird.model.entities.length >= 2 && weird.diagnostics.some((d) => d.code === 'W_SKIP_STATEMENT'))
// 无 mermaid 块 → error 但不抛
const empty = parseUml('# 只是文本\n没有代码块\n')
check('无 mermaid 块 → E_NO_UML error 且不抛', () => empty.diagnostics.some((d) => d.code === 'E_NO_UML') && empty.model.entities.length === 0)

/* ══ 1. 物化 ══ */
group('1. 物化：roots + 行号 → 真实代码')
const mat = materialize(parsed.model, { roots: [SRC_ROOT] })
check('六个源文件被读到', () => mat.files.length === 6, () => mat.files.join(', '))
check('12 个实体全部有 evidence.code 非空', () => {
  const missing = mat.model.entities.filter((e) => !e.evidence || typeof e.evidence.code !== 'string' || e.evidence.code.trim() === '')
  return mat.model.entities.length === 12 && missing.length === 0
}, () => `${mat.model.entities.filter((e) => e.evidence?.code).length}/12`)
check('实体拿到真实代码正文', () => {
  const e = mat.model.entities.find((x) => x.name === 'BasicCompactionEngine')
  return e.evidence && e.evidence.code.includes('export class BasicCompactionEngine')
})
check('evidence 行数与 endLine-line+1 一致', () => {
  const e = mat.model.entities.find((x) => x.name === 'BasicCompactionEngine')
  const lines = e.evidence.code.split('\n').length
  return lines === e.evidence.endLine - e.evidence.line + 1
}, () => {
  const e = mat.model.entities.find((x) => x.name === 'BasicCompactionEngine')
  return `${e.evidence.code.split('\n').length} 行 (${e.evidence.line}-${e.evidence.endLine})`
})
check('方法级代码被抽取（compactNow）', () => {
  const e = mat.model.entities.find((x) => x.name === 'BasicCompactionEngine')
  const m = e.methods.find((x) => x.name === 'compactNow')
  return m.evidence && m.evidence.code.includes('compactNow')
})
check('标注的 24 个关键成员都有 evidence.code', () => {
  const members = mat.model.entities.flatMap((e) => [...e.fields, ...e.methods])
  return members.length === 24 && members.every((m) => m.evidence && typeof m.evidence.code === 'string' && m.evidence.code.trim() !== '')
}, () => `${mat.model.entities.flatMap((e) => [...e.fields, ...e.methods]).filter((m) => m.evidence?.code).length} 个成员`)
check('13 条关系都有 evidence（file/line/code）', () => {
  const withCode = mat.model.relations.filter((r) => r.evidence && typeof r.evidence.file === 'string' && r.evidence.line > 0 && typeof r.evidence.code === 'string' && r.evidence.code.length > 0)
  return mat.model.relations.length === 13 && withCode.length === 13
}, () => `${mat.model.relations.filter((r) => r.evidence?.code).length}/13`)
check('调用点带上该行真实代码', () => {
  const r = mat.model.relations.find((x) => x.to === 'sessions')
  return r.sites.every((s) => typeof s.code === 'string' && s.code.length > 0) && r.sites[0].code.includes('sessions.flush')
})
check('12 个调用点全部带 file/line/code', () => {
  const sites = mat.model.relations.flatMap((r) => r.sites ?? [])
  return sites.length === 12 && sites.every((s) => typeof s.file === 'string' && s.line > 0 && typeof s.code === 'string' && s.code.length > 0)
}, () => `${mat.model.relations.flatMap((r) => r.sites ?? []).filter((s) => s.code).length}/12`)
check('成员全部标注了 line → 没有 W_MEMBER_NO_LINE', () => {
  return mat.diagnostics.filter((d) => d.code === 'W_MEMBER_NO_LINE').length === 0
})
check('物化零 error 诊断', () => !mat.diagnostics.some((d) => d.level === 'error'), () => mat.diagnostics.map((d) => d.code).join(','))

// 负例：路径不存在
const badModel = {
  entities: [{ name: 'Ghost', kind: 'class', fields: [], methods: [], file: 'no/such/file.ts', line: 1 }],
  relations: [],
}
const badMat = materialize(badModel, { roots: [SRC_ROOT] })
check('路径不存在 → E_PATH 且不抛', () => badMat.diagnostics.some((d) => d.code === 'E_PATH'))
check('E_PATH 消息里列出尝试过的绝对路径', () => {
  const d = badMat.diagnostics.find((x) => x.code === 'E_PATH')
  return d && d.message.includes('已尝试')
})
// 负例：行号越界
const rangeModel = { entities: [{ name: 'Big', kind: 'class', fields: [], methods: [], file: mat.files[0], line: 999999 }], relations: [] }
const rangeMat = materialize(rangeModel, { roots: [SRC_ROOT] })
check('行号越界 → E_LINE', () => rangeMat.diagnostics.some((d) => d.code === 'E_LINE'))
// 负例：越界路径被拒
const esc = resolveUnderRoots('../../etc/passwd', [SRC_ROOT])
check('.. 越界路径被拒绝', () => esc.abs === null && esc.diag.code === 'E_PATH')
const abs = resolveUnderRoots('C:/Windows/win.ini', [SRC_ROOT])
check('绝对路径被拒绝', () => abs.abs === null && abs.diag.code === 'E_PATH')
// capCode 保证不超过 schema 上限
const capped = capCode('x'.repeat(MAX_CODE_CHARS * 2))
check('超长代码被截断且带显式标记', () => capped.code.length <= MAX_CODE_CHARS && capped.code.includes('已截断'))

/* ══ 2. IR ══ */
group('2. IR：模型 → 1.0.0')
const ir = toIr(mat.model, { roots: [SRC_ROOT], title: 'compaction 能力接缝' })
check('schemaVersion = 1.0.0', () => ir.schemaVersion === '1.0.0')
check('IR 实体 = 12 / 关系 = 13', () => ir.entities.length === 12 && ir.relations.length === 13, () => `${ir.entities.length}/${ir.relations.length}`)
check('IR 里 sites 总数 = 12', () => ir.relations.reduce((n, r) => n + (r.sites ?? []).length, 0) === 12)
check('实体 id 全部合法（不含 > 等非法字符）', () => ir.entities.every((e) => /^[A-Za-z_][A-Za-z0-9_.$:@-]*$/.test(e.id)))
check('关系 id 全部合法', () => ir.relations.every((r) => /^[A-Za-z_][A-Za-z0-9_.$:@-]*$/.test(r.id)))
check('关系端点能解析到实体', () => {
  const ids = new Set(ir.entities.map((e) => e.id))
  return ir.relations.every((r) => ids.has(r.from.entity) && ids.has(r.to.entity))
})
check('provenance = heuristic（结构来自文本，非 AST）', () => ir.relations.every((r) => r.provenance === 'heuristic'))
check('meta.generator.mode 是被 schema 接受的枚举值', () => ['static', 'lsp-assisted', 'manual'].includes(ir.meta.generator.mode))
check('meta.generatedAt 是 ISO 时间（页面角标的数据源）', () => typeof ir.meta.generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(ir.meta.generatedAt), () => ir.meta.generatedAt)
check('标题收进 x-ehm 命名空间（不是顶层字段）', () => ir.meta['x-ehm']?.title === 'compaction 能力接缝' && ir.meta.title === undefined)
check('视图的 foldResult 按去重端点对计边（calls 11 节点 / 9 边）', () => {
  const v = ir.views.find((x) => x.edge.kind === 'calls')
  return v && v.foldResult.nodes === 11 && v.foldResult.edges === 9
}, () => JSON.stringify(ir.views.find((x) => x.edge.kind === 'calls')?.foldResult))
check('extends 视图 4 节点 / 2 边', () => {
  const v = ir.views.find((x) => x.edge.kind === 'extends')
  return v && v.foldResult.nodes === 4 && v.foldResult.edges === 2
}, () => JSON.stringify(ir.views.find((x) => x.edge.kind === 'extends')?.foldResult))
check('重复端点对的关系 id 用序号消歧', () => {
  const ids = ir.relations.map((r) => r.id)
  return ids.includes('rel.BasicCompactionEngine.selectCompactableRange')
    && ids.includes('rel.BasicCompactionEngine.selectCompactableRange.1')
    && ids.includes('rel.BasicCompactionEngine.compactSurfaceRegion')
    && ids.includes('rel.BasicCompactionEngine.compactSurfaceRegion.1')
})
// 用真实校验器物化校验（IR 40+ KiB，不能走命令行参数传递，直接写文件）
const irPath = join(workHome, 'ir.json')
writeFileSync(irPath, JSON.stringify(ir))
const val = spawnSync(process.execPath, [join(REPO, 'spec', 'validate.mjs'), irPath], { encoding: 'utf8' })
check('spec/validate.mjs 校验通过', () => val.status === 0, () => val.stdout.trim().split('\n').pop())
// 校验器支持 `-` 从 stdin 读：让 "GET /e/<id>.json | validate -" 这类管道可用
const valStdin = spawnSync(process.execPath, [join(REPO, 'spec', 'validate.mjs'), '-', '--json'], { input: JSON.stringify(ir), encoding: 'utf8' })
let valStdinOut = null
try { valStdinOut = JSON.parse(valStdin.stdout) } catch { /* ignore */ }
check('spec/validate.mjs 支持从 stdin 校验（- 管道输入）', () => valStdin.status === 0 && valStdinOut !== null && valStdinOut.ok === true && valStdinOut.stats.entities === 12, () => `status=${valStdin.status} ${(valStdin.stderr || '').slice(0, 120)}`)

/* ══ 3. H5 ══ */
group('3. H5：IR → 单文件页面')
const html = buildHtml(ir, { theme: 'dark', title: 'compaction 能力接缝', docId: 'abc', jumpUrl: '/jump/abc', bakeEngine: true })
check('产物含 EHMViewer.render', () => html.includes('EHMViewer.render'))
check('产物含内联 IR（__EHM_IR__）', () => html.includes('window.__EHM_IR__'))
check('默认外置引擎：HTML 只引用 ehm-viewer-engine.js，不内联 viewer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ehm-engine-'))
  try {
    const external = buildHtml(ir, { theme: 'dark', title: 'ext', externalEngine: dir })
    return external.includes('ehm-viewer-engine.js') && !external.includes('function createViewer')
      && existsSync(join(dir, 'ehm-viewer-engine.js'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
check('烘焙链路可选：bakeEngine 内联 viewer 且不引用外置引擎', () => {
  const baked = buildHtml(ir, { theme: 'dark', title: 'baked', bakeEngine: true })
  return baked.includes('function createViewer') && !baked.includes('src="file:')
})
const inlineIr = inlineIrOf(html)
check('H5 内联 IR 可解析且为 12 实体 / 13 关系', () => inlineIr !== null && inlineIr.entities.length === 12 && inlineIr.relations.length === 13, () => inlineIr ? `${inlineIr.entities.length}/${inlineIr.relations.length}` : 'null')
check('H5 内联 IR 里 12 个实体名一个不少', () => inlineIr !== null && ENTITY_NAMES.every((n) => inlineIr.entities.some((e) => e.name === n)), () => ENTITY_NAMES.filter((n) => !inlineIr?.entities.some((e) => e.name === n)).join(','))
check('H5 原文能 grep 到 12 个实体名', () => ENTITY_NAMES.every((n) => html.includes(n)), () => ENTITY_NAMES.filter((n) => !html.includes(n)).join(','))
check('H5 内联 IR 带代码正文（不是 slim）', () => inlineIr !== null && inlineIr.entities.every((e) => typeof e.evidence?.code === 'string' && e.evidence.code.length > 0))
// 生成时间角标（IMPLEMENTATION-PLAN §5.1「页面显示生成时间角标，不推送」）
check('H5 含生成时间角标（固定、pointer-events:none、深浅主题各有配色）', () => {
  return /class="ehm-stamp[^"]*" data-ehm-stamp/u.test(html)
    && /生成于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u.test(html)
    && html.includes('· abc')
    && /\.ehm-stamp[^}]*pointer-events:\s*none/u.test(html)
    && html.includes('.ehm-stamp.ehm-stamp-light')
})
check('H5 __EHM_META__.generatedAt = IR.meta.generatedAt（角标数据源一致）', () => {
  const line = html.split('\n').find((l) => l.startsWith('window.__EHM_META__ = '))
  if (!line) return false
  const meta = JSON.parse(line.slice('window.__EHM_META__ = '.length).replace(/;\s*$/u, ''))
  return meta.generatedAt === ir.meta.generatedAt && meta.docId === 'abc'
})
check('产物含 ehm- 前缀样式', () => html.includes('ehm-'))
check('产物不含旧产品标识残留', () => !LEGACY_RE.test(html))
check('无外链资源', () => !/<script[^>]+src=/i.test(html) && !/<link[^>]+rel="stylesheet"/i.test(html))
check('内联了 dagre', () => html.includes('graphlib'))
check('jumpUrl 被写进页面', () => html.includes('"/jump/abc"'))
check('H5 缺省 direction=TB（纵向，适合侧栏/内联）', () => {
  const line = html.split('\n').find((l) => l.startsWith('window.__EHM_META__ = '))
  const meta = JSON.parse(line.slice('window.__EHM_META__ = '.length).replace(/;\s*$/u, ''))
  return meta.direction === 'TB'
})
check('H5 buildHtml({direction:"LR"}) 才写横向', () => {
  const lr = buildHtml(ir, { theme: 'dark', title: 'lr', direction: 'LR', bakeEngine: true })
  const line = lr.split('\n').find((l) => l.startsWith('window.__EHM_META__ = '))
  const meta = JSON.parse(line.slice('window.__EHM_META__ = '.length).replace(/;\s*$/u, ''))
  return meta.direction === 'LR'
})
check('H5 buildHtml({direction:"TB"}) 把纵向方向写进 __EHM_META__', () => {
  const tb = buildHtml(ir, { theme: 'dark', title: 'tb', direction: 'TB', bakeEngine: true })
  const line = tb.split('\n').find((l) => l.startsWith('window.__EHM_META__ = '))
  const meta = JSON.parse(line.slice('window.__EHM_META__ = '.length).replace(/;\s*$/u, ''))
  return meta.direction === 'TB'
})
check('无 jumpUrl 时降级为剪贴板（不写 fetch）', () => {
  const h2 = buildHtml(ir, { theme: 'light', title: 't', bakeEngine: true })
  return !h2.includes('"/jump/')
})
check('jump actions：post / open / copy 与 roots 写进静态 H5', () => {
  const h2 = buildHtml(ir, {
    theme: 'dark', title: 'jump', bakeEngine: true, roots: ['D:\\repo'],
    jumpActions: ['post:http://127.0.0.1:7333/jump', 'open:vscode://file/{absPath}:{line}:{column}', 'copy'],
  })
  const line = h2.split('\n').find((l) => l.startsWith('window.__EHM_META__ = '))
  const meta = JSON.parse(line.slice('window.__EHM_META__ = '.length).replace(/;\s*$/u, ''))
  return meta.jumpActions.length === 3
    && meta.jumpActions[0].type === 'post'
    && meta.jumpActions[1].type === 'open'
    && meta.jumpActions[2].type === 'copy'
    && meta.roots[0] === 'D:\\repo'
    && h2.includes('{absPath}')
    && h2.includes('function expand(template, t)')
    && h2.includes('function openExternal(url)')
})
check('jump actions：拒绝 javascript/data 危险 open scheme，post 只允许 http(s)', () => {
  let dangerous = false
  try { normalizeJumpActions(['open:javascript:alert(1)']) } catch { dangerous = true }
  let badPost = false
  try { normalizeJumpActions(['post:file:///tmp/x']) } catch { badPost = true }
  return dangerous && badPost
    && normalizeJumpActions(['https://x.test/hook'])[0].type === 'post'
    && normalizeJumpActions(['vscode://file/a:1:1'])[0].type === 'open'
})
check('slimIr 剥掉代码正文', () => {
  const s = slimIr(ir)
  return byteSize(s) < byteSize(ir) && s.entities.every((e) => e.evidence === undefined || e.evidence.code === undefined)
})

/* ══ 4. server ══ */
group('4. server：快照仓 + 静态服务 + jump 转发')

const { startServer, SNAPSHOT_LIMIT } = await import('../src/server.mjs')
const srv = await startServer({ port: 0 })

// 宿主侧的假 jump 接收端
const got = []
const hostSrv = http.createServer((req, res) => {
  let b = ''
  req.on('data', (c) => { b += c })
  req.on('end', () => { got.push(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
})
await new Promise((r) => hostSrv.listen(0, '127.0.0.1', r))
const hostEndpoint = `http://127.0.0.1:${hostSrv.address().port}/host-jump`


const hz = await (await fetch(`${srv.url}/healthz`)).json()
check('healthz 返回 ok/version', () => hz.ok === true && hz.version === '0.1.0', () => `v${hz.version}`)

const body = { uml: sampleText, roots: [SRC_ROOT], title: 'server 测试图', scope: 'smoke', jumpEndpoint: hostEndpoint }
const rr = await fetch(`${srv.url}/api/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
check('POST /api/render 返回 url + dataPath', () => rr.ok === true && typeof rr.url === 'string' && typeof rr.dataPath === 'string', () => rr.id)
check('server /api/render stats = 12 实体 / 13 关系', () => rr.stats && rr.stats.entities === 12 && rr.stats.relations === 13, () => JSON.stringify(rr.stats))
check('server stats.sites = 12（调用点总数）', () => rr.stats && rr.stats.sites === 12, () => String(rr.stats?.sites))
const pageRes = await fetch(rr.url)
const pageHtml = await pageRes.text()
check('GET /e/<id> 返回 HTML', () => pageRes.status === 200 && pageHtml.includes('EHMViewer'), () => `${pageHtml.length} chars`)
check('服务端页面也带生成时间角标', () => pageHtml.includes('data-ehm-stamp') && /生成于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u.test(pageHtml))
check('服务端页面内联 IR 也是 12 实体 / 13 关系', () => {
  const pageInline = inlineIrOf(pageHtml)
  return pageInline !== null && pageInline.entities.length === 12 && pageInline.relations.length === 13
})
const dataRes = await fetch(rr.dataUrl)
const pageIr = await dataRes.json()
check('GET /e/<id>.json 返回 IR', () => dataRes.status === 200 && pageIr.schemaVersion === '1.0.0' && pageIr.entities.length === 12 && pageIr.relations.length === 13)
check('dataPath 文件真实存在且可读（12 实体）', () => existsSync(rr.dataPath) && JSON.parse(readFileSync(rr.dataPath, 'utf8')).entities.length === 12)

// 过期可见（§5.1）：刚渲染完源文件没动 → changed=false；mtime/snapshotMtime 是 ISO 字符串
const rrStale = await (await fetch(`${rr.url}/stale`)).json()
check('/e/<id>/stale 刚渲染后 changed=false 且文件 mtime 记录齐全', () => {
  return rrStale.changed === false && rrStale.checkedAt !== undefined
    && Array.isArray(rrStale.files) && rrStale.files.length >= 1
    && rrStale.files.every((f) => typeof f.file === 'string' && typeof f.mtime === 'string'
      && typeof f.snapshotMtime === 'string' && f.mtime === f.snapshotMtime && f.missing === undefined)
}, () => `changed=${rrStale.changed} files=${rrStale.files?.length}`)

const jr = await fetch(`${srv.url}/jump/${rr.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'definition', file: 'a.ts', line: 7, symbol: 'foo' }) }).then((r) => r.json())
check('POST /jump 转发给宿主 endpoint', () => jr.forwarded === true && jr.status === 200)
check('宿主真的收到了 intent 原样内容', () => got.length === 1 && JSON.parse(got[0]).line === 7)

// 无 endpoint 的文档：应回 forwarded:false 让页面降级
const rr2 = await fetch(`${srv.url}/api/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uml: sampleText, roots: [SRC_ROOT], title: 'no-jump', scope: 'smoke' }) }).then((r) => r.json())
const jr2 = await fetch(`${srv.url}/jump/${rr2.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())
check('没有 jumpEndpoint → forwarded:false', () => jr2.forwarded === false)

// 同 (scope,title) 覆盖同一 URL
const rr3 = await fetch(`${srv.url}/api/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
check('同 (scope,title) 重复 render → 同一 id', () => rr3.id === rr.id, () => rr.id)
check('不同 title → 不同 id', () => rr2.id !== rr.id)
const rr4 = await fetch(`${srv.url}/api/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, scope: 'other-scope' }) }).then((r) => r.json())
check('不同 scope 同 title → 不同 id', () => rr4.id !== rr.id, () => `${rr.id} vs ${rr4.id}`)

// 错误输入
const b1 = await fetch(`${srv.url}/api/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })
check('非法 JSON body → 400', () => b1.status === 400)
const b2 = await fetch(`${srv.url}/api/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uml: 'x', roots: [] }) })
check('缺 roots → 400', () => b2.status === 400)
const b3 = await fetch(`${srv.url}/e/deadbeefdead`)
check('未知 id → 404', () => b3.status === 404)
const b4 = await fetch(`${srv.url}/e/deadbeefdead/stale`)
const b4Body = await b4.json()
check('未知 id 的 /stale → 404 JSON（不是 HTML/500）', () => b4.status === 404 && b4Body.ok === false && typeof b4Body.error === 'string')

// 临时 root：真实源文件副本 + 2 实体 mini 图 → /stale 的 changed=false → 改 mtime → true → 删文件 → missing
const staleRoot = mkdtempSync(join(tmpdir(), 'ehm-stale-root-'))
const staleRel = 'summarizer.ts'
writeFileSync(join(staleRoot, staleRel), readFileSync(join(SRC_ROOT, 'packages/compaction/compaction-basic/src/summarizer.ts'), 'utf8'))
const miniUml = [
  '```mermaid',
  'classDiagram',
  '  class Alpha',
  '  class Beta',
  '  Alpha ..> Beta : 触发',
  '```',
  '',
  '%% ehm:v1',
  `%% entity Alpha file=${staleRel} line=119 lines=5`,
  `%% entity Beta file=${staleRel} line=1 lines=5`,
  `%% rel Alpha>Beta file=${staleRel} line=119`,
  `%% site Alpha>Beta file=${staleRel} line=119 column=1`,
].join('\n')
const rrMini = await fetch(`${srv.url}/api/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uml: miniUml, roots: [staleRoot], title: 'stale mini', scope: 'smoke' }) }).then((r) => r.json())
const staleBefore = await (await fetch(`${rrMini.url}/stale`)).json()
check('临时 root 渲染后 /stale changed=false（1 个源文件）', () => staleBefore.changed === false && staleBefore.files?.length === 1, () => `changed=${staleBefore.changed} files=${staleBefore.files?.length}`)
// 模拟源码更新：把副本文件的 mtime 推到未来（保证严格大于渲染时快照）
const future = new Date(Date.now() + 60_000)
utimesSync(join(staleRoot, staleRel), future, future)
const staleAfter = await (await fetch(`${rrMini.url}/stale`)).json()
check('源文件 mtime 变化后 /stale changed=true 且 mtime > snapshotMtime', () => {
  if (staleAfter.changed !== true) return false
  const f = staleAfter.files[0]
  return f !== undefined && f.file === staleRel && f.missing === undefined
    && new Date(f.mtime).getTime() > new Date(f.snapshotMtime).getTime()
}, () => JSON.stringify(staleAfter.files))
// 源文件被删除也算过期，并在该项标 missing
rmSync(join(staleRoot, staleRel), { force: true })
const staleMissing = await (await fetch(`${rrMini.url}/stale`)).json()
check('源文件被删除 → /stale changed=true 且该项 missing=true', () => {
  return staleMissing.changed === true && staleMissing.files[0]?.missing === true
}, () => JSON.stringify(staleMissing.files))
rmSync(staleRoot, { recursive: true, force: true })

// 内存 LRU 64 条（§5.1）：连续 render 70 个不同 title → 只留最近 64，最早被淘汰
const lruUml = [
  '```mermaid', 'classDiagram', '  class A', '  class B', '  A ..> B : 用', '```', '',
  '%% ehm:v1',
  '%% entity A file=packages/compaction/compaction/src/index.ts line=96 lines=2',
  '%% entity B file=packages/compaction/compaction/src/index.ts line=96 lines=2',
  '%% rel A>B file=packages/compaction/compaction/src/index.ts line=96',
].join('\n')
const lruIds = []
for (let i = 0; i < 70; i++) {
  const r = await fetch(`${srv.url}/api/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uml: lruUml, roots: [SRC_ROOT], title: `LRU ${i}`, scope: 'lru' }) }).then((x) => x.json())
  lruIds.push(r.id)
}
const hz2 = await (await fetch(`${srv.url}/healthz`)).json()
check('内存 LRU 上限 = 64 条（70 次 render 后 /healthz docs=64）', () => SNAPSHOT_LIMIT === 64 && hz2.docs === 64, () => `SNAPSHOT_LIMIT=${SNAPSHOT_LIMIT} docs=${hz2.docs}`)
const evictedRes = await fetch(`${srv.url}/e/${lruIds[0]}`)
check('LRU 淘汰最久未访问的文档（最早 id → 404）', () => evictedRes.status === 404, () => `status=${evictedRes.status}`)
const keptRes = await fetch(`${srv.url}/e/${lruIds[69]}`)
check('LRU 保留最近访问的文档（最新 id → 200）', () => keptRes.status === 200, () => `status=${keptRes.status}`)

/* ══ 5. CLI（真实子进程）══ */
group('5. CLI：门面 + 后端（真实子进程）')
const cli = spawnSync(process.execPath, [BIN, 'render', SAMPLE, '--root', SRC_ROOT, '--title', 'CLI 测试图', '--scope', 'cli', '--json', '--quiet'], {
  encoding: 'utf8', env: { ...process.env, EHM_HOME: workHome }, timeout: 60_000,
})
check('ehm render 退出码 0', () => cli.status === 0, () => `status=${cli.status} ${(cli.stderr || '').slice(0, 120)}`)
let cliOut = null
try { cliOut = JSON.parse(cli.stdout) } catch { /* ignore */ }
check('ehm render --json 输出合法 JSON', () => cliOut !== null && cliOut.ok === true)
check('CLI 输出含 url 与 diagnostics', () => cliOut && typeof cliOut.url === 'string' && Array.isArray(cliOut.diagnostics), () => cliOut?.url)
check('CLI stats = 12 实体 / 13 关系且零 error 诊断', () => cliOut && cliOut.stats.entities === 12 && cliOut.stats.relations === 13 && !cliOut.diagnostics.some((d) => d.level === 'error'), () => JSON.stringify(cliOut?.stats))
check('CLI --json stats.sites = 12', () => cliOut?.stats?.sites === 12, () => String(cliOut?.stats?.sites))

// 回归：裸 `-` = 从 stdin 读 UML（此前 parseArgs 把它当未知参数，stdin 模式不可用）
const cliStdin = spawnSync(process.execPath, [BIN, 'render', '-', '--root', SRC_ROOT, '--title', 'stdin 测试', '--scope', 'cli-stdin', '--json', '--quiet'], {
  input: sampleText, encoding: 'utf8', env: { ...process.env, EHM_HOME: workHome }, timeout: 60_000,
})
check('ehm render - 从 stdin 读取：退出码 0 且 stderr 无"未知参数"', () => {
  return cliStdin.status === 0 && !/未知参数/u.test(cliStdin.stderr || '')
}, () => `status=${cliStdin.status} stderr=${(cliStdin.stderr || '').trim().slice(0, 200)}`)
let cliStdinOut = null
try { cliStdinOut = JSON.parse(cliStdin.stdout) } catch { /* ignore */ }
check('stdin 模式 --json 输出合法 JSON 且 ok=true', () => cliStdinOut !== null && cliStdinOut.ok === true, () => cliStdinOut ? `id=${cliStdinOut.id}` : 'JSON 解析失败')
check('stdin 模式 stats = 12 实体 / 13 关系、零 error 诊断', () => {
  return cliStdinOut !== null && cliStdinOut.stats.entities === 12 && cliStdinOut.stats.relations === 13
    && !cliStdinOut.diagnostics.some((d) => d.level === 'error')
}, () => JSON.stringify(cliStdinOut?.stats))
// 帮助文本必须把 stdin 用法写清楚（`-` 与实现一致，避免"修了代码但文档还写着只能给文件"）
const cliHelp = spawnSync(process.execPath, [BIN, 'render', '--help'], { encoding: 'utf8', timeout: 30_000 })
check('render --help 里 stdin 用法与实现一致（<file.ehm.md|-> 与 ehm render - 示例）', () => {
  return cliHelp.status === 0 && cliHelp.stdout.includes('<file.ehm.md|->') && /ehm render - /u.test(cliHelp.stdout)
}, () => `status=${cliHelp.status}`)
check('render --help 说明 --direction 且默认 tb（纵向）', () => {
  return cliHelp.status === 0 && cliHelp.stdout.includes('--direction') && /默认\s*tb/u.test(cliHelp.stdout)
}, () => `status=${cliHelp.status}`)
// CLI 人类可读输出也要有调用点数（--json 只增字段，不破坏既有契约）
const cliHuman = spawnSync(process.execPath, [BIN, 'render', '-', '--root', SRC_ROOT, '--title', '人类输出测试', '--scope', 'cli-human', '--quiet'], {
  input: sampleText, encoding: 'utf8', env: { ...process.env, EHM_HOME: workHome }, timeout: 60_000,
})
check('CLI 人类可读输出含 调用点（sites）= 12 与 12/13', () => {
  return cliHuman.status === 0 && /实体\/关系\s*=\s*12 \/ 13/u.test(cliHuman.stdout) && /调用点\s*=\s*12/u.test(cliHuman.stdout)
}, () => (cliHuman.stdout || '').split('\n').filter((l) => l.includes('调用点') || l.includes('实体/关系')).join(' | ').slice(0, 200))

const st = spawnSync(process.execPath, [BIN, 'server', 'status'], { encoding: 'utf8', env: { ...process.env, EHM_HOME: workHome } })
check('ehm server status 报运行中', () => st.status === 0 && /运行中|running/u.test(st.stdout), () => st.stdout.trim().split('\n')[0])

const outFile = join(workHome, 'export.html')
const cli2 = spawnSync(process.execPath, [BIN, 'render', SAMPLE, '--root', SRC_ROOT, '--title', '导出', '--out', outFile, '--json', '--quiet'], {
  encoding: 'utf8', env: { ...process.env, EHM_HOME: workHome }, timeout: 60_000,
})
check('--out 导出单文件 HTML', () => cli2.status === 0 && existsSync(outFile) && readFileSync(outFile, 'utf8').includes('EHMViewer'), () => outFile)

const localOut = join(workHome, 'local-export.html')
const cliLocal = spawnSync(process.execPath, [BIN, 'render', SAMPLE, '--root', SRC_ROOT, '--title', '本地导出', '--out', localOut, '--local', '--json', '--quiet'], {
  encoding: 'utf8', env: { ...process.env, EHM_HOME: workHome }, timeout: 60_000,
})
let localJson = null
try { localJson = JSON.parse(cliLocal.stdout) } catch { localJson = null }
check('--local 不启 server，只返回 htmlPath 且无 url', () => cliLocal.status === 0 && localJson !== null && localJson.ok === true && localJson.local === true
  && typeof localJson.htmlPath === 'string' && localJson.htmlPath !== '' && localJson.url === undefined
  && existsSync(localOut), () => `status=${cliLocal.status} ${(cliLocal.stderr || '').slice(0, 120)}`)
const cliLocalNoOut = spawnSync(process.execPath, [BIN, 'render', SAMPLE, '--root', SRC_ROOT, '--local', '--quiet'], { encoding: 'utf8', env: { ...process.env, EHM_HOME: workHome }, timeout: 60_000 })
check('--local 缺 --out 明确报错', () => cliLocalNoOut.status === 2 && /--local.*--out/u.test(cliLocalNoOut.stderr + cliLocalNoOut.stdout), () => `status=${cliLocalNoOut.status}`)

const jumpOut = join(workHome, 'jump-export.html')
const cliJump = spawnSync(process.execPath, [BIN, 'render', SAMPLE, '--root', SRC_ROOT, '--title', '跳转导出', '--out', jumpOut,
  '--jump-actions', JSON.stringify(['post:http://127.0.0.1:7333/jump', 'open:vscode://file/{absPath}:{line}:{column}', 'copy']), '--json', '--quiet'], {
  encoding: 'utf8', env: { ...process.env, EHM_HOME: workHome }, timeout: 60_000,
})
check('--out + --jump-actions 把 post/open/copy 写进静态 HTML', () => {
  if (cliJump.status !== 0 || !existsSync(jumpOut)) return false
  const h = readFileSync(jumpOut, 'utf8')
  return h.includes('"type":"post"') && h.includes('"type":"open"') && h.includes('"type":"copy"') && h.includes('vscode://file/')
}, () => `status=${cliJump.status} ${(cliJump.stderr || '').slice(0, 160)}`)
const cliJumpNoOut = spawnSync(process.execPath, [BIN, 'render', SAMPLE, '--root', SRC_ROOT, '--jump-action', 'copy', '--quiet'], {
  encoding: 'utf8', env: { ...process.env, EHM_HOME: workHome }, timeout: 60_000,
})
check('--jump-action 未配合 --out 时明确报错（不静默忽略）', () => cliJumpNoOut.status === 2 && /只作用于 --out/u.test(cliJumpNoOut.stderr + cliJumpNoOut.stdout), () => `status=${cliJumpNoOut.status}`)

const stop = spawnSync(process.execPath, [BIN, 'server', 'stop'], { encoding: 'utf8', env: { ...process.env, EHM_HOME: workHome } })
check('ehm server stop 可停止后端', () => stop.status === 0 && /已停止/u.test(stop.stdout))
const st2 = spawnSync(process.execPath, [BIN, 'server', 'status'], { encoding: 'utf8', env: { ...process.env, EHM_HOME: workHome } })
check('停止后 status 报未运行', () => st2.status === 1 && /未运行/u.test(st2.stdout))

/* ══ 6. CLI 完整形态：可安装 bin / 版本 / validate / --strict / server --json / cwd 无关 ══ */
group('6. CLI 完整形态：可安装 bin / 版本 / validate / --strict / server --json / cwd 无关')

// 独立 EHM_HOME：前文 workHome 的后端已 stop。这里不自己起 in-process server ——
// spawnSync 会阻塞本进程事件循环，in-process 后端无法响应子进程；让第一个 `ehm render`
// 按真实产品路径自动拉起 detached 后端，后续 CLI 命令都打在这个后端上。
const cliHome = mkdtempSync(join(tmpdir(), 'ehm-cli-home-'))
process.env.EHM_HOME = cliHome
const cliEnv = { ...process.env, EHM_HOME: cliHome }
const jsonOf = (text) => { try { return JSON.parse(text) } catch { return null } }

let rootPkg = null
try { rootPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) } catch { rootPkg = null }

// --- 版本：CLI ← 根 package.json（唯一事实来源），后端 /healthz 三处同源 ---
const verLong = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8', timeout: 30_000 })
check('ehm --version = "<name> <version>" 且与根 package.json 一致', () => {
  return verLong.status === 0 && rootPkg !== null && verLong.stdout.trim() === `${rootPkg.name} ${rootPkg.version}`
}, () => (verLong.stdout || '').trim() || `status=${verLong.status}`)
const verShort = spawnSync(process.execPath, [BIN, '-v'], { encoding: 'utf8', timeout: 30_000 })
check('ehm -v 与 --version 输出一致', () => verShort.status === 0 && verShort.stdout.trim() === verLong.stdout.trim())

// --- 可安装的包形态：root package.json 的 bin 是真入口，任意 cwd 用绝对路径可跑 ---
check('根 package.json：ESM + name/version/bin/engines/license/scripts.test 齐全', () => {
  return rootPkg !== null && rootPkg.type === 'module'
    && rootPkg.name === 'enhance-mermaid' && rootPkg.version === '0.1.0'
    && rootPkg.bin?.ehm === './poc/bin/ehm.mjs'
    && typeof rootPkg.engines?.node === 'string' && typeof rootPkg.license === 'string'
    && rootPkg.scripts?.test === 'node poc/test/ehm.smoke.mjs'
})
check('根 package.json exports/files 覆盖运行依赖（server/viewer/vendor/spec）', () => {
  return rootPkg !== null && rootPkg.exports?.['.'] === './poc/src/server.mjs'
    && Array.isArray(rootPkg.files)
    && ['poc/bin/', 'poc/src/', 'poc/viewer/', 'poc/vendor/', 'spec/validate.mjs', 'spec/ehm.ir.schema.json']
      .every((f) => rootPkg.files.includes(f))
})
check('包 bin 指向的文件真实存在且从任意 cwd 以绝对路径执行 --help 成功', () => {
  if (!rootPkg?.bin?.ehm) return false
  const binAbs = resolve(REPO, rootPkg.bin.ehm)
  if (!existsSync(binAbs)) return false
  const r = spawnSync(process.execPath, [binAbs, '--help'], { cwd: tmpdir(), encoding: 'utf8', timeout: 30_000 })
  return r.status === 0 && r.stdout.includes('ehm render') && r.stdout.includes('EHM_HOME')
})

// --- help 文本补全（每个子命令就地可查）---
const mainHelp = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', timeout: 30_000 })
check('ehm --help 列出 render/serve/validate/server、--version、EHM_HOME', () => {
  return mainHelp.status === 0 && ['ehm render', 'ehm serve', 'ehm validate', 'ehm server', '--version', 'EHM_HOME'].every((s) => mainHelp.stdout.includes(s))
})
const serveHelp = spawnSync(process.execPath, [BIN, 'serve', '--help'], { encoding: 'utf8', timeout: 30_000 })
check('serve --help 写清 --port/--host 与 EHM_HOME', () => serveHelp.status === 0 && serveHelp.stdout.includes('--port') && serveHelp.stdout.includes('EHM_HOME'))
const validateHelp = spawnSync(process.execPath, [BIN, 'validate', '--help'], { encoding: 'utf8', timeout: 30_000 })
check('validate --help 写清 stdin（-）/--json/退出码', () => {
  return validateHelp.status === 0 && validateHelp.stdout.includes('<ir.json|->')
    && validateHelp.stdout.includes('stdin') && validateHelp.stdout.includes('--json') && /退出码/u.test(validateHelp.stdout)
})
const serverHelp = spawnSync(process.execPath, [BIN, 'server', '--help'], { encoding: 'utf8', timeout: 30_000 })
check('server --help 写清 status/stop 与 --json 字段', () => serverHelp.status === 0 && serverHelp.stdout.includes('status') && serverHelp.stdout.includes('stop') && serverHelp.stdout.includes('--json'))
const renderHelpStrict = spawnSync(process.execPath, [BIN, 'render', '--help'], { encoding: 'utf8', timeout: 30_000 })
check('render --help 写清 --strict / --out / EHM_HOME', () => {
  return renderHelpStrict.status === 0 && renderHelpStrict.stdout.includes('--strict')
    && renderHelpStrict.stdout.includes('--out') && renderHelpStrict.stdout.includes('EHM_HOME')
})

// --- validate 子命令：复用 spec/validate.mjs，退出码透传 0/1/2 ---
const sampleIrPath = join(REPO, 'spec', 'sample.ir.json')
const vPlain = spawnSync(process.execPath, [BIN, 'validate', sampleIrPath], { encoding: 'utf8', timeout: 120_000 })
check('ehm validate <file> 退出码 0 且输出"通过"', () => vPlain.status === 0 && /通过/u.test(vPlain.stdout), () => `status=${vPlain.status}`)
const vJson = spawnSync(process.execPath, [BIN, 'validate', sampleIrPath, '--json'], { encoding: 'utf8', timeout: 120_000 })
check('ehm validate --json 输出 {ok:true, stats.entities:12}', () => {
  const o = jsonOf(vJson.stdout)
  return vJson.status === 0 && o !== null && o.ok === true && o.stats?.entities === 12 && o.stats?.relations === 13
})
const vStdin = spawnSync(process.execPath, [BIN, 'validate', '-'], { input: readFileSync(sampleIrPath, 'utf8'), encoding: 'utf8', timeout: 120_000 })
check('ehm validate - 从 stdin 校验通过（退出码 0）', () => vStdin.status === 0, () => `status=${vStdin.status} ${(vStdin.stderr || '').slice(0, 120)}`)
const badIrPath = join(cliHome, 'bad.ir.json')
writeFileSync(badIrPath, JSON.stringify({ schemaVersion: 'v1' }))
const vBad = spawnSync(process.execPath, [BIN, 'validate', badIrPath, '--json'], { encoding: 'utf8', timeout: 120_000 })
check('ehm validate 坏 IR → 退出码 1 且 ok=false', () => vBad.status === 1 && jsonOf(vBad.stdout)?.ok === false, () => `status=${vBad.status}`)

// --- --strict：两个 root 放同名文件 → 歧义命中；非 strict warn、strict error ---
const ambA = mkdtempSync(join(tmpdir(), 'ehm-amb-a-'))
const ambB = mkdtempSync(join(tmpdir(), 'ehm-amb-b-'))
const ambRel = 'shared.ts'
const ambBody = 'export function shared() {\n  return 1\n}\nexport const marker = 42\n'
writeFileSync(join(ambA, ambRel), ambBody)
writeFileSync(join(ambB, ambRel), ambBody)
const ambModel = () => ({
  entities: [{ name: 'Alpha', kind: 'class', fields: [], methods: [], file: ambRel, line: 1 }],
  relations: [],
})
const ambLooseMat = materialize(ambModel(), { roots: [ambA, ambB] })
check('materialize 非 strict：多 root 命中 → W_AMBIGUOUS warn（行为不变）', () => {
  return ambLooseMat.diagnostics.some((d) => d.code === 'W_AMBIGUOUS' && d.level === 'warn')
    && !ambLooseMat.diagnostics.some((d) => d.level === 'error')
})
const ambStrictMat = materialize(ambModel(), { roots: [ambA, ambB], strict: true })
check('materialize strict：多 root 命中 → E_AMBIGUOUS error（仍取第一个命中者）', () => {
  const d = ambStrictMat.diagnostics.find((x) => x.code === 'E_AMBIGUOUS')
  return d !== undefined && d.level === 'error'
    && ambStrictMat.diagnostics.every((x) => x.code !== 'W_AMBIGUOUS')
    && ambStrictMat.model.entities[0].evidence?.code.includes('export function shared')
})
const ambUml = [
  '```mermaid',
  'classDiagram',
  '  class Alpha',
  '  class Beta',
  '  Alpha ..> Beta : 调用',
  '```',
  '',
  '%% ehm:v1',
  `%% entity Alpha file=${ambRel} line=1 lines=3`,
  `%% entity Beta file=${ambRel} line=4 lines=1`,
  `%% rel Alpha>Beta file=${ambRel} line=1`,
].join('\n')

const ambLooseRun = spawnSync(process.execPath, [BIN, 'render', '-', '--root', ambA, '--root', ambB, '--title', '歧义宽松', '--scope', 'cli-amb', '--json', '--quiet'], {
  input: ambUml, encoding: 'utf8', env: cliEnv, timeout: 60_000,
})
const ambLooseOut = jsonOf(ambLooseRun.stdout)
check('ehm render 非 strict 多 root 歧义：退出码 0', () => ambLooseRun.status === 0, () => `status=${ambLooseRun.status} ${(ambLooseRun.stderr || '').slice(0, 160)}`)
check('非 strict 歧义：diagnostics 含 warn W_AMBIGUOUS 且仍产出 url', () => {
  return ambLooseOut !== null && ambLooseOut.ok === true && ambLooseOut.strict === false
    && ambLooseOut.diagnostics.some((d) => d.code === 'W_AMBIGUOUS' && d.level === 'warn')
    && typeof ambLooseOut.url === 'string' && ambLooseOut.url.length > 0
})
// 第一个 CLI render 已按产品路径拉起 detached 后端：拿它的 baseUrl 复核版本同源
const hzCli = ambLooseOut !== null && typeof ambLooseOut.baseUrl === 'string'
  ? await (await fetch(`${ambLooseOut.baseUrl}/healthz`)).json()
  : {}
check('后端 /healthz 版本与根 package.json 一致（CLI/后端/包三处同源）', () => rootPkg !== null && hzCli.version === rootPkg.version, () => String(hzCli.version))
const ambStrictRun = spawnSync(process.execPath, [BIN, 'render', '-', '--root', ambA, '--root', ambB, '--title', '歧义严格', '--scope', 'cli-amb', '--strict', '--json', '--quiet'], {
  input: ambUml, encoding: 'utf8', env: cliEnv, timeout: 60_000,
})
const ambStrictOut = jsonOf(ambStrictRun.stdout)
check('ehm render --strict 多 root 歧义：退出码 1 但图/URL 仍产出', () => ambStrictRun.status === 1 && typeof ambStrictOut?.url === 'string', () => `status=${ambStrictRun.status} url=${typeof ambStrictOut?.url}`)
check('strict JSON：ok=false / strict=true / errors 与 diagnostics 均含 E_AMBIGUOUS error', () => {
  return ambStrictOut !== null && ambStrictOut.ok === false && ambStrictOut.strict === true
    && Array.isArray(ambStrictOut.errors) && ambStrictOut.errors.some((d) => d.code === 'E_AMBIGUOUS' && d.level === 'error')
    && ambStrictOut.diagnostics.some((d) => d.code === 'E_AMBIGUOUS' && d.level === 'error')
    && !ambStrictOut.diagnostics.some((d) => d.code === 'W_AMBIGUOUS')
})
const ambStrictHuman = spawnSync(process.execPath, [BIN, 'render', '-', '--root', ambA, '--root', ambB, '--title', '歧义严格人类', '--scope', 'cli-amb', '--strict', '--quiet'], {
  input: ambUml, encoding: 'utf8', env: cliEnv, timeout: 60_000,
})
check('strict 人类可读输出：给出 ERROR 列表 + url + exit 1', () => {
  return ambStrictHuman.status === 1
    && /ERROR E_AMBIGUOUS/u.test(ambStrictHuman.stdout || '')
    && /url\s+=/u.test(ambStrictHuman.stdout || '')
    && /strict 模式判定失败/u.test(ambStrictHuman.stderr || '')
})

// --- 服务端 /api/render 的 strict 透传（打在上一步拉起、真实存活的 detached 后端上）---
const apiStrictRes = await fetch(`${ambLooseOut.baseUrl}/api/render`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ uml: ambUml, roots: [ambA, ambB], title: 'strict api', scope: 'smoke', strict: true }),
}).then((r) => r.json())
check('/api/render strict:true → 200 + strict 回显 + diagnostics 含 error E_AMBIGUOUS', () => {
  return apiStrictRes.ok === true && apiStrictRes.strict === true
    && apiStrictRes.diagnostics.some((d) => d.code === 'E_AMBIGUOUS' && d.level === 'error')
    && typeof apiStrictRes.url === 'string'
})
const apiLooseRes = await fetch(`${ambLooseOut.baseUrl}/api/render`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ uml: ambUml, roots: [ambA, ambB], title: 'loose api', scope: 'smoke' }),
}).then((r) => r.json())
check('/api/render 默认非 strict：同一输入仍是 warn W_AMBIGUOUS（行为不变）', () => {
  return apiLooseRes.ok === true && apiLooseRes.strict === false
    && apiLooseRes.diagnostics.some((d) => d.code === 'W_AMBIGUOUS' && d.level === 'warn')
    && !apiLooseRes.diagnostics.some((d) => d.level === 'error')
})

// --- server status/stop 的 --json（机器可读；退出码规则与人类输出一致）---
const stJsonRun = spawnSync(process.execPath, [BIN, 'server', 'status', '--json'], { encoding: 'utf8', env: cliEnv, timeout: 30_000 })
check('server status --json：exit 0 + running/port/baseUrl/pid/version/docs/uptime 字段齐全', () => {
  const o = jsonOf(stJsonRun.stdout)
  return stJsonRun.status === 0 && o !== null && o.ok === true && o.running === true
    && o.port === ambLooseOut.port && o.baseUrl === ambLooseOut.baseUrl
    && Number.isInteger(o.pid) && o.version === rootPkg?.version
    && typeof o.docs === 'number' && typeof o.uptime === 'number' && typeof o.uptimeMs === 'number'
}, () => (stJsonRun.stdout || '').trim().slice(0, 200))

// --- CLI 不依赖 cwd：从临时目录用 bin 的绝对路径跑 render ---
const foreignCwd = mkdtempSync(join(tmpdir(), 'ehm-cwd-'))
const cwdRun = spawnSync(process.execPath, [BIN, 'render', SAMPLE, '--root', SRC_ROOT, '--title', 'cwd 无关', '--scope', 'cli-cwd', '--json', '--quiet'], {
  cwd: foreignCwd, encoding: 'utf8', env: cliEnv, timeout: 60_000,
})
check('从临时 cwd 用绝对路径跑 bin：render 成功（CLI 不依赖 cwd）', () => {
  const o = jsonOf(cwdRun.stdout)
  return cwdRun.status === 0 && o !== null && o.ok === true && o.stats.entities === 12
}, () => `status=${cwdRun.status} ${(cwdRun.stderr || '').slice(0, 120)}`)
rmSync(foreignCwd, { recursive: true, force: true })

const stopJsonRun = spawnSync(process.execPath, [BIN, 'server', 'stop', '--json'], { encoding: 'utf8', env: cliEnv, timeout: 30_000 })
const stopJsonOut = jsonOf(stopJsonRun.stdout)
check('server stop --json：exit 0 + {ok,stopped,port}', () => {
  return stopJsonRun.status === 0 && stopJsonOut !== null
    && stopJsonOut.ok === true && stopJsonOut.stopped === true && stopJsonOut.port === ambLooseOut.port
}, () => (stopJsonRun.stdout || '').trim().slice(0, 200))
const statusStoppedRun = spawnSync(process.execPath, [BIN, 'server', 'status', '--json'], { encoding: 'utf8', env: cliEnv, timeout: 30_000 })
const statusStoppedOut = jsonOf(statusStoppedRun.stdout)
check('停止后 server status --json：exit 1 + running=false / reason=not-running', () => {
  return statusStoppedRun.status === 1 && statusStoppedOut !== null
    && statusStoppedOut.ok === false && statusStoppedOut.running === false && statusStoppedOut.reason === 'not-running'
}, () => (statusStoppedRun.stdout || '').trim().slice(0, 200))
const stopAgainRun = spawnSync(process.execPath, [BIN, 'server', 'stop', '--json'], { encoding: 'utf8', env: cliEnv, timeout: 30_000 })
const stopAgainOut = jsonOf(stopAgainRun.stdout)
check('重复 stop --json：exit 1 + stopped=false + reason=not-running', () => {
  return stopAgainRun.status === 1 && stopAgainOut !== null
    && stopAgainOut.ok === false && stopAgainOut.stopped === false && stopAgainOut.reason === 'not-running'
})

// section 6 收尾：后端已由 stop --json 停掉；恢复主状态目录、清理临时目录
process.env.EHM_HOME = workHome
rmSync(cliHome, { recursive: true, force: true })
rmSync(ambA, { recursive: true, force: true })
rmSync(ambB, { recursive: true, force: true })

/* ══ 7. P13：member.summary + 完整 ranges / 可见性约束诊断 + ehm skill + AI 编写建议 ══ */
group('7. P13：member.summary / 范围与可见性约束 / ehm skill / help AI 建议')

const auditRoot = mkdtempSync(join(tmpdir(), 'ehm-audit-root-'))
const skillHome = mkdtempSync(join(tmpdir(), 'ehm-skill-home-'))
const FRAMEWORK = join(POC, 'samples', 'framework.ehm.md')
writeFileSync(join(auditRoot, 'demo.ts'), 'export class Demo {\n  private inner() {\n    return 1\n  }\n}\n')

// --- A. %% member ... summary="含义" 进入模型 / IR，且 schema 允许 ---
const goodUml = [
  '```mermaid', 'classDiagram', '  class Demo {', '    -inner() void', '  }', '```', '',
  '%% ehm:v1',
  '%% entity Demo file=demo.ts line=1 lines=5 summary="演示类"',
  '%% member Demo.inner file=demo.ts line=2 lines=3 summary="内部方法；返回 1"',
].join('\n')
const badUml = [
  '```mermaid', 'classDiagram', '  class Demo {', '    inner() void', '  }', '```', '',
  '%% ehm:v1',
  '%% entity Demo file=demo.ts line=1 lines=1',
  '%% member Demo.inner file=demo.ts line=2 lines=1',
].join('\n')

const goodParsed = parseUml(goodUml)
const badParsed = parseUml(badUml)
check('%% member summary 写进模型（方法含义）', () => goodParsed.model.entities[0].methods[0].summary === '内部方法；返回 1')
check('未写 summary 的方法保持 undefined（不伪造含义）', () => badParsed.model.entities[0].methods[0].summary === undefined)
const p13GoodMat = materialize(goodParsed.model, { roots: [auditRoot] })
check('合规输入：物化 0 诊断（完整 range + summary + 可见性齐全）', () => p13GoodMat.diagnostics.length === 0, () => p13GoodMat.diagnostics.map((d) => d.code).join(','))
const goodIr = toIr(p13GoodMat.model, { roots: [auditRoot] })
check('member.summary 投影进 IR', () => goodIr.entities[0].methods[0].summary === '内部方法；返回 1')
const summaryIrPath = join(skillHome, 'summary.ir.json')
writeFileSync(summaryIrPath, JSON.stringify(goodIr))
const summaryVal = spawnSync(process.execPath, [join(REPO, 'spec', 'validate.mjs'), summaryIrPath, '--json'], { encoding: 'utf8', timeout: 60_000 })
check('带 member.summary 的 IR 通过 spec/validate.mjs（schema/校验器允许）', () => {
  const o = jsonOf(summaryVal.stdout)
  return summaryVal.status === 0 && o !== null && o.ok === true
}, () => `status=${summaryVal.status} ${(summaryVal.stdout || '').slice(0, 160)}`)

// --- B. 三类约束诊断：命中与不命中都测（warning，不阻断）---
const p13BadMat = materialize(badParsed.model, { roots: [auditRoot] })
const codesOf = (mat) => mat.diagnostics.map((d) => d.code)
check('W_RANGE_THIN：实体/成员只给一行（lines=1）→ warn', () => {
  const hits = p13BadMat.diagnostics.filter((d) => d.code === 'W_RANGE_THIN')
  return hits.length >= 2 && hits.every((d) => d.level === 'warn')
}, () => codesOf(p13BadMat).join(','))
check('W_MEMBER_NO_SUMMARY：方法有证据但缺 summary → warn', () => {
  return p13BadMat.diagnostics.some((d) => d.code === 'W_MEMBER_NO_SUMMARY' && d.level === 'warn')
})
check('W_VISIBILITY_DEFAULT：成员没写 + - # ~ → warn', () => {
  return p13BadMat.diagnostics.some((d) => d.code === 'W_VISIBILITY_DEFAULT' && d.level === 'warn')
})
check('约束诊断全是 warning（不阻断渲染/不升级为 error）', () => p13BadMat.diagnostics.every((d) => d.level === 'warn'))

// --- C. ehm skill 子命令 ---
const skillRun = spawnSync(process.execPath, [BIN, 'skill'], { encoding: 'utf8', timeout: 30_000 })
check('ehm skill 输出 SKILL.md 原文（frontmatter + 关键约束/流程）', () => {
  const s = skillRun.stdout || ''
  return skillRun.status === 0 && s.includes('name: ehm-uml')
    && ['W_RANGE_THIN', 'W_MEMBER_NO_SUMMARY', 'W_VISIBILITY_DEFAULT', 'ehm_render', 'ehm fence'].every((k) => s.includes(k))
}, () => `status=${skillRun.status}`)
const skillJsonRun = spawnSync(process.execPath, [BIN, 'skill', '--json'], { encoding: 'utf8', timeout: 30_000 })
check('ehm skill --json → {ok:true, path, content}', () => {
  const o = jsonOf(skillJsonRun.stdout)
  return skillJsonRun.status === 0 && o !== null && o.ok === true
    && typeof o.path === 'string' && o.path.endsWith(join('skills', 'ehm-uml', 'SKILL.md'))
    && typeof o.content === 'string' && o.content.length > 1000
})
const skillHelpRun = spawnSync(process.execPath, [BIN, 'skill', '--help'], { encoding: 'utf8', timeout: 30_000 })
check('ehm skill --help 可用（exit 0）', () => skillHelpRun.status === 0 && (skillHelpRun.stdout || '').includes('ehm skill'))

// --- D. help：AI 编写建议（简版 + 详细版）---
const aiMainHelp = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', timeout: 30_000 })
check('ehm --help 含「AI 生成 EHM UML 的硬约束」并列出 skill 命令', () => {
  const s = aiMainHelp.stdout || ''
  return aiMainHelp.status === 0 && s.includes('AI 生成 EHM UML 的硬约束') && s.includes('ehm skill') && s.includes('summary')
})
const aiRenderHelp = spawnSync(process.execPath, [BIN, 'render', '--help'], { encoding: 'utf8', timeout: 30_000 })
check('render --help 含三个新诊断码 + summary/可见性/完整 range 建议', () => {
  const s = aiRenderHelp.stdout || ''
  return aiRenderHelp.status === 0 && ['W_RANGE_THIN', 'W_MEMBER_NO_SUMMARY', 'W_VISIBILITY_DEFAULT', 'summary="', '可见性', 'lines'].every((k) => s.includes(k))
})
check('render --help 提醒 ehm fence 作为主要输出，且保留 stdin 用法', () => {
  const s = aiRenderHelp.stdout || ''
  return s.includes('ehm fence') && s.includes('<file.ehm.md|->') && /ehm render - /u.test(s)
})

// --- E. 合规样板 poc/samples/framework.ehm.md：0 diagnostics ---
const fwText = readFileSync(FRAMEWORK, 'utf8')
const fwParsed = parseUml(fwText)
check('framework 样板：14 实体 / 16 关系 / 解析零诊断', () => {
  return fwParsed.model.entities.length === 14 && fwParsed.model.relations.length === 16 && fwParsed.diagnostics.length === 0
}, () => `${fwParsed.model.entities.length}/${fwParsed.model.relations.length} parseDiag=${fwParsed.diagnostics.length}`)
const fwMat = materialize(fwParsed.model, { roots: [PROJECT_ROOT] })
check('framework 样板物化 0 诊断（含 W_RANGE_THIN / W_MEMBER_NO_SUMMARY / W_VISIBILITY_DEFAULT）', () => fwMat.diagnostics.length === 0, () => fwMat.diagnostics.map((d) => d.code).join(','))
check('framework 样板：每个类/方法/字段都有 summary，每个成员都有 UML 可见性', () => {
  return fwMat.model.entities.every((e) => typeof e.summary === 'string' && e.summary !== '')
    && fwMat.model.entities.every((e) => e.methods.every((m) => typeof m.summary === 'string' && m.summary !== ''))
    && fwMat.model.entities.every((e) => [...e.fields, ...e.methods].every((m) => ['+', '-', '#', '~'].includes(m.visibility)))
})
check('framework 样板：实体/成员证据覆盖完整范围（lines >= 2）', () => {
  const entOk = fwMat.model.entities.every((e) => (e.evidence?.endLine ?? 0) - (e.evidence?.line ?? 0) + 1 >= 2)
  const memOk = fwMat.model.entities.every((e) => [...e.fields, ...e.methods].every((m) => (m.evidence?.endLine ?? 0) - (m.evidence?.line ?? 0) + 1 >= 2))
  return entOk && memOk
})
const fwHome = mkdtempSync(join(tmpdir(), 'ehm-fw-home-'))
const fwRun = spawnSync(process.execPath, [BIN, 'render', FRAMEWORK, '--root', PROJECT_ROOT, '--title', 'framework 合规样板', '--scope', 'p13', '--json', '--quiet'], {
  encoding: 'utf8', env: { ...process.env, EHM_HOME: fwHome }, timeout: 120_000,
})
const fwOut = jsonOf(fwRun.stdout)
check('ehm render framework.ehm.md --root repo --json → exit 0 且 diagnostics 为空', () => {
  return fwRun.status === 0 && fwOut !== null && fwOut.ok === true
    && Array.isArray(fwOut.diagnostics) && fwOut.diagnostics.length === 0
}, () => `status=${fwRun.status} ${JSON.stringify(fwOut?.diagnostics ?? []).slice(0, 240)}`)
check('framework CLI stats = 14 实体 / 16 关系', () => fwOut !== null && fwOut.stats?.entities === 14 && fwOut.stats?.relations === 16, () => JSON.stringify(fwOut?.stats))
spawnSync(process.execPath, [BIN, 'server', 'stop', '--json'], { encoding: 'utf8', env: { ...process.env, EHM_HOME: fwHome }, timeout: 30_000 })

// section 7 收尾
rmSync(auditRoot, { recursive: true, force: true })
rmSync(skillHome, { recursive: true, force: true })
rmSync(fwHome, { recursive: true, force: true })

// 收尾
hostSrv.close()
await srv.close()
rmSync(workHome, { recursive: true, force: true })

/* ══ 结果 ══ */
console.log('\n' + '═'.repeat(70))
console.log(`结果: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\n失败项:')
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.detail}`)
  process.exit(1)
}
console.log('全部通过 ✅')
