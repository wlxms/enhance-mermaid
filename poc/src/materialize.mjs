/**
 * materialize.mjs —— 模型 + 工作区根目录 → 带代码正文与诊断的模型
 *
 * 做的事只有四件（全部无智能）：
 *   ① 把每条声明的**相对路径**按 `--root` 顺序解析成绝对路径（首个存在者胜）
 *   ② 用声明的**行号**从真实文件里取出代码块（无行数时按花括号配平）
 *   ③ 失败只记诊断、降级该节点，**绝不中断整图**
 *   ④ 约束 AI 书写的质量（仅 warning，不阻断）：证据范围太窄 W_RANGE_THIN、
 *      方法缺含义 W_MEMBER_NO_SUMMARY、成员缺 UML 可见性 W_VISIBILITY_DEFAULT
 *
 * 明确不做：
 *   · 不搜符号、不猜行号（行号由 Agent 提供 —— Agent 刚读过代码，它才是那一刻的权威）
 *   · 不做 AST 分析、不推断调用关系（结构来自 UML 文本）
 *   · 不读工作区外文件（绝对路径与 `..` 一律拒绝）
 *   · 不替 AI 补 summary/可见性/范围（只诊断，修复由作者做——否则等于生成未经阅读的注释）
 *
 * @module poc/src/materialize
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

/* ──────────────────────────────────────────────────────────
   诊断
   ────────────────────────────────────────────────────────── */

const D = {
  BAD_PATH: (file, why) => ({ code: 'E_PATH', level: 'error', message: `路径 "${file}" 不合法：${why}` }),
  NOT_FOUND: (file, roots) => ({
    code: 'E_PATH',
    level: 'error',
    message: `"${file}" 在所有 root 下都不存在。已尝试：\n  ` + roots.map((r) => join(r, file)).join('\n  '),
  }),
  /** 多 root 命中同名文件：默认 warn（取第一个命中的 root）；strict 模式下由 materialize() 升级为 error E_AMBIGUOUS。 */
  AMBIGUOUS: (file, hits) => ({
    code: 'W_AMBIGUOUS',
    level: 'warn',
    message: `"${file}" 在多个 root 下命中，已取第一个：${hits[0]}（另有 ${hits.length - 1} 个）`,
  }),
  NO_LINE: (name) => ({ code: 'W_NO_LINE', level: 'warn', message: `实体/成员 "${name}" 没有 line，无法取代码正文` }),
  /** 有 file+line 但没给完整范围（lines 缺失或 ≤1）：AI 只写一行会导致气泡里看不到完整声明/实现。 */
  RANGE_THIN: (at, file, line, lines) => ({
    code: 'W_RANGE_THIN',
    level: 'warn',
    message: `"${at}" 的代码范围不完整："${file}:${line}" ${lines === undefined ? '没给 lines' : `只给了 ${lines} 行`}。请用 lines=<n> 覆盖完整声明/实现范围（方法含签名+函数体、字段含类型声明、类含头部关键成员），不要只给一行`,
  }),
  /** 方法缺含义说明：AI 必须给每个方法 summary="做什么/为什么存在"。 */
  MEMBER_NO_SUMMARY: (at) => ({
    code: 'W_MEMBER_NO_SUMMARY',
    level: 'warn',
    message: `方法 "${at}" 缺少 summary（含义说明）。请补 \`%% member <Entity>.<name> ... summary="这个方法做什么/为什么存在"\``,
  }),
  /** 成员缺 UML 可见性：一律写 + 不符合真实代码（public/private/protected/package 要如实标）。 */
  VISIBILITY_DEFAULT: (at) => ({
    code: 'W_VISIBILITY_DEFAULT',
    level: 'warn',
    message: `成员 "${at}" 没写 UML 可见性。请按真实代码标 +（public）/-（private）/#（protected）/~（package），不要一律用 +`,
  }),
  LINE_RANGE: (file, line, total) => ({
    code: 'E_LINE',
    level: 'error',
    message: `行号越界："${file}" 只有 ${total} 行，请求 line=${line}`,
  }),
  READ_FAIL: (file, err) => ({ code: 'E_READ', level: 'error', message: `读不了 "${file}"：${err}` }),
  UNBALANCED: (file, from) => ({ code: 'W_UNBALANCED', level: 'warn', message: `"${file}:${from}" 起的花括号没配平，已取到文件末尾` }),
}

