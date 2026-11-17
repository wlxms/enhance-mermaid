/**
 * to-ir.mjs —— 物化模型 → EHM IR 1.0.0
 *
 * 只做形状映射，不做任何判断。产出的 IR 必须能通过 `node spec/validate.mjs`。
 *
 * 两个约定（与 spec 的差异要在 README 里说清）：
 *   · **views 是 facet 声明**：一张卡片图里同时有 `extends` 与 `calls`，而 spec 的 P1 要求"一视图一边类型"。
 *     解法是按边类型各发一个 view（满足 schema），渲染器按"画全集"处理（与既有 poc 行为一致）。
 *   · **provenance = heuristic**：结构由 Agent 从文本声明、CLI 只验证了文件与行号存在，
 *     不是 AST 推导出来的，所以诚实标 heuristic。
 *
 * @module poc/src/to-ir
 */

/** IR 的 ident 规则（见 spec/ehm.ir.schema.json#ident）。 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.$:@-]*$/u

function ident(raw, fallback) {
  const s = String(raw ?? '').trim()
  return IDENT_RE.test(s) ? s : (fallback ?? s.replace(/[^A-Za-z0-9_.$:@-]/gu, '_').replace(/^[^A-Za-z_]/, '_'))
}

/** stereotype 里"是个什么角色"的白名单（宿主中立词，不是 DSH 概念）。 */
function locationOf(holder, fallbackFile) {
  const file = holder.evidence?.file ?? holder.file ?? fallbackFile
  const line = holder.evidence?.line ?? holder.line
  if (file === undefined || line === undefined) return undefined
  return {
    file,
    line,
    column: 1,
    basis: 'definition',
    symbol: holder.name,
  }
}

function evidenceOf(holder) {
  const ev = holder.evidence
  if (!ev) return undefined
  return { file: ev.file, line: ev.line, endLine: ev.endLine ?? ev.line, code: ev.code ?? '' }
}

function toField(f) {
  const out = { name: f.name }
  if (f.type !== undefined) out.type = f.type
  if (f.visibility !== undefined) out.visibility = f.visibility
  const loc = locationOf(f)
  if (loc) out.location = loc
  const ev = evidenceOf(f)
  if (ev) out.evidence = ev
  if (f.summary !== undefined) out.summary = f.summary
  return out
}

function toMethod(entityId, m) {
  const out = { id: ident(`${entityId}.${m.name}`, `${entityId}.m`), name: m.name }
  if (m.visibility !== undefined) out.visibility = m.visibility
  if (m.params !== undefined) out.params = m.params
  if (m.returns !== undefined) out.returns = m.returns
  if (m.params !== undefined || m.returns !== undefined) {
    out.signature = `${m.name}(${m.params ?? ''})${m.returns !== undefined ? ' ' + m.returns : ''}`
  }
  const loc = locationOf(m)
  if (loc) out.location = loc
  const ev = evidenceOf(m)
  if (ev) out.evidence = ev
  // 方法含义（P13）：%% member ... summary="..." → IR member.summary，viewer 悬停气泡头部显示
  if (m.summary !== undefined) out.summary = m.summary
  if (m.abstract === true) out.abstract = true
  if (m.static === true) out.static = true
  return out
}

function toEntity(e) {
  const id = ident(e.name)
  const out = {
    id,
    kind: e.kind ?? 'class',
    name: e.name,
    qualifiedName: e.name,
    scope: 'symbol',
  }
  const loc = locationOf(e)
  if (loc) out.location = loc
  if (e.stereotype !== undefined) out.stereotype = e.stereotype
  if (e.summary !== undefined) out.summary = e.summary
  const ev = evidenceOf(e)
  if (ev) out.evidence = ev
  if (Array.isArray(e.fields) && e.fields.length > 0) out.fields = e.fields.map(toField)
  if (Array.isArray(e.methods) && e.methods.length > 0) out.methods = e.methods.map((m) => toMethod(id, m))
  return out
}

