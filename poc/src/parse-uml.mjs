/**
 * parse-uml.mjs —— 增强 UML 文本 → 模型
 *
 * 输入是一份 Markdown 文本，包含：
 *   ① 一个 ```mermaid classDiagram 块 —— **唯一的结构来源**（类、成员、关系）
 *   ② 若干 `%% ehm:*` 指令行 —— 补 mermaid 表达不了的数据（file / line / sites）
 *
 * 设计原则：
 *   · **宽容解析**：不认识的 mermaid 语句、未知指令、未知键 → 记 warning 后跳过，绝不因为一个笔误整份失败
 *   · **结构只认 mermaid**：`%%` 指令永远不能凭空创造实体或关系，只能给已声明的补数据
 *   · **指令活在注释里**：`%%` 是 mermaid 的注释语法，所以同一份文本在 GitHub/VS Code 里渲染成一张普通 UML 图
 *
 * @module poc/src/parse-uml
 */

/* ──────────────────────────────────────────────────────────
   诊断
   ────────────────────────────────────────────────────────── */

/** @typedef {{ code:string, level:'error'|'warn', message:string, at?:string, line?:number }} Diag */

const D = {
  NO_UML: (line) => ({ code: 'E_NO_UML', level: 'error', message: '找不到 ```mermaid classDiagram 代码块', line }),
  NO_DIRECTIVE: () => ({ code: 'W_NO_EHM_BLOCK', level: 'warn', message: '没有找到 `%% ehm:v1` 指令块：图会渲染，但没有代码正文与跳转目标' }),
  BAD_VERSION: (v) => ({ code: 'E_EHM_VERSION', level: 'error', message: `不支持的指令版本 "${v}"，当前只支持 ehm:v1` }),
  UNKNOWN_DIRECTIVE: (w, line) => ({ code: 'W_UNKNOWN_DIRECTIVE', level: 'warn', message: `未知指令 "${w}"，已忽略`, line }),
  UNKNOWN_KEY: (k, at, line) => ({ code: 'W_UNKNOWN_KEY', level: 'warn', message: `未知参数 "${k}"，已忽略`, at: at, line }),
  UNKNOWN_ENTITY: (name, line) => ({ code: 'W_UNKNOWN_ENTITY', level: 'warn', message: `指令引用了 mermaid 里不存在的实体 "${name}"，已忽略`, line }),
  UNKNOWN_MEMBER: (e, m, line) => ({ code: 'W_UNKNOWN_MEMBER', level: 'warn', message: `指令引用了不存在的成员 "${e}.${m}"，已忽略`, line }),
  UNKNOWN_REL: (from, to, line) => ({ code: 'W_UNKNOWN_REL', level: 'warn', message: `指令引用了 mermaid 里没有声明的边 "${from} > ${to}"，已忽略`, line }),
  SKIP_STATEMENT: (text, line) => ({ code: 'W_SKIP_STATEMENT', level: 'warn', message: `跳过不支持的语句：${text}`, line }),
  BAD_ATTR: (k, v, line) => ({ code: 'W_BAD_ATTR', level: 'warn', message: `参数 ${k} 的值 "${v}" 无法解析，已忽略`, line }),
}

/* ──────────────────────────────────────────────────────────
   小工具
   ────────────────────────────────────────────────────────── */

/** 按空白切词，尊重双引号（引号内的空格不切）。 */
function tokenize(s) {
  const out = []
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/u.test(s[i])) i++
    if (i >= s.length) break
    let tok = ''
    if (s[i] === '"') {
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) i++
        tok += s[i++]
      }
      i++ // 跳掉收尾引号
    } else {
      // 未加引号的 token：允许中间出现 `key="带 空格 的值"`，遇到引号就整段吞进去
      while (i < s.length && !/\s/u.test(s[i])) {
        if (s[i] === '"') {
          i++
          while (i < s.length && s[i] !== '"') {
            if (s[i] === '\\' && i + 1 < s.length) i++
            tok += s[i++]
          }
          i++ // 跳掉收尾引号
          continue
        }
        tok += s[i++]
      }
    }
    out.push(tok)
  }
  return out
}