/* ──────────────────────────────────────────────────────────
   路径解析
   ────────────────────────────────────────────────────────── */

/**
 * 相对路径 → 绝对路径。按 roots 顺序取第一个存在的。
 * @returns {{ abs:string|null, diag?:object }}
 */
export function resolveUnderRoots(relPath, roots) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    return { abs: null, diag: D.BAD_PATH(String(relPath), '空路径') }
  }
  const p = relPath.trim()
  if (isAbsolute(p) || /^[A-Za-z]:[\\/]/u.test(p)) return { abs: null, diag: D.BAD_PATH(p, '不接受绝对路径，请给相对 root 的路径') }
  const norm = normalize(p)
  if (norm === '..' || norm.startsWith('..' + sep) || norm.startsWith('../')) {
    return { abs: null, diag: D.BAD_PATH(p, '不接受 .. 越界') }
  }

  const hits = []
  for (const root of roots) {
    const abs = resolve(root, norm)
    try {
      if (statSync(abs).isFile()) hits.push(abs)
    } catch { /* 不存在，继续尝试下一个 root */ }
  }
  if (hits.length === 0) return { abs: null, diag: D.NOT_FOUND(p, roots) }
  return { abs: hits[0], diag: hits.length > 1 ? D.AMBIGUOUS(p, hits) : undefined }
}

/* ──────────────────────────────────────────────────────────
   代码抽取
   ────────────────────────────────────────────────────────── */

/**
 * evidence.code 的长度上限（schema 的 maxLength）。
 * 超出时按行边界截断并写明显式标记 —— 绝不让气泡看起来像"这是全部代码"。
 */
export const MAX_CODE_CHARS = 8000

export function capCode(code) {
  const all = code.split('\n')
  if (code.length <= MAX_CODE_CHARS) return { code, lineCount: all.length }
  const kept = []
  let size = 0
  for (const ln of all) {
    if (size + ln.length + 1 > MAX_CODE_CHARS - 120) break
    kept.push(ln)
    size += ln.length + 1
  }
  kept.push(`// … 已截断：原文 ${all.length} 行 / ${code.length} 字符（打开源文件查看完整内容）`)
  return { code: kept.join('\n'), lineCount: kept.length }
}

/**
 * 从 `fromLine`（1-based）起按花括号配平找块结束行。
 * 跳过字符串 / 模板串 / 行注释 / 块注释里的花括号 —— 这是 prototypes/v14/extract.mjs 已验证的算法。
 * @returns {number} 结束行（1-based，含）
 */
export function findBlockEnd(lines, fromLine) {
  const start = Math.max(0, fromLine - 1)
  let depth = 0
  let opened = false
  let state = 'code' // code | line | block | single | double | template
  for (let i = start; i < lines.length; i++) {
    const s = lines[i]
    for (let j = 0; j < s.length; j++) {
      const c = s[j]
      const next = s[j + 1]
      if (state === 'line') break
      if (state === 'block') {
        if (c === '*' && next === '/') { state = 'code'; j++ }
        continue
      }
      if (state === 'single') {
        if (c === '\\') { j++; continue }
        if (c === "'") state = 'code'
        continue
      }
      if (state === 'double') {
        if (c === '\\') { j++; continue }
        if (c === '"') state = 'code'
        continue
      }
      if (state === 'template') {
        if (c === '\\') { j++; continue }
        if (c === '`') { state = 'code'; continue }
        if (c === '$' && next === '{') { // 模板串里的表达式：近似当成代码处理到配对 }
          let d = 1
          j += 2
          while (j < s.length && d > 0) {
            if (s[j] === '{') d++
            else if (s[j] === '}') d--
            j++
          }
          j--
        }
        continue
      }
      // state === 'code'
      if (c === '/' && next === '/') { state = 'line'; j++; continue }
      if (c === '/' && next === '*') { state = 'block'; j++; continue }
      if (c === "'") { state = 'single'; continue }
      if (c === '"') { state = 'double'; continue }
      if (c === '`') { state = 'template'; continue }
      if (c === '{') { depth++; opened = true; continue }
      if (c === '}') {
        depth--
        if (opened && depth <= 0) return i + 1
      }
    }
    if (state === 'line') state = 'code'
  }
  return lines.length
}