function toRelation(r, pairIndex) {
  const fromId = ident(r.from)
  const toId = ident(r.to)
  // 当前 UML/%% rel 语法不携带 member（只有 file/line/label），
  // 所以 CLI 产物永远是实体级端点；viewer 的 IR 级方法端点只对直接 IR 输入生效。
  const out = {
    id: `rel.${fromId}.${toId}${pairIndex > 0 ? '.' + pairIndex : ''}`,
    kind: r.kind ?? 'calls',
    from: { entity: fromId },
    to: { entity: toId },
  }
  if (r.label !== undefined && r.label !== '') out.label = r.label
  const ev = evidenceOf(r)
  out.evidence = ev ?? { file: r.file ?? '', line: r.line ?? 1 }
  if (out.evidence.file === '') delete out.evidence.file
  out.provenance = 'heuristic'
  out.confidence = r.evidence ? 0.9 : 0.6
  if (Array.isArray(r.sites) && r.sites.length > 0) {
    out.sites = r.sites.map((s) => {
      const site = { file: s.file, line: s.line }
      if (s.column !== undefined) site.column = s.column
      if (s.endLine !== undefined) site.endLine = s.endLine
      if (s.code !== undefined) site.code = s.code
      return site
    })
  }
  return out
}

/** 一张 view 的 fold 预算（P3：层状代替密度）。 */
function foldSpec() {
  return {
    maxNodes: 60,
    maxEdges: 120,
    mechanism: 'aggregate',
    aggregationOrder: ['degree', 'directory', 'depth'],
    aggregateLabel: '+{n} more',
  }
}

/**
 * 模型 → IR。
 * @param {{entities:Array, relations:Array}} model
 * @param {{roots?:string[], title?:string, theme?:string, generator?:object, layoutHint?:object}} opts
 * @returns {object}
 */
export function toIr(model, opts = {}) {
  const entities = model.entities.map(toEntity)
  // 同一对端点可能有多条边（如 extends + calls）：id 用 pair 内序号消歧
  const pairSeen = new Map()
  const relations = model.relations.map((r) => {
    const key = `${r.from}\\u0000${r.to}`
    const n = pairSeen.get(key) ?? 0
    pairSeen.set(key, n + 1)
    return toRelation(r, n)
  })
  const entityIds = new Set(entities.map((e) => e.id))

  // 丢弃指向不存在实体的边（parse 阶段已保证存在，这里只是防御）
  const keptRelations = relations.filter((r) => entityIds.has(r.from.entity) && entityIds.has(r.to.entity))

  // 每种边类型一个 facet view（渲染器按"画全集"处理）
  const kinds = [...new Set(keptRelations.map((r) => r.kind))]
  if (kinds.length === 0) kinds.push('uses')
  const views = kinds.map((kind) => {
    const ofKind = keptRelations.filter((r) => r.kind === kind)
    // validate R6 的口径：uml 视图按"该视图边涉及的实体数"计节点
    const endpoints = new Set()
    for (const r of ofKind) { endpoints.add(r.from.entity); endpoints.add(r.to.entity) }
    const nodes = endpoints.size
    // edges 按"去重端点对"计（与 spec/validate.mjs 的 resolveView 同口径），不是关系条数：
    // 同一对端点可以有多条关系（例如两个方法各调用一次同一能力），渲染成一条边。
    const edges = new Set(ofKind.map((r) => `${r.from.entity}->${r.to.entity}`)).size
    const hit = nodes > 60 || edges > 120
    return {
      id: `view.uml.${kind}`,
      type: 'uml',
      title: `UML · ${kind}`,
      facet: kind,
      edge: { kind, direction: 'forward' },
      query: { filter: {} },
      fold: foldSpec(),
      layoutFamily: 'uml',
      foldResult: { nodes, edges, collapsed: 0, hitBudget: hit },
    }
  })

  const roots = opts.roots ?? []
  return {
    schemaVersion: '1.0.0',
    meta: {
      locale: 'zh-CN',
      generatedAt: new Date().toISOString(),
      // static：结构来自静态文本 + 文件读取，没有 LSP/AST 参与
      generator: { name: 'ehm', version: opts.generator?.version ?? '0.1.0', mode: 'static' },
      workspace: { root: roots[0] ?? '.', ...(roots.length > 1 ? { roots } : {}) },
      capabilities: { lsp: false, git: false },
      evidenceMode: 'inline',
      // 展示用标题与布局提示属于宿主/渲染层信息，按 spec 规矩收进单个 x-* 命名空间（x-* 必须是对象）
      ...((opts.title !== undefined || opts.layoutHint !== undefined)
        ? {
            'x-ehm': {
              ...(opts.title !== undefined ? { title: opts.title } : {}),
              ...(opts.layoutHint !== undefined ? { layout: opts.layoutHint } : {}),
            },
          }
        : {}),
    },
    entities,
    relations: keptRelations,
    views,
  }
}

export default { toIr }