/** `a=1 b="x y"` → { a:'1', b:'x y' }，未知键原样返回。 */
function parseAttrs(tokens, line, diags, allowed, at) {
  const out = {}
  for (const tok of tokens) {
    const eq = tok.indexOf('=')
    if (eq <= 0) {
      diags.push(D.BAD_ATTR('(无键值对)', tok, line))
      continue
    }
    const k = tok.slice(0, eq)
    const v = tok.slice(eq + 1)
    if (!allowed.includes(k)) {
      diags.push(D.UNKNOWN_KEY(k, at, line))
      continue
    }
    out[k] = v
  }
  return out
}

/** 去掉行尾 `%%` 注释（mermaid 的注释），返回代码部分。 */
function stripComment(line) {
  const at = line.indexOf('%%')
  return at >= 0 ? line.slice(0, at) : line
}

/* ──────────────────────────────────────────────────────────
   ① 抽取 mermaid 块
   ────────────────────────────────────────────────────────── */

/**
 * 找第一个"内容含 classDiagram"的围栏代码块。
 * 支持 ```mermaid / ``` / 缩进围栏。
 * @returns {{ body:string, startLine:number, endLine:number } | null}
 */
export function extractMermaidBlock(text) {
  const lines = text.split(/\r?\n/u)
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)\s*$/u.exec(lines[i])
    if (!m) continue
    const fence = m[1]
    const lang = m[2].toLowerCase()
    const bodyStart = i + 1
    let j = bodyStart
    for (; j < lines.length; j++) {
      if (new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$', 'u').test(lines[j])) break
    }
    const body = lines.slice(bodyStart, j).join('\n')
    const looksMermaid = lang === 'mermaid' || /\bclassDiagram\b/u.test(body)
    if (looksMermaid && /\bclassDiagram\b/u.test(body)) {
      return { body, startLine: bodyStart + 1, endLine: j + 1 }
    }
    i = j // 跳过这个块
  }
  return null
}

/* ──────────────────────────────────────────────────────────
   ② 关系箭头表（必须按长度降序尝试，否则 `--` 会吃掉 `-->`）
   ────────────────────────────────────────────────────────── */

const ARROWS = [
  { token: '..|>', kind: 'implements', fromSide: 'left' },
  { token: '<|..', kind: 'implements', fromSide: 'right' },
  { token: '<|--', kind: 'extends', fromSide: 'right' },
  { token: '--|>', kind: 'extends', fromSide: 'left' },
  { token: '*--', kind: 'contains', fromSide: 'left' },
  { token: '--*', kind: 'contains', fromSide: 'right' },
  { token: 'o--', kind: 'uses', fromSide: 'left' },
  { token: '--o', kind: 'uses', fromSide: 'right' },
  { token: '..>', kind: 'calls', fromSide: 'left' },
  { token: '<..', kind: 'calls', fromSide: 'right' },
  { token: '-->', kind: 'calls', fromSide: 'left' },
  { token: '<--', kind: 'calls', fromSide: 'right' },
  { token: '..', kind: 'uses', fromSide: 'left' },
  { token: '--', kind: 'uses', fromSide: 'left' },
].sort((a, b) => b.token.length - a.token.length)

/** 在关系行里找箭头。返回 { arrow, left, right, label } 或 null。 */
function splitRelation(code) {
  for (const arrow of ARROWS) {
    const at = code.indexOf(arrow.token)
    if (at < 0) continue
    const left = code.slice(0, at).trim()
    let rest = code.slice(at + arrow.token.length).trim()
    let label = ''
    const colon = rest.indexOf(':')
    if (colon >= 0) {
      label = rest.slice(colon + 1).trim()
      rest = rest.slice(0, colon).trim()
    }
    if (left === '' || rest === '') continue
    return { arrow, left: cleanSide(left), right: cleanSide(rest), label }
  }
  return null
}