/**
 * 取一段代码。
 * @param {string} text 文件全文
 * @param {number} line 1-based 起始行
 * @param {number} [lines] 行数；省略则按花括号配平
 * @returns {{ from:number, to:number, code:string }}
 */
export function sliceCode(text, line, lines) {
  const all = text.split(/\r?\n/u)
  const from = Math.min(Math.max(1, line), all.length)
  let to
  if (typeof lines === 'number' && lines > 0) to = Math.min(all.length, from + lines - 1)
  else to = findBlockEnd(all, from)
  return { from, to, code: all.slice(from - 1, to).join('\n') }
}

/* ──────────────────────────────────────────────────────────
   主流程
   ────────────────────────────────────────────────────────── */

/**
 * @param {{entities:Array, relations:Array}} model  parse-uml 的产物
 * @param {{roots:string[], strict?:boolean}} opts  strict=true 时把歧义命中升级为 error（E_AMBIGUOUS）
 * @returns {{ model:any, diagnostics:object[], resolved:Map<string,string>, files:string[] }}
 */
export function materialize(model, opts) {
  const roots = (opts.roots ?? []).map((r) => resolve(r))
  const strict = opts.strict === true
  const diagnostics = []
  /**
   * strict 模式把"多 root 命中"（默认 W_AMBIGUOUS / warn）升级为 E_AMBIGUOUS / error：
   * 仍然取第一个命中者（图照出），但诊断级别变为 error，由 CLI/调用方决定退出码。
   */
  const upgrade = (diag) => (strict && diag.code === 'W_AMBIGUOUS'
    ? { ...diag, code: 'E_AMBIGUOUS', level: 'error', message: `[strict] ${diag.message}` }
    : diag)
  if (roots.length === 0) {
    diagnostics.push({ code: 'E_NO_ROOT', level: 'error', message: '没有提供 --root，无法解析任何相对路径' })
    return { model, diagnostics, resolved: new Map(), files: [] }
  }

  /** 文件内容缓存：同一文件只读一次 */
  const cache = new Map()
  const resolved = new Map()
  const usedFiles = new Set()

  /** 读文件；返回 { text, rel } 或 null（已记诊断）。 */
  const load = (relPath, at) => {
    if (relPath === undefined) return null
    if (cache.has(relPath)) return cache.get(relPath)
    const { abs, diag } = resolveUnderRoots(relPath, roots)
    if (diag) diagnostics.push({ ...upgrade(diag), at })
    if (abs === null) { cache.set(relPath, null); return null }
    try {
      const text = readFileSync(abs, 'utf8')
      const entry = { text, abs, rel: relPath, lines: text.split(/\r?\n/u) }
      cache.set(relPath, entry)
      resolved.set(relPath, abs)
      usedFiles.add(relPath)
      return entry
    } catch (e) {
      diagnostics.push({ ...D.READ_FAIL(relPath, e && e.code ? e.code : String(e)), at })
      cache.set(relPath, null)
      return null
    }
  }

  /** 给一个"有 file/line"的对象补 evidence。 */
  const attach = (holder, name, fallbackFile, silent = false) => {
    const file = holder.file ?? fallbackFile
    const note = (diag) => { if (!silent) diagnostics.push(diag) }
    if (file === undefined) { note({ ...D.NO_LINE(name), at: name }); return false }
    const entry = load(file, name)
    if (entry === null) return false
    if (holder.line === undefined) { note({ ...D.NO_LINE(name), at: name }); return false }
    if (holder.line > entry.lines.length) {
      diagnostics.push({ ...D.LINE_RANGE(file, holder.line, entry.lines.length), at: name })
      return false
    }
    const { from, to, code } = sliceCode(entry.text, holder.line, holder.lines)
    // 截断后必须让 endLine 与实际行数对齐（schema：行数 == endLine - line + 1）
    const capped = capCode(code)
    holder.evidence = { file, line: from, endLine: from + capped.lineCount - 1, code: capped.code }
    if (holder.lines === undefined && to >= entry.lines.length && !/[}]\s*$/u.test(code.trimEnd())) {
      diagnostics.push({ ...D.UNBALANCED(file, from), at: name })
    }
    return true
  }

  let membersWithoutLine = 0

  /** 只有同时给了 file+line 才算"声明了证据"——此时范围/含义缺失才是 AI 的质量问题。 */
  const hasEvidenceIntent = (h) => h.file !== undefined && h.line !== undefined
  /** lines 缺失或只有 1 行 = 没给完整范围。 */
  const rangeIsThin = (h) => h.lines === undefined || h.lines <= 1

  for (const ent of model.entities) {
    attach(ent, `entity ${ent.name}`)
    if (hasEvidenceIntent(ent) && rangeIsThin(ent)) {
      diagnostics.push({ ...D.RANGE_THIN(`entity ${ent.name}`, ent.file, ent.line, ent.lines), at: `entity ${ent.name}` })
    }
    // 成员没有 line 是常态（Agent 只标注关键的），不逐条告警，最后汇总一条
    for (const f of ent.fields) {
      if (!attach(f, `${ent.name}.${f.name}`, ent.file, true)) membersWithoutLine++
      if (f.visibility === undefined) diagnostics.push({ ...D.VISIBILITY_DEFAULT(`${ent.name}.${f.name}`), at: `${ent.name}.${f.name}` })
      if (hasEvidenceIntent(f) && rangeIsThin(f)) diagnostics.push({ ...D.RANGE_THIN(`${ent.name}.${f.name}`, f.file, f.line, f.lines), at: `${ent.name}.${f.name}` })
    }
    for (const m of ent.methods) {
      if (!attach(m, `${ent.name}.${m.name}`, ent.file, true)) membersWithoutLine++
      if (m.visibility === undefined) diagnostics.push({ ...D.VISIBILITY_DEFAULT(`${ent.name}.${m.name}`), at: `${ent.name}.${m.name}` })
      if (hasEvidenceIntent(m) && rangeIsThin(m)) diagnostics.push({ ...D.RANGE_THIN(`${ent.name}.${m.name}`, m.file, m.line, m.lines), at: `${ent.name}.${m.name}` })
      // 方法含义是硬约束：有证据但没 summary 就提醒（字段暂不强制）
      if (m.summary === undefined && (m.evidence !== undefined || hasEvidenceIntent(m))) {
        diagnostics.push({ ...D.MEMBER_NO_SUMMARY(`${ent.name}.${m.name}`), at: `${ent.name}.${m.name}` })
      }
    }
  }
  if (membersWithoutLine > 0) {
    diagnostics.push({
      code: 'W_MEMBER_NO_LINE',
      level: 'warn',
      message: `${membersWithoutLine} 个成员没有 line：悬停时显示不出代码正文（给它们加 \`%% member <Entity>.<name> line=...\` 即可）`,
    })
  }

  for (const rel of model.relations) {
    const label = `rel ${rel.from} > ${rel.to}`
    const file = rel.file ?? findFile(model, rel.from)
    // 边的证据只取 3 行上下文：悬停时告诉用户「这行代码促成了这条关系」
    if (file === undefined || rel.line === undefined) {
      if (rel.line === undefined) diagnostics.push({ code: 'W_NO_LINE', level: 'warn', message: `关系 "${label}" 没有 line，悬停时无证据代码`, at: label })
    } else {
      const entry = load(file, label)
      if (entry !== null) {
        if (rel.line > entry.lines.length) {
          diagnostics.push({ ...D.LINE_RANGE(file, rel.line, entry.lines.length), at: label })
        } else {
          const to = Math.min(entry.lines.length, rel.line + 2)
          const capped = capCode(entry.lines.slice(rel.line - 1, to).join('\n'))
          rel.evidence = { file, line: rel.line, endLine: rel.line + capped.lineCount - 1, code: capped.code }
        }
      }
    }
    // 调用点：校验行号并取该行代码（schema 要求 site 有 code 或 snippetRef）
    for (const site of rel.sites ?? []) {
      const entry = load(site.file, `${label} site`)
      if (entry === null) continue
      if (site.line > entry.lines.length) {
        diagnostics.push({ ...D.LINE_RANGE(site.file, site.line, entry.lines.length), at: `${label} site` })
        continue
      }
      site.endLine = site.line
      site.code = entry.lines[site.line - 1].slice(0, 2000)
    }
  }

  return { model, diagnostics, resolved, files: [...usedFiles] }
}

function findFile(model, name) {
  const e = model.entities.find((x) => x.name === name)
  return e ? e.file : undefined
}

export default { materialize, resolveUnderRoots, sliceCode, findBlockEnd }