/** 去掉基数标注（"1"、"*"）与尾部空白；只留标识符。 */
function cleanSide(raw) {
  return raw.replace(/"[^"]*"/gu, ' ').trim().split(/\s+/u).pop() ?? ''
}

/* ──────────────────────────────────────────────────────────
   ③ 成员行
   ────────────────────────────────────────────────────────── */

const VIS_RE = /^([+\-#~])\s*/u

/**
 * 解析一行成员声明。
 * 支持：`+name: type` / `+name type` / `+name(params) Return` / `name`
 * @returns {{ kind:'field'|'method', name:string, type?:string, params?:string, returns?:string, visibility?:string, abstract?:boolean, static?:boolean }}
 */
export function parseMember(raw) {
  let s = raw.trim()
  const out = { kind: 'field', name: '' }
  const vis = VIS_RE.exec(s)
  if (vis) {
    out.visibility = vis[1]
    s = s.slice(vis[0].length)
  }
  // 尾部分类器：`*` 抽象、`$` 静态
  if (/\*$/u.test(s)) { out.abstract = true; s = s.slice(0, -1).trim() }
  if (/\$$/u.test(s)) { out.static = true; s = s.slice(0, -1).trim() }

  const paren = s.indexOf('(')
  if (paren >= 0) {
    const close = s.lastIndexOf(')')
    out.kind = 'method'
    out.name = (s.slice(0, paren).trim().split(/\s+/u).pop() ?? '').trim()
    out.params = close > paren ? s.slice(paren + 1, close).trim() : s.slice(paren + 1).trim()
    if (close >= 0) {
      const ret = s.slice(close + 1).trim()
      if (ret !== '') out.returns = ret
    }
    return out
  }
  const colon = s.indexOf(':')
  if (colon > 0) {
    out.name = s.slice(0, colon).trim()
    out.type = s.slice(colon + 1).trim()
  } else {
    const parts = s.split(/\s+/u).filter(Boolean)
    out.name = parts.length > 1 ? parts[parts.length - 1] : (parts[0] ?? '')
    if (parts.length > 1) out.type = parts.slice(0, -1).join(' ')
  }
  return out
}

/* ──────────────────────────────────────────────────────────
   ④ 类图解析
   ────────────────────────────────────────────────────────── */

/** stereotype → entityKind（spec 的枚举见 spec/ehm.ir.schema.json#entityKind）。 */
function kindOf(stereotype) {
  switch ((stereotype ?? '').toLowerCase()) {
    case 'interface': return 'interface'
    case 'capability': case 'service': case 'host-service': return 'capability'
    case 'function': return 'function'
    case 'module': case 'plugin': case 'command': return 'module'
    case 'type': return 'type'
    case 'enum': case 'enumeration': return 'type'
    default: return 'class'
  }
}

function emptyEntity(name) {
  return {
    name,
    kind: 'class',
    stereotype: undefined,
    summary: undefined,
    location: undefined,
    lines: undefined,
    fields: [],
    methods: [],
  }
}

/**
 * 解析 classDiagram 主体。
 * @param {string} body
 * @param {Diag[]} diags
 * @param {number} baseLine  该块在原文里的起始行（用于诊断定位）
 */
export function parseClassDiagram(body, diags, baseLine = 1) {
  const lines = body.split(/\r?\n/u)
  /** @type {Map<string, ReturnType<typeof emptyEntity>>} */
  const byName = new Map()
  /** @type {Array<{from:string,to:string,kind:string,label:string}>} */
  const relations = []
  let current = null

  const ensure = (name) => {
    if (!byName.has(name)) byName.set(name, emptyEntity(name))
    return byName.get(name)
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNo = baseLine + i
    const raw = stripComment(lines[i])
    const code = raw.trim()
    if (code === '') continue
    if (/^classDiagram\b/u.test(code)) continue
    if (/^direction\b/u.test(code)) continue
    if (/^namespace\b/u.test(code)) { diags.push(D.SKIP_STATEMENT(code, lineNo)); continue }
    if (/^note\b/u.test(code)) { diags.push(D.SKIP_STATEMENT(code, lineNo)); continue }
    if (/^style\b/u.test(code) || /^classDef\b/u.test(code) || /^cssClass\b/u.test(code) || /^link\b/u.test(code) || /^click\b/u.test(code) || /^callback\b/u.test(code)) {
      diags.push(D.SKIP_STATEMENT(code, lineNo))
      continue
    }

    // class Foo { / class Foo["label"] / class Foo <<stereotype>>
    const classOpen = /^class\s+([A-Za-z_][\w.$:-]*)\s*(?:\[[^\]]*\])?\s*(?:\{\s*)?$/u.exec(code)
    if (classOpen) {
      current = ensure(classOpen[1])
      continue
    }
    // class Foo <<interface>>
    const classStereo = /^class\s+([A-Za-z_][\w.$:-]*)\s*<<([^>]+)>>\s*$/u.exec(code)
    if (classStereo) {
      const e = ensure(classStereo[1])
      e.stereotype = classStereo[2].trim()
      e.kind = kindOf(e.stereotype)
      continue
    }
    if (code === '}') { current = null; continue }

    // 关系（须在成员之前判，因为 `A --> B` 也含 `>`）
    const rel = splitRelation(code)
    if (rel) {
      const fromName = rel.arrow.fromSide === 'left' ? rel.left : rel.right
      const toName = rel.arrow.fromSide === 'left' ? rel.right : rel.left
      if (fromName !== '' && toName !== '') {
        ensure(fromName)
        ensure(toName)
        relations.push({ from: fromName, to: toName, kind: rel.arrow.kind, label: rel.label })
        continue
      }
    }

    // `X : +member`
    const inlineMember = /^([A-Za-z_][\w.$:-]*)\s*:\s*(.+)$/u.exec(code)
    if (inlineMember && !/\s/u.test(inlineMember[1])) {
      const e = ensure(inlineMember[1])
      addMember(e, inlineMember[2], diags, lineNo)
      continue
    }

    // 类体内部
    if (current !== null) {
      const stereo = /^<<([^>]+)>>$/u.exec(code)
      if (stereo) {
        current.stereotype = stereo[1].trim()
        current.kind = kindOf(current.stereotype)
        continue
      }
      addMember(current, code, diags, lineNo)
      continue
    }

    diags.push(D.SKIP_STATEMENT(code, lineNo))
  }

  return { entities: [...byName.values()], relations }
}

function addMember(entity, raw, diags, lineNo) {
  const m = parseMember(raw)
  if (m.name === '') { diags.push(D.SKIP_STATEMENT(raw, lineNo)); return }
  if (m.kind === 'method') entity.methods.push(m)
  else entity.fields.push(m)
}

/* ──────────────────────────────────────────────────────────
   ⑤ %% ehm 指令
   ────────────────────────────────────────────────────────── */

const ENTITY_KEYS = ['file', 'line', 'lines', 'summary', 'kind', 'stereotype']
const MEMBER_KEYS = ['file', 'line', 'lines', 'summary']
// UML 指令不能把关系端绑定到方法；member 端点只存在于直接 IR 输入。
const REL_KEYS = ['file', 'line', 'label']
const SITE_KEYS = ['file', 'line', 'column']

/**
 * 从全文里收集 `%% ehm:*` 指令。
 * @returns {{ version:string|null, files:Array, entities:Array, members:Array, rels:Array, sites:Array, defaultFile:string|null }}
 */
export function parseDirectives(text) {
  const lines = text.split(/\r?\n/u)
  const out = {
    version: null,
    defaultFile: null,
    entities: [],
    members: [],
    rels: [],
    sites: [],
    unsupported: [],
  }
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*%%\s+ehm:(\S+)\s*(.*)$/u.exec(lines[i])
    if (m) {
      out.version = out.version ?? m[1]
      const rest = m[2].trim()
      if (rest !== '') out.unsupported.push({ text: lines[i].trim(), line: i + 1 })
      continue
    }
    const d = /^\s*%%\s+(file|entity|member|rel|site)\s+(.*)$/u.exec(lines[i])
    if (!d) continue
    out.unsupported.length // keep shape
    const kind = d[1]
    const tokens = tokenize(d[2])
    if (tokens.length === 0) continue
    const target = tokens[0]
    const rest = tokens.slice(1)
    const line = i + 1
    if (kind === 'file') { out.defaultFile = target; continue }
    if (kind === 'entity') out.entities.push({ name: target, attrs: rest, line })
    else if (kind === 'member') out.members.push({ path: target, attrs: rest, line })
    else if (kind === 'rel') out.rels.push({ key: target, attrs: rest, line })
    else if (kind === 'site') out.sites.push({ key: target, attrs: rest, line })
  }
  return out
}

/** 解析 `From>To` 或 `From>To#2`。 */
function splitRelKey(key) {
  const hash = key.indexOf('#')
  const nth = hash >= 0 ? Number.parseInt(key.slice(hash + 1), 10) : 1
  const core = hash >= 0 ? key.slice(0, hash) : key
  const gt = core.indexOf('>')
  if (gt < 0) return null
  return { from: core.slice(0, gt).trim(), to: core.slice(gt + 1).trim(), nth: Number.isFinite(nth) && nth > 0 ? nth : 1 }
}

/**
 * 把指令合并进模型。
 * @param {{entities:Array, relations:Array}} model
 * @param {ReturnType<typeof parseDirectives>} dirs
 * @param {Diag[]} diags
 */
export function applyDirectives(model, dirs, diags) {
  const byName = new Map(model.entities.map((e) => [e.name, e]))
  let defaultFile = dirs.defaultFile

  for (const d of dirs.entities) {
    const e = byName.get(d.name)
    if (!e) { diags.push(D.UNKNOWN_ENTITY(d.name, d.line)); continue }
    const a = parseAttrs(d.attrs, d.line, diags, ENTITY_KEYS, 'entity ' + d.name)
    const file = a.file ?? defaultFile
    if (file !== undefined) e.file = file
    if (a.line !== undefined) { const n = Number.parseInt(a.line, 10); if (n > 0) e.line = n; else diags.push(D.BAD_ATTR('line', a.line, d.line)) }
    if (a.lines !== undefined) { const n = Number.parseInt(a.lines, 10); if (n > 0) e.lines = n }
    if (a.summary !== undefined) e.summary = a.summary
    if (a.kind !== undefined) e.kind = a.kind
    if (a.stereotype !== undefined) { e.stereotype = a.stereotype; if (a.kind === undefined) e.kind = kindOf(a.stereotype) }
  }

  for (const d of dirs.members) {
    const dot = d.path.lastIndexOf('.')
    if (dot <= 0) { diags.push(D.UNKNOWN_MEMBER('?', d.path, d.line)); continue }
    const eName = d.path.slice(0, dot)
    const mName = d.path.slice(dot + 1)
    const e = byName.get(eName)
    if (!e) { diags.push(D.UNKNOWN_ENTITY(eName, d.line)); continue }
    const all = [...e.methods, ...e.fields]
    const target = all.find((m) => m.name === mName)
    if (!target) { diags.push(D.UNKNOWN_MEMBER(eName, mName, d.line)); continue }
    const a = parseAttrs(d.attrs, d.line, diags, MEMBER_KEYS, 'member ' + d.path)
    target.file = a.file ?? e.file ?? defaultFile
    if (a.line !== undefined) { const n = Number.parseInt(a.line, 10); if (n > 0) target.line = n }
    if (a.lines !== undefined) { const n = Number.parseInt(a.lines, 10); if (n > 0) target.lines = n }
    // 成员含义（方法/字段的一句话说明）——直接进 IR 的 member.summary，供 viewer 气泡展示
    if (a.summary !== undefined) target.summary = a.summary
  }

  /** 找到指令对应的关系；`#n` 指定同一对端点里的第 n 条。 */
  const findRel = (from, to, nth) => {
    const list = model.relations.filter((r) => r.from === from && r.to === to)
    return list[nth - 1]
  }

  for (const d of dirs.rels) {
    const k = splitRelKey(d.key)
    if (!k) { diags.push(D.UNKNOWN_REL('?', '?', d.line)); continue }
    const r = findRel(k.from, k.to, k.nth)
    if (!r) { diags.push(D.UNKNOWN_REL(k.from, k.to, d.line)); continue }
    const a = parseAttrs(d.attrs, d.line, diags, REL_KEYS, 'rel ' + d.key)
    r.file = a.file ?? findFile(model, k.from) ?? defaultFile
    if (a.line !== undefined) { const n = Number.parseInt(a.line, 10); if (n > 0) r.line = n }
    if (a.label !== undefined) r.label = a.label
  }

  for (const d of dirs.sites) {
    const k = splitRelKey(d.key)
    if (!k) continue
    const r = findRel(k.from, k.to, k.nth)
    if (!r) { diags.push(D.UNKNOWN_REL(k.from, k.to, d.line)); continue }
    const a = parseAttrs(d.attrs, d.line, diags, SITE_KEYS, 'site ' + d.key)
    const file = a.file ?? r.file ?? findFile(model, k.from) ?? defaultFile
    const line = Number.parseInt(a.line ?? '', 10)
    if (!file || !Number.isFinite(line)) { diags.push(D.BAD_ATTR('site', d.key, d.line)); continue }
    r.sites = r.sites ?? []
    r.sites.push({ file, line, ...(a.column !== undefined ? { column: Number.parseInt(a.column, 10) } : {}) })
  }

  // 已知实体补默认文件
  for (const e of model.entities) if (e.file === undefined && defaultFile) e.file = defaultFile
}

function findFile(model, name) {
  const e = model.entities.find((x) => x.name === name)
  return e ? e.file : undefined
}

/* ──────────────────────────────────────────────────────────
   ⑥ 主入口
   ────────────────────────────────────────────────────────── */

/**
 * 解析增强 UML 文本。
 * @param {string} text
 * @returns {{ model:{entities:Array, relations:Array}, diagnostics:Diag[], version:string|null }}
 */
export function parseUml(text) {
  /** @type {Diag[]} */
  const diagnostics = []
  const block = extractMermaidBlock(text)
  if (block === null) {
    diagnostics.push(D.NO_UML())
    return { model: { entities: [], relations: [] }, diagnostics, version: null }
  }

  const parsed = parseClassDiagram(block.body, diagnostics, block.startLine)
  const model = { entities: parsed.entities, relations: parsed.relations }

  const dirs = parseDirectives(text)
  if (dirs.version === null) {
    diagnostics.push(D.NO_DIRECTIVE())
  } else if (dirs.version !== 'v1') {
    diagnostics.push(D.BAD_VERSION(dirs.version))
  } else {
    applyDirectives(model, dirs, diagnostics)
  }

  for (const u of dirs.unsupported) diagnostics.push(D.UNKNOWN_DIRECTIVE(u.text, u.line))

  return { model, diagnostics, version: dirs.version, layoutHint: layoutOf(text) }
}

/** `%% ehm:layout rankdir=TB ranksep=110` 之类的宿主提示（可选，未知则 undefined）。 */
function layoutOf(text) {
  const m = /^\s*%%\s+ehm:layout\s+(.+)$/mu.exec(text)
  if (!m) return undefined
  const attrs = {}
  for (const tok of tokenize(m[1].trim())) {
    const eq = tok.indexOf('=')
    if (eq > 0) attrs[tok.slice(0, eq)] = tok.slice(eq + 1)
  }
  return attrs
}

export default { parseUml, extractMermaidBlock, parseClassDiagram, parseDirectives, applyDirectives, parseMember }
