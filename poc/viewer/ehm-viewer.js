/* ============================================================
   ehm-viewer.js —— EHM IR → 可交互 UML 卡片图
   ------------------------------------------------------------
   设计约束（来自验收要求）：
     · 只有一个入口：EHMViewer.render(ir, container, options)
       IR 必须作为**参数**传入；本文件不 fetch、不读文件、不认任何宿主。
     · 跳转统一走 options.onJump({file,line,column,symbol,edgeId})；
       默认实现 = 复制 "file:line:col" 到剪贴板 + 右下角 toast。
     · 除 dagre bundle（window.DAGRE）外零依赖。
     · 布局：dagre 分层（LR）+ 两遍布局（估算 → 量真实尺寸 → 重跑）。
     · 走线：正交（stub + 通道 + 端口均分 + 通道避让 + 竖直段分离）。
     · 标签：宽度参与 dagre 布局；渲染时推到线外，并避让卡片与其他线。
     · 气泡：绝不覆盖被悬停/点击对象；优先贴近鼠标，其他卡片允许轻微重叠。
   ============================================================ */

;(function (global) {
  'use strict'

  var SVG_NS = 'http://www.w3.org/2000/svg'
  var VERSION = '0.1.0'

  /* 字体：CSS 里用同一组具体字体族，保证 canvas 测量 == DOM 渲染 */
  var MONO = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, "SFMono-Regular", Consolas, "Cascadia Mono", monospace'
  var SANS = 'Inter, "Helvetica Neue", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif'
  var FONT = {
    title: '600 12.5px ' + MONO,
    stereo: '500 9px ' + MONO,
    member: '400 10.5px ' + MONO,
    label: '500 9.5px ' + MONO,
    code: '400 10.5px ' + MONO,
  }

  /** 几何常量（与 style.css 严格对应） */
  var G = {
    ROW_H: 21,
    ROW_PAD_X: 24,
    BORDER_X: 2,
    /** .ehm-head 的上下 padding(5+4) + 类名行(17) = 26；stereotype / summary 各自再加 */
    HEAD_BASE: 26,
    STEREO_H: 12,
    SUMMARY_H: 13,
    /** summary 超过这个宽度就折成两行，避免把卡片撑得过宽 / 文字被裁 */
    SUMMARY_MAX_W: 300,
    BORDER_Y: 2,
    COMPARTMENT_PAD_Y: 8,
    MIN_W: 168,
    STUB: 16,
    LABEL_H: 16,
    LABEL_PAD_X: 12,
    PARALLEL_GAP: 10,
    MIN_GAP_TO_WIRE: 4,
    /** 两条平行线的最小净距；小于它视觉上仍像贴着重叠。 */
    MIN_WIRE_GAP: 12,
    /** 同一张卡片边上两个箭头端点的最小间距；14px 仍会让箭头压在一起。 */
    ENDPOINT_GAP: 24,
  }

  var LAYOUT_BASE = {
    rankdir: 'TB',
    // 略小于 prototype14 的 130/52：本图的右列有 9 张卡，
    // nodesep 直接决定整张图的高度；配合 1800x1500 视口可让 fit 接近 1:1。
    ranksep: 112,
    nodesep: 64,
    marginx: 8,
    marginy: 8,
    ranker: 'network-simplex',
  }
  /** 内置主题：默认 DSH 深/浅，另有 Graphite / Editorial Technical / Carbon。 */
  var SKINS = [
    { id: 'dsh-dark', label: 'DSH 深色', theme: 'dark' },
    { id: 'dsh-light', label: 'DSH 浅色', theme: 'light' },
    { id: 'graphite', label: 'Graphite', theme: 'dark' },
    { id: 'editorial', label: 'Editorial Technical', theme: 'light' },
    { id: 'carbon', label: 'Carbon', theme: 'dark' },
  ]

  var PAD = { x: 56, y: 56 }
  /** 当前渲染的布线轴：'h' 横向（LR）/ 'v' 纵向（TB）。由 createViewer 按 rankdir 设置。 */
  var CURRENT_EDGE_AXIS = 'h'
  // 行转列后同一列内还可能有上下级关系：跨列用左右端口，同列用上下端口。
  var CURRENT_EDGE_AXIS_AUTO = false

  /* ============================================================
     0. 小工具
     ============================================================ */

  function fail(msg) { throw new Error('EHMViewer: ' + msg) }

  /** 保留 1 位小数，避免 SVG 里出现超长浮点串。 */
  function round1(n) { return Math.round(n * 10) / 10 }

  function el(tag, attrs, children) {
    var n = document.createElement(tag)
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue
        var v = attrs[k]
        if (v === undefined || v === null) continue
        if (k === 'class') n.className = v
        else if (k === 'text') n.textContent = v
        else if (k === 'style') n.setAttribute('style', v)
        else n.setAttribute(k, String(v))
      }
    }
    if (children) {
      var list = [].concat(children)
      for (var i = 0; i < list.length; i++) {
        var c = list[i]
        if (c === null || c === undefined || c === false) continue
        n.append(typeof c === 'string' ? document.createTextNode(c) : c)
      }
    }
    return n
  }

  function svg(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag)
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue
        if (attrs[k] === undefined || attrs[k] === null) continue
        n.setAttribute(k, String(attrs[k]))
      }
    }
    return n
  }

  /* ============================================================
     1. 文字测量（canvas，与 DOM 同字体）
     ============================================================ */

  var measureSurface = null
  function measureText(text, font) {
    if (measureSurface === null) measureSurface = document.createElement('canvas')
    var g = measureSurface.__g
    if (!g) { g = measureSurface.getContext('2d'); measureSurface.__g = g }
    g.font = font
    return g.measureText(String(text === undefined ? '' : text)).width
  }

  /* ============================================================
     2. 极简 TypeScript 着色（只为「扫一眼能分清结构」）
     ============================================================ */

  var KW = {}
  ;('import export from const let var function class extends implements interface type enum '
    + 'namespace module abstract static readonly public private protected override async await '
    + 'return if else for while do switch case default break continue try catch finally throw '
    + 'new this super typeof instanceof in of as is declare satisfies keyof infer never void '
    + 'null undefined true false yield delete get set').split(' ').forEach(function (w) { KW[w] = 1 })

  var TYPES = {}
  ;('string number boolean object symbol bigint unknown any Promise Array Record Map Set Date '
    + 'Error Partial Readonly Pick Omit Exclude Extract ReturnType Awaited AbortSignal').split(' ').forEach(function (w) { TYPES[w] = 1 })

  function tokenizeLine(line, inBlockComment) {
    var out = []
    var i = 0
    var n = line.length
    var inComment = inBlockComment === true
    function push(t, v) {
      if (v === '') return
      var last = out.length > 0 ? out[out.length - 1] : null
      if (t === 'plain' && last !== null && last.t === 'plain') last.v += v
      else out.push({ t: t, v: v })
    }
    while (i < n) {
      if (inComment) {
        var endc = line.indexOf('*/', i)
        if (endc < 0) { push('comment', line.slice(i)); i = n }
        else { push('comment', line.slice(i, endc + 2)); i = endc + 2; inComment = false }
        continue
      }
      var ch = line[i]
      var nx = line[i + 1]
      if (ch === '/' && nx === '/') { push('comment', line.slice(i)); break }
      if (ch === '/' && nx === '*') {
        var endb = line.indexOf('*/', i + 2)
        if (endb < 0) { push('comment', line.slice(i)); inComment = true; break }
        push('comment', line.slice(i, endb + 2)); i = endb + 2; continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        var q = ch
        var j = i + 1
        while (j < n) {
          if (line[j] === '\\') { j += 2; continue }
          if (line[j] === q) { j += 1; break }
          j += 1
        }
        push('string', line.slice(i, j)); i = j; continue
      }
      if (ch >= '0' && ch <= '9') {
        var d = i
        while (d < n && /[0-9a-fA-FxX._]/.test(line[d])) d += 1
        push('number', line.slice(i, d)); i = d; continue
      }
      if (ch === '@' && /[A-Za-z_$]/.test(nx || '')) {
        var a = i + 1
        while (a < n && /[A-Za-z0-9_$]/.test(line[a])) a += 1
        push('decorator', line.slice(i, a)); i = a; continue
      }
      if (/[A-Za-z_$]/.test(ch)) {
        var b = i
        while (b < n && /[A-Za-z0-9_$]/.test(line[b])) b += 1
        var word = line.slice(i, b)
        var k2 = b
        while (k2 < n && line[k2] === ' ') k2 += 1
        var isCall = line[k2] === '('
        if (KW[word]) push('keyword', word)
        else if (word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) push(TYPES[word] ? 'type' : 'class', word)
        else if (isCall) push('fn', word)
        else if (TYPES[word]) push('type', word)
        else push('plain', word)
        i = b; continue
      }
      push('punct', ch); i += 1
    }
    return { tokens: out, inBlockComment: inComment }
  }

  /** 把 code 文本渲染成带行号的高亮 DOM。 */
  function renderCodeBlock(text, firstLine) {
    var box = el('div', { class: 'ehm-code' })
    var raw = String(text === undefined ? '' : text).split('\n')
    var inComment = false
    var startNo = typeof firstLine === 'number' && isFinite(firstLine) ? firstLine : 1
    for (var i = 0; i < raw.length; i++) {
      var res = tokenizeLine(raw[i], inComment)
      inComment = res.inBlockComment
      var row = el('div', { class: 'ehm-code-line' })
      row.append(el('span', { class: 'ehm-ln', text: String(startNo + i) }))
      var src = el('span', { class: 'ehm-src' })
      if (raw[i] === '') src.textContent = ' '
      else {
        for (var t = 0; t < res.tokens.length; t++) {
          var tok = res.tokens[t]
          if (tok.t === 'plain' || tok.t === 'punct') src.append(document.createTextNode(tok.v))
          else src.append(el('span', { class: 'ehm-tk-' + tok.t, text: tok.v }))
        }
      }
      row.append(src)
      box.append(row)
    }
    return box
  }

  /* ============================================================
     3. IR 归一化（权威形状 = spec/ 的 1.0.0；同时兼容 0.1 旧形状）

     ## 为什么需要这一层

     IR 有两代形状，而渲染器只有一套：

       | 维度        | 1.0.0（spec，权威）                  | 0.1（早期原型）           |
       | ----------- | ------------------------------------ | ------------------------- |
       | schemaVer   | "1.0.0"                              | "0.1"                     |
       | kind 枚举   | module/class/interface/function/...  | class/abstract/service/...|
       | 关系 kind   | calls/extends/implements/uses/...    | call/inherit/depend/...   |
       | 关系端点    | {entity:"X", member:"m"}             | "X" + fromMethod          |
       | 位置        | {file,line,column,basis,symbol}      | {file,line} 或 line 数字  |
       | 证据正文    | evidence.code                        | evidence.snippet          |

     归一化的唯一职责：把两种形状**擦平成同一个内部形状**，让下游
     （测尺寸 / dagre / 走线 / 渲染 / 气泡 / 跳转）只认一种结构。

     这个函数是**纯函数**（不碰 DOM、不改入参），因此可以在 node 里单测。
     归一化结果里 `model.irVersion` / `model.irCompat` 供测试断言走了哪条路径。
     ============================================================ */

  /** spec 1.0.0 的 relation.kind 全量（来自 spec/ehm.ir.schema.json#definitions.relationKind）。 */
  var RELATION_KINDS = {
    calls: 1, imports: 1, extends: 1, implements: 1, uses: 1, contains: 1, 'diff-change': 1,
  }

  /**
   * 0.1 → 1.0.0 的 kind 映射表。
   * 这张表也写进 README，因为「老分析器产物还能不能渲染」取决于它。
   */
  var RELATION_KIND_COMPAT = {
    inherit: 'extends',
    call: 'calls',
    calls: 'calls',
    depend: 'uses',
    dependency: 'uses',
    uses: 'uses',
    import: 'imports',
    imports: 'imports',
    compose: 'contains',
    composition: 'contains',
    aggregate: 'contains',
    aggregation: 'contains',
    contains: 'contains',
    impl: 'implements',
    implements: 'implements',
    change: 'diff-change',
    'diff-change': 'diff-change',
  }

  /** 0.1 → 1.0.0 的 entity.kind 映射。 */
  var ENTITY_KIND_COMPAT = {
    abstract: 'interface',
    service: 'capability',
    module: 'module',
    class: 'class',
    function: 'function',
    interface: 'interface',
    file: 'file',
    type: 'type',
    const: 'const',
    capability: 'capability',
    aggregate: 'aggregate',
    unknown: 'unknown',
  }

  var ENTITY_KINDS = {
    module: 1, file: 1, class: 1, interface: 1, function: 1, type: 1, const: 1,
    capability: 1, aggregate: 1, unknown: 1,
  }

  /** 判断 IR 走哪条路径。只看 major 版本；缺失版本时按形状嗅探。 */
  function detectIrPath(ir) {
    var v = ir.schemaVersion !== undefined ? String(ir.schemaVersion) : ''
    var m = /^(\d+)\.(\d+)/.exec(v)
    if (m !== null) {
      var major = Number(m[1])
      return { path: major >= 1 ? 'spec' : 'legacy', version: v, major: major }
    }
    // 版本号缺失：1.0.0 的关系端点一定是对象；0.1 一定是字符串
    var rel = (ir.relations || ir.edges || [])[0]
    if (rel && rel.from && typeof rel.from === 'object') return { path: 'spec', version: 'unknown', major: 1 }
    return { path: 'legacy', version: 'unknown', major: 0 }
  }

  function toNum(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback
  }

  /** 统一位置对象：既接受 {file,line,...} 也接受裸数字行号。 */
  function normalizeLocation(loc, fallbackLine) {
    if (loc === undefined || loc === null) {
      return { file: '', line: toNum(fallbackLine, 0), column: 1, symbol: undefined, basis: undefined }
    }
    if (typeof loc === 'number') return { file: '', line: loc, column: 1, symbol: undefined, basis: undefined }
    if (typeof loc === 'string') return { file: loc, line: toNum(fallbackLine, 0), column: 1, symbol: undefined, basis: undefined }
    return {
      file: loc.file !== undefined ? String(loc.file) : '',
      line: toNum(loc.line, toNum(fallbackLine, 0)),
      column: toNum(loc.column, 1),
      symbol: loc.symbol !== undefined ? String(loc.symbol) : undefined,
      basis: loc.basis,
      endLine: typeof loc.endLine === 'number' ? loc.endLine : undefined,
    }
  }

  /**
   * 统一证据对象。
   * 1.0.0: {file, line, column, endLine, code, snippetRef, symbol}
   * 0.1  : {file, from, to, totalLines, truncated, note, snippet}
   * 内部统一成 {file, from, to, code, ...}，下游只认这个。
   */
  function normalizeEvidence(ev) {
    if (ev === undefined || ev === null) return null
    if (typeof ev === 'string') {
      return { file: '', from: 0, to: 0, code: ev, snippetRef: undefined, provenance: undefined }
    }
    var code = ''
    if (ev.code !== undefined && ev.code !== null) code = String(ev.code)
    else if (ev.snippet !== undefined && ev.snippet !== null) code = String(ev.snippet)

    var from = toNum(ev.line, toNum(ev.from, 0))
    var to = toNum(ev.endLine, toNum(ev.to, from))
    return {
      file: ev.file !== undefined ? String(ev.file) : '',
      from: from,
      to: to,
      code: code,
      symbol: ev.symbol,
      snippetRef: ev.snippetRef,
      totalLines: typeof ev.totalLines === 'number' ? ev.totalLines : undefined,
      truncated: ev.truncated === true,
      note: ev.note,
      /** 1.0.0 的 evidenceMode=slim 时只有 snippetRef 没有 code —— 记下来供 UI 提示 */
      slim: ev.slim === true || (code === '' && ev.snippetRef !== undefined),
    }
  }

  /** 关系端点：1.0.0 {entity,member} / 0.1 "X" / dagre {id} 。 */
  function normalizeEndpoint(ep, fallbackMember) {
    if (ep === undefined || ep === null) return { entity: undefined, member: fallbackMember || null }
    if (typeof ep === 'string') return { entity: ep, member: fallbackMember || null }
    var id = ep.entity !== undefined ? ep.entity
      : ep.id !== undefined ? ep.id
        : ep['class'] !== undefined ? ep['class']
          : undefined
    var member = ep.member !== undefined ? ep.member : (fallbackMember || null)
    return { entity: id === undefined ? undefined : String(id), member: member === null ? null : String(member) }
  }

  /** 成员（字段 / 方法）归一化。 */
  function normalizeMember(m, entityId, index, isMethod) {
    var name = m.name !== undefined ? String(m.name) : ('member' + index)
    var loc = normalizeLocation(m.location, m.line)
    return {
      id: m.id !== undefined ? String(m.id) : (entityId + '.' + name),
      name: name,
      visibility: m.visibility,
      type: m.type,
      params: m.params,
      returns: m.returns,
      signature: m.signature,
      abstract: m.abstract === true,
      static: m.static === true,
      summary: m.summary,
      line: loc.line,
      column: loc.column,
      location: loc,
      evidence: normalizeEvidence(m.evidence),
      raw: m,
    }
  }

  /**
   * **纯函数**：把任意版本的 IR 归一化成 viewer 内部形状。
   * @param {object} ir 原始 IR
   * @returns {{irVersion:string, irMajor:number, irPath:'spec'|'legacy', ...}}
   */
  function normalizeIR(ir) {
    if (ir === null || typeof ir !== 'object') fail('IR 必须是对象')
    var detected = detectIrPath(ir)

    var rawEntities = ir.entities || ir.classes || ir.nodes
    if (!Array.isArray(rawEntities) || rawEntities.length === 0) fail('IR 缺少 entities[]')

    var seen = {}
    var entities = []
    var kindAliased = 0
    var i
    for (i = 0; i < rawEntities.length; i++) {
      var c = rawEntities[i]
      if (!c || c.id === undefined) continue
      var id = String(c.id)
      if (seen[id]) continue
      seen[id] = 1

      var rawKind = c.kind || c.type || 'unknown'
      var kind = ENTITY_KINDS[rawKind] ? rawKind : (ENTITY_KIND_COMPAT[rawKind] || 'unknown')
      if (kind !== rawKind) kindAliased += 1

      var loc = normalizeLocation(c.location, c.line)
      var ent = {
        id: id,
        kind: kind,
        rawKind: rawKind,
        name: c.name !== undefined ? String(c.name) : id,
        qualifiedName: c.qualifiedName,
        scope: c.scope,
        stereotype: c.stereotype,
        summary: c.summary,
        size: c.size,
        entry: c.entry === true,
        heat: typeof c.heat === 'number' ? c.heat : undefined,
        folded: c.folded,
        diff: c.diff,
        location: loc,
        fields: [],
        methods: [],
        evidence: normalizeEvidence(c.evidence),
        raw: c,
      }
      var fs = c.fields || []
      for (var k = 0; k < fs.length; k++) ent.fields.push(normalizeMember(fs[k], id, k, false))
      var ms = c.methods || []
      for (var q = 0; q < ms.length; q++) ent.methods.push(normalizeMember(ms[q], id, q, true))
      entities.push(ent)
    }
    if (entities.length === 0) fail('IR 里没有可用实体')

    var byId = {}
    for (i = 0; i < entities.length; i++) byId[entities[i].id] = entities[i]

    var rawRels = ir.relations || ir.edges || []
    if (!Array.isArray(rawRels)) rawRels = []
    var relations = []
    var dropped = []
    var kindAliasedRels = 0

    for (i = 0; i < rawRels.length; i++) {
      var rel = rawRels[i]
      if (!rel) continue
      var fromEp = normalizeEndpoint(rel.from !== undefined ? rel.from : rel.source, rel.fromMethod)
      var toEp = normalizeEndpoint(rel.to !== undefined ? rel.to : rel.target, rel.toMethod)

      if (!fromEp.entity || !toEp.entity) {
        dropped.push({ id: rel.id, reason: 'missing endpoint' })
        continue
      }
      if (!byId[fromEp.entity] || !byId[toEp.entity]) {
        dropped.push({ id: rel.id, reason: 'unknown endpoint: ' + fromEp.entity + ' -> ' + toEp.entity })
        continue
      }
      if (fromEp.entity === toEp.entity) {
        dropped.push({ id: rel.id, reason: 'self relation' })
        continue
      }

      var rawRelKind = rel.kind || rel.type || rel.relType || 'calls'
      var relKind = RELATION_KINDS[rawRelKind] ? rawRelKind : (RELATION_KIND_COMPAT[rawRelKind] || 'calls')
      if (relKind !== rawRelKind) kindAliasedRels += 1

      // 1.0.0 的额外证据点：sites[] 是「同一个语义关系的多处调用点」
      var sites = []
      if (Array.isArray(rel.sites)) {
        for (var s = 0; s < rel.sites.length; s++) {
          var st = rel.sites[s]
          if (!st) continue
          sites.push({
            file: st.file !== undefined ? String(st.file) : '',
            line: toNum(st.line, 0),
            column: toNum(st.column, 1),
            endLine: typeof st.endLine === 'number' ? st.endLine : undefined,
            code: st.code !== undefined ? String(st.code) : '',
            form: st.form,
          })
        }
      }

      relations.push({
        id: rel.id !== undefined ? String(rel.id) : ('rel-' + (relations.length + 1)),
        kind: relKind,
        rawKind: rawRelKind,
        from: fromEp.entity,
        to: toEp.entity,
        fromMethod: fromEp.member,
        toMethod: toEp.member,
        label: rel.label !== undefined ? String(rel.label) : '',
        evidence: normalizeEvidence(rel.evidence),
        sites: sites,
        provenance: rel.provenance,
        confidence: typeof rel.confidence === 'number' ? rel.confidence : undefined,
        external: rel.external === true,
        cycle: rel.cycle === true,
        role: rel.role,
        raw: rel,
      })
    }

    var views = normalizeViews(ir, entities)

    return {
      irVersion: detected.version,
      irMajor: detected.major,
      irPath: detected.path,
      meta: ir.meta || {},
      entities: entities,
      relations: relations,
      views: views,
      view: views.length > 0 ? views[0] : {},
      dropped: dropped,
      compat: {
        path: detected.path,
        entityKindAliased: kindAliased,
        relationKindAliased: kindAliasedRels,
      },
    }
  }

  /** views[]：只保留渲染器认识的部分（type / edge.kind / query.filter.entityKinds / root）。 */
  function normalizeViews(ir, entities) {
    if (!Array.isArray(ir.views)) return []
    var out = []
    for (var i = 0; i < ir.views.length; i++) {
      var v = ir.views[i]
      if (!v) continue
      var edgeKind = null
      if (v.edge && v.edge.kind) {
        var rk = v.edge.kind
        edgeKind = RELATION_KINDS[rk] ? rk : (RELATION_KIND_COMPAT[rk] || null)
      }
      var entityKinds = null
      if (v.query && v.query.filter && Array.isArray(v.query.filter.entityKinds)) {
        entityKinds = v.query.filter.entityKinds.map(function (k) {
          return ENTITY_KINDS[k] ? k : (ENTITY_KIND_COMPAT[k] || 'unknown')
        })
      }
      var root = null
      if (v.query && v.query.root) {
        var rootEntity = typeof v.query.root === 'string' ? v.query.root
          : (v.query.root.entity !== undefined ? v.query.root.entity : null)
        if (rootEntity !== null) {
          root = {
            entity: String(rootEntity),
            member: v.query.root.member !== undefined ? String(v.query.root.member) : null,
          }
        }
      }
      out.push({
        id: v.id !== undefined ? String(v.id) : ('view-' + i),
        type: v.type !== undefined ? String(v.type) : 'uml',
        title: v.title,
        facet: v.facet,
        edgeKind: edgeKind,
        direction: v.edge && v.edge.direction ? v.edge.direction : 'forward',
        entityKinds: entityKinds,
        root: root,
        depth: v.query && typeof v.query.depth === 'number' ? v.query.depth : undefined,
        layoutFamily: v.layoutFamily,
        fold: v.fold,
        foldResult: v.foldResult,
        raw: v,
      })
    }
    return out
  }

  /* ============================================================
     4. 卡片尺寸
     ============================================================ */

  function formatField(f) {
    var vis = f.visibility === undefined ? '-' : f.visibility
    var type = f.type !== undefined && f.type !== '' ? ': ' + f.type : ''
    return vis + ' ' + f.name + type
  }

  function formatMethod(m) {
    var vis = m.visibility === undefined ? '+' : m.visibility
    var sig = m.signature
    if (sig === undefined || sig === '') {
      var params = m.params !== undefined && m.params !== '' ? '(' + m.params + ')' : '()'
      sig = m.name + params
      if (m.returns !== undefined && m.returns !== '') sig += ': ' + m.returns
    }
    return vis + ' ' + sig
  }

  function measureCard(ent, collapsed) {
    var nameW = measureText(ent.name, FONT.title)
    var stereoW = ent.stereotype !== undefined && ent.stereotype !== ''
      ? measureText('«' + ent.stereotype + '»', FONT.stereo) : 0
    var summaryW = ent.summary !== undefined && ent.summary !== ''
      ? measureText(ent.summary, SANS) : 0

    /** summary 过长就折两行，同时限制它对卡片宽度的贡献 —— 否则页面被它撑宽或文字被裁 */
    var summaryLines = summaryW > G.SUMMARY_MAX_W ? 2 : (summaryW > 0 ? 1 : 0)
    var summaryLayoutW = summaryLines === 2 ? G.SUMMARY_MAX_W : summaryW

    var bodyW = 0
    var fieldRows = []
    var methodRows = []
    var i
    for (i = 0; i < ent.fields.length; i++) {
      var ftext = formatField(ent.fields[i])
      bodyW = Math.max(bodyW, measureText(ftext, FONT.member))
      fieldRows.push({ kind: 'field', text: ftext, member: ent.fields[i], index: i })
    }
    if (!collapsed) {
      for (i = 0; i < ent.methods.length; i++) {
        var mtext = formatMethod(ent.methods[i])
        bodyW = Math.max(bodyW, measureText(mtext, FONT.member))
        methodRows.push({ kind: 'method', text: mtext, member: ent.methods[i], index: i })
      }
    }

    var w = Math.max(
      G.MIN_W,
      Math.ceil(Math.max(nameW, stereoW, summaryLayoutW) + G.ROW_PAD_X + G.BORDER_X),
      Math.ceil(bodyW + G.ROW_PAD_X + G.BORDER_X)
    )

    var headH = G.HEAD_BASE
    if (stereoW > 0) headH += G.STEREO_H
    if (summaryLines > 0) headH += G.SUMMARY_H * summaryLines

    var fieldBlockH = fieldRows.length > 0 ? fieldRows.length * G.ROW_H + G.COMPARTMENT_PAD_Y : 0
    var methodBlockH = methodRows.length > 0
      ? methodRows.length * G.ROW_H + G.COMPARTMENT_PAD_Y
      : (collapsed && ent.methods.length > 0 ? G.ROW_H + G.COMPARTMENT_PAD_Y : 0)

    return {
      w: w,
      h: headH + fieldBlockH + methodBlockH + G.BORDER_Y,
      headH: headH,
      summaryLines: summaryLines,
      fieldBlockH: fieldBlockH,
      methodBlockH: methodBlockH,
      fieldRows: fieldRows,
      methodRows: methodRows,
    }
  }

  /* ============================================================
     5. dagre 布局（两遍：估算 → 真实尺寸）
     ============================================================ */

  function buildGroups(model) {
    var groups = []
    var index = {}
    for (var i = 0; i < model.relations.length; i++) {
      var rel = model.relations[i]
      var key = rel.from + '\u0000' + rel.to + '\u0000' + rel.kind
      if (index[key] === undefined) {
        index[key] = groups.length
        groups.push({ key: key, from: rel.from, to: rel.to, kind: rel.kind, rels: [], label: '' })
      }
      var g = groups[index[key]]
      g.rels.push(rel)
      if (g.label === '' && rel.label) g.label = rel.label
    }
    return groups
  }

  function dagreLayout(entities, groups, sizes, params) {
    if (!global.DAGRE || !global.DAGRE.graphlib) {
      fail('缺少 dagre bundle（需要先加载 dagre.bundle.js，暴露 window.DAGRE）')
    }
    var graphlib = global.DAGRE.graphlib
    var g = new graphlib.Graph({ multigraph: true, compound: false })
    g.setGraph({
      rankdir: params.rankdir,
      ranksep: params.ranksep,
      nodesep: params.nodesep,
      marginx: params.marginx,
      marginy: params.marginy,
      ranker: params.ranker,
    })
    g.setDefaultEdgeLabel(function () { return {} })

    var i
    for (i = 0; i < entities.length; i++) {
      var ent = entities[i]
      var sz = sizes[ent.id]
      g.setNode(ent.id, { width: sz.w, height: sz.h })
    }

    // 边标签尺寸也交给 dagre —— 否则它不知道标签要占地方（标签会压线）
    var laidGroups = []
    for (i = 0; i < groups.length; i++) {
      var grp = groups[i]
      var labelSize = null
      if (grp.label !== '' && params.edgeLabels !== false) {
        labelSize = {
          w: Math.ceil(measureText(grp.label, FONT.label)) + G.LABEL_PAD_X,
          h: G.LABEL_H,
        }
      }
      var opts = { weight: 1, minlen: 1, labelpos: 'c', labeloffset: 12 }
      // 虚线语义边（uses/imports/depend）不强制跨层；允许同层/少跨一层，
      // 能让控制流卡片靠得更近，也避免虚线为了“分层”绕出很长的空走廊。
      if (params.compactDashed === true && grp.rels && grp.rels.length > 0) {
        var weak = true
        for (var wi = 0; wi < grp.rels.length; wi++) {
          if (!isDashed(grp.rels[wi].kind)) { weak = false; break }
        }
        if (weak) { opts.minlen = 0; opts.weight = 0.5 }
      }
      if (labelSize !== null) { opts.width = labelSize.w; opts.height = labelSize.h }
      var name = 'e' + i
      g.setEdge(grp.from, grp.to, opts, name)
      laidGroups.push({ name: name, group: grp, labelSize: labelSize })
    }

    global.DAGRE.layout(g)

    var graphLabel = g.graph()
    var outNodes = {}
    for (i = 0; i < entities.length; i++) {
      var e2 = entities[i]
      var nd = g.node(e2.id)
      if (nd === undefined) continue
      outNodes[e2.id] = {
        id: e2.id,
        x: nd.x - nd.width / 2 + PAD.x,
        y: nd.y - nd.height / 2 + PAD.y,
        w: nd.width,
        h: nd.height,
      }
    }

    var outEdges = []
    for (i = 0; i < laidGroups.length; i++) {
      var lg = laidGroups[i]
      var le = g.edge(lg.group.from, lg.group.to, lg.name)
      if (le === undefined) continue
      var raw = (le.points || []).map(function (p) { return [p.x + PAD.x, p.y + PAD.y] })
      var labelPos = (typeof le.x === 'number' && typeof le.y === 'number')
        ? [le.x + PAD.x, le.y + PAD.y] : null
      outEdges.push({
        group: lg.group,
        labelSize: lg.labelSize,
        rawPoints: raw,
        labelPos: labelPos,
      })
    }

    return {
      nodes: outNodes,
      edges: outEdges,
      width: (graphLabel.width || 0) + PAD.x * 2,
      height: (graphLabel.height || 0) + PAD.y * 2,
    }
  }

  /* ============================================================
     6. 正交走线（移植 prototype14 已验证的做法）
     ============================================================ */

  function dedupePoints(pts) {
    var out = []
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i]
      var last = out.length > 0 ? out[out.length - 1] : null
      if (last === null || Math.abs(last[0] - p[0]) > 0.5 || Math.abs(last[1] - p[1]) > 0.5) out.push([p[0], p[1]])
    }
    return out
  }

  /** 正交折线的所有段。 */
  function segmentsOf(pts) {
    var segs = []
    for (var i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]])
    return segs
  }

  /** 线段是否穿过矩形内部（含 2px 容差内缩）。 */
  function segmentHitsRect(a, b, rect, inset) {
    var pad = inset === undefined ? 2 : inset
    var left = rect.x + pad
    var right = rect.x + rect.w - pad
    var top = rect.y + pad
    var bottom = rect.y + rect.h - pad
    if (left >= right || top >= bottom) return false
    var len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])
    var steps = Math.max(2, Math.ceil(len / 3))
    for (var s = 0; s <= steps; s++) {
      var x = a[0] + (b[0] - a[0]) * s / steps
      var y = a[1] + (b[1] - a[1]) * s / steps
      if (x > left && x < right && y > top && y < bottom) return true
    }
    return false
  }

  function pathHitsAnyCard(pts, cards, skipIds) {
    for (var i = 0; i < pts.length - 1; i++) {
      for (var c = 0; c < cards.length; c++) {
        var card = cards[c]
        if (skipIds[card.id]) continue
        if (segmentHitsRect(pts[i], pts[i + 1], card)) return card.id
      }
    }
    return null
  }

  /** 统计一条路径穿过的卡片数（同一张卡多段穿过只算一次），用于在无「零穿卡」巷道时取最优兜底。 */
  function countCardHits(pts, cards, skipIds) {
    var hit = {}
    var count = 0
    for (var i = 0; i < pts.length - 1; i++) {
      for (var c = 0; c < cards.length; c++) {
        var card = cards[c]
        if (skipIds[card.id] || hit[card.id]) continue
        if (segmentHitsRect(pts[i], pts[i + 1], card)) {
          hit[card.id] = 1
          count += 1
        }
      }
    }
    return count
  }

  /**
   * 生成一条正交连线。
   *
   * @param fromBox / toBox  卡片盒
   * @param raw              dagre 原始通道点
   * @param outSlot          出边端口在源盒边缘的**归一化比例**（0..1）
   * @param inSlot           入边端口在目标盒边缘的归一化比例（0..1）
   * @param laneShift        通道横向偏移（平行边错开）
   * @param portOverride     { outX, outY, inX, inY }：端口微调坐标。
   *                         方法级端口只有直接喂 IR（relation endpoint 带 member）时才有；
   *                         ehm_render/CLI 的 UML 链路不会产生 member，不能把它当成当前能力。
   */
  /** 端口 y 必须落在卡片边缘内（留 4px 圆角余量），否则箭头会被裁掉。 */
  function clampPortY(y, box) {
    return Math.max(box.y + 4, Math.min(box.y + box.h - 4, y))
  }
  function clampPortX(x, box) {
    return Math.max(box.x + 4, Math.min(box.x + box.w - 4, x))
  }

  /** 相邻两段是否反向折返（同一轴上先下后上 / 先左后右）；这种路径会与自身重叠。 */
  function hasImmediateBacktrack(points) {
    for (var i = 1; i < points.length - 1; i++) {
      var ax = points[i][0] - points[i - 1][0]
      var ay = points[i][1] - points[i - 1][1]
      var bx = points[i + 1][0] - points[i][0]
      var by = points[i + 1][1] - points[i][1]
      if (Math.abs(ax) < 0.6 && Math.abs(bx) < 0.6 && ay * by < 0) return true
      if (Math.abs(ay) < 0.6 && Math.abs(by) < 0.6 && ax * bx < 0) return true
    }
    return false
  }

  /** 目标端前的通道必须留出至少一个 stub，否则最后一段会沿卡片边缘横着走、箭头方向反了。 */
  function clampLaneAway(lane, edge) {
    var min = G.STUB + 2
    if (Math.abs(lane - edge) < min) return edge + (lane < edge ? -min : min)
    return lane
  }

  /** 通道必须落在源 stub 之后、目标 stub 之前，否则线会先出去再折返，形成重叠。 */
  function clampLaneSpan(lane, source, target, dir) {
    var stubSource = source + dir * G.STUB
    var stubTarget = target - dir * G.STUB
    var lo = Math.min(stubSource, stubTarget)
    var hi = Math.max(stubSource, stubTarget)
    if (hi - lo < 1) return (source + target) / 2
    return Math.max(lo, Math.min(hi, lane))
  }

  /** 端口一侧 → 从卡片指向外侧的单位方向。 */
  function sideVector(side) {
    if (side === 'left') return [-1, 0]
    if (side === 'right') return [1, 0]
    if (side === 'top') return [0, -1]
    return [0, 1]
  }

  /** 把一个方法/字段端口放到卡片对应侧的 y 上。 */
  function portAt(box, side, y) {
    var px = side === 'left' ? box.x : side === 'right' ? box.x + box.w : box.x + box.w / 2
    var py = side === 'top' ? box.y : side === 'bottom' ? box.y + box.h : clampPortY(y, box)
    return { x: px, y: py, side: side }
  }

  /**
   * TB 布局里带方法端点时的折线：方法端必须接在成员行的**左右边缘**，
   * 不能接卡片上下边——否则「端点选到哪个方法」在视觉上完全看不出来。
   * 这里同时支持方法端和实体端（实体端仍按相对位置走上/下边）。
   */
  function buildMethodPortEdge(fromBox, toBox, outSlot, inSlot, portOverride, shift) {
    var outY = portOverride.outY
    var inY = portOverride.inY
    var fcx = fromBox.x + fromBox.w / 2
    var tcx = toBox.x + toBox.w / 2
    var fcy = fromBox.y + fromBox.h / 2
    var tcy = toBox.y + toBox.h / 2
    var outSide = outY !== undefined
      ? (tcx >= fcx ? 'right' : 'left')
      : (tcy >= fcy ? 'bottom' : 'top')
    var inSide = inY !== undefined
      ? (fcx >= tcx ? 'right' : 'left')
      : (fcy >= tcy ? 'bottom' : 'top')
    var start
    var end
    if (outY !== undefined) start = portAt(fromBox, outSide, outY)
    else if (outSide === 'top' || outSide === 'bottom') {
      start = {
        x: clampPortX(portOverride.outX === undefined ? fromBox.x + fromBox.w * outSlot : portOverride.outX, fromBox),
        y: outSide === 'top' ? fromBox.y : fromBox.y + fromBox.h,
        side: outSide,
      }
    } else start = portAt(fromBox, outSide, fromBox.y + fromBox.h * outSlot)
    if (inY !== undefined) end = portAt(toBox, inSide, inY)
    else if (inSide === 'top' || inSide === 'bottom') {
      end = {
        x: clampPortX(portOverride.inX === undefined ? toBox.x + toBox.w * inSlot : portOverride.inX, toBox),
        y: inSide === 'top' ? toBox.y : toBox.y + toBox.h,
        side: inSide,
      }
    } else end = portAt(toBox, inSide, toBox.y + toBox.h * inSlot)
    var sv = sideVector(start.side)
    var ev = sideVector(end.side)
    var s1 = { x: start.x + sv[0] * G.STUB, y: start.y + sv[1] * G.STUB }
    var e1 = { x: end.x + ev[0] * G.STUB, y: end.y + ev[1] * G.STUB }
    var candidates = []
    var sh = shift || 0
    var horizontalStart = start.side === 'left' || start.side === 'right'
    var horizontalEnd = end.side === 'left' || end.side === 'right'
    if (horizontalStart && horizontalEnd) {
      var midX = (s1.x + e1.x) / 2 + sh
      candidates.push([[start.x, start.y], [s1.x, s1.y], [midX, s1.y], [midX, e1.y], [e1.x, e1.y], [end.x, end.y]])
    } else if (!horizontalStart && !horizontalEnd) {
      var midY = (s1.y + e1.y) / 2 + sh
      candidates.push([[start.x, start.y], [s1.x, s1.y], [s1.x, midY], [e1.x, midY], [e1.x, e1.y], [end.x, end.y]])
    } else if (horizontalStart) {
      candidates.push([[start.x, start.y], [s1.x, s1.y], [e1.x, s1.y], [e1.x, e1.y], [end.x, end.y]])
      candidates.push([[start.x, start.y], [s1.x, s1.y], [s1.x, e1.y], [e1.x, e1.y], [end.x, end.y]])
    } else {
      candidates.push([[start.x, start.y], [s1.x, s1.y], [s1.x, e1.y], [e1.x, e1.y], [end.x, end.y]])
      candidates.push([[start.x, start.y], [s1.x, s1.y], [e1.x, s1.y], [e1.x, e1.y], [end.x, end.y]])
    }
    if (candidates.length === 1 && candidates[0].length > 4) {
      // 首尾通道附近再加一组平行偏移，给密集图留选择。
      var extra = candidates[0].map(function (p) { return [p[0], p[1]] })
      if (horizontalStart && horizontalEnd) {
        extra[2][0] += sh >= 0 ? G.PARALLEL_GAP : -G.PARALLEL_GAP
        extra[3][0] = extra[2][0]
      } else if (!horizontalStart && !horizontalEnd) {
        extra[2][1] += sh >= 0 ? G.PARALLEL_GAP : -G.PARALLEL_GAP
        extra[3][1] = extra[2][1]
      }
      candidates.push(extra)
    }
    return candidates.map(function (pts) { return dedupePoints(pts) })
  }

  /** 根据布局轴和方法端点，算出这条边两端的真实端口（点 + 侧）。 */
  function endpointPorts(fromBox, toBox, outSlot, inSlot, portOverride, methodMode) {
    var fcx = fromBox.x + fromBox.w / 2
    var tcx = toBox.x + toBox.w / 2
    var fcy = fromBox.y + fromBox.h / 2
    var tcy = toBox.y + toBox.h / 2
    if (CURRENT_EDGE_AXIS === 'h' && CURRENT_EDGE_AXIS_AUTO) {
      // 转置布局里先看“是否同一列”：跨列永远左右进出，同列才上下进出。
      // 不能只用距离判断，否则子节点在父节点上方但属于右列时会错误地从父卡顶边出线。
      var fromCol = fromBox.colIndex
      var toCol = toBox.colIndex
      var sameColumn = fromCol !== undefined && toCol !== undefined && fromCol === toCol
      var preferVertical = fromCol !== undefined && toCol !== undefined
        ? sameColumn
        : Math.abs(tcy - fcy) > Math.abs(tcx - fcx) * 1.15
      if (!preferVertical) {
        // 跨列：继续走下面的左右端口分支
      } else {
        var autoDown = tcy >= fcy
        return {
          start: {
            x: clampPortX(portOverride.outX === undefined ? fromBox.x + fromBox.w * outSlot : portOverride.outX, fromBox),
            y: autoDown ? fromBox.y + fromBox.h : fromBox.y,
            side: autoDown ? 'bottom' : 'top',
          },
          end: {
            x: clampPortX(portOverride.inX === undefined ? toBox.x + toBox.w * inSlot : portOverride.inX, toBox),
            y: autoDown ? toBox.y : toBox.y + toBox.h,
            side: autoDown ? 'top' : 'bottom',
          },
        }
      }
    }
    if (CURRENT_EDGE_AXIS === 'h') {
      var rightward = tcx >= fcx
      return {
        start: { x: rightward ? fromBox.x + fromBox.w : fromBox.x, y: clampPortY(portOverride.outY === undefined ? fromBox.y + fromBox.h * outSlot : portOverride.outY, fromBox), side: rightward ? 'right' : 'left' },
        end: { x: rightward ? toBox.x : toBox.x + toBox.w, y: clampPortY(portOverride.inY === undefined ? toBox.y + toBox.h * inSlot : portOverride.inY, toBox), side: rightward ? 'left' : 'right' },
      }
    }
    if (methodMode) {
      var outSide = portOverride.outY !== undefined ? (tcx >= fcx ? 'right' : 'left') : (tcy >= fcy ? 'bottom' : 'top')
      var inSide = portOverride.inY !== undefined ? (fcx >= tcx ? 'right' : 'left') : (fcy >= tcy ? 'bottom' : 'top')
      return {
        start: portOverride.outY !== undefined ? portAt(fromBox, outSide, portOverride.outY) : portAt(fromBox, outSide, fromBox.y + fromBox.h * outSlot),
        end: portOverride.inY !== undefined ? portAt(toBox, inSide, portOverride.inY) : portAt(toBox, inSide, toBox.y + toBox.h * inSlot),
      }
    }
    var downward = tcy >= fcy
    return {
      start: {
        x: clampPortX(portOverride.outX === undefined ? fromBox.x + fromBox.w * outSlot : portOverride.outX, fromBox),
        y: downward ? fromBox.y + fromBox.h : fromBox.y,
        side: downward ? 'bottom' : 'top',
      },
      end: {
        x: clampPortX(portOverride.inX === undefined ? toBox.x + toBox.w * inSlot : portOverride.inX, toBox),
        y: downward ? toBox.y : toBox.y + toBox.h,
        side: downward ? 'top' : 'bottom',
      },
    }
  }


  function buildOrthogonalEdge(fromBox, toBox, raw, outSlot, inSlot, laneShift, portOverride) {
    var shift = laneShift || 0
    var override = portOverride || null
    var fc = [fromBox.x + fromBox.w / 2, fromBox.y + fromBox.h / 2]
    var tc = [toBox.x + toBox.w / 2, toBox.y + toBox.h / 2]
    var dx = tc[0] - fc[0]
    var dy = tc[1] - fc[1]
    var horizontal = CURRENT_EDGE_AXIS === 'h'
    var pts = []

    if (horizontal) {
      var rightward = dx >= 0
      var sy = override !== null && override.outY !== undefined
        ? clampPortY(override.outY, fromBox)
        : fromBox.y + fromBox.h * outSlot
      var ey = override !== null && override.inY !== undefined
        ? clampPortY(override.inY, toBox)
        : toBox.y + toBox.h * inSlot
      var sx = rightward ? fromBox.x + fromBox.w : fromBox.x
      var ex = rightward ? toBox.x : toBox.x + toBox.w
      pts.push([sx, sy])
      pts.push([sx + (rightward ? G.STUB : -G.STUB), sy])
      var cx = clampLaneAway(clampLaneSpan(pickLane(raw, 0, sx, ex) + shift, sx, ex, rightward ? 1 : -1), ex)
      pts.push([cx, sy])
      pts.push([cx, ey])
      pts.push([ex - (rightward ? G.STUB : -G.STUB), ey])
      pts.push([ex, ey])
    } else {
      var downward = dy >= 0
      var sx2 = clampPortX(override !== null && override.outX !== undefined ? override.outX : fromBox.x + fromBox.w * outSlot, fromBox)
      var ex2 = clampPortX(override !== null && override.inX !== undefined ? override.inX : toBox.x + toBox.w * inSlot, toBox)
      var sy2 = downward ? fromBox.y + fromBox.h : fromBox.y
      var ey2 = downward ? toBox.y : toBox.y + toBox.h
      pts.push([sx2, sy2])
      pts.push([sx2, sy2 + (downward ? G.STUB : -G.STUB)])
      var cy = clampLaneAway(clampLaneSpan(pickLane(raw, 1, sy2, ey2) + shift, sy2, ey2, downward ? 1 : -1), ey2)
      pts.push([sx2, cy])
      pts.push([ex2, cy])
      pts.push([ex2, ey2 - (downward ? G.STUB : -G.STUB)])
      pts.push([ex2, ey2])
    }
    return dedupePoints(pts)

    /** 从 dagre 的中间通道点里挑一个（落在两端之间的）；没有就取中点。 */
    function pickLane(rawPts, axis, a, b) {
      var lo = Math.min(a, b)
      var hi = Math.max(a, b)
      var cands = []
      for (var i = 1; i < rawPts.length - 1; i++) {
        var v = rawPts[i][axis]
        if (isFinite(v) && v > lo + 8 && v < hi - 8) cands.push(v)
      }
      if (cands.length === 0) cands.push((a + b) / 2)
      return cands[0]
    }
  }

  /**
   * 同一盒子上的多条边沿边缘均分端口。
   *
   * 端口顺序不能按「关系声明顺序」——否则从同一张卡出去的多条线会在卡边交叉
   * （排在上面的线指向下方目标、下面的线指向上方目标）。这里按**对端卡片的纵向中心**
   * 排序后分配端口：out 按目标 y、in 按来源 y，让线在出口/入口处自然展开，
   * 这是正交布线里最便宜也最有效的交叉削减。
   */
  function makePortAllocator(entities, relations, nodes) {
    // 端点槽位要跟边的“端口方向”走，而不是整张图一个方向：
    //   横向端口（左/右）：沿 y 排序，看对端中心 y；
    //   纵向端口（上/下）：沿 x 排序，看对端中心 x。
    // 转置布局里两条规则同时存在：跨列边走左右，同列上下级走上下。
    function orientationOf(rel) {
      if (CURRENT_EDGE_AXIS !== 'h') return 'v'
      if (CURRENT_EDGE_AXIS_AUTO) {
        var fb = nodes && nodes[rel.from]
        var tb = nodes && nodes[rel.to]
        if (fb && tb && fb.colIndex !== undefined && tb.colIndex !== undefined) {
          return fb.colIndex === tb.colIndex ? 'v' : 'h'
        }
      }
      return 'h'
    }
    function coordOf(id, orient) {
      var n = nodes && nodes[id]
      if (!n) return 0
      return orient === 'h' ? n.y + n.h / 2 : n.x + n.w / 2
    }
    var outLists = {}
    var inLists = {}
    var i
    for (i = 0; i < relations.length; i++) {
      var rel = relations[i]
      var orient = orientationOf(rel)
      var outKey = rel.from + '|' + orient
      var inKey = rel.to + '|' + orient
      var outList = outLists[outKey] || (outLists[outKey] = [])
      outList.push({ index: i, other: rel.to, pos: coordOf(rel.to, orient) })
      var inList = inLists[inKey] || (inLists[inKey] = [])
      inList.push({ index: i, other: rel.from, pos: coordOf(rel.from, orient) })
    }
    var outSlots = {}
    var inSlots = {}
    function assign(lists, slots) {
      for (var key in lists) {
        if (!Object.prototype.hasOwnProperty.call(lists, key)) continue
        var list = lists[key]
        // 同一侧端口按对端沿该侧坐标排序，避免出口/入口处交叉。
        list.sort(function (a, b) { return a.pos - b.pos || a.other.localeCompare(b.other) })
        for (var k = 0; k < list.length; k++) {
          slots[list[k].index] = list.length <= 1 ? 0.5 : (k + 1) / (list.length + 1)
        }
      }
    }
    assign(outLists, outSlots)
    assign(inLists, inSlots)
    /** @param {number} relIndex 关系下标；@param {'out'|'in'} direction */
    return function slotFor(relIndex, direction) {
      var value = (direction === 'out' ? outSlots : inSlots)[relIndex]
      return typeof value === 'number' ? value : 0.5
    }
  }

  /**
   * 竖直段分离：dagre 在普通图上不分配边通道，
   * 多条边的竖直段可能落在同一 x → 视觉上叠成一条线。
   * 后处理把重叠的竖直段横向推开（并同步移动相邻水平段端点）。
   */
  function separateVerticalSegments(edges, cards) {
    var GAP = G.MIN_WIRE_GAP
    var segs = []
    var ei
    var i
    for (ei = 0; ei < edges.length; ei++) {
      var pts = edges[ei].points
      for (i = 0; i < pts.length - 1; i++) {
        var a = pts[i]
        var b = pts[i + 1]
        if (Math.abs(a[0] - b[0]) > 0.8) continue
        var y1 = Math.min(a[1], b[1])
        var y2 = Math.max(a[1], b[1])
        if (y2 - y1 < 8) continue
        segs.push({ ei: ei, i: i, x: a[0], y1: y1, y2: y2 })
      }
    }
    segs.sort(function (p, q) { return p.x - q.x || p.y1 - q.y1 })
    for (i = 0; i < segs.length; i++) {
      for (var j = i + 1; j < segs.length; j++) {
        var s1 = segs[i]
        var s2 = segs[j]
        if (s2.x - s1.x >= GAP) break
        var overlap = Math.min(s1.y2, s2.y2) - Math.max(s1.y1, s2.y1)
        if (overlap <= 4) continue
        var shift = s1.x + GAP - s2.x
        var target = edges[s2.ei].points
        // 分离竖直段不能把它推进卡片：否则本来干净的绕障/巷道会被「后处理」破坏。
        var skipCards = {}
        skipCards[edges[s2.ei].rel.from] = 1
        skipCards[edges[s2.ei].rel.to] = 1
        var blocked = false
        for (var c = 0; c < cards.length; c++) {
          if (skipCards[cards[c].id]) continue
          if (segmentHitsRect([s2.x + shift, s2.y1], [s2.x + shift, s2.y2], cards[c])) { blocked = true; break }
        }
        if (blocked) continue
        var oldAx = target[s2.i][0]
        var oldBx = s2.i + 1 < target.length ? target[s2.i + 1][0] : null
        var beforeFirst = target.length > 1 ? target[1][0] - target[0][0] : 0
        var beforeLast = target.length > 1 ? target[target.length - 1][0] - target[target.length - 2][0] : 0
        target[s2.i][0] += shift
        if (oldBx !== null) target[s2.i + 1][0] += shift
        // 分离后整条线仍不能穿新增卡片（水平段端点也会被移动，必须整体复查）。
        var afterHits = 0
        for (var k2 = 0; k2 < cards.length; k2++) {
          if (skipCards[cards[k2].id]) continue
          if (pathHitsAnyCard(target, [cards[k2]], {})) { afterHits = 1; break }
        }
        // 不能把首/末段推成反向，也不能造成相邻两段折返。
        var firstOk = target.length > 1 ? (target[1][0] - target[0][0]) * beforeFirst > 0 : true
        var lastOk = target.length > 1 ? (target[target.length - 1][0] - target[target.length - 2][0]) * beforeLast > 0 : true
        if (afterHits === 1 || !firstOk || !lastOk || hasImmediateBacktrack(target)) {
          target[s2.i][0] = oldAx
          if (oldBx !== null) target[s2.i + 1][0] = oldBx
          continue
        }
        s2.x += shift
      }
    }
  }

  /** 两条折线的真实问题数：交叉权重 1，共线重叠权重 5，平行贴线按净距补权重。 */
  function wirePairIssue(a, b) {
    var issue = 0
    for (var i = 0; i < a.length - 1; i++) {
      for (var j = 0; j < b.length - 1; j++) {
        var relation = orthogonalPairRelation([a[i], a[i + 1]], [b[j], b[j + 1]])
        if (relation === 1) issue += 1
        else if (relation === 2) issue += 5
        else if (segmentsTouch([a[i], a[i + 1]], [b[j], b[j + 1]])) issue += 3
        else issue += wireProximity([a[i], a[i + 1]], [b[j], b[j + 1]], G.MIN_WIRE_GAP) * 0.5
      }
    }
    return issue
  }

  /**
   * TB 布局的残余重叠/交叉后处理：只平移边的**内部水平段**（不碰端口），
   * 在若干 dy 里选一个让该边与其它边的真实问题数下降、且不穿卡的位置。
   * 这是对路由顺序/候选不足的兜底，专门解决「多条边共用同一 y 通道」。
   */
  function separateHorizontalLanes(edges, cards) {
    function crossingsFor(edgeIndex, points) {
      var count = 0
      for (var j = 0; j < edges.length; j++) {
        if (j === edgeIndex) continue
        var other = edges[j].points
        for (var a = 0; a < points.length - 1; a++) {
          for (var b = 0; b < other.length - 1; b++) {
            if (orthogonalPairRelation([points[a], points[a + 1]], [other[b], other[b + 1]]) === 1) count += 1
          }
        }
      }
      return count
    }
    function issuesFor(edgeIndex, points) {
      var total = 0
      for (var j = 0; j < edges.length; j++) {
        if (j === edgeIndex) continue
        total += wirePairIssue(points, edges[j].points)
      }
      return total
    }
    function bestMove(edgeIndex) {
      var base = issuesFor(edgeIndex, edges[edgeIndex].points)
      var baseCross = crossingsFor(edgeIndex, edges[edgeIndex].points)
      var basePoints = edges[edgeIndex].points
      var beforeFirst = basePoints.length > 1 ? basePoints[1][1] - basePoints[0][1] : 0
      var beforeLast = basePoints.length > 1 ? basePoints[basePoints.length - 1][1] - basePoints[basePoints.length - 2][1] : 0
      var best = null
      for (var k = 1; k < basePoints.length - 2; k++) {
        // 只平移内部水平段；前后必须都是竖直段，否则会破坏正交性。
        if (Math.abs(basePoints[k][1] - basePoints[k + 1][1]) > 0.6) continue
        if (Math.abs(basePoints[k - 1][0] - basePoints[k][0]) > 0.6) continue
        if (Math.abs(basePoints[k + 2][0] - basePoints[k + 1][0]) > 0.6) continue
        var dys = [8, -8, 16, -16, 24, -24, 32, -32, 48, -48, 64, -64, 80, -80, 96, -96, 112, -112, 128, -128, 144, -144, 160, -160]
        for (var d = 0; d < dys.length; d++) {
          var clone = basePoints.map(function (p) { return [p[0], p[1]] })
          clone[k][1] += dys[d]
          clone[k + 1][1] += dys[d]
          var skip = {}
          skip[edges[edgeIndex].rel.from] = 1
          skip[edges[edgeIndex].rel.to] = 1
          if (pathHitsAnyCard(clone, cards, skip) !== null) continue
          // 平移不能把首/末段推成反向，也不能造成相邻两段折返。
          if ((clone[1][1] - clone[0][1]) * beforeFirst <= 0) continue
          if ((clone[clone.length - 1][1] - clone[clone.length - 2][1]) * beforeLast <= 0) continue
          if (hasImmediateBacktrack(clone)) continue
          var issues = issuesFor(edgeIndex, clone)
          var crossings = crossingsFor(edgeIndex, clone)
          var score = crossings * 1000 + issues
          var baseScore = baseCross * 1000 + base
          if (score < baseScore && (best === null || score < best.score)) {
            best = { score: score, issue: issues, points: clone, edge: edgeIndex }
          }
        }
      }
      return best
    }
    var LIMIT = 30
    for (var pass = 0; pass < LIMIT; pass++) {
      var improved = false
      for (var i = 0; i < edges.length && !improved; i++) {
        for (var j = i + 1; j < edges.length && !improved; j++) {
          if (wirePairIssue(edges[i].points, edges[j].points) === 0) continue
          var best = bestMove(j)
          var moveI = bestMove(i)
          if (moveI !== null && (best === null || moveI.issue < best.issue)) best = moveI
          if (best !== null) {
            edges[best.edge].points = best.points
            improved = true
          }
        }
      }
      if (!improved) break
    }
  }

  /* ============================================================
     7. 连线标签：锚点 + 避让（标签/线/卡片）
     ============================================================ */

  function labelWidthOf(text) {
    return Math.ceil(measureText(text, FONT.label)) + G.LABEL_PAD_X
  }

  /**
   * 选一个放标签的锚点。
   *
   * 关键修正（相比 prototype14）：**不要优先用 dagre 的 labelPos**。
   * dagre 给的是"标签中心应落在通道上"的坐标，正交化之后那个位置常常落在
   * 竖直通道的中段 —— 标签放上去必然压线。
   * 这里改成优先挑「足够长的水平段」，标签沿该段滑动，再把标签推到线的上下方。
   */
  function pickLabelAnchor(edge, needW) {
    var pts = edge.points
    if (!pts || pts.length < 2) return null
    var i
    // ① 最长的「够放下标签」的水平段
    var best = null
    for (i = 0; i < pts.length - 1; i++) {
      var a = pts[i]
      var b = pts[i + 1]
      if (Math.abs(a[1] - b[1]) > 0.6) continue
      var len = Math.abs(b[0] - a[0])
      if (len < needW + 16) continue
      if (best === null || len > best.len) {
        best = {
          x: (a[0] + b[0]) / 2, y: a[1], len: len,
          x1: Math.min(a[0], b[0]), x2: Math.max(a[0], b[0]),
        }
      }
    }
    if (best !== null) {
      return { x: best.x, y: best.y, kind: 'horizontal', span: [best.x1, best.x2] }
    }
    // ② 次选：最长的水平段（即使不够长，也沿它摆放并允许略微超出）
    var bestShort = null
    for (i = 0; i < pts.length - 1; i++) {
      var a2 = pts[i]
      var b2 = pts[i + 1]
      if (Math.abs(a2[1] - b2[1]) > 0.6) continue
      var len2 = Math.abs(b2[0] - a2[0])
      if (len2 < 24) continue
      if (bestShort === null || len2 > bestShort.len) {
        bestShort = {
          x: (a2[0] + b2[0]) / 2, y: a2[1], len: len2,
          x1: Math.min(a2[0], b2[0]), x2: Math.max(a2[0], b2[0]),
        }
      }
    }
    if (bestShort !== null) {
      return { x: bestShort.x, y: bestShort.y, kind: 'horizontal', span: [bestShort.x1, bestShort.x2] }
    }
    // ③ 竖直段：标签放在线旁边
    var bestV = null
    for (i = 0; i < pts.length - 1; i++) {
      var a3 = pts[i]
      var b3 = pts[i + 1]
      if (Math.abs(a3[0] - b3[0]) > 0.6) continue
      var lenV = Math.abs(b3[1] - a3[1])
      if (lenV < 40) continue
      if (bestV === null || lenV > bestV.len) bestV = { x: a3[0], y: (a3[1] + b3[1]) / 2, len: lenV }
    }
    if (bestV !== null) return { x: bestV.x, y: bestV.y, kind: 'vertical' }
    return null
  }

  /**
   * 标签摆放：候选枚举 + 打分（贪心）。
   *
   * prototype14 的「优先放线上方，不行放下方，再不行逐级推远」在密集图里会失手：
   * 一旦某条候选位置与别的线相交，后续再推远也会撞到相邻通道，最后退化成压线。
   *
   * 这里改成**生成一大批候选位并统一打分**：
   *   · 沿锚点所在水平段按步长左右滑动（让标签躲开竖线）
   *   · 上下各试若干档距离（让标签离开自己的线）
   *   · 惩罚：压线（重）> 压卡片（重）> 压标签（中）> 越界（重）> 离锚点远（轻）
   * 取分数最低者。分数仍有压线时，缩小标签字号而不是放弃（见 CSS 的 .ehm-label-text）。
   */
  function placeLabels(labels, allEdges, cards, sceneW, sceneH) {
    var placed = []
    var GAP = G.MIN_GAP_TO_WIRE
    var MARGIN = 5

    function rectHitsWire(l, t, w, h, skipEdge) {
      var right = l + w
      var bottom = t + h
      for (var e = 0; e < allEdges.length; e++) {
        var edge = allEdges[e]
        if (skipEdge !== undefined && edge === skipEdge) continue
        var pts = edge.points
        if (!pts) continue
        for (var i = 0; i < pts.length - 1; i++) {
          if (segIntersectsRect(pts[i], pts[i + 1], l, t, right, bottom)) return true
        }
      }
      return false
    }
    function rectHitsLabel(l, t, w, h) {
      for (var i = 0; i < placed.length; i++) {
        var p = placed[i]
        var apart = (l + w + MARGIN <= p.left)
          || (l - MARGIN >= p.left + p.w)
          || (t + h + MARGIN <= p.top)
          || (t - MARGIN >= p.top + p.h)
        if (!apart) return true
      }
      return false
    }
    function rectHitsCard(l, t, w, h) {
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i]
        if (l < c.x + c.w && l + w > c.x && t < c.y + c.h && t + h > c.y) return true
      }
      return false
    }

    for (var n = 0; n < labels.length; n++) {
      var lb = labels[n]
      var w = labelWidthOf(lb.text)
      var h = G.LABEL_H
      var best = null

      if (lb.anchorKind === 'vertical') {
        var candOffsets = [-(w / 2 + GAP), (w / 2 + GAP), -(w / 2 + GAP + 10), (w / 2 + GAP + 10), -(w / 2 + GAP + 24), (w / 2 + GAP + 24)]
        var candY = [0, -h - GAP, h + GAP, -2 * h - GAP, 2 * h + GAP]
        for (var vy = 0; vy < candY.length; vy++) {
          for (var vi = 0; vi < candOffsets.length; vi++) {
            var vl = lb.x + candOffsets[vi] - w / 2
            var vt = lb.y + candY[vy] - h / 2
            var vs = scoreAt(vl, vt, w, h, lb, Math.abs(candOffsets[vi]) + Math.abs(candY[vy]) * 1.4)
            if (best === null || vs < best.score) best = { left: vl, top: vt, score: vs }
            if (best !== null && best.score === 0) break
          }
          if (best !== null && best.score === 0) break
        }
      } else {
        var span = lb.span || [lb.x - 200, lb.x + 200]
        var xs = [lb.x]
        // 沿水平段滑动：步长 = 标签宽的一半，至少 3 个位置；再允许滑出线段两端。
        var step = Math.max(18, Math.round(w / 2))
        var maxShift = Math.max(Math.abs(span[0] - lb.x), Math.abs(span[1] - lb.x), 160)
        for (var s = step; s <= maxShift; s += step) {
          xs.push(lb.x - s)
          xs.push(lb.x + s)
        }
        xs.push(lb.x - w / 2 - GAP, lb.x + w / 2 + GAP, lb.x - w - GAP, lb.x + w + GAP)
        var ys = [
          lb.y - (h / 2 + GAP),
          lb.y + (h / 2 + GAP),
          lb.y - (h / 2 + GAP + 8),
          lb.y + (h / 2 + GAP + 8),
          lb.y - (h / 2 + GAP + 18),
          lb.y + (h / 2 + GAP + 18),
          lb.y - (h / 2 + GAP + 30),
          lb.y + (h / 2 + GAP + 30),
          lb.y - (h / 2 + GAP + 48),
          lb.y + (h / 2 + GAP + 48),
          lb.y - (h / 2 + GAP + 68),
          lb.y + (h / 2 + GAP + 68),
          lb.y - (h / 2 + GAP + 96),
          lb.y + (h / 2 + GAP + 96),
        ]
        for (var yi = 0; yi < ys.length; yi++) {
          for (var xi = 0; xi < xs.length; xi++) {
            var l = xs[xi] - w / 2
            var t = ys[yi] - h / 2
            var dist = Math.abs(xs[xi] - lb.x) + Math.abs(ys[yi] - lb.y) * 1.4
            var sc = scoreAt(l, t, w, h, lb, dist)
            if (best === null || sc < best.score) best = { left: l, top: t, score: sc }
            if (sc === 0) break
          }
          if (best !== null && best.score === 0) break
        }
      }

      // 兜底扫描：候选位全被线/卡占用时，在锚点周围大范围找最低分位置；
      // 密集图里宁可标签离锚点远一点，也不能压在别的线上。
      // score 700 = 只压住自己这条线（可接受）；只有压到别的线/卡片/标签（>=1200）
      // 才启动昂贵的大范围扫描。
      if (best === null || best.score >= 1200) {
        var scanBest = best
        // 先粗扫（48px 步长），有可行位就停；没有可行位才在最优粗位附近细扫。
        // 全图 24px 步长的逐点扫描是渲染热点之一，密集图能吃掉 1s 以上。
        for (var gy = -288; gy <= 288; gy += 48) {
          for (var gx = -288; gx <= 288; gx += 48) {
            var gl = lb.x + gx - w / 2
            var gt = lb.y + gy - h / 2
            var gscore = scoreAt(gl, gt, w, h, lb, Math.abs(gx) + Math.abs(gy) * 1.4)
            if (scanBest === null || gscore < scanBest.score) scanBest = { left: gl, top: gt, score: gscore }
            if (scanBest !== null && scanBest.score === 0) break
          }
          if (scanBest !== null && scanBest.score === 0) break
        }
        if (scanBest !== null && scanBest.score > 0) {
          var coarse = scanBest
          for (var ry = -48; ry <= 48; ry += 12) {
            for (var rx = -48; rx <= 48; rx += 12) {
              var rl = coarse.left + rx
              var rt = coarse.top + ry
              var rscore = scoreAt(rl, rt, w, h, lb, Math.abs(rx) + Math.abs(ry) * 1.4)
              if (rscore < scanBest.score) scanBest = { left: rl, top: rt, score: rscore }
              if (scanBest.score === 0) break
            }
            if (scanBest.score === 0) break
          }
        }
        if (scanBest !== null) best = scanBest
      }

      if (best === null) best = { left: lb.x - w / 2, top: lb.y - h / 2, score: 9999 }

      // 夹进画布
      var left = Math.max(4, Math.min(sceneW - w - 4, best.left))
      var top = Math.max(4, Math.min(sceneH - h - 4, best.top))
      lb.x = left + w / 2
      lb.y = top + h / 2
      lb.w = w
      lb.h = h
      lb.rect = { left: left, top: top, right: left + w, bottom: top + h }
      placed.push({ left: left, top: top, w: w, h: h })
      lb.penalty = best.score

      function scoreAt(l, t, ww, hh, self, dist) {
        var score = 0
        if (l < 4 || t < 4 || l + ww > sceneW - 4 || t + hh > sceneH - 4) score += 4000
        if (rectHitsCard(l, t, ww, hh)) score += 3000
        if (rectHitsWire(l, t, ww, hh, self.edge)) score += 2000
        // 自己那条线也尽量不压（但允许：标签贴着自己的线是常见且可接受的）
        if (rectHitsWire(l, t, ww, hh, undefined)) score += 700
        if (rectHitsLabel(l, t, ww, hh)) score += 1200
        return score + dist
      }
    }
  }

  function segIntersectsRect(a, b, left, top, right, bottom) {
    var box = { x: left, y: top, w: right - left, h: bottom - top }
    return segmentHitsRect(a, b, box, 0)
  }


  /* ============================================================
     8. 关系线几何
     ============================================================ */

  /**
   * 成员行中线的绝对 y（画布坐标）。
   *
   * 卡片结构：head(含 stereotype/summary) → fields 分区 → methods 分区。
   * 分区各自有 4px 上下 padding（G.COMPARTMENT_PAD_Y / 2），行高 ROW_H。
   * 返回 undefined 表示「这个成员不在卡片里」（可能被折叠了），由调用方兜底。
   */
  function memberYIn(box, ent, memberName, entityLayout) {
    if (memberName === undefined || memberName === null || memberName === '') return undefined
    if (ent === undefined) return undefined
    var layout = entityLayout && entityLayout[ent.id]
    if (!layout) return undefined
    var i
    for (i = 0; i < layout.fieldRows.length; i++) {
      if (layout.fieldRows[i].member.name === memberName || layout.fieldRows[i].member.id === memberName) {
        return box.y + layout.headH + G.COMPARTMENT_PAD_Y / 2 + i * G.ROW_H + G.ROW_H / 2
      }
    }
    for (i = 0; i < layout.methodRows.length; i++) {
      if (layout.methodRows[i].member.name === memberName || layout.methodRows[i].member.id === memberName) {
        return box.y + layout.headH + layout.fieldBlockH + G.COMPARTMENT_PAD_Y / 2
          + i * G.ROW_H + G.ROW_H / 2
      }
    }
    return undefined
  }

  /**
   * 兜底正交绕障：当所有平行巷道都穿卡片时，在「卡片边界 ± margin」构成的网格上做 Dijkstra，
   * 找一条从源端口到目标端口、不穿任何无关卡片的正交折线。
   *
   * 只处理 LR（从左到右）的情形；找不到路径返回 null，调用方保留原候选。
   */
  function routeAroundCards(fromBox, toBox, outSlot, inSlot, portOverride, cards, skipIds, routed) {
    var fc = [fromBox.x + fromBox.w / 2, fromBox.y + fromBox.h / 2]
    var tc = [toBox.x + toBox.w / 2, toBox.y + toBox.h / 2]
    var horizontal = CURRENT_EDGE_AXIS === 'h'
    var start
    var end
    if (horizontal) {
      var rightward = tc[0] >= fc[0]
      start = [rightward ? fromBox.x + fromBox.w : fromBox.x, clampPortY(portOverride.outY === undefined ? fromBox.y + fromBox.h * outSlot : portOverride.outY, fromBox)]
      end = [rightward ? toBox.x : toBox.x + toBox.w, clampPortY(portOverride.inY === undefined ? toBox.y + toBox.h * inSlot : portOverride.inY, toBox)]
      if (!((end[0] - start[0]) * (rightward ? 1 : -1) > 12)) return null
    } else {
      var downward = tc[1] >= fc[1]
      var clampX = function (x, box) { return Math.max(box.x + 4, Math.min(box.x + box.w - 4, x)) }
      start = [clampX(fromBox.x + fromBox.w * outSlot, fromBox), downward ? fromBox.y + fromBox.h : fromBox.y]
      end = [clampX(toBox.x + toBox.w * inSlot, toBox), downward ? toBox.y : toBox.y + toBox.h]
      if (!((end[1] - start[1]) * (downward ? 1 : -1) > 12)) return null
    }
    // 网格坐标统一保留 1 位小数（uniqSorted 也按 1 位取整）；否则小数端口
    // 在 xs.indexOf(start[0]) 里找不到索引，A* 会退化成无效起点、永远选不到短路径。
    start = [Math.round(start[0] * 10) / 10, Math.round(start[1] * 10) / 10]
    end = [Math.round(end[0] * 10) / 10, Math.round(end[1] * 10) / 10]
    // A* 只在「端口外侧 stub」之间寻路；最后把端口→stub、stub→端口两段补回来。
    // 否则 A* 可能从端口的切线方向进入卡片，箭头就会沿卡边横着飞（端点选择看起来错）。
    var coreStart
    var coreEnd
    if (horizontal) {
      var hdir = rightward ? 1 : -1
      coreStart = [Math.round((start[0] + hdir * G.STUB) * 10) / 10, start[1]]
      coreEnd = [Math.round((end[0] - hdir * G.STUB) * 10) / 10, end[1]]
    } else {
      var vdir = downward ? 1 : -1
      coreStart = [start[0], Math.round((start[1] + vdir * G.STUB) * 10) / 10]
      coreEnd = [end[0], Math.round((end[1] - vdir * G.STUB) * 10) / 10]
    }
    if (Math.abs(coreStart[0] - coreEnd[0]) < 0.1 && Math.abs(coreStart[1] - coreEnd[1]) < 0.1) return null
    var obs = []
    var i
    for (i = 0; i < cards.length; i++) {
      if (!skipIds[cards[i].id]) obs.push(cards[i])
    }
    if (obs.length === 0) return null
    var M = 12
    var xs = [coreStart[0], coreEnd[0]]
    var ys = [coreStart[1], coreEnd[1]]
    for (i = 0; i < obs.length; i++) {
      xs.push(obs[i].x - M, obs[i].x + obs[i].w + M)
      ys.push(obs[i].y - M, obs[i].y + obs[i].h + M)
    }
    function uniqSorted(list) {
      var seen = {}
      var out = []
      for (var k = 0; k < list.length; k++) {
        var v = Math.round(list[k] * 10) / 10
        if (seen[v]) continue
        seen[v] = 1
        out.push(v)
      }
      out.sort(function (a, b) { return a - b })
      return out
    }
    xs = uniqSorted(xs)
    ys = uniqSorted(ys)
    var nx = xs.length
    var ny = ys.length
    function idOf(ix, iy) { return iy * nx + ix }
    var total = nx * ny
    var dist = new Array(total)
    var prev = new Array(total)
    for (i = 0; i < total; i++) { dist[i] = Infinity; prev[i] = -1 }
    var startId = idOf(xs.indexOf(coreStart[0]), ys.indexOf(coreStart[1]))
    var endId = idOf(xs.indexOf(coreEnd[0]), ys.indexOf(coreEnd[1]))
    var visited = new Array(total)
    function segClear(a, b) {
      for (var k = 0; k < obs.length; k++) {
        if (segmentHitsRect(a, b, obs[k])) return false
      }
      return true
    }
    function wirePenalty(a, b) {
      if (!routed || routed.length === 0) return 0
      var penalty = 0
      for (var r = 0; r < routed.length; r++) {
        var pts = routed[r].points || []
        for (var q = 0; q < pts.length - 1; q++) {
          var relation = orthogonalPairRelation([a, b], [pts[q], pts[q + 1]])
          if (relation === 1) penalty += 1
          else if (relation === 2) penalty += 5
          else if (segmentsTouch([a, b], [pts[q], pts[q + 1]])) penalty += 3
          else penalty += wireProximity([a, b], [pts[q], pts[q + 1]], G.MIN_WIRE_GAP) * 0.5
        }
      }
      return penalty
    }
    function relax(fromId, toId, a, b) {
      if (!segClear(a, b)) return
      var w = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + wirePenalty(a, b) * 100000
      if (dist[fromId] + w < dist[toId]) {
        dist[toId] = dist[fromId] + w
        prev[toId] = fromId
      }
    }
    dist[startId] = 0
    for (var iter = 0; iter < total; iter++) {
      var bestId = -1
      var bestD = Infinity
      for (i = 0; i < total; i++) {
        if (!visited[i] && dist[i] < bestD) { bestD = dist[i]; bestId = i }
      }
      if (bestId < 0 || bestId === endId) break
      visited[bestId] = 1
      var ix = bestId % nx
      var iy = (bestId - ix) / nx
      var here = [xs[ix], ys[iy]]
      if (ix + 1 < nx) relax(bestId, idOf(ix + 1, iy), here, [xs[ix + 1], ys[iy]])
      if (ix > 0) relax(bestId, idOf(ix - 1, iy), here, [xs[ix - 1], ys[iy]])
      if (iy + 1 < ny) relax(bestId, idOf(ix, iy + 1), here, [xs[ix], ys[iy + 1]])
      if (iy > 0) relax(bestId, idOf(ix, iy - 1), here, [xs[ix], ys[iy - 1]])
    }
    if (!isFinite(dist[endId])) return null
    var path = []
    var cur = endId
    while (cur !== -1) {
      var cx = cur % nx
      var cy = (cur - cx) / nx
      path.push([xs[cx], ys[cy]])
      cur = prev[cur]
    }
    path.reverse()
    // A* 不能被允许先朝端口内部折返：否则补回端口段后，第一段会朝卡片里扎。
    if (path.length > 1) {
      var firstStep = path[1]
      var lastStep = path[path.length - 2]
      if (horizontal) {
        var hdir2 = rightward ? 1 : -1
        if (hdir2 * (firstStep[0] - coreStart[0]) < -0.1) return null
        if (hdir2 * (coreEnd[0] - lastStep[0]) < -0.1) return null
      } else {
        var vdir2 = downward ? 1 : -1
        if (vdir2 * (firstStep[1] - coreStart[1]) < -0.1) return null
        if (vdir2 * (coreEnd[1] - lastStep[1]) < -0.1) return null
      }
    }
    // 补回端口到外侧 stub 的两段，保证终点最后一段垂直进入卡片边界。
    path.unshift(start)
    path.push(end)
    // 简化共线点
    var out = [path[0]]
    for (i = 1; i < path.length - 1; i++) {
      var a = out[out.length - 1]
      var b = path[i]
      var c = path[i + 1]
      if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) continue
      out.push(b)
    }
    out.push(path[path.length - 1])
    return out
  }

  /**
   *
   * 旧实现只检查 `pathHitsAnyCard`：第一条不穿卡片的巷道直接采用，完全不计它与
   * 其它线的交叉——于是「穿越 cost」事实上为 0/负数，密集区会选到交叉最多的方案。
   * 这里返回与已布线的无关连线（不共享源/目标卡片）的交叉+重叠次数，越小越好。
   */
  /**
   * 全图上下绕行候选：走所有卡片上方/下方，再从目标左侧竖直落回端口。
   * 只处理 LR；比网格 A* 简单，能覆盖「端口 y 恰好穿过整排卡片」这种最常见的坏情况。
   */
  function detourCandidates(fromBox, toBox, outSlot, inSlot, portOverride, cards, skipIds) {
    var fc = [fromBox.x + fromBox.w / 2, fromBox.y + fromBox.h / 2]
    var tc = [toBox.x + toBox.w / 2, toBox.y + toBox.h / 2]
    var horizontal = CURRENT_EDGE_AXIS === 'h'
    var routes = []
    var i
    if (horizontal) {
      var rightward = tc[0] >= fc[0]
      var sy = portOverride.outY === undefined ? fromBox.y + fromBox.h * outSlot : clampPortY(portOverride.outY, fromBox)
      var ey = portOverride.inY === undefined ? toBox.y + toBox.h * inSlot : clampPortY(portOverride.inY, toBox)
      var hx1 = rightward ? fromBox.x + fromBox.w : fromBox.x
      var hx2 = rightward ? toBox.x : toBox.x + toBox.w
      var hdir = rightward ? 1 : -1
      var startH = [hx1, sy]
      var endH = [hx2, ey]
      if (!(hdir * (endH[0] - startH[0]) > 12)) return []
      var minY = Infinity
      var maxY = -Infinity
      for (i = 0; i < cards.length; i++) {
        if (skipIds[cards[i].id]) continue
        minY = Math.min(minY, cards[i].y)
        maxY = Math.max(maxY, cards[i].y + cards[i].h)
      }
      if (!isFinite(minY)) return []
      var lanesY = [sy, sy + 24, sy - 24, sy + 48, sy - 48, ey, ey + 24, ey - 24, (sy + ey) / 2, minY - 24, maxY + 24]
      var seenY = {}
      for (i = 0; i < lanesY.length; i++) {
        var laneY = lanesY[i]
        var keyY = String(Math.round(laneY * 10) / 10)
        if (seenY[keyY]) continue
        seenY[keyY] = 1
        routes.push([startH, [startH[0] + hdir * 8, startH[1]], [startH[0] + hdir * 8, laneY], [endH[0] - hdir * 16, laneY], [endH[0] - hdir * 16, endH[1]], endH])
      }
    } else {
      var downward = tc[1] >= fc[1]
      var clampX = function (x, box) { return Math.max(box.x + 4, Math.min(box.x + box.w - 4, x)) }
      var sx = clampX(fromBox.x + fromBox.w * (portOverride.outX === undefined ? outSlot : 0.5), fromBox)
      var ex = clampX(toBox.x + toBox.w * (portOverride.inX === undefined ? inSlot : 0.5), toBox)
      var dir = downward ? 1 : -1
      var vStart = [sx, downward ? fromBox.y + fromBox.h : fromBox.y]
      var vEnd = [ex, downward ? toBox.y : toBox.y + toBox.h]
      if (!(dir * (vEnd[1] - vStart[1]) > 12)) return []
      var minX = Infinity
      var maxX = -Infinity
      for (i = 0; i < cards.length; i++) {
        if (skipIds[cards[i].id]) continue
        minX = Math.min(minX, cards[i].x)
        maxX = Math.max(maxX, cards[i].x + cards[i].w)
      }
      if (!isFinite(minX)) return []
      var lanesX = [sx, sx + 24, sx - 24, sx + 48, sx - 48, ex, ex + 24, ex - 24, (sx + ex) / 2, minX - 24, maxX + 24]
      var seenX = {}
      for (i = 0; i < lanesX.length; i++) {
        var laneX = lanesX[i]
        var keyX = String(Math.round(laneX * 10) / 10)
        if (seenX[keyX]) continue
        seenX[keyX] = 1
        routes.push([vStart, [vStart[0], vStart[1] + dir * 8], [laneX, vStart[1] + dir * 8], [laneX, vEnd[1] - dir * 8], [vEnd[0], vEnd[1] - dir * 8], vEnd])
      }
    }
    return routes
  }

  /**
   * 任意端口之间的全局正交路由（Dijkstra，带方向状态与已有线通道惩罚）。
   *
   * 和 routeAroundCards 的区别：它把**源/目标卡片也当障碍**，只允许从端口出发的
   * 第一小段沿卡片边界外走；因此不会出现「线从卡片内部穿过」的兜底路径。
   * 同时把已布线的重叠段惩罚放大，避免多条线在同一条通道里叠成一条。
   */
  function routePorts(start, end, cards, routed, opts) {
    var sv = sideVector(start.side)
    var ev = sideVector(end.side)
    var coreStart = [start.x + sv[0] * G.STUB, start.y + sv[1] * G.STUB]
    var coreEnd = [end.x + ev[0] * G.STUB, end.y + ev[1] * G.STUB]
    coreStart = [Math.round(coreStart[0] * 10) / 10, Math.round(coreStart[1] * 10) / 10]
    coreEnd = [Math.round(coreEnd[0] * 10) / 10, Math.round(coreEnd[1] * 10) / 10]
    var obs = []
    var c
    for (c = 0; c < cards.length; c++) {
      if (cards[c].w > 0 && cards[c].h > 0) obs.push(cards[c])
    }
    function insideCard(card, p) {
      return p[0] > card.x + 2 && p[0] < card.x + card.w - 2 && p[1] > card.y + 2 && p[1] < card.y + card.h - 2
    }
    for (c = 0; c < obs.length; c++) {
      if (insideCard(obs[c], coreStart) || insideCard(obs[c], coreEnd)) return null
    }
    var M = 14
    var xs = [coreStart[0], coreEnd[0]]
    var ys = [coreStart[1], coreEnd[1]]
    for (c = 0; c < obs.length; c++) {
      xs.push(obs[c].x - M, obs[c].x + obs[c].w + M)
      ys.push(obs[c].y - M, obs[c].y + obs[c].h + M)
    }
    function uniqSorted(list) {
      var seen = {}
      var out = []
      for (var k = 0; k < list.length; k++) {
        var v = Math.round(list[k] * 10) / 10
        if (seen[v]) continue
        seen[v] = true
        out.push(v)
      }
      out.sort(function (a, b) { return a - b })
      return out
    }
    xs = uniqSorted(xs)
    ys = uniqSorted(ys)
    var nx = xs.length
    var ny = ys.length
    if (nx < 2 || ny < 2) return null
    function idOf(ix, iy) { return iy * nx + ix }
    function segClear(a, b) {
      for (var k = 0; k < obs.length; k++) {
        if (segmentHitsRect(a, b, obs[k])) return false
      }
      return true
    }
    function wirePenalty(a, b) {
      var penalty = 0
      for (var r = 0; r < routed.length; r++) {
        var pts = routed[r].points || []
        for (var q = 0; q < pts.length - 1; q++) {
          var relation = orthogonalPairRelation([a, b], [pts[q], pts[q + 1]])
          if (relation === 1) penalty += 1
          else if (relation === 2) penalty += 5
          else if (segmentsTouch([a, b], [pts[q], pts[q + 1]])) penalty += 3
          else penalty += wireProximity([a, b], [pts[q], pts[q + 1]], G.MIN_WIRE_GAP) * 0.5
        }
      }
      return penalty
    }
    var TURN = 2
    var PENALTY = opts !== null && typeof opts === "object" && typeof opts.penalty === "number" && opts.penalty > 0 ? opts.penalty : 200
    var total = nx * ny
    var dist = new Array(total * 3)
    var prev = new Array(total * 3)
    for (var q0 = 0; q0 < dist.length; q0++) { dist[q0] = Infinity; prev[q0] = -1 }
    var startId = idOf(xs.indexOf(coreStart[0]), ys.indexOf(coreStart[1]))
    var endId = idOf(xs.indexOf(coreEnd[0]), ys.indexOf(coreEnd[1]))
    if (startId < 0 || endId < 0) return null
    // 小顶堆
    var heapState = []
    var heapCost = []
    function heapPush(state, cost) {
      heapState.push(state); heapCost.push(cost)
      var i = heapState.length - 1
      while (i > 0) {
        var p = (i - 1) >> 1
        if (heapCost[p] <= heapCost[i]) break
        var ts = heapState[p]; heapState[p] = heapState[i]; heapState[i] = ts
        var tc = heapCost[p]; heapCost[p] = heapCost[i]; heapCost[i] = tc
        i = p
      }
    }
    function heapPop() {
      var top = heapState[0]
      var lastS = heapState.pop()
      var lastC = heapCost.pop()
      if (heapState.length > 0) {
        heapState[0] = lastS; heapCost[0] = lastC
        var i = 0
        while (true) {
          var l = i * 2 + 1
          var r = l + 1
          var m = i
          if (l < heapState.length && heapCost[l] < heapCost[m]) m = l
          if (r < heapState.length && heapCost[r] < heapCost[m]) m = r
          if (m === i) break
          var ts = heapState[m]; heapState[m] = heapState[i]; heapState[i] = ts
          var tc2 = heapCost[m]; heapCost[m] = heapCost[i]; heapCost[i] = tc2
          i = m
        }
      }
      return top
    }
    var startState = startId * 3 + 2
    dist[startState] = 0
    heapPush(startState, 0)
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    while (heapState.length > 0) {
      var state = heapPop()
      var dir = state % 3
      var node = (state - dir) / 3
      if (dist[state] === Infinity) continue
      var ix = node % nx
      var iy = (node - ix) / nx
      for (var di = 0; di < dirs.length; di++) {
        var nix = ix + dirs[di][0]
        var niy = iy + dirs[di][1]
        if (nix < 0 || nix >= nx || niy < 0 || niy >= ny) continue
        var a = [xs[ix], ys[iy]]
        var b = [xs[nix], ys[niy]]
        if (!segClear(a, b)) continue
        var ndir = dirs[di][0] !== 0 ? 0 : 1
        var nid = idOf(nix, niy)
        var cost = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])
          + (dir === 2 || dir === ndir ? 0 : TURN)
          + wirePenalty(a, b) * PENALTY
        var nstate = nid * 3 + ndir
        var nd = dist[state] + cost
        if (nd < dist[nstate]) {
          dist[nstate] = nd
          prev[nstate] = state
          heapPush(nstate, nd)
        }
      }
    }
    var bestState = -1
    var bestDist = Infinity
    for (var bd = 0; bd < 2; bd++) {
      var ss = endId * 3 + bd
      if (dist[ss] < bestDist) { bestDist = dist[ss]; bestState = ss }
    }
    if (bestState < 0 || bestDist === Infinity) return null
    var pts = []
    var cur = bestState
    while (cur !== -1) {
      var cd = cur % 3
      var cn = (cur - cd) / 3
      var cix = cn % nx
      var ciy = (cn - cix) / nx
      pts.push([xs[cix], ys[ciy]])
      cur = prev[cur]
    }
    pts.reverse()
    pts.unshift([start.x, start.y])
    pts.push([end.x, end.y])
    // 去掉共线/重复点
    var out = [pts[0]]
    for (var pi = 1; pi < pts.length; pi++) {
      var last = out[out.length - 1]
      if (Math.abs(pts[pi][0] - last[0]) < 0.1 && Math.abs(pts[pi][1] - last[1]) < 0.1) continue
      out.push(pts[pi])
    }
    var simp = [out[0]]
    for (var si = 1; si < out.length - 1; si++) {
      var a0 = simp[simp.length - 1]
      var b0 = out[si]
      var c0 = out[si + 1]
      var abx = b0[0] - a0[0]; var aby = b0[1] - a0[1]
      var bcx = c0[0] - b0[0]; var bcy = c0[1] - b0[1]
      if (Math.abs(abx * bcy - aby * bcx) < 0.1) continue
      simp.push(b0)
    }
    simp.push(out[out.length - 1])
    // 端口外第一段和最后一段必须保持向外/向内，并确保不穿任何卡片（含源/目标）。
    var first = simp[1]
    var lastPt = simp[simp.length - 2]
    if (!first || !lastPt) return null
    if (Math.abs(first[0] - start.x) > 0.6 && Math.abs(first[1] - start.y) > 0.6) return null
    if (Math.abs(lastPt[0] - end.x) > 0.6 && Math.abs(lastPt[1] - end.y) > 0.6) return null
    var fdx = first[0] - start.x; var fdy = first[1] - start.y
    var ldx = end.x - lastPt[0]; var ldy = end.y - lastPt[1]
    if ((sv[0] !== 0 && fdx * sv[0] <= 0) || (sv[1] !== 0 && fdy * sv[1] <= 0)) return null
    if ((ev[0] !== 0 && ldx * ev[0] >= 0) || (ev[1] !== 0 && ldy * ev[1] >= 0)) return null
    return simp
  }

  function orthogonalCrossCost(candidate, routed, fromId, toId) {
    var cost = 0
    function cross(a, b) {
      var ax = Math.abs(a[0][0] - a[1][0]) <= 0.6
      var bx = Math.abs(b[0][0] - b[1][0]) <= 0.6
      if (ax === bx) {
        var ay = Math.abs(a[0][1] - a[1][1]) <= 0.6
        var by = Math.abs(b[0][1] - b[1][1]) <= 0.6
        if (!ay || !by) return false
        var sameY = Math.abs(a[0][1] - b[0][1]) <= 0.6
        var sameX = Math.abs(a[0][0] - b[0][0]) <= 0.6
        if (sameY) {
          var lo = Math.max(Math.min(a[0][0], a[1][0]), Math.min(b[0][0], b[1][0]))
          var hi = Math.min(Math.max(a[0][0], a[1][0]), Math.max(b[0][0], b[1][0]))
          return hi - lo > 4
        }
        if (sameX) {
          var lo2 = Math.max(Math.min(a[0][1], a[1][1]), Math.min(b[0][1], b[1][1]))
          var hi2 = Math.min(Math.max(a[0][1], a[1][1]), Math.max(b[0][1], b[1][1]))
          return hi2 - lo2 > 4
        }
        return false
      }
      // 一横一竖：严格内部相交才算（端点相接不算“穿越”）。
      var h = ax ? b : a
      var v = ax ? a : b
      var x = v[0][0]
      var y = h[0][1]
      var hx1 = Math.min(h[0][0], h[1][0])
      var hx2 = Math.max(h[0][0], h[1][0])
      var hy1 = Math.min(h[0][1], h[1][1])
      var hy2 = Math.max(h[0][1], h[1][1])
      var vx1 = Math.min(v[0][0], v[1][0])
      var vx2 = Math.max(v[0][0], v[1][0])
      var vy1 = Math.min(v[0][1], v[1][1])
      var vy2 = Math.max(v[0][1], v[1][1])
      return x > hx1 + 0.6 && x < hx2 - 0.6 && y > vy1 + 0.6 && y < vy2 - 0.6
    }
    for (var r = 0; r < routed.length; r++) {
      var other = routed[r]
      if (!other || !other.points) continue
      var sameStart = Math.abs(candidate[0][0] - other.points[0][0]) < 0.6 && Math.abs(candidate[0][1] - other.points[0][1]) < 0.6
      var sameEnd = Math.abs(candidate[candidate.length - 1][0] - other.points[other.points.length - 1][0]) < 0.6
        && Math.abs(candidate[candidate.length - 1][1] - other.points[other.points.length - 1][1]) < 0.6
      var issue = 0
      for (var i = 0; i < candidate.length - 1; i++) {
        for (var j = 0; j < other.points.length - 1; j++) {
          var relation = orthogonalPairRelation([candidate[i], candidate[i + 1]], [other.points[j], other.points[j + 1]])
          // 同一端口的第一小段/最后小段共线是不可避免的；只忽略这一小段的重叠，
          // 其余任何交叉/重叠都要计入（旧实现直接跳过整条边，会漏掉真实交叉）。
          if (relation === 2 && ((i === 0 && j === 0 && sameStart) || (i === candidate.length - 2 && j === other.points.length - 2 && sameEnd))) continue
          if (relation === 1) issue += 1
          else if (relation === 2) issue += 5
          else if (segmentsTouch([candidate[i], candidate[i + 1]], [other.points[j], other.points[j + 1]])) issue += 3
          else issue += wireProximity([candidate[i], candidate[i + 1]], [other.points[j], other.points[j + 1]], G.MIN_WIRE_GAP) * 0.5
        }
      }
      cost += issue
    }
    return cost
  }

  /**
   * 两段正交线的关系：0 无 / 1 交叉 / 2 共线重叠（>4px）。
   * `diagnose()` 用它统计真实相交与重叠（含共享源/目标卡片、不同端口的边）。
   */
  function orthogonalPairRelation(a, b) {
    var ax = Math.abs(a[0][0] - a[1][0]) <= 0.6
    var bx = Math.abs(b[0][0] - b[1][0]) <= 0.6
    if (ax === bx) {
      // 两条竖线：按 x 是否同一条线、y 投影是否重叠判断；
      // 两条横线：按 y 是否同一条线、x 投影是否重叠判断。
      if (ax) {
        if (Math.abs(a[0][0] - b[0][0]) > 0.6) return 0
        var loV = Math.max(Math.min(a[0][1], a[1][1]), Math.min(b[0][1], b[1][1]))
        var hiV = Math.min(Math.max(a[0][1], a[1][1]), Math.max(b[0][1], b[1][1]))
        return hiV - loV > 4 ? 2 : 0
      }
      var ay = Math.abs(a[0][1] - a[1][1]) <= 0.6
      var by = Math.abs(b[0][1] - b[1][1]) <= 0.6
      if (!ay || !by) return 0
      if (Math.abs(a[0][1] - b[0][1]) <= 0.6) {
        var lo = Math.max(Math.min(a[0][0], a[1][0]), Math.min(b[0][0], b[1][0]))
        var hi = Math.min(Math.max(a[0][0], a[1][0]), Math.max(b[0][0], b[1][0]))
        return hi - lo > 4 ? 2 : 0
      }
      return 0
    }
    var h = ax ? b : a
    var v = ax ? a : b
    var x = v[0][0]
    var y = h[0][1]
    var hx1 = Math.min(h[0][0], h[1][0])
    var hx2 = Math.max(h[0][0], h[1][0])
    var vy1 = Math.min(v[0][1], v[1][1])
    var vy2 = Math.max(v[0][1], v[1][1])
    return x > hx1 + 0.6 && x < hx2 - 0.6 && y > vy1 + 0.6 && y < vy2 - 0.6 ? 1 : 0
  }

  /**
   * 平行线的净距成本：两条正交段平行且纵向/横向投影重叠时，距离小于 gap 返回
   * `gap - distance`，否则返回 0。交叉线不计——它们必然在某点相交，由交叉成本负责。
   */
  function wireProximity(a, b, gap) {
    var ax = Math.abs(a[0][0] - a[1][0]) <= 0.6
    var bx = Math.abs(b[0][0] - b[1][0]) <= 0.6
    if (ax !== bx) return 0
    if (ax) {
      var dx = Math.abs(a[0][0] - b[0][0])
      if (dx <= 0.6 || dx >= gap) return 0
      var lo = Math.max(Math.min(a[0][1], a[1][1]), Math.min(b[0][1], b[1][1]))
      var hi = Math.min(Math.max(a[0][1], a[1][1]), Math.max(b[0][1], b[1][1]))
      return hi - lo > 4 ? gap - dx : 0
    }
    var dy = Math.abs(a[0][1] - b[0][1])
    if (dy <= 0.6 || dy >= gap) return 0
    var lox = Math.max(Math.min(a[0][0], a[1][0]), Math.min(b[0][0], b[1][0]))
    var hix = Math.min(Math.max(a[0][0], a[1][0]), Math.max(b[0][0], b[1][0]))
    return hix - lox > 4 ? gap - dy : 0
  }

  /**
   * T 型碰线：一条线段的端点落在另一条线段内部（不是共享端口）。
   * `orthogonalPairRelation` 对端点相交返回 0，视觉上却会像箭头直接戳在线上。
   */
  function pointOnSegmentInterior(p, a, b) {
    if (Math.abs(a[0] - b[0]) <= 0.6) {
      return Math.abs(p[0] - a[0]) <= 0.6
        && p[1] > Math.min(a[1], b[1]) + 0.6
        && p[1] < Math.max(a[1], b[1]) - 0.6
    }
    if (Math.abs(a[1] - b[1]) <= 0.6) {
      return Math.abs(p[1] - a[1]) <= 0.6
        && p[0] > Math.min(a[0], b[0]) + 0.6
        && p[0] < Math.max(a[0], b[0]) - 0.6
    }
    return false
  }
  function segmentsTouch(a, b) {
    return pointOnSegmentInterior(a[0], b[0], b[1])
      || pointOnSegmentInterior(a[1], b[0], b[1])
      || pointOnSegmentInterior(b[0], a[0], a[1])
      || pointOnSegmentInterior(b[1], a[0], a[1])
  }

  function polylineLength(points) {
    var total = 0
    for (var i = 0; i < points.length - 1; i++) {
      total += Math.abs(points[i + 1][0] - points[i][0]) + Math.abs(points[i + 1][1] - points[i][1])
    }
    return total
  }

  function computeEdges(model, laid, entities, entityLayout) {
    var nowFn = function () { return (global.performance && global.performance.now) ? global.performance.now() : Date.now() }
    function cprof(label, since) {
      if (global.__EHM_PROFILE__) global.__EHM_PROFILE__.phases.push([label, Math.round((nowFn() - since) * 10) / 10])
    }
    var cT0 = nowFn()
    var cT1 = cT0
    var byId = {}
    var entitiesById = {}
    var i
    for (i = 0; i < entities.length; i++) { byId[entities[i].id] = entities[i]; entitiesById[entities[i].id] = entities[i] }
    var cards = []
    for (i = 0; i < entities.length; i++) {
      var nd = laid.nodes[entities[i].id]
      if (nd) cards.push(nd)
    }

    var nextSlot = makePortAllocator(entities, model.relations, laid.nodes)
    var groupByName = {}
    for (i = 0; i < laid.edges.length; i++) groupByName[laid.edges[i].group.key] = laid.edges[i]

    /**
     * 端口去重：同一张卡的同一条边上，任意两条线的起点/终点都不能重合。
     * 直接喂 IR 时关系可能带 member，端点会落在同一方法行；普通 ehm_render/CLI
     * 的 UML 只有实体端点，所有端口都按实体边分配。
     * 这里把所有共享端口的端点按 4~6px 间距轻微错开，既能落在同一个方法行内，
     * 又不会让第一/最后一段叠成一条线。
     */
    var portAssignments = {}
    var portGroups = {}
    function addPortEndpoint(relId, dir, cardId, box, side, base) {
      var key = cardId + '\u0000' + side
      if (!portGroups[key]) portGroups[key] = []
      portGroups[key].push({ relId: relId, dir: dir, box: box, side: side, base: base })
    }
    for (var pri = 0; pri < model.relations.length; pri++) {
      var prel = model.relations[pri]
      var pfrom = laid.nodes[prel.from]
      var pto = laid.nodes[prel.to]
      if (!pfrom || !pto) continue
      var pOutSlot = nextSlot(pri, 'out')
      var pInSlot = nextSlot(pri, 'in')
      var pOutY = memberYIn(pfrom, entitiesById[prel.from], prel.fromMethod, entityLayout)
      var pInY = memberYIn(pto, entitiesById[prel.to], prel.toMethod, entityLayout)
      var pFcx = pfrom.x + pfrom.w / 2
      var pTcx = pto.x + pto.w / 2
      var pFcy = pfrom.y + pfrom.h / 2
      var pTcy = pto.y + pto.h / 2
      var pMethod = CURRENT_EDGE_AXIS !== 'h' && (pOutY !== undefined || pInY !== undefined)
      var pOutSide
      var pInSide
      if (CURRENT_EDGE_AXIS === 'h') {
        var pRight = pTcx >= pFcx
        pOutSide = pRight ? 'right' : 'left'
        pInSide = pRight ? 'left' : 'right'
      } else if (pMethod) {
        pOutSide = pOutY !== undefined ? (pTcx >= pFcx ? 'right' : 'left') : (pTcy >= pFcy ? 'bottom' : 'top')
        pInSide = pInY !== undefined ? (pFcx >= pTcx ? 'right' : 'left') : (pFcy >= pTcy ? 'bottom' : 'top')
      } else {
        var pDown = pTcy >= pFcy
        pOutSide = pDown ? 'bottom' : 'top'
        pInSide = pDown ? 'top' : 'bottom'
      }
      var pOutBase = pOutSide === 'top' || pOutSide === 'bottom'
        ? pfrom.x + pfrom.w * pOutSlot
        : (pOutY !== undefined ? pOutY : pfrom.y + pfrom.h * pOutSlot)
      var pInBase = pInSide === 'top' || pInSide === 'bottom'
        ? pto.x + pto.w * pInSlot
        : (pInY !== undefined ? pInY : pto.y + pto.h * pInSlot)
      addPortEndpoint(prel.id, 'out', prel.from, pfrom, pOutSide, pOutBase)
      addPortEndpoint(prel.id, 'in', prel.to, pto, pInSide, pInBase)
    }
    Object.keys(portGroups).forEach(function (groupKey) {
      var group = portGroups[groupKey]
      var first = group[0]
      var horizontalSide = first.side === 'top' || first.side === 'bottom'
      var min = horizontalSide ? first.box.x + 4 : first.box.y + 4
      var max = horizontalSide ? first.box.x + first.box.w - 4 : first.box.y + first.box.h - 4
      group.sort(function (a, b) { return a.base - b.base || String(a.relId).localeCompare(String(b.relId)) || (a.dir < b.dir ? -1 : 1) })
      var n = group.length
      var gap = n <= 1 ? 0 : Math.min(G.MIN_WIRE_GAP, (max - min) / (n - 1))
      var positions = []
      var cursor = min
      for (var gi = 0; gi < n; gi++) {
        var pos = Math.max(group[gi].base, cursor)
        if (gi > 0 && pos < positions[gi - 1] + gap) pos = positions[gi - 1] + gap
        positions.push(pos)
        cursor = pos + gap
      }
      var overflow = positions[n - 1] - max
      if (overflow > 0) {
        for (var gs = 0; gs < n; gs++) positions[gs] -= overflow
      }
      if (positions[0] < min) {
        var compact = n <= 1 ? 0 : Math.max(0.5, (max - min) / (n - 1))
        for (var gc = 0; gc < n; gc++) positions[gc] = Math.min(max, min + gc * compact)
      }
      for (var ga = 0; ga < n; ga++) {
        var entry = group[ga]
        var assignment = portAssignments[entry.relId] || (portAssignments[entry.relId] = {})
        var endpoint = assignment[entry.dir] || (assignment[entry.dir] = {})
        if (horizontalSide) endpoint.x = positions[ga]
        else endpoint.y = positions[ga]
      }
    })

    cprof('computeEdges.ports', cT0)
    cT1 = nowFn()
    var edges = []
    var routed = []
    var groupSeen = {}
    // 先布「跨度大」的连线：长线需要的干净巷道少，先占位；短边后布可以在局部绕行。
    // 旧实现按 IR 关系顺序，长边常被后来的短线抢先占道，最后只能穿卡片兜底。
    var orderedRelations = model.relations.map(function (rel, index) {
      var a = laid.nodes[rel.from]
      var b = laid.nodes[rel.to]
      var span = a && b ? Math.abs(a.x - b.x) + Math.abs(a.y - b.y) : 0
      return { rel: rel, index: index, span: span }
    }).sort(function (p, q) { return q.span - p.span || p.index - q.index })

    for (var oi = 0; oi < orderedRelations.length; oi++) {
      var rel = orderedRelations[oi].rel
      var relIndex = orderedRelations[oi].index
      var key = rel.from + '\u0000' + rel.to + '\u0000' + rel.kind
      var laidEdge = groupByName[key]
      if (laidEdge === undefined) continue
      var fromBox = laid.nodes[rel.from]
      var toBox = laid.nodes[rel.to]
      if (!fromBox || !toBox) continue

      var outSlot = nextSlot(relIndex, 'out')
      var inSlot = nextSlot(relIndex, 'in')

      var idxInGroup = groupSeen[key] || 0
      groupSeen[key] = idxInGroup + 1
      var total = laidEdge.group.rels.length
      var baseShift = (idxInGroup - (total - 1) / 2) * G.PARALLEL_GAP

      var skip = {}
      skip[rel.from] = 1
      skip[rel.to] = 1

      /**
       * ── IR 级方法端点（不是 ehm_render/CLI 能力）──
       *
       * 只有直接喂 IR、且 relation endpoint 带 member 时，线才接到**那个成员行**。
       * UML/CLI 的 `%% rel` 目前只有 file/line/label，不产出 member 端点，
       * 所以正常图里 methodPorts.checked = 0，不能宣称方法级端口。
       */
      var assigned = portAssignments[rel.id] || {}
      var methodOutY = memberYIn(fromBox, entitiesById[rel.from], rel.fromMethod, entityLayout)
      var methodInY = memberYIn(toBox, entitiesById[rel.to], rel.toMethod, entityLayout)
      var portOverride = {
        outY: assigned.out !== undefined && assigned.out.y !== undefined ? assigned.out.y : methodOutY,
        inY: assigned.in !== undefined && assigned.in.y !== undefined ? assigned.in.y : methodInY,
        outX: assigned.out !== undefined ? assigned.out.x : undefined,
        inX: assigned.in !== undefined ? assigned.in.x : undefined,
      }

      // 候选巷道：基础偏移 + 两侧多档平行偏移；优先零穿卡，其次少穿卡，再其次少交叉。
      // 平行边（同一对实体多条关系）需要更宽的偏移范围，否则第 3 条线只能穿卡兜底。
      var shiftCandidates = [baseShift, 0]
      for (var lane = 1; lane <= 4; lane += 1) {
        shiftCandidates.push(baseShift + lane * G.PARALLEL_GAP)
        shiftCandidates.push(baseShift - lane * G.PARALLEL_GAP)
        shiftCandidates.push(lane * G.PARALLEL_GAP)
        shiftCandidates.push(-lane * G.PARALLEL_GAP)
      }
      var seenShift = {}
      var chosen = null
      var chosenPoints = null
      var bestScore = Infinity
      var bestHits = Infinity
      var routeKind = 'primary'
      // TB 下带方法端点的关系：用侧边端口专用折线；否则走原来的实体端口路径。
      var useMethodPorts = CURRENT_EDGE_AXIS !== 'h'
        && (portOverride.outY !== undefined || portOverride.inY !== undefined)
      var methodMode = useMethodPorts
      if (useMethodPorts) {
        routeKind = 'method'
        for (var ms = 0; ms < shiftCandidates.length; ms++) {
          var mshift = shiftCandidates[ms]
          var mkey = String(mshift)
          if (seenShift[mkey]) continue
          seenShift[mkey] = true
          var methodCands = buildMethodPortEdge(fromBox, toBox, outSlot, inSlot, portOverride, mshift)
          for (var mc = 0; mc < methodCands.length; mc++) {
            var mpts = methodCands[mc]
            var mhits = countCardHits(mpts, cards, skip)
            var mscore = mhits * 1000000
              + orthogonalCrossCost(mpts, routed, rel.from, rel.to) * 10000
              + polylineLength(mpts) + Math.abs(mshift - baseShift) * 0.01
            if (mscore < bestScore) {
              bestScore = mscore
              bestHits = mhits
              chosen = mshift
              chosenPoints = mpts
            }
          }
        }
      } else {
        for (var s = 0; s < shiftCandidates.length; s++) {
          var shift = shiftCandidates[s]
          var shiftKey = String(shift)
          if (seenShift[shiftKey]) continue
          seenShift[shiftKey] = true
          var cand = buildOrthogonalEdge(fromBox, toBox, laidEdge.rawPoints, outSlot, inSlot, shift, portOverride)
          var hits = countCardHits(cand, cards, skip)
          var score = hits * 1000000
            + orthogonalCrossCost(cand, routed, rel.from, rel.to) * 10000
            + Math.abs(shift - baseShift) * 0.01
          if (score < bestScore) {
            bestScore = score
            bestHits = hits
            chosen = shift
            chosenPoints = cand
          }
        }
      }
      // 零穿卡但仍有交叉/重叠时，也要尝试绕行/A*：某条更长的干净路线可能比一条短的重叠线更好。
      var chosenIssues = chosenPoints === null ? Infinity : orthogonalCrossCost(chosenPoints, routed, rel.from, rel.to)
      if (!useMethodPorts && (bestHits > 0 || chosenIssues > 0)) {
        var cleanRoutes = []
        var detourRoutes = detourCandidates(fromBox, toBox, outSlot, inSlot, portOverride, cards, skip)
        for (var d = 0; d < detourRoutes.length; d++) {
          if (countCardHits(detourRoutes[d], cards, skip) === 0) cleanRoutes.push(detourRoutes[d])
        }
        var gridRoute = routeAroundCards(fromBox, toBox, outSlot, inSlot, portOverride, cards, skip, routed)
        if (gridRoute !== null && countCardHits(gridRoute, cards, skip) === 0) cleanRoutes.push(gridRoute)
        if (global.__EHM_ROUTE_DEBUG) global.__EHM_ROUTE_DEBUG.push({ id: rel.id, chosenIssues: chosenIssues, cleanRoutes: cleanRoutes.length, grid: gridRoute !== null, gridHits: gridRoute === null ? null : countCardHits(gridRoute, cards, skip), gridPoints: gridRoute })
        var currentScore = chosenIssues * 10000 + (chosenPoints === null ? 0 : polylineLength(chosenPoints))
        var bestDetour = null
        var bestDetourScore = currentScore
        for (var dr = 0; dr < cleanRoutes.length; dr++) {
          var route = cleanRoutes[dr]
          var routeScore = orthogonalCrossCost(route, routed, rel.from, rel.to) * 10000 + polylineLength(route)
          if (routeScore < bestDetourScore) {
            bestDetourScore = routeScore
            bestDetour = route
          }
        }
        if (bestDetour !== null) {
          chosenPoints = bestDetour
          chosen = null
          bestHits = 0
          routeKind = 'detour'
        }
      }
      // 最后兜底：任意端口之间的全局障碍路由。源/目标卡也当障碍，保证线不穿任何卡片；
      // 同时用已布线通道惩罚压掉重叠段。只有当前候选存在穿卡/交叉/重叠时才尝试。
      var anyHits = chosenPoints === null ? Infinity : countCardHits(chosenPoints, cards, {})
      if (chosenPoints === null || bestHits > 0 || chosenIssues > 0 || anyHits > 0) {
        var ports = endpointPorts(fromBox, toBox, outSlot, inSlot, portOverride, methodMode)
        var portRoute = routePorts(ports.start, ports.end, cards, routed)
        if (portRoute !== null) {
          var pIssues = orthogonalCrossCost(portRoute, routed, rel.from, rel.to)
          var pLen = polylineLength(portRoute)
          var pBetter = chosenPoints === null || bestHits > 0 || anyHits > 0
            || pIssues < chosenIssues
            || (pIssues === chosenIssues && pLen < polylineLength(chosenPoints))
          if (pBetter) {
            chosenPoints = portRoute
            chosen = null
            bestHits = 0
            routeKind = 'port-route'
          }
        }
      }
      if (chosenPoints === null) {
        chosenPoints = buildOrthogonalEdge(fromBox, toBox, laidEdge.rawPoints, outSlot, inSlot, baseShift, portOverride)
      } else {
        routed.push({ points: chosenPoints, from: rel.from, to: rel.to })
      }

      edges.push({
        rel: rel,
        group: laidEdge.group,
        points: chosenPoints,
        laneShift: chosen === null ? baseShift : chosen,
        labelPos: laidEdge.labelPos,
        isGroupLead: idxInGroup === 0,
        outSlot: outSlot,
        inSlot: inSlot,
        methodMode: methodMode,
        ports: portOverride,
        cardHits: countCardHits(chosenPoints, cards, skip),
        routeKind: routeKind,
      })
    }

    cprof('computeEdges.initialRouting', cT1)
    var cT2 = nowFn()
    // 大图不做线段分离后处理：它是 O(段数²) 的微调，60 张卡/119 条边时本身就要 1.6s；
    // 优先保证图能快速出来，重叠交给初始布线/通道。
    if (edges.length <= 30) {
      if (CURRENT_EDGE_AXIS === 'h') separateVerticalSegments(edges, cards)
      else separateHorizontalLanes(edges, cards)
    }
    cprof('computeEdges.postprocess', cT2)

    /**
     * 全局复核：单个边按顺序布线时看不到后来者，容易留下「本可避免的交叉」；
     * 这里让每条边看到**其它全部边**，用高惩罚重新寻路，只有实际代价下降才替换。
     */
    function wireStats(points, otherPoints) {
      var cross = 0
      var overlap = 0
      var near = 0
      var touch = 0
      for (var a = 0; a < points.length - 1; a++) {
        for (var r = 0; r < otherPoints.length; r++) {
          var pts = otherPoints[r]
          var sameStart = Math.abs(points[0][0] - pts[0][0]) < 0.6 && Math.abs(points[0][1] - pts[0][1]) < 0.6
          var sameEnd = Math.abs(points[points.length - 1][0] - pts[pts.length - 1][0]) < 0.6
            && Math.abs(points[points.length - 1][1] - pts[pts.length - 1][1]) < 0.6
          for (var b = 0; b < pts.length - 1; b++) {
            var relation = orthogonalPairRelation([points[a], points[a + 1]], [pts[b], pts[b + 1]])
            if (relation === 2 && ((a === 0 && b === 0 && sameStart) || (a === points.length - 2 && b === pts.length - 2 && sameEnd))) continue
            if (relation === 1) cross += 1
            else if (relation === 2) overlap += 1
            else if (segmentsTouch([points[a], points[a + 1]], [pts[b], pts[b + 1]])) touch += 1
            else near += wireProximity([points[a], points[a + 1]], [pts[b], pts[b + 1]], G.MIN_WIRE_GAP)
          }
        }
      }
      return { cross: cross, overlap: overlap, near: near, touch: touch, hits: countCardHits(points, cards, {}) }
    }
    function wireScore(stats, points) {
      return stats.hits * 1000000000 + stats.overlap * 10000000 + stats.cross * 100000
        + stats.touch * 300000 + stats.near * 500000 + polylineLength(points) * 0.01
    }
    cprof('computeEdges.postprocess', cT2)
    var cT3 = nowFn()
    var rerouteLimit = edges.length <= 24 ? 2 : 1
    // 大图给后处理设时间预算：sideSelect/endpointSelect 是四侧×多位置 A* 搜索，
    // 边数一多会从几百毫秒膨胀到几十秒；超过预算就保留当前较优结果先出图。
    var heavyEdgeCount = edges.length > 30
    var globalRerouteDeadline = nowFn() + (heavyEdgeCount ? 300 : Infinity)
    // 转置跨列边最终由列间通道路由统一接管；不要先花几十次 A* 做四侧端点枚举，
    // 否则边数一多，sideSelect 会成为 30s 级瓶颈。
    function isTransposeChannelEdge(edge) {
      if (!CURRENT_EDGE_AXIS_AUTO) return false
      var fb = laid.nodes[edge.rel.from]
      var tb = laid.nodes[edge.rel.to]
      return fb !== undefined && tb !== undefined && fb.colIndex !== undefined && tb.colIndex !== undefined && fb.colIndex !== tb.colIndex
    }
    for (var rr = 0; rr < rerouteLimit; rr++) {
      if (nowFn() > globalRerouteDeadline) break
      var rerouted = false
      for (var re = 0; re < edges.length; re++) {
        if (nowFn() > globalRerouteDeadline) break
        var edgeR = edges[re]
        if (isTransposeChannelEdge(edgeR)) continue
        var others = []
        for (var oe = 0; oe < edges.length; oe++) {
          if (oe !== re) others.push({ points: edges[oe].points })
        }
        var statsOld = wireStats(edgeR.points, others.map(function (x) { return x.points }))
        if (statsOld.hits === 0 && statsOld.overlap === 0 && statsOld.cross === 0 && statsOld.near === 0 && statsOld.touch === 0) continue
        var fb = laid.nodes[edgeR.rel.from]
        var tb = laid.nodes[edgeR.rel.to]
        if (!fb || !tb) continue
        var rp = endpointPorts(fb, tb, edgeR.outSlot, edgeR.inSlot, edgeR.ports, edgeR.methodMode)
        var alternative = routePorts(rp.start, rp.end, cards, others, { penalty: 50000 })
        if (alternative === null) continue
        var statsNew = wireStats(alternative, others.map(function (x) { return x.points }))
        if (wireScore(statsNew, alternative) + 0.5 < wireScore(statsOld, edgeR.points)) {
          edgeR.points = alternative
          edgeR.routeKind = 'global-reroute'
          rerouted = true
        }
      }
      if (!rerouted) break
    }
    cprof('computeEdges.globalReroute', cT3)

    /**
     * 端点侧选择：默认 TB 走上下、LR 走左右，遇到卡片遮挡时会绕出很长的路。
     * 对「路径明显长于曼哈顿距离」的实体边，枚举四边端口重新寻路，选实际代价最小的；
     * 共享端点/终点仍然拒绝。
     */
    function sidePortOf(box, side, slot) {
      if (side === 'top') return { x: clampPortX(box.x + box.w * slot, box), y: box.y, side: side }
      if (side === 'bottom') return { x: clampPortX(box.x + box.w * slot, box), y: box.y + box.h, side: side }
      if (side === 'left') return { x: box.x, y: clampPortY(box.y + box.h * slot, box), side: side }
      return { x: box.x + box.w, y: clampPortY(box.y + box.h * slot, box), side: side }
    }
    /** 同一侧边上，按绝对坐标放端口（用于把起点/终点对齐到同一条通道）。 */
    function sidePortAt(box, side, x, y) {
      if (side === 'top') return { x: clampPortX(x, box), y: box.y, side: side }
      if (side === 'bottom') return { x: clampPortX(x, box), y: box.y + box.h, side: side }
      if (side === 'left') return { x: box.x, y: clampPortY(y, box), side: side }
      return { x: box.x + box.w, y: clampPortY(y, box), side: side }
    }
    function hitsOtherEndpoint(candidate, selfIndex) {
      for (var q = 0; q < edges.length; q++) {
        if (q === selfIndex) continue
        var op = edges[q].points
        if (!op) continue
        for (var e = 0; e < 2; e++) {
          var ep = e === 0 ? op[0] : op[op.length - 1]
          for (var ce = 0; ce < 2; ce++) {
            var cp = ce === 0 ? candidate[0] : candidate[candidate.length - 1]
            if (Math.abs(ep[0] - cp[0]) < 0.6 && Math.abs(ep[1] - cp[1]) < 0.6) return true
          }
        }
      }
      return false
    }
    /** 端点彼此贴近也会让出口看起来糊成一片；按净距不足计数，供候选评分。 */
    function endpointNearPenalty(candidate, selfIndex) {
      var penalty = 0
      for (var q = 0; q < edges.length; q++) {
        if (q === selfIndex) continue
        var op = edges[q].points
        if (!op) continue
        for (var e = 0; e < 2; e++) {
          var ep = e === 0 ? op[0] : op[op.length - 1]
          for (var ce = 0; ce < 2; ce++) {
            var cp = ce === 0 ? candidate[0] : candidate[candidate.length - 1]
            var d = Math.max(Math.abs(ep[0] - cp[0]), Math.abs(ep[1] - cp[1]))
            if (d > 0.6 && d < G.ENDPOINT_GAP) penalty += G.ENDPOINT_GAP - d
          }
        }
      }
      return penalty
    }
    var cT4 = nowFn()
    // 大图直接跳过四侧端点枚举：单次 A* 在 100+ 条边/60 张卡上就可能几秒，
    // 预算只能限制“边之间”，限制不了单次调用；先出图，保留初始布线。
    var sideSelectDeadline = heavyEdgeCount ? -1 : Infinity
    var SIDE_NAMES = ['top', 'bottom', 'left', 'right']
    // 转置布局：同列只允许上下端口，跨列只允许左右端口，后处理搜索也必须守这个约束。
    function transposeSidePolicy(fromBox, toBox) {
      if (!CURRENT_EDGE_AXIS_AUTO || fromBox.colIndex === undefined || toBox.colIndex === undefined) return null
      if (fromBox.colIndex === toBox.colIndex) return { start: ['bottom', 'top'], end: ['top', 'bottom'] }
      var rightward = toBox.colIndex > fromBox.colIndex
      return rightward
        ? { start: ['right'], end: ['left'] }
        : { start: ['left'], end: ['right'] }
    }
    for (var se = 0; se < edges.length; se++) {
      if (nowFn() > sideSelectDeadline) break
      var edgeS = edges[se]
      if (edgeS.methodMode) continue
      if (isTransposeChannelEdge(edgeS)) continue
      // 性能模式只跳过“已经零穿卡”的边；有线穿卡的边仍然做完整端点修复，
      // 保证最基本的布线正确性不被性能开关牺牲。
      if (heavyEdgeCount && (edgeS.cardHits || 0) === 0) continue
      var fs = laid.nodes[edgeS.rel.from]
      var ts = laid.nodes[edgeS.rel.to]
      if (!fs || !ts) continue
      var directLen = Math.abs(fs.x + fs.w / 2 - (ts.x + ts.w / 2)) + Math.abs(fs.y + fs.h / 2 - (ts.y + ts.h / 2))
      if (polylineLength(edgeS.points) <= directLen * 1.2) continue
      var othersS = []
      for (var os = 0; os < edges.length; os++) {
        if (os !== se) othersS.push({ points: edges[os].points })
      }
      var oldStats = wireStats(edgeS.points, othersS.map(function (x) { return x.points }))
      var bestPoints = edgeS.points
      var bestScore = wireScore(oldStats, edgeS.points) + endpointNearPenalty(edgeS.points, se) * 1000000
      var sidePolicyS = transposeSidePolicy(fs, ts)
      var startSidesS = sidePolicyS ? sidePolicyS.start : SIDE_NAMES
      var endSidesS = sidePolicyS ? sidePolicyS.end : SIDE_NAMES
      for (var si = 0; si < startSidesS.length; si++) {
        for (var ei = 0; ei < endSidesS.length; ei++) {
          var ss = startSidesS[si]
          var es = endSidesS[ei]
          var sp = sidePortOf(fs, ss, edgeS.outSlot)
          var ep = sidePortOf(ts, es, edgeS.inSlot)
          var pairs = [[sp, ep]]
          var sVert = ss === 'top' || ss === 'bottom'
          var eVert = es === 'top' || es === 'bottom'
          if (sVert && eVert) {
            // 起点/终点对齐到同一条竖直通道，避免“先出去再横跳回来”。
            pairs.push([sidePortAt(fs, ss, ep.x, sp.y), ep])
            pairs.push([sp, sidePortAt(ts, es, sp.x, ep.y)])
          } else if (!sVert && !eVert) {
            pairs.push([sidePortAt(fs, ss, sp.x, ep.y), ep])
            pairs.push([sp, sidePortAt(ts, es, sp.x, sp.y)])
          }
          for (var ppi = 0; ppi < pairs.length; ppi++) {
            var psp = pairs[ppi][0]
            var pep = pairs[ppi][1]
            if (Math.abs(psp.x - pep.x) < 0.6 && Math.abs(psp.y - pep.y) < 0.6) continue
            var alt = routePorts(psp, pep, cards, othersS, { penalty: 50000 })
            if (alt === null) continue
            var altStats = wireStats(alt, othersS.map(function (x) { return x.points }))
            var altScore = wireScore(altStats, alt)
            if (hitsOtherEndpoint(alt, se)) altScore += 1000000000
            altScore += endpointNearPenalty(alt, se) * 1000000
            if (altScore + 0.5 < bestScore) {
              bestScore = altScore
              bestPoints = alt
            }
          }
        }
      }
      // 绕远边再做一次「自然通道 + 多个端口位置」的组合搜索：
      // 例如 A→B 的虚线被现有卡片挡住时，换一条底/顶通道的 1/4、1/2、3/4 位置，
      // 往往比在图的边缘绕一大圈更短、也更不容易和其它线叠。
      if (polylineLength(bestPoints) > directLen * 1.4) {
        function sidePositionsFor(box, side, alignX, alignY) {
          var raw = []
          if (side === 'top' || side === 'bottom') raw = [alignX, box.x + box.w * 0.5, box.x + box.w * 0.25, box.x + box.w * 0.75]
          else raw = [alignY, box.y + box.h * 0.5, box.y + box.h * 0.25, box.y + box.h * 0.75]
          var out = []
          for (var ri = 0; ri < raw.length; ri++) {
            var p = side === 'top' || side === 'bottom'
              ? sidePortAt(box, side, raw[ri], 0)
              : sidePortAt(box, side, 0, raw[ri])
            var dup = false
            for (var oi = 0; oi < out.length; oi++) {
              if (Math.abs(out[oi].x - p.x) < 0.6 && Math.abs(out[oi].y - p.y) < 0.6) { dup = true; break }
            }
            if (!dup) out.push(p)
          }
          return out
        }
        var fcx = fs.x + fs.w / 2
        var fcy = fs.y + fs.h / 2
        var tcx = ts.x + ts.w / 2
        var tcy = ts.y + ts.h / 2
        var dyNat = tcy - fcy
        var dxNat = tcx - fcx
        var naturalPairs = []
        var sidePolicyN = transposeSidePolicy(fs, ts)
        if (sidePolicyN) {
          for (var nps = 0; nps < sidePolicyN.start.length; nps++) {
            for (var npe = 0; npe < sidePolicyN.end.length; npe++) naturalPairs.push([sidePolicyN.start[nps], sidePolicyN.end[npe]])
          }
        } else {
          if (dyNat >= 0) naturalPairs.push(['bottom', 'top'])
          else naturalPairs.push(['top', 'bottom'])
          if (dxNat >= 0) naturalPairs.push(['right', 'left'])
          else naturalPairs.push(['left', 'right'])
          naturalPairs.push(['bottom', 'top'])
          naturalPairs.push(['top', 'bottom'])
          naturalPairs.push(['left', 'right'])
          naturalPairs.push(['right', 'left'])
        }
        var seenPair = {}
        for (var npi = 0; npi < naturalPairs.length; npi++) {
          var ss = naturalPairs[npi][0]
          var es = naturalPairs[npi][1]
          var pairKey = ss + '>' + es
          if (seenPair[pairKey]) continue
          seenPair[pairKey] = true
          var starts = sidePositionsFor(fs, ss, tcx, tcy)
          var ends = sidePositionsFor(ts, es, fcx, fcy)
          for (var sti = 0; sti < starts.length; sti++) {
            for (var eti = 0; eti < ends.length; eti++) {
              var nsp = starts[sti]
              var nep = ends[eti]
              if (Math.abs(nsp.x - nep.x) < 0.6 && Math.abs(nsp.y - nep.y) < 0.6) continue
              var nAlt = routePorts(nsp, nep, cards, othersS, { penalty: 50000 })
              if (nAlt === null) continue
              var nScore = wireScore(wireStats(nAlt, othersS.map(function (x) { return x.points })), nAlt)
              if (hitsOtherEndpoint(nAlt, se)) nScore += 1000000000
              nScore += endpointNearPenalty(nAlt, se) * 1000000
              if (nScore + 0.5 < bestScore) { bestScore = nScore; bestPoints = nAlt }
            }
          }
        }
      }
      if (bestPoints !== edgeS.points) {
        edgeS.points = bestPoints
        edgeS.routeKind = 'side-select'
      }
    }

    cprof('computeEdges.sideSelect', cT4)
    /**
     * 终点/起点侧二次选择：不只看绕路比，直接比较「保留另一端、改这一端侧边」的路径。
     * 主要解决虚线终点从卡片远端进入、沿卡边横走一长段的问题。
     */
    function sideAtPoint(box, p) {
      var tol = 2
      if (Math.abs(p[0] - box.x) <= tol) return 'left'
      if (Math.abs(p[0] - (box.x + box.w)) <= tol) return 'right'
      if (Math.abs(p[1] - box.y) <= tol) return 'top'
      if (Math.abs(p[1] - (box.y + box.h)) <= tol) return 'bottom'
      return null
    }
    var cT5 = nowFn()
    var epCount = 0
    var epCalls = 0
    // 端点搜索是整条渲染链路最贵的部分（每次候选都要跑一次 A*）。给全图一个
    // 硬预算：优先修最前面的问题边；超出后保留当前路径，宁可少修一条也不能卡死。
    var epBudget = 24
    var endpointDeadline = heavyEdgeCount ? -1 : Infinity
    for (var te = 0; te < edges.length; te++) {
      if (epCalls >= epBudget || nowFn() > endpointDeadline) break
      var edgeT = edges[te]
      if (edgeT.methodMode) continue
      if (isTransposeChannelEdge(edgeT)) continue
      if (heavyEdgeCount && (edgeT.cardHits || 0) === 0) continue
      var ft = laid.nodes[edgeT.rel.from]
      var tt = laid.nodes[edgeT.rel.to]
      if (!ft || !tt || !edgeT.points || edgeT.points.length < 2) continue
      var othersT = []
      for (var ot = 0; ot < edges.length; ot++) {
        if (ot !== te) othersT.push({ points: edges[ot].points })
      }
      var startPt = edgeT.points[0]
      var endPt = edgeT.points[edgeT.points.length - 1]
      var startSide = sideAtPoint(ft, startPt)
      var endSide = sideAtPoint(tt, endPt)
      var curStats = wireStats(edgeT.points, othersT.map(function (x) { return x.points }))
      var curScore = wireScore(curStats, edgeT.points) + endpointNearPenalty(edgeT.points, te) * 1000000
      var directT = Math.abs(ft.x + ft.w / 2 - (tt.x + tt.w / 2)) + Math.abs(ft.y + ft.h / 2 - (tt.y + tt.h / 2))
      var pathLenT = polylineLength(edgeT.points)
      var issueT = curStats.hits + curStats.overlap + curStats.cross + curStats.touch + (curStats.near > 0 ? 1 : 0)
      // 端点二次搜索很贵（每条边几十次 A*）。只对「绕远」或「确有交叉/重叠/T 型碰线」
      // 的边做；干净边没必要为了几像素长度差重排端点。
      if (pathLenT <= directT * 2.2 && issueT === 0) continue
      epCount += 1
      var fcxT = ft.x + ft.w / 2
      var fcyT = ft.y + ft.h / 2
      var tcxT = tt.x + tt.w / 2
      var tcyT = tt.y + tt.h / 2
      var dxRelT = tcxT - fcxT
      var dyRelT = tcyT - fcyT
      var prefStartSide, prefEndSide
      if (Math.abs(dxRelT) >= Math.abs(dyRelT)) {
        prefStartSide = dxRelT > 0 ? 'right' : 'left'
        prefEndSide = dxRelT > 0 ? 'left' : 'right'
      } else {
        prefStartSide = dyRelT > 0 ? 'bottom' : 'top'
        prefEndSide = dyRelT > 0 ? 'top' : 'bottom'
      }
      var fallbackEndSide = prefEndSide === 'top' || prefEndSide === 'bottom' ? 'left' : 'top'
      var fallbackStartSide = prefStartSide === 'top' || prefStartSide === 'bottom' ? 'left' : 'top'
      var sidePolicyT = transposeSidePolicy(ft, tt)
      var tSideOptions = sidePolicyT ? sidePolicyT.end.slice() : [endSide, prefEndSide, fallbackEndSide].filter(function (s, i, a) {
        return s !== null && s !== undefined && a.indexOf(s) === i
      })
      var sSideOptions = sidePolicyT ? sidePolicyT.start.slice() : [startSide, prefStartSide, fallbackStartSide].filter(function (s, i, a) {
        return s !== null && s !== undefined && a.indexOf(s) === i
      })
      // 真有交叉/重叠/T 型碰线时恢复完整四侧+四位搜索，否则只走“当前/朝向/兜底”三侧两位。
      var fullSearch = issueT > 0
      if (fullSearch) {
        tSideOptions = sidePolicyT ? sidePolicyT.end.slice() : SIDE_NAMES.slice()
        sSideOptions = sidePolicyT ? sidePolicyT.start.slice() : SIDE_NAMES.slice()
      }
      /** 一条侧边上的候选坐标：对齐另一端、中心、1/4、3/4；去重后夹在卡片内。 */
      function endpointCandidatesOn(box, side, alignX, alignY, full) {
        var raw = []
        if (side === 'top' || side === 'bottom') {
          raw = full ? [alignX, box.x + box.w * 0.5, box.x + box.w * 0.25, box.x + box.w * 0.75] : [alignX, box.x + box.w * 0.5]
        } else {
          raw = full ? [alignY, box.y + box.h * 0.5, box.y + box.h * 0.25, box.y + box.h * 0.75] : [alignY, box.y + box.h * 0.5]
        }
        var out = []
        for (var ri = 0; ri < raw.length; ri++) {
          var p = side === 'top' || side === 'bottom'
            ? sidePortAt(box, side, raw[ri], 0)
            : sidePortAt(box, side, 0, raw[ri])
          var dup = false
          for (var oi = 0; oi < out.length; oi++) {
            if (Math.abs(out[oi].x - p.x) < 0.6 && Math.abs(out[oi].y - p.y) < 0.6) { dup = true; break }
          }
          if (!dup) out.push(p)
        }
        return out
      }
      var bestT = edgeT.points
      var bestTScore = curScore
      var tSolved = false
      // 终点候选：起点不动，终点四侧各试多个位置（不再只试“对齐起点”一个点）。
      if (startSide !== null) {
        for (var ti = 0; ti < tSideOptions.length; ti++) {
          var tSide = tSideOptions[ti]
          var tPositions = endpointCandidatesOn(tt, tSide, startPt[0], startPt[1], fullSearch)
          for (var tpi = 0; tpi < tPositions.length; tpi++) {
            var tpos = tPositions[tpi]
            if (Math.abs(tpos.x - startPt[0]) < 0.6 && Math.abs(tpos.y - startPt[1]) < 0.6) continue
            if (epCalls >= epBudget) break
            epCalls += 1
            var tAlt = routePorts({ x: startPt[0], y: startPt[1], side: startSide }, tpos, cards, othersT, { penalty: 50000 })
            if (tAlt === null) continue
            var tStats = wireStats(tAlt, othersT.map(function (x) { return x.points }))
            var tScore = wireScore(tStats, tAlt)
            var tBadEndpoint = hitsOtherEndpoint(tAlt, te)
            if (tBadEndpoint) tScore += 1000000000
            tScore += endpointNearPenalty(tAlt, te) * 1000000
            var tClean = !tBadEndpoint && tStats.hits === 0 && tStats.cross === 0 && tStats.overlap === 0
              && tStats.touch === 0 && tStats.near === 0 && endpointNearPenalty(tAlt, te) === 0
            if (tClean && issueT > 0) {
              // 已经有交叉的边：找到第一条完全干净的路就接受，避免把四侧×四位全跑完。
              bestTScore = tScore
              bestT = tAlt
              tSolved = true
              break
            }
            if (tScore + 0.5 < bestTScore) { bestTScore = tScore; bestT = tAlt }
          }
          if (tSolved) break
        }
      }
      edgeT.points = bestT
      // 起点候选：终点固定，起点四侧各试多个位置。
      var endPt2 = edgeT.points[edgeT.points.length - 1]
      var endSide2 = sideAtPoint(tt, endPt2)
      var bestS = edgeT.points
      var bestSScore = wireScore(wireStats(edgeT.points, othersT.map(function (x) { return x.points })), edgeT.points)
        + endpointNearPenalty(edgeT.points, te) * 1000000
      if (endSide2 !== null) {
        for (var si2 = 0; si2 < sSideOptions.length; si2++) {
          var sSide = sSideOptions[si2]
          var sPositions = endpointCandidatesOn(ft, sSide, endPt2[0], endPt2[1], fullSearch)
          for (var spi = 0; spi < sPositions.length; spi++) {
            var spos = sPositions[spi]
            if (Math.abs(spos.x - endPt2[0]) < 0.6 && Math.abs(spos.y - endPt2[1]) < 0.6) continue
            if (epCalls >= epBudget) break
            epCalls += 1
            var sAlt = routePorts(spos, { x: endPt2[0], y: endPt2[1], side: endSide2 }, cards, othersT, { penalty: 50000 })
            if (sAlt === null) continue
            var sStats = wireStats(sAlt, othersT.map(function (x) { return x.points }))
            var sScore = wireScore(sStats, sAlt)
            var sBadEndpoint = hitsOtherEndpoint(sAlt, te)
            if (sBadEndpoint) sScore += 1000000000
            sScore += endpointNearPenalty(sAlt, te) * 1000000
            var sClean = !sBadEndpoint && sStats.hits === 0 && sStats.cross === 0 && sStats.overlap === 0
              && sStats.touch === 0 && sStats.near === 0 && endpointNearPenalty(sAlt, te) === 0
            if (sClean && issueT > 0) { bestSScore = sScore; bestS = sAlt; break }
            if (sScore + 0.5 < bestSScore) { bestSScore = sScore; bestS = sAlt }
          }
        }
      }
      if (bestS !== edgeT.points) {
        edgeT.points = bestS
        edgeT.routeKind = 'endpoint-side-select'
      }
    }

    cprof('computeEdges.endpointSelect', cT5)
    if (global.__EHM_PROFILE__) {
      global.__EHM_PROFILE__.endpointEdges = epCount
      global.__EHM_PROFILE__.endpointRouteCalls = epCalls
    }
    var cT6 = nowFn()
    // 端点侧选择之后再做一次全局复核：固定当前端点，只重算走线。
    // 之前的全局复核发生在端点选定之前，无法处理端点变化后新出现的交叉/T 型碰线。
    var postGlobalDeadline = nowFn() + (heavyEdgeCount ? 250 : Infinity)
    for (var gr = 0; gr < 2; gr++) {
      if (nowFn() > postGlobalDeadline) break
      var grChanged = false
      for (var ge = 0; ge < edges.length; ge++) {
        if (nowFn() > postGlobalDeadline) break
        var edgeG = edges[ge]
        if (!edgeG.points || edgeG.points.length < 2) continue
        if (isTransposeChannelEdge(edgeG)) continue
        var othersG = []
        for (var go = 0; go < edges.length; go++) {
          if (go !== ge) othersG.push({ points: edges[go].points })
        }
        var gStats = wireStats(edgeG.points, othersG.map(function (x) { return x.points }))
        if (gStats.cross === 0 && gStats.overlap === 0 && gStats.touch === 0 && gStats.near === 0) continue
        var gs = edgeG.points[0]
        var gEnd = edgeG.points[edgeG.points.length - 1]
        var gsSide = sideAtPoint(laid.nodes[edgeG.rel.from], gs)
        var geSide = sideAtPoint(laid.nodes[edgeG.rel.to], gEnd)
        if (gsSide === null || geSide === null) continue
        var gAlt = routePorts(
          { x: gs[0], y: gs[1], side: gsSide },
          { x: gEnd[0], y: gEnd[1], side: geSide },
          cards, othersG, { penalty: 1000000 }
        )
        if (gAlt === null) continue
        var gNewStats = wireStats(gAlt, othersG.map(function (x) { return x.points }))
        if (wireScore(gNewStats, gAlt) + 0.5 < wireScore(gStats, edgeG.points)) {
          edgeG.points = gAlt
          edgeG.routeKind = 'post-global-reroute'
          grChanged = true
        }
      }
      if (!grChanged) break
    }

    cprof('computeEdges.postGlobal', cT6)

    /**
     * 竖向单列打包的专用总线布线：父节点在上、子节点成列，连线从父卡片下沿
     * 走左侧独立车道，再按行横切到子卡片顶部。它避免通用 A* 在多行子节点间
     * 互相绕行造成的 spaghetti；每条边仍有自己的起点/车道，不共享端口。
     */
    if (laid.fanoutGroups && laid.fanoutGroups.length > 0) {
      for (var fg = 0; fg < laid.fanoutGroups.length; fg++) {
        var fgroup = laid.fanoutGroups[fg]
        if (fgroup.parent === null) continue
        var fParent = laid.nodes[fgroup.parent]
        if (!fParent) continue
        var orderedEdges = []
        for (var fr = 0; fr < fgroup.rows.length; fr++) {
          for (var fn = 0; fn < fgroup.rows[fr].length; fn++) {
            var childId = fgroup.rows[fr][fn]
            for (var fe = 0; fe < edges.length; fe++) {
              if (edges[fe].rel.from === fgroup.parent && edges[fe].rel.to === childId) orderedEdges.push(edges[fe])
            }
          }
        }
        if (orderedEdges.length === 0) continue
        var fParentCenterX = fParent.x + fParent.w / 2
        var fTrunkX = Math.max(8, fgroup.left - 24)
        var fBusY = fParent.y + fParent.h + 24
        for (var fb = 0; fb < orderedEdges.length; fb++) {
          var fEdge = orderedEdges[fb]
          var fChild = laid.nodes[fEdge.rel.to]
          if (!fChild) continue
          var fTargetX = fChild.x + fChild.w / 2
          var fTargetY = fChild.y
          // 一条共享主干 + 每行一条横支路：视觉上是一棵树，而不是多条线互相绕。
          fEdge.points = [
            [fParentCenterX, fParent.y + fParent.h],
            [fParentCenterX, fBusY],
            [fTrunkX, fBusY],
            [fTrunkX, fTargetY - 10],
            [fTargetX, fTargetY - 10],
            [fTargetX, fTargetY],
          ]
          fEdge.routeKind = 'fanout-bus'
          fEdge.bundleKey = fgroup.parent
        }
      }
    }
    /**
     * 转置布局的最后一步：按“对端卡片沿该侧的中心坐标”重新排列同一张卡同一侧的端点。
     * 这一步和 makePortAllocator 使用同一条排序规则，但作用在最终折线上，
     * 防止 side-select / 通道重排把已经分好的端口顺序又打乱。
     */
    if (CURRENT_EDGE_AXIS_AUTO) {
      function endSideOf(box, pt) {
        if (!box || !pt) return null
        if (Math.abs(pt[0] - box.x) < 0.6) return 'left'
        if (Math.abs(pt[0] - (box.x + box.w)) < 0.6) return 'right'
        if (Math.abs(pt[1] - box.y) < 0.6) return 'top'
        if (Math.abs(pt[1] - (box.y + box.h)) < 0.6) return 'bottom'
        return null
      }
      var endpointGroups = {}
      function addEndpointGroup(cardId, side, edge, isStart, otherId) {
        var key = cardId + '|' + side
        if (!endpointGroups[key]) endpointGroups[key] = []
        endpointGroups[key].push({ edge: edge, isStart: isStart, otherId: otherId })
      }
      for (var npe = 0; npe < edges.length; npe++) {
        var npeEdge = edges[npe]
        var npeFrom = laid.nodes[npeEdge.rel.from]
        var npeTo = laid.nodes[npeEdge.rel.to]
        if (!npeFrom || !npeTo || !npeEdge.points || npeEdge.points.length < 2) continue
        var npeStartSide = endSideOf(npeFrom, npeEdge.points[0])
        var npeEndSide = endSideOf(npeTo, npeEdge.points[npeEdge.points.length - 1])
        if (npeStartSide) addEndpointGroup(npeEdge.rel.from, npeStartSide, npeEdge, true, npeEdge.rel.to)
        if (npeEndSide) addEndpointGroup(npeEdge.rel.to, npeEndSide, npeEdge, false, npeEdge.rel.from)
      }
      function shiftEndpointRun(points, isStart, side, newValue) {
        var verticalSide = side === 'left' || side === 'right'
        var axis = verticalSide ? 1 : 0
        var idx = isStart ? 0 : points.length - 1
        var oldValue = points[idx][axis]
        points[idx][axis] = newValue
        var step = isStart ? 1 : -1
        var k = idx + step
        while (k >= 0 && k < points.length && Math.abs(points[k][axis] - oldValue) < 0.6) {
          points[k][axis] = newValue
          k += step
        }
      }
      for (var egKey in endpointGroups) {
        if (!Object.prototype.hasOwnProperty.call(endpointGroups, egKey)) continue
        var egParts = egKey.split('|')
        var egCardId = egParts[0]
        var egSide = egParts[1]
        var egBox = laid.nodes[egCardId]
        if (!egBox) continue
        var egList = endpointGroups[egKey]
        var egVerticalSide = egSide === 'left' || egSide === 'right'
        egList.forEach(function (item) {
          var other = laid.nodes[item.otherId]
          item.otherCoord = other
            ? (egVerticalSide ? other.y + other.h / 2 : other.x + other.w / 2)
            : 0
        })
        egList.sort(function (a, b) {
          return a.otherCoord - b.otherCoord || a.edge.rel.id.localeCompare(b.edge.rel.id)
        })
        for (var egk = 0; egk < egList.length; egk++) {
          var egItem = egList[egk]
          var slot = egList.length <= 1 ? 0.5 : (egk + 1) / (egList.length + 1)
          var newValue = egVerticalSide
            ? egBox.y + egBox.h * slot
            : egBox.x + egBox.w * slot
          shiftEndpointRun(egItem.edge.points, egItem.isStart, egSide, newValue)
          if (egItem.edge.points.length < 2) continue
          egItem.edge.points = egItem.edge.points.filter(function (pt, idx, arr) {
            return idx === 0 || Math.abs(pt[0] - arr[idx - 1][0]) + Math.abs(pt[1] - arr[idx - 1][1]) > 0.6
          })
        }
      }
    }

    /**
     * 转置布局的列间通道路由：跨列边统一在列间空档里分配车道，再横出/横入。
     * 车道顺序不是写死的：枚举几种“按起点 Y / 终点 Y / 中点排序”的候选，
     * 用整张图的交叉、重叠、贴近和总长度打分，取分数最低的一种。
     */
    if (CURRENT_EDGE_AXIS_AUTO) {
      var colBounds = {}
      var crossRecords = []
      var crossSet = {}
      for (var cbe = 0; cbe < edges.length; cbe++) {
        var eCb = edges[cbe]
        var fCb = laid.nodes[eCb.rel.from]
        var tCb = laid.nodes[eCb.rel.to]
        if (!fCb || !tCb || fCb.colIndex === undefined || tCb.colIndex === undefined) continue
        if (fCb.colIndex === tCb.colIndex) continue
        if (!eCb.points || eCb.points.length < 2) continue
        var colsCb = [fCb.colIndex, tCb.colIndex]
        for (var cbi = 0; cbi < colsCb.length; cbi++) {
          var cbKey = colsCb[cbi]
          if (!colBounds[cbKey]) colBounds[cbKey] = { left: Infinity, right: -Infinity }
          var cbBox = cbi === 0 ? fCb : tCb
          colBounds[cbKey].left = Math.min(colBounds[cbKey].left, cbBox.x)
          colBounds[cbKey].right = Math.max(colBounds[cbKey].right, cbBox.x + cbBox.w)
        }
        var dirCb = tCb.colIndex > fCb.colIndex ? 1 : -1
        var sPtCb = eCb.points[0]
        var ePtCb = eCb.points[eCb.points.length - 1]
        crossRecords.push({
          edge: eCb,
          fromBox: fCb,
          toBox: tCb,
          gapKey: Math.min(fCb.colIndex, tCb.colIndex) + ':' + Math.max(fCb.colIndex, tCb.colIndex),
          dir: dirCb,
          sx: dirCb > 0 ? fCb.x + fCb.w : fCb.x,
          ex: dirCb > 0 ? tCb.x : tCb.x + tCb.w,
          sy: Math.max(fCb.y + 4, Math.min(fCb.y + fCb.h - 4, sPtCb[1])),
          ey: Math.max(tCb.y + 4, Math.min(tCb.y + tCb.h - 4, ePtCb[1])),
        })
        crossSet[eCb.rel.id] = true
      }
      var gapGroups = {}
      for (var cri = 0; cri < crossRecords.length; cri++) {
        var cRec = crossRecords[cri]
        if (!gapGroups[cRec.gapKey]) gapGroups[cRec.gapKey] = []
        gapGroups[cRec.gapKey].push(cRec)
      }
      var fixedEdgePoints = []
      for (var fei = 0; fei < edges.length; fei++) {
        if (!crossSet[edges[fei].rel.id] && edges[fei].points) fixedEdgePoints.push(edges[fei].points)
      }
      function channelPath(rec, laneX) {
        return [
          [rec.sx, rec.sy],
          [rec.sx + rec.dir * G.STUB, rec.sy],
          [laneX, rec.sy],
          [laneX, rec.ey],
          [rec.ex - rec.dir * G.STUB, rec.ey],
          [rec.ex, rec.ey],
        ].filter(function (pt, idx, arr) {
          return idx === 0 || Math.abs(pt[0] - arr[idx - 1][0]) + Math.abs(pt[1] - arr[idx - 1][1]) > 0.6
        })
      }
      function scoreChannel(paths) {
        var score = 0
        var all = fixedEdgePoints.slice()
        for (var pi = 0; pi < paths.length; pi++) {
          score += polylineLength(paths[pi]) * 0.02
          for (var oi = 0; oi < all.length; oi++) {
            var st = wireStats(paths[pi], [all[oi]])
            score += st.hits * 100000 + st.cross * 1000 + st.overlap * 1000 + st.touch * 100 + st.near * 10
          }
          all.push(paths[pi])
        }
        return score
      }
      // 车道顺序用 DP 求全局最优：把每条跨列边看成一笔“中间竖线 + 两端横线”，
      // 两笔线是否交叉只取决于它们在通道里的相对左右顺序，因此可以用
      // dp[mask][last] 在 O(2^n * n^2) 内求出交叉数最少的顺序（n 为通道内边数）。
      function optimizeLaneOrder(recs) {
        var n = recs.length
        if (n <= 1) return recs.slice()
        if (n > 14) return recs.slice().sort(function (a, b) { return a.sy - b.sy })
        function covers(lo, hi, y) { return y >= Math.min(lo, hi) - 0.1 && y <= Math.max(lo, hi) + 0.1 }
        var before = []
        for (var i = 0; i < n; i++) {
          before.push([])
          for (var j = 0; j < n; j++) {
            if (i === j) { before[i].push(0); continue }
            var a = recs[i]
            var b = recs[j]
            var cost = 0
            // i 在左、j 在右：j 的左横线要穿过 i 的竖线，i 的右横线要穿过 j 的竖线。
            if (covers(a.sy, a.ey, b.sy)) cost += 1
            if (covers(b.sy, b.ey, a.ey)) cost += 1
            before[i].push(cost)
          }
        }
        var total = 1 << n
        var dp = []
        var parent = []
        for (var m = 0; m < total; m++) {
          dp.push(new Array(n).fill(Infinity))
          parent.push(new Array(n).fill(-1))
        }
        for (var s = 0; s < n; s++) dp[1 << s][s] = 0
        for (var mask = 1; mask < total; mask++) {
          for (var last = 0; last < n; last++) {
            if (dp[mask][last] === Infinity) continue
            var addCostBase = 0
            for (var nxt = 0; nxt < n; nxt++) {
              if (mask & (1 << nxt)) continue
              var add = 0
              for (var prev = 0; prev < n; prev++) {
                if (mask & (1 << prev)) add += before[prev][nxt]
              }
              var nm = mask | (1 << nxt)
              if (dp[mask][last] + add < dp[nm][nxt]) {
                dp[nm][nxt] = dp[mask][last] + add
                parent[nm][nxt] = last
              }
            }
          }
        }
        var full = total - 1
        var bestLast = 0
        for (var bl = 1; bl < n; bl++) if (dp[full][bl] < dp[full][bestLast]) bestLast = bl
        var orderIdx = []
        var cm = full
        var cl = bestLast
        while (cl !== -1) {
          orderIdx.push(cl)
          var pl = parent[cm][cl]
          cm = cm ^ (1 << cl)
          cl = pl
        }
        orderIdx.reverse()
        return orderIdx.map(function (idx) { return recs[idx] })
      }
      for (var gapKey in gapGroups) {
        if (!Object.prototype.hasOwnProperty.call(gapGroups, gapKey)) continue
        var recs = gapGroups[gapKey]
        var parts = gapKey.split(':')
        var loB = colBounds[Number(parts[0])]
        var hiB = colBounds[Number(parts[1])]
        if (!loB || !hiB) continue
        var gapLeft = loB.right + G.STUB
        var gapRight = hiB.left - G.STUB
        if (gapRight <= gapLeft) continue
        var bestOrder = optimizeLaneOrder(recs)
        var bestPaths = []
        var usable = true
        for (var oi2 = 0; oi2 < bestOrder.length; oi2++) {
          var laneShare = (oi2 + 1) / (bestOrder.length + 1)
          var laneX = gapLeft + (gapRight - gapLeft) * laneShare
          var pts = channelPath(bestOrder[oi2], laneX)
          if (countCardHits(pts, cards, {}) > 0) { usable = false; break }
          bestPaths.push(pts)
        }
        if (!usable) {
          // 兜底：按起点 Y 排，保持单调查道
          bestOrder = recs.slice().sort(function (a, b) { return a.sy - b.sy || a.ey - b.ey })
          bestPaths = []
          for (var oi3 = 0; oi3 < bestOrder.length; oi3++) {
            var laneShare2 = (oi3 + 1) / (bestOrder.length + 1)
            var laneX2 = gapLeft + (gapRight - gapLeft) * laneShare2
            bestPaths.push(channelPath(bestOrder[oi3], laneX2))
          }
        }
        for (var bi3 = 0; bi3 < bestOrder.length; bi3++) {
          bestOrder[bi3].edge.points = bestPaths[bi3]
          bestOrder[bi3].edge.routeKind = 'transpose-channel'
        }
      }
    }
    /**
     * 最终穿卡修复：无论前面哪个阶段/性能开关跳过了优化，只要交付前还有线段穿过卡片，
     * 就针对这条边重新做一次避开卡片的 A*。这是“正确性兜底”，只对违规边生效，
     * 不会把大图的全局搜索成本重新加回来。
     */
    var repairDeadline = nowFn() + (edges.length > 30 ? 1200 : 600)
    for (var rp = 0; rp < edges.length; rp++) {
      var edgeP = edges[rp]
      if (!edgeP.points || edgeP.points.length < 2) continue
      if (countCardHits(edgeP.points, cards, {}) === 0) continue
      if (nowFn() > repairDeadline) break
      var fromP = laid.nodes[edgeP.rel.from]
      var toP = laid.nodes[edgeP.rel.to]
      if (!fromP || !toP) continue
      var othersP = []
      for (var op = 0; op < edges.length; op++) {
        if (op !== rp && edges[op].points) othersP.push({ points: edges[op].points })
      }
      var repaired = null
      var sp = edgeP.points[0]
      var ep = edgeP.points[edgeP.points.length - 1]
      var ss = sideAtPoint(fromP, sp)
      var es = sideAtPoint(toP, ep)
      if (ss !== null && es !== null) {
        repaired = routePorts({ x: sp[0], y: sp[1], side: ss }, { x: ep[0], y: ep[1], side: es }, cards, othersP, { penalty: 100000 })
      }
      if (repaired === null || countCardHits(repaired, cards, {}) > 0) {
        repaired = routeAroundCards(fromP, toP, 0.5, 0.5, {}, cards, {}, [])
      }
      if (repaired !== null && countCardHits(repaired, cards, {}) === 0 && polylineLength(repaired) < polylineLength(edgeP.points) * 5) {
        edgeP.points = repaired
        edgeP.routeKind = 'card-repair'
      }
    }
    return edges
  }

  /* ============================================================
     9. 渲染：DOM 卡片 + SVG 连线
     ============================================================ */

  /**
   * 实体 kind → 视觉类名。
   *
   * 同时覆盖两代枚举：
   *   1.0.0: module/file/class/interface/function/type/const/capability/aggregate/unknown
   *   0.1  : module/abstract/class/service/function
   * （0.1 的 kind 在 normalizeIR 里已被别名到 1.0.0，这里主要是给 1.0.0 补齐。
   *   保留 0.1 分支是为了防御：万一调用方直接喂了未归一化的对象也不会掉样式。）
   */
  function paletteOf(kind) {
    if (kind === 'interface' || kind === 'abstract') return 'ehm-kind-abstract'
    if (kind === 'capability' || kind === 'service' || kind === 'aggregate') return 'ehm-kind-service'
    if (kind === 'module' || kind === 'file') return 'ehm-kind-module'
    if (kind === 'function' || kind === 'const' || kind === 'type') return 'ehm-kind-function'
    return 'ehm-kind-class'
  }

  /** 关系语义 → 主题变量（1.0.0 kind 与 0.1 kind 都要认）。 */
  function edgeStrokeVar(kind) {
    // 带 hex fallback：外置引擎/缓存异常导致 CSS 变量没注入时，线仍然可见。
    if (kind === 'extends' || kind === 'implements' || kind === 'inherit') return 'var(--ehm-edge-inherit, rgba(236,226,207,.68))'
    if (kind === 'uses' || kind === 'imports' || kind === 'depend' || kind === 'dependency') return 'var(--ehm-edge-depend, rgba(198,187,167,.56))'
    if (kind === 'contains' || kind === 'compose') return 'var(--ehm-edge-compose, rgba(150,176,255,.55))'
    return 'var(--ehm-edge-call, rgba(150,176,255,.92))'
  }
  /** 是否为「继承类」关系（空心三角箭头）。 */
  function isInheritLike(kind) {
    return kind === 'extends' || kind === 'implements' || kind === 'inherit'
  }
  /** 是否虚线（非结构性的语义关系）。 */
  /**
   * 虚线只影响描边/箭头填充，**不参与布线成本**：uses/imports/depend 与普通边
   * 使用同一套卡片避让、交叉、共线重叠、平行净距成本，避免虚线被当成低优先级。
   */
  function isDashed(kind) {
    return kind === 'uses' || kind === 'imports' || kind === 'depend' || kind === 'diff-change'
  }

  function edgeDash(kind) {
    return isDashed(kind) ? '5 4' : undefined
  }

  function arrowHead(prev, last, kind) {
    var dx = last[0] - prev[0]
    var dy = last[1] - prev[1]
    var len = Math.sqrt(dx * dx + dy * dy) || 1
    var ux = dx / len
    var uy = dy / len
    var size = isInheritLike(kind) ? 11 : 9
    var px = -uy
    var py = ux
    var bx = last[0] - ux * size
    var by = last[1] - uy * size
    var left = [bx + px * size * 0.5, by + py * size * 0.5]
    var right = [bx - px * size * 0.5, by - py * size * 0.5]
    var d = 'M ' + last[0] + ' ' + last[1] + ' L ' + left[0] + ' ' + left[1]
      + ' L ' + right[0] + ' ' + right[1] + ' Z'
    var filled = !isInheritLike(kind) && !isDashed(kind)
    return svg('path', {
      d: d,
      fill: filled ? edgeStrokeVar(kind) : 'var(--ehm-arrow-hollow)',
      stroke: edgeStrokeVar(kind),
      'stroke-width': 1.3,
      class: 'ehm-arrow',
    })
  }

  /* ============================================================
     10. 实例
     ============================================================ */

  function createViewer(ir, container, options) {
    if (!container) fail('render(ir, container) 需要容器元素')
    var opts = options || {}
    var PROFILE = global.__EHM_PROFILE__ = { phases: [], totalMs: 0 }
    var profileStart = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
    function prof(label, since) {
      var now = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
      PROFILE.phases.push([label, Math.round((now - since) * 10) / 10])
    }
    var model = normalizeIR(ir)

    var viewOptions = model.view && model.view.options ? model.view.options : {}
    var layoutParams = {}
    var lk
    for (lk in LAYOUT_BASE) {
      if (!Object.prototype.hasOwnProperty.call(LAYOUT_BASE, lk)) continue
      layoutParams[lk] = LAYOUT_BASE[lk]
    }
    // H5 内联的布局方向（CLI --direction / ehm_render direction；缺省 TB 纵向）。
    // 必须覆盖 IR view.options 里的默认 rankdir，但允许调用方 opts.layout 再覆盖（测试/嵌入用）。
    var meta = global.__EHM_META__ && typeof global.__EHM_META__ === 'object' ? global.__EHM_META__ : {}
    for (lk in viewOptions) {
      if (Object.prototype.hasOwnProperty.call(layoutParams, lk) && typeof viewOptions[lk] === typeof layoutParams[lk]) {
        layoutParams[lk] = viewOptions[lk]
      }
    }
    if (meta.direction === 'TB' || meta.direction === 'LR') layoutParams.rankdir = meta.direction
    if (opts.layout) {
      for (lk in opts.layout) {
        if (Object.prototype.hasOwnProperty.call(layoutParams, lk)) layoutParams[lk] = opts.layout[lk]
      }
    }
    CURRENT_EDGE_AXIS = layoutParams.rankdir === 'TB' ? 'v' : 'h'
    global.__EHM_ROUTE_DEBUG = []

    var initialSkin = typeof opts.skin === 'string' && SKINS.some(function (s) { return s.id === opts.skin })
      ? opts.skin
      : (opts.theme === 'light' ? 'dsh-light' : 'dsh-dark')
    var state = {
      skin: initialSkin,
      theme: initialSkin === 'dsh-light' || initialSkin === 'editorial' ? 'light' : 'dark',
      methodsCollapsed: opts.methodsMode === 'collapsed',
      view: { x: 0, y: 0, k: 1 },
      layout: null,
      edges: [],
      labels: [],
      bubbles: 0,
      diag: null,
    }

    // 宿主注入的 onJump（html.mjs 的 interactionScript 会传；插件 iframe 里同一个）。
    // 独立窗口（新标签页）没有 DSH 客户端轮询，跳转必须自己给可见反馈 —— 见 onJump()。
    var hostOnJump = typeof opts.onJump === 'function' ? opts.onJump : null

    /* ---------- DOM 骨架 ---------- */
    container.classList.add('ehm-host')
    container.replaceChildren()
    var root = el('div', { class: 'ehm-root ehm-theme-' + state.theme })
    root.setAttribute('data-ehm-skin', state.skin)
    var bar = el('div', { class: 'ehm-bar' })
    var brand = el('div', { class: 'ehm-brand' }, [
      el('span', { class: 'ehm-brand-name', text: 'ehm' }),
      el('span', { class: 'ehm-brand-sub', text: 'IR / UML' }),
    ])
    var title = el('div', { class: 'ehm-title' }, [
      el('span', { class: 'ehm-title-main', text: meta.title || countTitle(model) }),
      el('span', { class: 'ehm-title-meta', text: countTitle(model) }),
    ])
    var hint = el('div', {
      class: 'ehm-hint',
      text: '悬停代码 · 单击固定 · Alt 拖拽 / 缩放 · 0 适配',
    })
    var spacer = el('span', { class: 'ehm-spacer' })
    var btnFit = el('button', { class: 'ehm-btn', type: 'button', 'data-ehm-action': 'fit', text: '适配' })
    var btnSidebar = el('button', { class: 'ehm-btn', type: 'button', 'data-ehm-action': 'sidebar', text: '在侧栏打开' })
    var btnTheme = el('button', {
      class: 'ehm-btn', type: 'button', 'data-ehm-action': 'theme', text: '主题',
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
    })
    bar.append(brand, title, spacer, hint, btnFit, btnSidebar, btnTheme)

    // 主题菜单：点击「主题」打开；默认 DSH 深色，内置 DSH 浅色 / Graphite / Editorial / Carbon。
    var themeMenu = el('div', { class: 'ehm-theme-menu', 'data-ehm-theme-menu': '1', role: 'menu' })
    themeMenu.append(el('div', { class: 'ehm-theme-menu-head', text: '主题 / THEME' }))
    var themeMenuItems = []
    SKINS.forEach(function (skin) {
      var item = el('button', {
        class: 'ehm-theme-item', type: 'button', role: 'menuitemradio',
        'data-ehm-skin': skin.id, 'aria-checked': skin.id === state.skin ? 'true' : 'false',
      })
      item.append(el('span', { class: 'ehm-theme-swatch ehm-swatch-' + skin.id }))
      item.append(el('span', { class: 'ehm-theme-label', text: skin.label }))
      item.append(el('span', { class: 'ehm-theme-check', text: '\u2713' }))
      themeMenu.append(item)
      themeMenuItems.push(item)
    })

    var stage = el('div', { class: 'ehm-stage' })
    var content = el('div', { class: 'ehm-content' })
    stage.append(content)
    var toastEl = el('div', { class: 'ehm-toast' })
    var bubbleEl = el('div', { class: 'ehm-bubble' })
    root.append(bar, stage, themeMenu, toastEl, bubbleEl)
    container.append(root)

    /* ---------- 气泡（三态：none / hover / locked） ---------- */
    var bubble = {
      state: 'none',
      key: null,
      ownerRect: null,
      ownerCardRect: null,
      pointer: { x: 0, y: 0 },
      /** hover 态是否已进入「离开 owner 的宽限期」 */
      hoverHold: false,
      selectedEl: null,
      selectedKey: null,
      el: bubbleEl,
    }
    /** Alt 按下期间禁用 hover 气泡；Alt 松开后下一次悬停才出。 */
    var altHeld = false
    /** hover 态离开 owner 后的短暂宽限（毫秒）：只用于避免相邻行移动时闪烁；hover 气泡不可操作 */
    var HOVER_HOLD_MS = 600
    var hoverHoldTimer = null

    /** file:line:col 文本（跳转、复制、toast 共用；列缺省按 1）。 */
    function locationText(target) {
      if (!target || !target.file) return '(未知位置)'
      return target.file + ':' + (target.line === undefined ? '?' : target.line) + ':' + (target.column === undefined ? 1 : target.column)
    }

    /**
     * 当前页面是不是独立窗口（不是 iframe）。
     *
     * 侧边栏 / 内联卡里 viewer 跑在 iframe 中，点击后页面会 POST 给宿主，再由
     * DSH 客户端轮询 /ehm/intent 真正打开文件；但在**独立标签页**里没有那个
     * 轮询者，用户点完看不到任何跳转 —— 必须自己给可见反馈（P13-B）。
     */
    function isStandaloneWindow() {
      try { return global.self === global.top } catch (e) { return false }
    }

    /**
     * 独立窗口里的跳转反馈：
     *   · 复制 file:line:col 到剪贴板；
     *   · toast 明确告诉用户「位置已记录/已复制，请回 DSH 窗口查看跳转」；
     *   · 页面有 jumpUrl 时仍 POST 一次（让 DSH 窗口的轮询/宿主能收到意图）；
     *     dist 静态页没有 jumpUrl，就只提示已复制。
     *
     * 不再依赖 html.mjs 的 body 级 toast —— 那个元素与 viewer 的 .ehm-toast 撞名，
     * 被 style.css 的全局 `.ehm-toast { opacity: 0 }` 压成透明，所以以前独立窗口
     * 点击「一点反应都没有」。
     */
    function standaloneJumpFeedback(target) {
      var text = locationText(target)
      var copied = copyText(text)
      global.__lastIntent = target
      var jumpUrl = (global.__EHM_META__ && typeof global.__EHM_META__.jumpUrl === 'string' && global.__EHM_META__.jumpUrl !== '')
        ? global.__EHM_META__.jumpUrl
        : null
      if (jumpUrl === null) {
        toast((copied ? '已复制 ' : '跳转位置 ') + text + '（独立窗口无法打开 DSH 文件）', '跳转')
        return
      }
      toast('已记录位置 ' + text + '；请回到 DSH 窗口查看跳转' + (copied ? '（已复制）' : ''), '跳转')
      try {
        if (typeof global.fetch === 'function') {
          var p = global.fetch(jumpUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(target),
          })
          if (p && typeof p.then === 'function') {
            p.then(function (r) { return r && r.json ? r.json() : null }).then(function (res) {
              // ehm 原始页（/jump/<id>）如果没有配置 jumpEndpoint，后端会回 forwarded:false：
              // 这时「请回到 DSH 窗口」会误导，改成明确的「已复制（独立窗口无法打开 DSH 文件）」。
              if (res === null || res.forwarded !== true) {
                toast((copied ? '已复制 ' : '跳转位置 ') + text + '（独立窗口无法打开 DSH 文件）', '跳转')
              }
            }).catch(function () { /* 网络失败：保留首条可见反馈 */ })
          } else if (p && typeof p.catch === 'function') {
            p.catch(function () { /* 记录失败不影响可见反馈 */ })
          }
        }
      } catch (e) { /* 同上 */ }
    }

    function defaultOnJump(target) {
      var text = locationText(target)
      var copied = copyText(text)
      global.__lastIntent = target
      if (isStandaloneWindow()) {
        toast((copied ? '已复制 ' : '跳转位置 ') + text + '（独立窗口无法打开 DSH 文件）', '跳转')
      } else {
        toast((copied ? '已复制 ' : '跳转目标 ') + text, '跳转')
      }
      if (global.console && global.console.log) global.console.log('[ehm] onJump', target)
    }

    /** 统一入口：宿主提供 onJump 时完全交给宿主（静态 HTML 的 post/open/copy 动作在这里执行）；否则走默认实现。 */
    function onJump(target) {
      if (hostOnJump !== null) { hostOnJump(target); return }
      defaultOnJump(target)
    }

    function copyText(text) {
      try {
        if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
          var p = global.navigator.clipboard.writeText(text)
          if (p && typeof p.catch === 'function') p.catch(function () {})
          return true
        }
      } catch (e) { /* 忽略，走兜底 */ }
      try {
        var ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', 'readonly')
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.append(ta)
        ta.select()
        var ok = document.execCommand && document.execCommand('copy')
        ta.remove()
        return ok === true
      } catch (e2) { return false }
    }

    var toastTimer = null
    function toast(text, tag) {
      toastEl.replaceChildren(
        tag ? el('span', { class: 'ehm-toast-tag', text: tag }) : null,
        el('code', { class: 'ehm-toast-text', text: text })
      )
      toastEl.classList.add('show')
      if (toastTimer !== null) clearTimeout(toastTimer)
      toastTimer = setTimeout(function () { toastEl.classList.remove('show') }, 2200)
    }

    /* ---------- 布局 + 绘制 ---------- */

    function sizesFor(realSizes) {
      var sizes = {}
      for (var i = 0; i < model.entities.length; i++) {
        var ent = model.entities[i]
        var real = realSizes ? realSizes[ent.id] : null
        var est = measureCard(ent, state.methodsCollapsed)
        if (real && real.w > 0 && real.h > 0) {
          // 量到的真实尺寸可能被 CSS 压缩过（行内 ellipsis / overflow:hidden），
          // 取两者最大值，保证布局留足空间、文字不被裁。
          sizes[ent.id] = { w: Math.max(real.w, est.w), h: Math.max(real.h, est.h) }
        } else {
          sizes[ent.id] = { w: est.w, h: est.h }
        }
      }
      return sizes
    }

    /**
     * 高扇出叶子层打包：dagre 的 TB 把同一 rank 的所有节点横排成一行，
     * 10 个兄弟节点就会得到一张 3000px 宽的图。这里在布局完成后、布线前，
     * 只对「最后一层、无后续依赖、数量多」的节点：
     *   ① 按父节点分组；
     *   ② 组内每行最多 4 个，换行堆叠；
     *   ③ 组与组水平错开，保持父子归属可读。
     * 返回 null 表示不满足条件/没有收益，原始布局保持不变。
     */
    /**
     * 行 → 列转置：把 dagre 的每个 rank（一行）变成一列，行内节点按原顺序竖排。
     * 与“直接交换 x/y”不同：卡片不旋转，列宽取行内最大卡宽、列高按卡高重新排，
     * 所以不会因为宽高不等而重叠。窄容器下用于把宽图变成竖图。
     */
    function transposeRankBands(laid, params, viewportWidth) {
      if (!laid || CURRENT_EDGE_AXIS !== 'v') return null
      // 对话内联卡片会主动带 #ehm-portrait：正文容器可能比侧栏宽得多，
      // 但仍应使用竖向排版；侧栏/独立页面仍按容器宽度决定。
      var forcePortrait = false
      try {
        forcePortrait = String(global.location && global.location.hash ? global.location.hash : '').indexOf('ehm-portrait') >= 0
      } catch (ignoreHashError) {}
      if (!forcePortrait && (typeof viewportWidth !== 'number' || viewportWidth >= 1500)) return null
      var ids = Object.keys(laid.nodes)
      if (ids.length < 8) return null
      for (var mri = 0; mri < model.relations.length; mri++) {
        if (model.relations[mri].fromMethod || model.relations[mri].toMethod) return null
      }
      var entries = []
      for (var i = 0; i < ids.length; i++) {
        var node = laid.nodes[ids[i]]
        if (!node) continue
        entries.push({ id: ids[i], node: node, cx: node.x + node.w / 2, cy: node.y + node.h / 2 })
      }
      entries.sort(function (a, b) { return a.cy - b.cy || a.cx - b.cx })
      var bands = []
      for (var ei = 0; ei < entries.length; ei++) {
        var en = entries[ei]
        var band = bands.length > 0 ? bands[bands.length - 1] : null
        if (band === null || en.cy - band.cy > 8) {
          band = { cy: en.cy, nodes: [] }
          bands.push(band)
        }
        band.nodes.push(en)
        band.cy = (band.cy * (band.nodes.length - 1) + en.cy) / band.nodes.length
      }
      var bandOf = {}
      for (var bi = 0; bi < bands.length; bi++) for (var bn = 0; bn < bands[bi].nodes.length; bn++) bandOf[bands[bi].nodes[bn].id] = bi
      var lastBand = bands[bands.length - 1]
      if (!lastBand || lastBand.nodes.length < 6) return null
      var lastIndex = bands.length - 1
      for (var ri = 0; ri < model.relations.length; ri++) {
        var rel = model.relations[ri]
        if (bandOf[rel.from] === lastIndex && bandOf[rel.to] !== undefined && bandOf[rel.to] > lastIndex) return null
      }
      var parentScore = {}
      var parentOf = {}
      for (var rj = 0; rj < model.relations.length; rj++) {
        var rel2 = model.relations[rj]
        if (bandOf[rel2.to] !== lastIndex) continue
        var fromB = bandOf[rel2.from]
        if (fromB === undefined || fromB >= lastIndex) continue
        parentScore[rel2.to] = parentScore[rel2.to] || {}
        parentScore[rel2.to][rel2.from] = (parentScore[rel2.to][rel2.from] || 0) + 1
      }
      for (var ci = 0; ci < lastBand.nodes.length; ci++) {
        var cid = lastBand.nodes[ci].id
        var scores = parentScore[cid]
        if (!scores) continue
        var best = null
        var bestScore = -1
        for (var pid in scores) {
          if (!Object.prototype.hasOwnProperty.call(scores, pid)) continue
          if (scores[pid] > bestScore) { bestScore = scores[pid]; best = pid }
        }
        parentOf[cid] = best
      }
      var parentX = {}
      for (var pi = 0; pi < bands[0].nodes.length; pi++) parentX[bands[0].nodes[pi].id] = bands[0].nodes[pi].node.x
      for (var bi2 = 0; bi2 < bands.length; bi2++) {
        var sortBand = bands[bi2]
        sortBand.nodes.sort(function (a, b) {
          if (bi2 === lastIndex) {
            var ap = parentOf[a.id]
            var bp = parentOf[b.id]
            if (ap !== undefined && bp !== undefined) {
              var ax = parentX[ap] === undefined ? 0 : parentX[ap]
              var bx = parentX[bp] === undefined ? 0 : parentX[bp]
              if (ax !== bx) return ax - bx
              if (ap !== bp) return String(ap).localeCompare(String(bp))
            }
          }
          return a.cx - b.cx || a.cy - b.cy
        })
      }

      var gapX = Math.max(72, Math.round((params.ranksep || 112) * 0.65))
      var gapY = 96
      // 列间通道宽度由穿过它的边数决定：每条车道至少 14px，否则十几条线会挤成一条。
      var columnCrossCounts = []
      for (var gci = 0; gci < bands.length - 1; gci++) columnCrossCounts.push(0)
      for (var gcr = 0; gcr < model.relations.length; gcr++) {
        var gcrRel = model.relations[gcr]
        var gcrFrom = bandOf[gcrRel.from]
        var gcrTo = bandOf[gcrRel.to]
        if (gcrFrom === undefined || gcrTo === undefined) continue
        if (Math.abs(gcrFrom - gcrTo) !== 1) continue
        columnCrossCounts[Math.min(gcrFrom, gcrTo)] += 1
      }
      var columnGaps = []
      for (var gcg = 0; gcg < columnCrossCounts.length; gcg++) {
        columnGaps.push(Math.max(gapX, columnCrossCounts[gcg] * 14 + 24))
      }
      // 先量出每列宽/高，再把短列在纵向居中；父节点列不再从左上角起排，
      // 否则整张图会重心偏上、右侧长列把左侧短列甩在顶部。
      var colWidths = []
      var colHeights = []
      var contentHeight = 0
      for (var cmeasure = 0; cmeasure < bands.length; cmeasure++) {
        var measureBand = bands[cmeasure]
        var measureWidth = 0
        var measureHeight = 0
        for (var mw = 0; mw < measureBand.nodes.length; mw++) {
          measureWidth = Math.max(measureWidth, measureBand.nodes[mw].node.w)
          measureHeight += measureBand.nodes[mw].node.h + (mw > 0 ? gapY : 0)
        }
        colWidths.push(measureWidth)
        colHeights.push(measureHeight)
        contentHeight = Math.max(contentHeight, measureHeight)
      }
      var xCursor = PAD.x
      for (var colIndex = 0; colIndex < bands.length; colIndex++) {
        var col = bands[colIndex]
        var colWidth = colWidths[colIndex]
        var colHeight = colHeights[colIndex]
        var yCursor = PAD.y + (contentHeight - colHeight) / 2
        for (var cn2 = 0; cn2 < col.nodes.length; cn2++) {
          var cnNode = col.nodes[cn2].node
          cnNode.colIndex = colIndex
          cnNode.x = xCursor + (colWidth - cnNode.w) / 2
          cnNode.y = yCursor
          yCursor += cnNode.h + gapY
        }
        xCursor += colWidth + (colIndex < columnGaps.length ? columnGaps[colIndex] : gapX)
        col.width = colWidth
      }
      var maxBottom = PAD.y + contentHeight
      var maxRight = xCursor - gapX
      var oldWidth = laid.width
      var oldHeight = laid.height
      laid.width = Math.max(1, maxRight + PAD.x)
      laid.height = Math.max(1, maxBottom + PAD.y)
      return {
        applied: true,
        mode: 'transpose',
        columns: bands.length,
        oldWidth: oldWidth,
        oldHeight: oldHeight,
        width: laid.width,
        height: laid.height,
      }
    }

    function packLeafFanout(laid, params, viewportWidth) {
      function bail(reason) {
        global.__EHM_PACK_REASON__ = reason
        return null
      }
      if (!laid || CURRENT_EDGE_AXIS !== 'v') return bail('axis-or-empty')
      var ids = Object.keys(laid.nodes)
      if (ids.length < 8) return bail('nodes<8')
      var entries = []
      for (var i = 0; i < ids.length; i++) {
        var node = laid.nodes[ids[i]]
        if (!node) continue
        entries.push({ id: ids[i], node: node, cx: node.x + node.w / 2, cy: node.y + node.h / 2 })
      }
      if (entries.length < 8) return bail('entries<8')
      entries.sort(function (a, b) { return a.cy - b.cy || a.cx - b.cx })

      // 按 dagre 的 y 中心切 rank band（同层卡片中心通常完全同 y；留 8px 容差）。
      var bands = []
      for (var ei = 0; ei < entries.length; ei++) {
        var en = entries[ei]
        var band = bands.length > 0 ? bands[bands.length - 1] : null
        if (band === null || en.cy - band.cy > 8) {
          band = { cy: en.cy, top: en.node.y, nodes: [] }
          bands.push(band)
        }
        band.nodes.push(en)
        band.top = Math.min(band.top, en.node.y)
        band.cy = (band.cy * (band.nodes.length - 1) + en.cy) / band.nodes.length
      }
      var bandOf = {}
      for (var bi = 0; bi < bands.length; bi++) {
        for (var bn = 0; bn < bands[bi].nodes.length; bn++) bandOf[bands[bi].nodes[bn].id] = bi
      }
      var lastBand = bands[bands.length - 1]
      if (!lastBand || lastBand.nodes.length < 6) return bail('lastBand<' + (lastBand ? lastBand.nodes.length : 0))
      var lastIndex = bands.length - 1

      // 方法级端点依赖卡片内成员行的精确 y；打包会改变卡片间距，暂不参与。
      for (var mri = 0; mri < model.relations.length; mri++) {
        if (model.relations[mri].fromMethod || model.relations[mri].toMethod) return bail('method-endpoints')
      }

      // 只打包叶子层：任何一条边指向更后面的层都不碰。
      for (var ri = 0; ri < model.relations.length; ri++) {
        var rel = model.relations[ri]
        var fromBand = bandOf[rel.from]
        var toBand = bandOf[rel.to]
        if (fromBand === lastIndex && toBand !== undefined && toBand > lastIndex) return bail('not-leaf')
      }

      // 子节点归属：取同一层里出现次数最多的父节点（多父节点时只归到主父）。
      var parentScore = {}
      var parentOf = {}
      for (var rj = 0; rj < model.relations.length; rj++) {
        var rel2 = model.relations[rj]
        if (bandOf[rel2.to] !== lastIndex) continue
        var fromB = bandOf[rel2.from]
        if (fromB === undefined || fromB >= lastIndex) continue
        parentScore[rel2.to] = parentScore[rel2.to] || {}
        parentScore[rel2.to][rel2.from] = (parentScore[rel2.to][rel2.from] || 0) + 1
      }
      for (var bn2 = 0; bn2 < lastBand.nodes.length; bn2++) {
        var childId = lastBand.nodes[bn2].id
        var scores = parentScore[childId]
        if (!scores) continue
        var bestParent = null
        var bestScore = -1
        for (var pid in scores) {
          if (!Object.prototype.hasOwnProperty.call(scores, pid)) continue
          if (scores[pid] > bestScore) { bestScore = scores[pid]; bestParent = pid }
        }
        parentOf[childId] = bestParent
      }

      var groupMap = {}
      var groups = []
      for (var gn = 0; gn < lastBand.nodes.length; gn++) {
        var child = lastBand.nodes[gn]
        var parentId = parentOf[child.id] || null
        var key = parentId === null ? '\u0000root' : parentId
        var group = groupMap[key]
        if (!group) {
          group = { parent: parentId, nodes: [], center: child.cx }
          groupMap[key] = group
          groups.push(group)
        }
        group.nodes.push(child)
      }
      if (groups.length === 0) return bail('no-groups')
      var hasWideGroup = false
      for (var gi = 0; gi < groups.length; gi++) {
        if (groups[gi].nodes.length > 4) hasWideGroup = true
      }
      if (!hasWideGroup) return bail('no-wide-group')

      // 窄容器（对话内联/侧栏）优先纵横比：每行 1 个，形成竖向长图；
      // 宽画布（独立窗口/截图）每行 4 个，避免无谓变高。
      var maxPerRow = 4
      if (typeof viewportWidth === 'number' && viewportWidth > 0 && viewportWidth < 1500) maxPerRow = 1
      var gapX = Math.max(26, Math.min(44, Math.round((params.nodesep || 34) * 0.9)))
      var gapY = maxPerRow === 1 ? 96 : Math.max(64, Math.round((params.ranksep || 112) * 0.55))
      var groupGap = Math.max(64, Math.round(gapX * 2.2))
      var bandLeft = Infinity
      var bandRight = -Infinity
      for (var bnode = 0; bnode < lastBand.nodes.length; bnode++) {
        var lnode = lastBand.nodes[bnode].node
        bandLeft = Math.min(bandLeft, lnode.x)
        bandRight = Math.max(bandRight, lnode.x + lnode.w)
      }
      var oldBandWidth = bandRight - bandLeft

      // 组内按原布局 x 排序，保持 dagre 原本的左右顺序。
      for (var gsort = 0; gsort < groups.length; gsort++) {
        groups[gsort].nodes.sort(function (a, b) { return a.node.x - b.node.x || a.node.y - b.node.y })
        var parentNode = groups[gsort].parent !== null ? laid.nodes[groups[gsort].parent] : null
        groups[gsort].center = parentNode ? parentNode.x + parentNode.w / 2 : lastBand.nodes[0].node.x
      }
      groups.sort(function (a, b) { return a.center - b.center })

      for (var gl = 0; gl < groups.length; gl++) {
        var g = groups[gl]
        var rows = []
        for (var rstart = 0; rstart < g.nodes.length; rstart += maxPerRow) {
          var rowNodes = g.nodes.slice(rstart, rstart + maxPerRow)
          var rowWidth = 0
          var rowHeight = 0
          for (var rn = 0; rn < rowNodes.length; rn++) {
            rowWidth += rowNodes[rn].node.w + (rn > 0 ? gapX : 0)
            rowHeight = Math.max(rowHeight, rowNodes[rn].node.h)
          }
          rows.push({ nodes: rowNodes, width: rowWidth, height: rowHeight })
        }
        var gw = 0
        var gh = 0
        for (var rw = 0; rw < rows.length; rw++) {
          gw = Math.max(gw, rows[rw].width)
          gh += rows[rw].height + (rw > 0 ? gapY : 0)
        }
        g.rows = rows
        g.width = gw
        g.height = gh
      }

      // 组间排布：多组时优先整体变窄；组中心只决定顺序，不强制对齐父节点，
      // 否则父节点分散会把打包后的组重新拉成一条宽带。
      if (groups.length === 1) {
        groups[0].left = Math.max(PAD.x, groups[0].center - groups[0].width / 2)
      } else {
        var packedStart = PAD.x
        var groupCursor = packedStart
        for (var gpc = 0; gpc < groups.length; gpc++) {
          groups[gpc].left = groupCursor
          groupCursor += groups[gpc].width + groupGap
        }
      }
      var packedRight = -Infinity
      for (var pr = 0; pr < groups.length; pr++) packedRight = Math.max(packedRight, groups[pr].left + groups[pr].width)
      var packedWidth = packedRight - Math.min(bandLeft, groups[0].left)
      // 只有明显变窄、且能换来更多纵向空间时才替换；否则保留 dagre 原布局。
      if (packedWidth >= oldBandWidth * 0.92) return bail('not-narrower ' + Math.round(packedWidth) + '/' + Math.round(oldBandWidth))

      var yCursorBase = lastBand.top
      var packedBottom = yCursorBase
      for (var gy = 0; gy < groups.length; gy++) {
        var gg = groups[gy]
        var yCursor = yCursorBase
        for (var rowIndex = 0; rowIndex < gg.rows.length; rowIndex++) {
          var row = gg.rows[rowIndex]
          var rowLeft = gg.left + (gg.width - row.width) / 2
          var xCursor = rowLeft
          for (var cell = 0; cell < row.nodes.length; cell++) {
            var item = row.nodes[cell]
            item.node.x = xCursor
            item.node.y = yCursor + (row.height - item.node.h) / 2
            xCursor += item.node.w + gapX
          }
          yCursor += row.height + gapY
        }
        packedBottom = Math.max(packedBottom, yCursor)
      }

      // 父节点往往还停在旧宽图的远端。若同一横排的节点恰好都是这些组父节点，
      // 就把整排父节点按组顺序紧凑排开（而不是只逐個对齐组中心，避免互相碰撞后
      // 有一个父节点留在 3000px 外，把画布重新撑宽）。
      var parentGroups = []
      var parentSet = {}
      for (var pg = 0; pg < groups.length; pg++) {
        if (groups[pg].parent === null || !laid.nodes[groups[pg].parent]) continue
        parentGroups.push(groups[pg])
        parentSet[groups[pg].parent] = true
      }
      var parentBandPacked = false
      if (parentGroups.length > 1 && maxPerRow === 1) {
        var pAnchor = laid.nodes[parentGroups[0].parent]
        var sameRow = pAnchor !== null
        for (var ps = 1; ps < parentGroups.length; ps++) {
          var pNode = laid.nodes[parentGroups[ps].parent]
          if (!pNode || pAnchor === null || pNode.y >= pAnchor.y + pAnchor.h + 8 || pNode.y + pNode.h + 8 <= pAnchor.y) {
            sameRow = false
            break
          }
        }
        var cleanRow = sameRow
        if (sameRow) {
          for (var pn = 0; pn < ids.length; pn++) {
            if (parentSet[ids[pn]]) continue
            var pBox = laid.nodes[ids[pn]]
            if (!pBox) continue
            if (pAnchor !== null && pBox.y < pAnchor.y + pAnchor.h + 8 && pBox.y + pBox.h + 8 > pAnchor.y) {
              cleanRow = false
              break
            }
          }
        }
        if (cleanRow) {
          parentGroups.sort(function (a, b) { return a.left - b.left })
          var parentCursor = PAD.x
          for (var pc = 0; pc < parentGroups.length; pc++) {
            var pcNode = laid.nodes[parentGroups[pc].parent]
            pcNode.x = parentCursor
            parentCursor += pcNode.w + Math.max(28, gapX)
          }
          parentBandPacked = true
        }
      }

      // 单父节点/非整排父节点的兜底：逐个对齐到组中心，碰撞就保留原位。
      for (var pm = 0; pm < groups.length; pm++) {
        var pmGroup = groups[pm]
        if (pmGroup.parent === null) continue
        if (parentBandPacked === true && parentSet[pmGroup.parent]) continue
        var pmParent = laid.nodes[pmGroup.parent]
        if (!pmParent) continue
        var pmTargetX = pmGroup.left + pmGroup.width / 2 - pmParent.w / 2
        if (pmTargetX < PAD.x) pmTargetX = PAD.x
        if (Math.abs(pmTargetX - pmParent.x) < 1) continue
        var pmCollision = false
        for (var pmid = 0; pmid < ids.length; pmid++) {
          if (ids[pmid] === pmGroup.parent) continue
          var pmBox = laid.nodes[ids[pmid]]
          if (!pmBox) continue
          if (pmParent.y < pmBox.y + pmBox.h + 12 && pmParent.y + pmParent.h + 12 > pmBox.y
            && pmTargetX < pmBox.x + pmBox.w + 12 && pmTargetX + pmParent.w + 12 > pmBox.x) {
            pmCollision = true
            break
          }
        }
        if (!pmCollision) pmParent.x = pmTargetX
      }

      // 重新计算真实画布边界（打包后可能变窄、变高）。
      var maxRight = 0
      var maxBottom = 0
      for (var nb = 0; nb < ids.length; nb++) {
        var box = laid.nodes[ids[nb]]
        if (!box) continue
        maxRight = Math.max(maxRight, box.x + box.w)
        maxBottom = Math.max(maxBottom, box.y + box.h)
      }
      var oldWidth = laid.width
      var oldHeight = laid.height
      laid.width = Math.max(1, maxRight + PAD.x)
      laid.height = Math.max(1, maxBottom + PAD.y)
      return {
        applied: true,
        bandNodes: lastBand.nodes.length,
        groups: groups.length,
        groupInfo: groups.map(function (g) {
          return {
            parent: g.parent,
            nodes: g.nodes.map(function (x) { return x.id }),
            rows: g.rows.map(function (r) { return r.nodes.map(function (x) { return x.id }) }),
            left: g.left,
            width: g.width,
          }
        }),
        portrait: maxPerRow === 1,
        rows: groups.reduce(function (n, x) { return n + x.rows.length }, 0),
        oldWidth: oldWidth,
        oldHeight: oldHeight,
        width: laid.width,
        height: laid.height,
      }
    }

    function runLayout(realSizes, withEdges, viewportWidth) {
      var rT0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
      var sizes = sizesFor(realSizes)
      var groups = buildGroups(model)
      var laid = dagreLayout(model.entities, groups, sizes, layoutParams)

      /**
       * 卡片摆放候选：dagre 默认只做分层/交叉最小化，不直接优化连线总长；
       * 对同一张图试几种 ranker / 间距，用“连线曼哈顿总长 + 画布尺寸”做代理评分，
       * 选更紧凑的布局，再进入正式布线。
       */
      var layoutCandidates = [
        {},
        { ranksep: 88, nodesep: 40 },
        { ranksep: 96, nodesep: 34, ranker: 'tight-tree' },
        { ranksep: 112, nodesep: 34, ranker: 'longest-path' },
        { edgeLabels: false },
        { edgeLabels: false, ranksep: 88, nodesep: 40 },
        { edgeLabels: false, ranksep: 96, nodesep: 34, ranker: 'tight-tree' },
        { edgeLabels: false, ranksep: 88, nodesep: 40, compactDashed: true },
        { edgeLabels: false, ranksep: 96, nodesep: 34, ranker: 'tight-tree', compactDashed: true },
      ]
      function proxyScore(layout) {
        var total = 0
        for (var gi = 0; gi < groups.length; gi++) {
          var grp = groups[gi]
          var a = layout.nodes[grp.from]
          var b = layout.nodes[grp.to]
          if (!a || !b) continue
          total += Math.abs((a.x + a.w / 2) - (b.x + b.w / 2))
            + Math.abs((a.y + a.h / 2) - (b.y + b.h / 2))
        }
        return total + (layout.width + layout.height) * 0.05
      }
      var bestScore = proxyScore(laid)
      for (var lc = 0; lc < layoutCandidates.length; lc++) {
        var overrides = layoutCandidates[lc]
        var params = {}
        for (var lk in layoutParams) {
          if (Object.prototype.hasOwnProperty.call(layoutParams, lk)) params[lk] = layoutParams[lk]
        }
        for (var ok in overrides) {
          if (Object.prototype.hasOwnProperty.call(overrides, ok)) params[ok] = overrides[ok]
        }
        var altLayout = null
        try {
          altLayout = dagreLayout(model.entities, groups, sizes, params)
        } catch (e) {
          // 某些 ranker/间距组合在极端图上会让 dagre 求交点失败；跳过该候选即可。
          continue
        }
        var sc = proxyScore(altLayout)
        if (sc + 0.5 < bestScore) { bestScore = sc; laid = altLayout }
      }

      var packInfo = null
      if (withEdges !== false) {
        var packT0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
        global.__EHM_PACK_REASON__ = undefined
        var wantPortraitInline = false
        try {
          wantPortraitInline = String(global.location && global.location.hash ? global.location.hash : '').indexOf('ehm-portrait') >= 0
        } catch (ignoreInlineHashError) {}
        packInfo = wantPortraitInline || (typeof viewportWidth === 'number' && viewportWidth > 0 && viewportWidth < 1500)
          ? transposeRankBands(laid, layoutParams, viewportWidth)
          : null
        if (packInfo === null) packInfo = packLeafFanout(laid, layoutParams, viewportWidth)
        if (packInfo === null) packInfo = { applied: false, reason: global.__EHM_PACK_REASON__ || 'unknown' }
        // 行转列后主方向变成水平：端口、正交走线和分道都要同步切到左右进出，
        // 否则卡片已经横排，线还从底边出/顶边进，端点会拧着。
        CURRENT_EDGE_AXIS = packInfo.mode === 'transpose' ? 'h' : (layoutParams.rankdir === 'TB' ? 'v' : 'h')
        CURRENT_EDGE_AXIS_AUTO = packInfo.mode === 'transpose'
        if (packInfo.applied === true && packInfo.portrait === true) laid.fanoutGroups = packInfo.groupInfo
        prof('runLayout:edges:fanoutPack', packT0)
      }

      var cards = []
      var entityLayout = {}
      for (var i = 0; i < model.entities.length; i++) {
        var ent = model.entities[i]
        var nd = laid.nodes[ent.id]
        if (nd) cards.push(nd)
        // 成员行在卡片内的相对几何：方法级端口要用它算绝对 y
        entityLayout[ent.id] = measureCard(ent, state.methodsCollapsed)
      }
      prof('runLayout' + (withEdges === false ? ':cards' : ':edges') + ':layout', rT0)
      var eT0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
      var edges = withEdges === false ? [] : computeEdges(model, laid, model.entities, entityLayout)
      prof('runLayout' + (withEdges === false ? ':cards' : ':edges') + ':edges', eT0)
      return { laid: laid, cards: cards, edges: edges, sizes: sizes, entityLayout: entityLayout, fanoutPack: packInfo }
    }

    /**
     * 绘制。
     *
     * @param {object} layout  runLayout() 的结果
     * @param {boolean} withWires 是否画线
     * @param {boolean} measureMode
     *   **量尺寸专用**：卡片宽度改成 auto + min/max-width，
     *   让浏览器按内容自然撑开，这样第一次 paint 之后 offsetWidth
     *   拿到的才是「真实需要的宽度」，而不是上一轮估算值。
     *   （不做这一步，两遍布局会退化成「量估算值 → 用估算值」，白跑一遍。）
     */
    function paint(layout, withWires, measureMode) {
      var contentW = layout.laid.width
      var contentH = layout.laid.height
      content.replaceChildren()
      content.style.width = contentW + 'px'
      content.style.height = contentH + 'px'

      if (withWires) {
        var wT0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
        var wireSvg = svg('svg', { class: 'ehm-wires', width: contentW, height: contentH })
        content.append(wireSvg)
        drawWires(wireSvg, layout)
        prof('paint.drawWires', wT0)
      }

      var cT0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
      for (var i = 0; i < model.entities.length; i++) {
        var ent = model.entities[i]
        var box = layout.laid.nodes[ent.id]
        if (!box) continue
        var card = buildCard(ent, box, layout, measureMode === true)
        content.append(card)
      }
      prof('paint.cards', cT0)
    }

    function buildCard(ent, box, layout, measureMode) {
      var measured = measureCard(ent, state.methodsCollapsed)
      // measureMode 下让内容决定宽度（auto + 上下限），否则用布局给的最終宽度
      var widthStyle = measureMode === true
        ? 'width:auto; min-width:' + G.MIN_W + 'px; max-width:' + Math.ceil(box.w * 1.6) + 'px;'
        : 'width:' + box.w + 'px;'
      var card = el('div', {
        class: 'ehm-card ' + paletteOf(ent.kind) + (state.methodsCollapsed ? ' is-collapsed' : '') + (measureMode === true ? ' ehm-measuring' : ''),
        'data-ehm-card': ent.id,
        style: 'left:' + box.x + 'px; top:' + box.y + 'px; ' + widthStyle,
      })
      card.__ehm = { ent: ent, box: box, measured: measured }
      card.setAttribute('data-ehm-kind', ent.kind)

      var head = el('div', { class: 'ehm-head', style: 'height:' + measured.headH + 'px' })
      head.append(el('div', { class: 'ehm-name-row' }, [
        el('span', { class: 'ehm-name', text: ent.name, title: ent.name }),
      ]))
      if (ent.stereotype !== undefined && ent.stereotype !== '') {
        head.append(el('div', { class: 'ehm-stereo', text: '«' + ent.stereotype + '»' }))
      }
      if (ent.summary !== undefined && ent.summary !== '') {
        var summaryEl = el('div', {
          class: 'ehm-summary' + (measured.summaryLines > 1 ? ' is-two-line' : ''),
          text: ent.summary,
          title: ent.summary,
        })
        head.append(summaryEl)
      }
      head.addEventListener('mousedown', function (e) { if (!e.altKey) e.stopPropagation() })
      bindTarget(head, function () {
        return jumpTargetForEntity(ent)
      }, 'entity:' + ent.id, function () { return entityEvidence(ent) })
      card.append(head)

      card.append(makeCompartment(measured.fieldRows, measured.fieldBlockH, 'fields', ent))
      card.append(makeCompartment(measured.methodRows, measured.methodBlockH, 'methods', ent))
      if (state.methodsCollapsed && ent.methods.length > 0) {
        var more = el('div', { class: 'ehm-row ehm-row-more', style: 'height:' + G.ROW_H + 'px' })
        more.append(el('span', { class: 'ehm-row-text', text: '« ' + ent.methods.length + ' 个方法已折叠 »' }))
        card.append(more)
      }
      // 卡片空白区单击 = 选中整个类/实体并固定代码框（head/行自己的 click 已 stopPropagation）。
      card.addEventListener('click', function (e) {
        if (altHeld || e.altKey) { releaseBubble(); return }
        if (draggedRecently()) return
        e.stopPropagation()
        var target = jumpTargetForEntity(ent)
        var spec = bubbleSpecFor(entityEvidence(ent), target)
        if (spec === null) return
        markSelection(card, 'entity:' + ent.id)
        showHoverBubble(spec, card.getBoundingClientRect(), e.clientX, e.clientY, 'entity:' + ent.id, cardScreenRects(null), card.getBoundingClientRect(), true, e.altKey)
      })
      return card

      function makeCompartment(rows, height, kind, entity) {
        var comp = el('div', { class: 'ehm-compartment ehm-' + kind })
        if (rows.length === 0) { comp.style.display = 'none'; return comp }
        comp.style.height = height + 'px'
        for (var i = 0; i < rows.length; i++) {
          // 用 IIFE 把当前 row 绑进闭包：`var` 是函数作用域，直接闭包会让所有行
          // 都指向最后一行 —— 表现为「悬停任意方法行都显示最后一个方法的代码」。
          (function (row) {
            var rowEl = el('div', {
              class: 'ehm-row ehm-' + kind + '-row' + (row.member.abstract ? ' is-abstract' : ''),
              'data-ehm-row': entity.id + '#' + kind + '#' + row.index,
              style: 'height:' + G.ROW_H + 'px',
            })
            rowEl.append(el('span', { class: 'ehm-row-text', text: row.text, title: row.text }))
            rowEl.addEventListener('mousedown', function (e) { if (!e.altKey) e.stopPropagation() })
            bindTarget(rowEl, function () { return jumpTargetForMember(entity, row) }, null, function () {
              return memberEvidence(row.member) || entityEvidence(entity)
            }, function () {
              // 气泡 header：声明行（含 + - # ~ 可见性）+ 方法/字段含义（IR member.summary，P13）
              return {
                declaration: row.text,
                summary: typeof row.member.summary === 'string' ? row.member.summary : '',
              }
            })
            comp.append(rowEl)
          })(rows[i])
        }
        return comp
      }
    }

    function drawWires(wireSvg, layout) {
      var edges = layout.edges
      var labels = []
      var i

      for (i = 0; i < edges.length; i++) {
        var edge = edges[i]
        if (!edge.points || edge.points.length < 2) continue
        var d = edge.points.map(function (p, idx) {
          return (idx === 0 ? 'M ' : 'L ') + round1(p[0]) + ' ' + round1(p[1])
        }).join(' ')
        var g = svg('g', {
          class: 'ehm-wire' + (isInheritLike(edge.rel.kind) ? ' ehm-wire-inherit' : '') + ' ehm-rel-' + String(edge.rel.kind || 'call'),
          'data-ehm-wire': edge.rel.id,
          'data-ehm-rel-kind': edge.rel.kind || 'call',
        })
        g.append(svg('path', {
          d: d,
          fill: 'none',
          stroke: edgeStrokeVar(edge.rel.kind),
          'stroke-width': 1.35,
          'stroke-dasharray': edgeDash(edge.rel.kind),
          class: 'ehm-wire-line',
        }))
        // 起点端口：小方块明确「这条线从哪里出发」，终点仍由箭头帽表示。
        // 两者配合解决密集图里“线到底连到哪一端”的歧义。
        var first = edge.points[0]
        g.append(svg('rect', {
          x: round1(first[0] - 2.2),
          y: round1(first[1] - 2.2),
          width: 4.4,
          height: 4.4,
          class: 'ehm-port',
          stroke: edgeStrokeVar(edge.rel.kind),
        }))
        var last = edge.points[edge.points.length - 1]
        var prev = edge.points[edge.points.length - 2]
        // 终点也画端口标记：虚线可能正好在箭头前落进 dash 空隙，
        // 端口小方块保证“箭头—线—卡片”在视觉上始终连在一起。
        g.append(svg('rect', {
          x: round1(last[0] - 2.2),
          y: round1(last[1] - 2.2),
          width: 4.4,
          height: 4.4,
          class: 'ehm-port',
          stroke: edgeStrokeVar(edge.rel.kind),
        }))
        // 虚线在端口前可能正好落在 dash 空隙里，视觉上箭头会和线断开；
        // 在箭头前补一小段实线，保证箭头始终和线/卡片连上。
        var sdx = last[0] - prev[0]
        var sdy = last[1] - prev[1]
        var slen = Math.sqrt(sdx * sdx + sdy * sdy) || 1
        var stubLen = Math.min(24, slen)
        g.append(svg('line', {
          x1: round1(last[0] - sdx / slen * stubLen),
          y1: round1(last[1] - sdy / slen * stubLen),
          x2: round1(last[0]),
          y2: round1(last[1]),
          stroke: edgeStrokeVar(edge.rel.kind),
          'stroke-width': 1.35,
          class: 'ehm-wire-stub',
        }))
        g.append(arrowHead(prev, last, edge.rel.kind))
        wireSvg.append(g)
        edge.g = g
      }

      // 标签：每个 class-pair 组只放一个（同一组共用一条线）
      for (i = 0; i < edges.length; i++) {
        var e2 = edges[i]
        if (!e2.isGroupLead) continue
        var text = e2.group.label
        if (!text) continue
        var anchor = pickLabelAnchor({ points: e2.points, labelPos: e2.labelPos }, labelWidthOf(text))
        if (anchor === null) continue
        labels.push({ edge: e2, text: text, x: anchor.x, y: anchor.y, anchorKind: anchor.kind })
      }
      var lpT0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
      placeLabels(labels, edges, layout.cards, layout.laid.width, layout.laid.height)
      prof('drawWires.placeLabels', lpT0)

      for (i = 0; i < labels.length; i++) {
        var lb = labels[i]
        var gL = svg('g', {
          class: 'ehm-label',
          'data-ehm-label': lb.edge.rel.id,
        })
        gL.append(svg('rect', {
          x: round1(lb.x - lb.w / 2),
          y: round1(lb.y - lb.h / 2),
          width: round1(lb.w),
          height: round1(lb.h),
          rx: 0,
          class: 'ehm-label-bg',
        }))
        var tEl = svg('text', {
          x: round1(lb.x),
          y: round1(lb.y + 3.4),
          'text-anchor': 'middle',
          class: 'ehm-label-text',
        })
        tEl.textContent = lb.text
        gL.append(tEl)
        wireSvg.append(gL)
        lb.g = gL
        lb.edge.labelLayout = lb
        lb.rect = { left: lb.x - lb.w / 2, top: lb.y - lb.h / 2, right: lb.x + lb.w / 2, bottom: lb.y + lb.h / 2 }
      }

      state.labels = labels
      installWireHitTest(wireSvg, edges, labels)
    }

    /* ---------- 命中测试（几何，唯一最近 → 不闪） ---------- */

    function installWireHitTest(wireSvg, edges, labels) {
      var HIT_RADIUS = 7
      var current = null
      var lastRun = 0

      function distSqToSegment(px, py, ax, ay, bx, by) {
        var dx = bx - ax
        var dy = by - ay
        var lenSq = dx * dx + dy * dy
        if (lenSq < 1e-6) {
          var ddx0 = px - ax
          var ddy0 = py - ay
          return ddx0 * ddx0 + ddy0 * ddy0
        }
        var t = ((px - ax) * dx + (py - ay) * dy) / lenSq
        t = Math.max(0, Math.min(1, t))
        var cx = ax + t * dx
        var cy = ay + t * dy
        var ddx = px - cx
        var ddy = py - cy
        return ddx * ddx + ddy * ddy
      }

      function toScene(clientX, clientY) {
        var rect = content.getBoundingClientRect()
        var k = state.view.k || 1
        return [(clientX - rect.left) / k, (clientY - rect.top) / k]
      }

      function nearestAt(x, y) {
        for (var i = 0; i < labels.length; i++) {
          var lb = labels[i]
          if (x >= lb.rect.left && x <= lb.rect.right && y >= lb.rect.top && y <= lb.rect.bottom) {
            return lb.edge
          }
        }
        var best = null
        var bestD = HIT_RADIUS * HIT_RADIUS
        for (var e = 0; e < edges.length; e++) {
          var pts = edges[e].points
          if (!pts) continue
          for (var j = 0; j < pts.length - 1; j++) {
            var d = distSqToSegment(x, y, pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1])
            if (d < bestD) { bestD = d; best = edges[e] }
          }
        }
        return best
      }

      function clearHot() {
        if (current === null) return
        if (current.g) current.g.classList.remove('hot')
        for (var i = 0; i < labels.length; i++) {
          if (labels[i].edge === current && labels[i].g) labels[i].g.classList.remove('hot')
        }
        current = null
        stage.classList.remove('ehm-wire-hover')
      }

      /**
       * 连线/标签悬停的 owner 区域：**以鼠标点为中心的小矩形**（±7px），
       * 不再用整条 `<g>` 的 bbox —— 一条关系横跨大半个画布，用它当 owner 会把气泡推到天边
       * （这正是「气泡不在鼠标附近」的根因之一）。
       * 若鼠标正压在标签上，再把标签矩形并进来：标签就是被悬停的元素，不能被盖住。
       */
      function wireOwnerRect(clientX, clientY) {
        var out = { left: clientX - 7, top: clientY - 7, right: clientX + 7, bottom: clientY + 7 }
        var sc = toScene(clientX, clientY)
        for (var i = 0; i < labels.length; i++) {
          var lb = labels[i]
          if (!lb.rect) continue
          if (sc[0] < lb.rect.left || sc[0] > lb.rect.right || sc[1] < lb.rect.top || sc[1] > lb.rect.bottom) continue
          var cr = content.getBoundingClientRect()
          var k = state.view.k || 1
          out.left = Math.min(out.left, cr.left + lb.rect.left * k)
          out.top = Math.min(out.top, cr.top + lb.rect.top * k)
          out.right = Math.max(out.right, cr.left + lb.rect.right * k)
          out.bottom = Math.max(out.bottom, cr.top + lb.rect.bottom * k)
          break
        }
        return out
      }

      function applyHit(hit, clientX, clientY) {
        if (altHeld) { clearHot(); releaseBubble(); return }
        if (hit === current) {
          if (hit === null) return
          positionBubbleIfHover(clientX, clientY)
          return
        }
        clearHot()
        current = hit
        if (hit === null) { hideBubble(); return }
        if (hit.g) hit.g.classList.add('hot')
        for (var i = 0; i < labels.length; i++) {
          if (labels[i].edge === hit && labels[i].g) labels[i].g.classList.add('hot')
        }
        stage.classList.add('ehm-wire-hover')
        var ev = hit.rel.evidence
        showHoverBubble({
          title: hit.rel.label || (hit.rel.from + ' → ' + hit.rel.to),
          subtitle: ev ? ev.file + ':' + ev.from + '–' + ev.to : ('关系 ' + hit.rel.id),
          code: ev ? ev.code : '',
          firstLine: ev && ev.from ? ev.from : 1,
          target: jumpTargetForRelation(hit.rel),
        }, wireOwnerRect(clientX, clientY), clientX, clientY, 'rel:' + hit.rel.id, cardScreenRects(null), null, false, false)
      }

      stage.addEventListener('pointermove', function (e) {
        // Alt 是画布平移/缩放修饰键：按住期间悬停线条也不出代码框。
        if (altHeld || e.altKey) { clearHot(); releaseBubble(); return }
        var now = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
        if (lastRun !== 0 && now - lastRun < 8) return
        lastRun = now
        var overCard = e.target && e.target.closest ? e.target.closest('.ehm-card') : null
        if (overCard) { clearHot(); return }
        var xy = toScene(e.clientX, e.clientY)
        applyHit(nearestAt(xy[0], xy[1]), e.clientX, e.clientY)
      }, { passive: true })

      stage.addEventListener('pointerleave', function () { clearHot(); hideBubble() })

      // 单击连线/标签 = 选中该关系 + 固定代码框（双击才跳转）
      stage.addEventListener('click', function (e) {
        if (e.altKey || draggedRecently()) return
        var overCard = e.target && e.target.closest ? e.target.closest('.ehm-card') : null
        if (overCard) return
        var xy = toScene(e.clientX, e.clientY)
        var hit = nearestAt(xy[0], xy[1])
        if (hit === null) return
        e.stopPropagation()
        applyHit(hit, e.clientX, e.clientY)
        if (bubbleEl.classList.contains('show')) {
          markSelection(hit.g, 'rel:' + hit.rel.id)
          lockBubble()
        }
      })

      stage.addEventListener('dblclick', function (e) {
        var overCard = e.target && e.target.closest ? e.target.closest('.ehm-card') : null
        if (overCard) return
        var xy = toScene(e.clientX, e.clientY)
        var hit = nearestAt(xy[0], xy[1])
        if (hit === null) return
        e.stopPropagation()
        if (hit.g) hit.g.getBoundingClientRect()
        onJump(jumpTargetForRelationMethod(hit.rel))
      })
    }

    /* ---------- 气泡 ---------- */

    function entityEvidence(ent) {
      return ent.evidence || {
        file: ent.location.file,
        from: ent.location.line,
        to: ent.location.line,
        code: '// 该实体在 IR 里没有 evidence.snippet（可用 onJump 跳到 ' + ent.location.file + ':' + ent.location.line + '）',
      }
    }

    function memberEvidence(member) {
      return member.evidence
    }

    /**
     * 统一悬停入口：卡片/成员、连线/标签都走这里。
     * Alt、locked、空 spec、取消旧宽限这些横切规则只在这一处判断；
     * 命中检测仍分开做（DOM mouseenter vs SVG nearestAt），因为两者对象模型不同。
     */
    function showHoverBubble(spec, ownerScreenRect, mouseX, mouseY, key, obstacleRects, ownerCardRect, pin, altKey) {
      if (altHeld || altKey === true) { releaseBubble(); return false }
      if (bubble.state === 'locked' && pin !== true) return false
      if (!spec || (!spec.code && !spec.title)) return false
      cancelHoverHold()
      showBubble(spec, ownerScreenRect, mouseX, mouseY, key, obstacleRects, ownerCardRect, pin)
      return true
    }

    function showBubble(spec, ownerScreenRect, mouseX, mouseY, key, obstacleRects, ownerCardRect, pin) {
      if (bubble.state === 'locked' && pin !== true) return
      if (!spec || (!spec.code && !spec.title)) return
      // 新内容 / 新 owner：取消上一个 hover 的关闭宽限，避免旧定时器把新气泡关掉
      cancelHoverHold()
      // header：第一行 = 标题（成员悬停时是带可见性的声明行）+ file:line；
      // 有含义（member.summary）时补一行 muted 小字，没有就完全不占空间。
      var head = el('div', { class: 'ehm-bubble-head' })
      head.append(el('div', { class: 'ehm-bubble-head-row' }, [
        el('span', { class: 'ehm-bubble-title', text: spec.title || '', title: spec.title || '' }),
        el('span', { class: 'ehm-bubble-sub', text: spec.subtitle || '', title: spec.subtitle || '' }),
      ]))
      if (spec.summary) {
        head.append(el('div', { class: 'ehm-bubble-summary', text: spec.summary, title: spec.summary }))
      }
      var scroll = el('div', { class: 'ehm-bubble-scroll' })
      scroll.append(renderCodeBlock(spec.code || '// (无代码)', spec.firstLine || 1))
      bubbleEl.replaceChildren(head, scroll)
      bubbleEl.classList.add('show')
      bubbleEl.classList.remove('locked')
      fitBubbleWidth(scroll, spec)

      bubble.ownerRect = ownerScreenRect || null
      // owner 所在的整张卡片（只有实体/字段/方法行悬停才有）：仅用于「卡片外侧」兜底候选，
      // 不参与硬约束 —— 硬约束只有一个：不盖住 ownerRect（被悬停的那一行/那段连线）。
      bubble.ownerCardRect = ownerCardRect || null
      bubble.key = key || null
      bubble.spec = spec
      bubble.obstacles = obstacleRects || []
      if (isFinite(mouseX) && isFinite(mouseY)) { bubble.pointer.x = mouseX; bubble.pointer.y = mouseY }

      bubble.state = 'hover'
      positionBubble()
      scroll.scrollTop = 0
      if (pin === true) lockBubble()
    }

    function fitBubbleWidth(scroll, spec) {
      // 宽度 = 最长代码行需要的宽度。注意必须量「代码文本本身」的 scrollWidth：
      // `.ehm-code-line` 是块级 flex，会撑满滚动容器，直接量它等于量容器宽度，
      // 会让气泡每显示一次就变宽 ~80px（历史 bug：连续 hover 几个元素后气泡撑满屏幕）。
      var maxLine = 0
      var lines = scroll.querySelectorAll('.ehm-code-line')
      for (var i = 0; i < lines.length; i++) {
        var src = lines[i].querySelector('.ehm-src')
        if (!src) continue
        // 44px 行号列 + 18px 代码右侧留白 + 文本宽度
        maxLine = Math.max(maxLine, src.scrollWidth + 44 + 18)
      }
      var wanted = Math.ceil(maxLine + 46 + 22 + 12)
      var maxW = Math.max(320, (global.innerWidth || 1200) - 40)
      bubbleEl.style.width = Math.min(maxW, Math.max(320, wanted)) + 'px'
      bubbleEl.classList.toggle('h-overflow', wanted > maxW)
      bubble.naturalHeight = 0
      bubbleEl.style.maxHeight = ''
      bubble.naturalHeight = bubbleEl.offsetHeight || 240
      bubble.wantedWidth = Math.min(maxW, Math.max(320, wanted))
      if (spec) bubble.spec = spec
    }

    /* ---------- 气泡定位（回归 v14 设计：鼠标优先 + owner 禁入） ---------- */

    /**
     * 气泡定位 —— **鼠标优先 + owner 禁入**。
     *
     * 旧实现为了「不压任何卡片」会撒 64px 全视口网格；密集图里只要远处有一个空白格子，
     * 就会压过鼠标旁 20px 的候选，表现为气泡突然飞到屏幕别处。现在只枚举**局部候选**：
     *   1. **硬约束**：气泡矩形绝不与 ownerRect 相交（实体头 / 字段行 / 方法行 / 连线局部锚点；
     *      标签命中时并入标签矩形），被悬停/点击的对象永远可见。
     *   2. 候选先 clamp 进视口，然后在「不压 owner」的候选里按
     *      `鼠标距离 + 卡片重叠惩罚(最多36px) + owner 卡重叠惩罚(8px)` 打分。
     *      其他卡片只做轻微惩罚，绝不为了避开它们把气泡推到远处。
     *   3. 只有全部候选都压 owner（owner 比视口还大 / 视口极小）时，才取 owner 重叠面积最小者。
     *
     * 候选方位：
     *   · 鼠标四向：右下 / 左下 / 右上 / 左上（offset 18px）—— 默认锚点，保证贴近鼠标；
     *   · owner 右/左（纵向对齐鼠标）、owner 下/上（横向对齐鼠标）、owner 四角；
     *   · owner 在卡片内时补「整卡外侧」候选，优先让气泡离开整张卡，但不远处也不强求。
     *
     * 高度：用自然高度（fitBubbleWidth 量过），只受视口高度限制；超出时内部滚动。
     */
    function positionBubble() {
      var owner = bubble.ownerRect
      var ownerCard = bubble.ownerCardRect
      var pointer = bubble.pointer
      var vw = global.innerWidth || 1200
      var vh = global.innerHeight || 800
      var pad = 8
      var offset = 18

      var bw = Math.min(bubble.wantedWidth || bubbleEl.offsetWidth || 420, Math.max(200, vw - pad * 2))
      bubbleEl.style.width = bw + 'px'

      // 自然高度 + 视口上限：maxHeight = min(naturalHeight, 视口高 - 16)，超出内部滚动
      var wantH = bubble.naturalHeight || bubbleEl.offsetHeight || 240
      var maxH = Math.max(48, Math.min(wantH, vh - pad * 2))
      bubbleEl.style.maxHeight = Math.round(maxH) + 'px'
      var bh = Math.max(32, Math.min(maxH, bubbleEl.offsetHeight || maxH))

      function clamp(l, t) {
        return [
          Math.max(pad, Math.min(vw - bw - pad, l)),
          Math.max(pad, Math.min(vh - bh - pad, t)),
        ]
      }
      function mouseDistance(l, t) {
        var dx = Math.max(l - pointer.x, 0, pointer.x - (l + bw))
        var dy = Math.max(t - pointer.y, 0, pointer.y - (t + bh))
        return Math.sqrt(dx * dx + dy * dy)
      }

      /*
       * 只使用「鼠标附近 / owner 外侧」的局部候选。
       *
       * 旧实现为了同时满足「不压任何卡片」会在全视口撒 64px 网格：只要远处有一个
       * 完全空白的格子，就会压过鼠标 20px 旁的候选 —— 这正是用户看到的
       * 「气泡跑到别的地方」。现在不再找远方空白：先保证不盖 owner，再在局部
       * 候选里优先贴近鼠标；其他卡片只作为轻微惩罚，不会把气泡推到远处。
       */
      var raw = []
      function add(l, t, tag) { raw.push({ l: l, t: t, tag: tag }) }

      // 鼠标四向：最近的一圈，优先贴指针
      add(pointer.x + offset, pointer.y + offset, 'mouse-br')
      add(pointer.x - bw - offset, pointer.y + offset, 'mouse-bl')
      add(pointer.x + offset, pointer.y - bh - offset, 'mouse-tr')
      add(pointer.x - bw - offset, pointer.y - bh - offset, 'mouse-tl')

      if (owner) {
        // owner 外侧：贴住被悬停/点击的元素，而不是贴整张卡
        add(owner.right + offset, pointer.y - bh / 2, 'owner-right')
        add(owner.left - bw - offset, pointer.y - bh / 2, 'owner-left')
        add(pointer.x - bw / 2, owner.bottom + offset, 'owner-below')
        add(pointer.x - bw / 2, owner.top - bh - offset, 'owner-above')
        // owner 四角，窄高卡片/宽气泡时更实用
        add(owner.right + offset, owner.top - bh - offset, 'owner-corner-tr')
        add(owner.left - bw - offset, owner.top - bh - offset, 'owner-corner-tl')
        add(owner.right + offset, owner.bottom + offset, 'owner-corner-br')
        add(owner.left - bw - offset, owner.bottom + offset, 'owner-corner-bl')
      }
      if (ownerCard) {
        // owner 在卡片内部时，卡片外侧仍是局部兜底
        add(pointer.x - bw / 2, ownerCard.bottom + offset, 'card-below')
        add(pointer.x - bw / 2, ownerCard.top - bh - offset, 'card-above')
        add(ownerCard.right + offset, pointer.y - bh / 2, 'card-right')
        add(ownerCard.left - bw - offset, pointer.y - bh / 2, 'card-left')
      }

      var obstacles = bubble.obstacles || []
      var bestFree = null
      var bestBlocked = null
      for (var i = 0; i < raw.length; i++) {
        var xy = clamp(raw[i].l, raw[i].t)
        var left = xy[0]
        var top = xy[1]
        // 不把鼠标点盖在气泡里
        if (pointer.x >= left && pointer.x <= left + bw && pointer.y >= top && pointer.y <= top + bh) continue
        var ownerOverlap = owner ? overlapArea(left, top, bw, bh, [owner]) : 0
        var cardOverlap = overlapArea(left, top, bw, bh, obstacles)
        var mouseDist = mouseDistance(left, top)
        var cand = {
          left: left,
          top: top,
          tag: raw[i].tag,
          ownerOverlap: ownerOverlap,
          cardOverlap: cardOverlap,
          mouseDist: mouseDist,
          // 先贴鼠标；完全不压卡片的候选有最多 36px 的优先权（不会因此跑到远处）
          score: mouseDist + (cardOverlap > 0 ? 36 : 0) + (ownerCard && intersectsRect(left, top, bw, bh, ownerCard) ? 8 : 0),
        }
        if (ownerOverlap === 0 && (bestFree === null || cand.score < bestFree.score)) bestFree = cand
        if (bestBlocked === null || ownerOverlap < bestBlocked.ownerOverlap
          || (ownerOverlap === bestBlocked.ownerOverlap && cand.score < bestBlocked.score)) {
          bestBlocked = cand
        }
      }

      var best = bestFree !== null ? bestFree : bestBlocked
      if (best === null) {
        var fallback = clamp(pointer.x + offset, pointer.y + offset)
        best = { left: fallback[0], top: fallback[1], tag: 'fallback', ownerOverlap: 0, cardOverlap: 0, mouseDist: 0 }
      }

      bubbleEl.style.left = Math.round(best.left) + 'px'
      bubbleEl.style.top = Math.round(best.top) + 'px'
      bubble.lastPlacement = {
        left: best.left,
        top: best.top,
        width: bw,
        height: bh,
        maxHeight: maxH,
        tag: best.tag,
        ownerOverlap: best.ownerOverlap,
        cardOverlap: best.cardOverlap,
        mouseDist: best.mouseDist,
        hadFreeCandidate: bestFree !== null,
      }
    }

    /** 气泡矩形与屏幕矩形是否相交（边贴边不算，与 overlapArea=0 等价）。 */
    function intersectsRect(l, t, w, h, r) {
      if (!r) return false
      return !(l + w <= r.left || l >= r.right || t + h <= r.top || t >= r.bottom)
    }

    /** 气泡矩形与一组屏幕矩形的重叠总面积（px²）。 */
    function overlapArea(l, t, w, h, rects) {
      var total = 0
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i]
        if (!r) continue
        var ox = Math.max(0, Math.min(l + w, r.right) - Math.max(l, r.left))
        var oy = Math.max(0, Math.min(t + h, r.bottom) - Math.max(t, r.top))
        total += ox * oy
      }
      return total
    }

    function positionBubbleIfHover(clientX, clientY) {
      if (bubble.state !== 'hover') return
      if (isFinite(clientX)) { bubble.pointer.x = clientX; bubble.pointer.y = clientY }
      positionBubble()
    }

    /* ---------- hover 气泡：纯展示，不接收任何操作 ---------- */

    /** 取消「离开 owner 的关闭宽限」。 */
    function cancelHoverHold() {
      if (hoverHoldTimer !== null) {
        clearTimeout(hoverHoldTimer)
        hoverHoldTimer = null
      }
      bubble.hoverHold = false
    }

    /**
     * 鼠标离开被悬停元素：只做短暂延迟关闭，避免在相邻成员行之间移动时闪烁。
     * hover 气泡是纯展示层（pointer-events:none）：不接收滚轮、不能选中/复制；
     * 要滚动代码必须单击锁定气泡。
     */
    function beginHoverHold() {
      if (bubble.state !== 'hover') return
      if (bubble.hoverHold) return
      bubble.hoverHold = true
      if (hoverHoldTimer !== null) clearTimeout(hoverHoldTimer)
      hoverHoldTimer = setTimeout(function () {
        hoverHoldTimer = null
        if (bubble.state !== 'hover') return
        cancelHoverHold()
        hideBubble()
      }, HOVER_HOLD_MS)
    }

    function hideBubble() {
      if (bubble.state === 'locked') return
      releaseBubble()
    }

    function releaseBubble() {
      bubble.state = 'none'
      bubble.key = null
      bubble.ownerRect = null
      bubble.ownerCardRect = null
      cancelHoverHold()
      bubbleEl.classList.remove('show')
      bubbleEl.classList.remove('locked')
      bubbleEl.classList.remove('h-overflow')
    }

    function lockBubble() {
      if (!bubbleEl.classList.contains('show')) return
      if (bubble.state === 'locked') return
      // 锁定后位置/内容冻结，不再需要 hover 保持
      cancelHoverHold()
      bubble.state = 'locked'
      bubbleEl.classList.add('locked')
    }

    /* hover 气泡只跟随鼠标；不冻结、不接收滚轮/选中。 */
    document.addEventListener('mousemove', function (e) {
      bubble.pointer.x = e.clientX
      bubble.pointer.y = e.clientY
      if (bubble.state !== 'hover') return
      // 指针已离开 viewer/气泡（如移到宿主侧栏/工具栏）时不要继续牵引气泡，
      // 否则 owner 屏幕坐标未变、pointer 却跑到别处，气泡会“飞走”。
      if (e.target && !stage.contains(e.target) && !bubbleEl.contains(e.target)) return
      positionBubbleIfHover(e.clientX, e.clientY)
    }, { passive: true })

    /* 单击选中：高亮元素/连线，并固定当前代码框；Alt 只用于拖拽/缩放，不再锁气泡 */
    function clearSelection() {
      if (bubble.selectedEl && bubble.selectedEl.classList) bubble.selectedEl.classList.remove('ehm-selected')
      bubble.selectedEl = null
      bubble.selectedKey = null
    }
    function markSelection(el, key) {
      clearSelection()
      if (el && el.classList) el.classList.add('ehm-selected')
      bubble.selectedEl = el || null
      bubble.selectedKey = key || null
    }

    /* 点击气泡外部 → 关闭（必须 capture：气泡内部 mousedown 会 stopPropagation） */
    document.addEventListener('mousedown', function (e) {
      if (bubble.state !== 'locked') return
      if (bubbleEl.contains(e.target)) return
      releaseBubble()
      clearSelection()
    }, true)

    /* 滚轮：只有**锁定**气泡接收代码滚动；hover 气泡是纯展示，不拦截滚轮。
       这样鼠标快速掠过时不会因为气泡正好在指针下而打断画布/页面滚动。 */
    document.addEventListener('wheel', function (e) {
      if (bubble.state !== 'locked') return
      var scroll = bubbleEl.querySelector('.ehm-bubble-scroll')
      if (scroll === null) return
      if (!bubbleEl.contains(e.target)) return
      e.stopPropagation()
      e.preventDefault()
      scroll.scrollTop += e.deltaY
    }, { passive: false, capture: true })

    /* ---------- 悬停/点击绑定 ---------- */

    function bindTarget(targetEl, getTarget, key, getEvidence, getExtras) {
      targetEl.addEventListener('mouseenter', function (e) {
        // 统一入口内部处理 Alt / locked / 取消旧宽限。
        var extras = typeof getExtras === 'function' ? getExtras() : null
        var spec = bubbleSpecFor(getEvidence(), getTarget(), extras)
        if (spec === null) return
        var rect = targetEl.getBoundingClientRect()
        // owner 所在的整张卡片只用于「卡外兜底候选」，不参与硬约束；
        // obstacles 仍传全部卡片（气泡优先不压任何卡片）。
        var cardEl = targetEl.closest ? targetEl.closest('.ehm-card') : null
        showHoverBubble(spec, rect, e.clientX, e.clientY, key, cardScreenRects(null), cardEl ? cardEl.getBoundingClientRect() : null, false, e.altKey)
      })
      targetEl.addEventListener('mouseleave', function (e) {
        if (bubble.state !== 'hover') { hideBubble(); return }
        // 长代码气泡要能用滚轮：离开 owner 时先冻结位置 + 给宽限，
        // 指针可以趁机移到气泡上（见 beginHoverHold 的注释）。
        bubble.pointer.x = e.clientX
        bubble.pointer.y = e.clientY
        beginHoverHold()
      })
      // 单击 = 选中该字段/方法/类 + 固定代码框（不再跳转；双击才跳转）
      targetEl.addEventListener('click', function (e) {
        if (altHeld || e.altKey) { releaseBubble(); return }
        if (draggedRecently()) return
        e.stopPropagation()
        var extras = typeof getExtras === 'function' ? getExtras() : null
        var spec = bubbleSpecFor(getEvidence(), getTarget(), extras)
        if (spec === null) return
        markSelection(targetEl, key)
        var cardEl = targetEl.closest ? targetEl.closest('.ehm-card') : null
        showHoverBubble(spec, targetEl.getBoundingClientRect(), e.clientX, e.clientY, key, cardScreenRects(null), cardEl ? cardEl.getBoundingClientRect() : null, true, e.altKey)
      })
      targetEl.addEventListener('dblclick', function (e) {
        e.stopPropagation()
        onJump(getTarget())
      })
    }

    /**
     * 气泡内容。
     * @param {object|null} evidence 归一化后的 evidence（code/firstLine）
     * @param {object} target 跳转目标
     * @param {{declaration?:string, summary?:string}|null} [extras]
     *   成员悬停时传入：declaration = 带可见性(+ - # ~)的声明行（行文本），
     *   summary = IR member.summary（方法/字段含义）。
     */
    function bubbleSpecFor(evidence, target, extras) {
      if (target === null || target === undefined) return null
      var ev = evidence
      var title = extras && extras.declaration ? extras.declaration : target.symbol
      var subtitle = ev && ev.file ? (ev.file + ':' + (ev.from || target.line)) : (target.file + ':' + target.line)
      var code = ev && ev.code ? ev.code : ''
      var firstLine = ev && ev.from ? ev.from : (target.line || 1)
      return {
        title: title,
        subtitle: subtitle,
        summary: extras && typeof extras.summary === 'string' && extras.summary !== '' ? extras.summary : null,
        code: code,
        firstLine: firstLine,
        target: target,
      }
    }

    /** 除 owner 之外所有卡片的屏幕矩形（气泡避让用）。 */
    function cardScreenRects(ownerEl) {
      var out = []
      var cards = content.querySelectorAll('.ehm-card')
      for (var i = 0; i < cards.length; i++) {
        var cardEl = cards[i]
        if (ownerEl && (cardEl === ownerEl || ownerEl.contains(cardEl))) continue
        var r = cardEl.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) continue
        out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
      }
      return out
    }

    /* ---------- 跳转目标 ---------- */

    function jumpTargetForEntity(ent) {
      return {
        file: ent.location.file,
        line: ent.location.line,
        column: 1,
        symbol: ent.name,
        edgeId: null,
        kind: 'entity',
        entityId: ent.id,
      }
    }

    function jumpTargetForMember(ent, row) {
      var line = row.member.line || ent.location.line
      return {
        file: (row.member.evidence && row.member.evidence.file) || ent.location.file,
        line: line,
        column: 1,
        symbol: ent.name + '.' + row.member.name,
        edgeId: null,
        kind: row.kind,
        entityId: ent.id,
        memberId: row.member.id,
      }
    }

    function jumpTargetForRelation(rel) {
      var ev = rel.evidence
      return {
        file: ev ? ev.file : '',
        line: ev ? ev.from : 0,
        column: 1,
        symbol: rel.label || (rel.from + ' → ' + rel.to),
        edgeId: rel.id,
        kind: 'relation',
      }
    }

    /**
     * 双击关系线 → 优先跳到关系关联的方法（toMethod，其次 fromMethod），
     * 而不是关系证据的某一行；找不到方法时退回关系证据。
     */
    function jumpTargetForRelationMethod(rel) {
      function memberTarget(entityId, memberName) {
        if (!memberName) return null
        var ent = null
        for (var i = 0; i < model.entities.length; i++) if (model.entities[i].id === entityId) ent = model.entities[i]
        if (!ent) return null
        var lists = [ent.methods || [], ent.fields || []]
        for (var l = 0; l < lists.length; l++) {
          for (var m = 0; m < lists[l].length; m++) {
            var member = lists[l][m]
            if (member.name !== memberName) continue
            var ev = member.evidence || {}
            return {
              file: ev.file || ent.location.file,
              line: ev.from || member.line || ent.location.line,
              column: 1,
              symbol: ent.name + '.' + member.name,
              edgeId: rel.id,
              kind: l === 0 ? 'method' : 'field',
              entityId: ent.id,
              memberId: member.id,
            }
          }
        }
        return null
      }
      var to = memberTarget(rel.to, rel.toMethod)
      if (to !== null) return to
      var from = memberTarget(rel.from, rel.fromMethod)
      if (from !== null) return from
      // 关系没有显式 fromMethod/toMethod 时，用证据行号反查它落在哪个方法/字段范围内。
      var ev = rel.evidence
      if (ev && typeof ev.from === 'number') {
        var hit = memberAtLine(rel.from, ev.from) || memberAtLine(rel.to, ev.from)
        if (hit !== null) return hit
      }
      return jumpTargetForRelation(rel)
    }

    function memberAtLine(entityId, line) {
      var ent = null
      for (var i = 0; i < model.entities.length; i++) if (model.entities[i].id === entityId) ent = model.entities[i]
      if (!ent) return null
      var lists = [ent.methods || [], ent.fields || []]
      for (var l = 0; l < lists.length; l++) {
        for (var m = 0; m < lists[l].length; m++) {
          var member = lists[l][m]
          var ev = member.evidence || {}
          var from = typeof ev.from === 'number' ? ev.from : member.line
          var to = typeof ev.to === 'number' ? ev.to : from
          if (typeof from !== 'number' || !(line >= from && line <= to)) continue
          return {
            file: ev.file || ent.location.file,
            line: from,
            column: 1,
            symbol: ent.name + '.' + member.name,
            edgeId: null,
            kind: l === 0 ? 'method' : 'field',
            entityId: ent.id,
            memberId: member.id,
          }
        }
      }
      return null
    }

    /* ---------- 视口 ---------- */

    var drag = { active: false, moves: 0, sx: 0, sy: 0, ox: 0, oy: 0 }

    function draggedRecently() { return drag.moves > 3 }

    // 每次新按下都清零「拖拽计数」：否则 Alt 拖拽一次后 drag.moves>3 会长期保留，
    // 之后的普通单击都会被误判成“刚拖拽过”而忽略（选中固定气泡失效的根因）。
    document.addEventListener('mousedown', function () { drag.moves = 0 }, true)

    stage.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return
      // 只有 Alt+左键拖拽才平移画布；普通左键用于选中卡片/成员/连线。
      if (!e.altKey) return
      // Alt 拖拽是画布操作：任何代码悬浮框立即隐藏，避免挡手/跟着画布跑。
      releaseBubble()
      drag.active = true
      drag.moves = 0
      drag.sx = e.clientX
      drag.sy = e.clientY
      drag.ox = state.view.x
      drag.oy = state.view.y
      stage.classList.add('ehm-grabbing')
      e.preventDefault()
    })
    global.addEventListener('mousemove', function (e) {
      if (!drag.active) return
      var dx = e.clientX - drag.sx
      var dy = e.clientY - drag.sy
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moves += 1
      state.view.x = drag.ox + dx
      state.view.y = drag.oy + dy
      applyView()
    })
    global.addEventListener('mouseup', function () {
      if (!drag.active) return
      drag.active = false
      stage.classList.remove('ehm-grabbing')
    })

    stage.addEventListener('wheel', function (e) {
      // Alt+滚轮 = 以指针为中心缩放；普通滚轮留给页面/不缩放。
      if (!e.altKey) return
      releaseBubble()
      e.preventDefault()
      var rect = stage.getBoundingClientRect()
      var mx = e.clientX - rect.left
      var my = e.clientY - rect.top
      var factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      var next = Math.min(2.6, Math.max(0.22, state.view.k * factor))
      var ratio = next / state.view.k
      state.view.x = mx - (mx - state.view.x) * ratio
      state.view.y = my - (my - state.view.y) * ratio
      state.view.k = next
      applyView()
    }, { passive: false })

    function applyView() {
      content.style.transform = 'translate(' + state.view.x + 'px, ' + state.view.y + 'px) scale(' + state.view.k + ')'
    }

    function fitView() {
      var vw = stage.clientWidth
      var vh = stage.clientHeight
      var sw = content.offsetWidth
      var sh = content.offsetHeight
      if (!vw || !vh || !sw || !sh) return
      var pad = 36
      var k = Math.min((vw - pad) / sw, (vh - pad) / sh, 1.25)
      state.view.k = Math.max(0.25, k)
      state.view.x = (vw - sw * state.view.k) / 2
      state.view.y = Math.max(16, (vh - sh * state.view.k) / 2)
      applyView()
    }

    function zoomBy(factor) {
      var vw = stage.clientWidth
      var vh = stage.clientHeight
      var next = Math.min(2.6, Math.max(0.22, state.view.k * factor))
      var ratio = next / state.view.k
      state.view.x = vw / 2 - (vw / 2 - state.view.x) * ratio
      state.view.y = vh / 2 - (vh / 2 - state.view.y) * ratio
      state.view.k = next
      applyView()
    }

    /* ---------- 工具条 / 主题菜单 ---------- */
    function skinById(id) {
      for (var i = 0; i < SKINS.length; i++) if (SKINS[i].id === id) return SKINS[i]
      return null
    }
    function syncSkinUI() {
      for (var i = 0; i < themeMenuItems.length; i++) {
        var item = themeMenuItems[i]
        var on = item.getAttribute('data-ehm-skin') === state.skin
        item.setAttribute('aria-checked', on ? 'true' : 'false')
        item.classList.toggle('is-current', on)
      }
    }
    function setMenuOpen(open) {
      themeMenu.classList.toggle('open', open === true)
      btnTheme.setAttribute('aria-expanded', open === true ? 'true' : 'false')
    }
    function setSkin(id) {
      var skin = skinById(id)
      if (skin === null) return false
      state.skin = skin.id
      state.theme = skin.theme
      root.setAttribute('data-ehm-skin', skin.id)
      root.classList.toggle('ehm-theme-dark', skin.theme === 'dark')
      root.classList.toggle('ehm-theme-light', skin.theme === 'light')
      syncSkinUI()
      setMenuOpen(false)
      hideBubble()
      return true
    }
    btnFit.addEventListener('click', function () { fitView() })
    btnSidebar.addEventListener('click', function () {
      var meta = global.__EHM_META__ && typeof global.__EHM_META__ === 'object' ? global.__EHM_META__ : {}
      var payload = {
        type: 'ehm:open-sidebar',
        id: typeof meta.docId === 'string' ? meta.docId : '',
        title: typeof meta.title === 'string' ? meta.title : '',
        stats: { entities: meta.entityCount || 0, relations: meta.relationCount || 0 },
        htmlPath: typeof meta.htmlPath === 'string' ? meta.htmlPath : '',
        sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : '',
      }
      // 内联 fence / 右栏 tab 都在 DSH Web GUI 的 iframe 里：通知宿主打开右侧 EHM tab。
      if (global.parent && global.parent !== global) {
        try {
          // 本地 HTML 可能在 sandbox/Blob（opaque origin）里运行，targetOrigin 不能用自身 origin；
          // 消息只含图元数据，由父窗口按 id/source 校验后处理。
          global.parent.postMessage(payload, '*')
          return
        } catch (error) {
          /* fall through */
        }
      }
      if (typeof toast === 'function') toast('请从 DSH 内的 EHM 图打开侧栏', 'ok')
    })
    btnTheme.addEventListener('click', function (e) {
      e.stopPropagation()
      setMenuOpen(!themeMenu.classList.contains('open'))
    })
    themeMenu.addEventListener('mousedown', function (e) { e.stopPropagation() })
    themeMenuItems.forEach(function (item) {
      item.addEventListener('click', function () {
        setSkin(item.getAttribute('data-ehm-skin'))
      })
    })
    syncSkinUI()
    document.addEventListener('mousedown', function (e) {
      if (!themeMenu.classList.contains('open')) return
      if (themeMenu.contains(e.target) || btnTheme.contains(e.target)) return
      setMenuOpen(false)
    }, true)

    document.addEventListener('keydown', function (e) {
      var tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // 按 Alt 准备平移/缩放的瞬间就收起代码悬浮框（包括锁定的），按住期间不再出。
      if (e.key === 'Alt') { altHeld = true; releaseBubble() }
      if (e.key === '0') fitView()
      else if (e.key === '+' || e.key === '=') zoomBy(1.15)
      else if (e.key === '-') zoomBy(1 / 1.15)
      else if (e.key === 'Escape') { setMenuOpen(false); releaseBubble() }
    })
    document.addEventListener('keyup', function (e) {
      if (e.key === 'Alt') altHeld = false
    })

    /* ---------- 主流程 ---------- */

    function relayout() {
      // ① 第一遍：估算尺寸跑 dagre，只摆卡片（不画线）
      var pT0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
      var first = runLayout(null, false)
      prof('relayout.firstRunLayout', pT0)
      var pT1 = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
      //    关键：measureMode 让卡片按**内容**撑开，量到的才是真实宽度
      paint(first, false, true)
      content.style.transform = 'translate(0px, 0px) scale(1)'
      // ② 量真实尺寸（同步读 offsetWidth/Height，不依赖 rAF —— headless 下 rAF 可能不触发）
      var realSizes = measureRenderedCards()
      var hasReal = false
      for (var key in realSizes) { if (Object.prototype.hasOwnProperty.call(realSizes, key)) { hasReal = true; break } }
      prof('relayout.measurePaint', pT1)
      var pT2 = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
      // ③ 第二遍：用真实尺寸重跑 dagre + 重算走线，然后正式绘制
      var finalLayout = hasReal ? runLayout(realSizes, true, stage.clientWidth) : first
      prof('relayout.finalRunLayout', pT2)
      var pT3 = (global.performance && global.performance.now) ? global.performance.now() : Date.now()
      paint(finalLayout, true, false)
      prof('relayout.finalPaint', pT3)
      state.layout = finalLayout.laid
      state.edges = finalLayout.edges
      state.layoutState = { realSizes: realSizes, usedReal: hasReal, first: first.laid, final: finalLayout.laid, entityLayout: finalLayout.entityLayout, pack: finalLayout.fanoutPack }
      return finalLayout
    }

    function measureRenderedCards() {
      var sizes = {}
      var cards = content.querySelectorAll('.ehm-card')
      for (var i = 0; i < cards.length; i++) {
        var id = cards[i].getAttribute('data-ehm-card')
        if (id === null) continue
        var w = cards[i].offsetWidth
        var h = cards[i].offsetHeight
        if (w > 0 && h > 0) sizes[id] = { w: w, h: h }
      }
      return sizes
    }

    /* ---------- 诊断（供自动化验收断言） ---------- */

    /**
     * 核验「IR 级方法端点」：只有直接喂 IR 且关系带 fromMethod / toMethod 时，
     * 折线的首点/末点 y 才会要求落在对应成员行中线附近。
     *
     * 注意：普通 ehm_render/CLI 的 UML 不产生 member 端点，这里 checked 会是 0；
     * 方法级端口不是当前 CLI 链路能力。
     */
    function auditMethodPorts() {
      var out = { checked: 0, ok: 0, bad: [], missing: [] }
      var layout = state.layout
      if (layout === null) return out
      var entityLayout = state.layoutState ? state.layoutState.entityLayout : null
      for (var i = 0; i < state.edges.length; i++) {
        var edge = state.edges[i]
        var rel = edge.rel
        if (!rel.fromMethod && !rel.toMethod) continue
        out.checked += 1
        var pts = edge.points || []
        if (pts.length < 2) { out.bad.push(rel.id + ':too-few-points'); continue }
        var fromBox = layout.nodes[rel.from]
        var toBox = layout.nodes[rel.to]
        var problems = []
        if (rel.fromMethod && fromBox) {
          var expectY = memberYIn(fromBox, byIdOf(rel.from), rel.fromMethod, entityLayout)
          if (expectY === undefined) out.missing.push(rel.id + '@from:' + rel.fromMethod)
          else if (Math.abs(pts[0][1] - expectY) > G.ROW_H) {
            problems.push('from y=' + Math.round(pts[0][1]) + ' expect=' + Math.round(expectY))
          }
        }
        if (rel.toMethod && toBox) {
          var expectY2 = memberYIn(toBox, byIdOf(rel.to), rel.toMethod, entityLayout)
          if (expectY2 === undefined) out.missing.push(rel.id + '@to:' + rel.toMethod)
          else if (Math.abs(pts[pts.length - 1][1] - expectY2) > G.ROW_H) {
            problems.push('to y=' + Math.round(pts[pts.length - 1][1]) + ' expect=' + Math.round(expectY2))
          }
        }
        if (problems.length === 0) out.ok += 1
        else out.bad.push(rel.id + ': ' + problems.join('; '))
      }
      return out

      function byIdOf(id) {
        for (var k = 0; k < model.entities.length; k++) if (model.entities[k].id === id) return model.entities[k]
        return undefined
      }
    }

    /**
     * 核验每条线的两端：必须落在源/目标卡片边界上，且最后一段垂直进入该边界。
     * 这条断言专门抓「箭头沿卡边横着飞 / 端点没贴到卡片」的回归。
     */
    function auditWireEndpoints() {
      var out = { checked: 0, ok: 0, bad: [] }
      var layout = state.layout
      if (layout === null) return out
      function sideOf(box, pt) {
        var tol = 2
        if (Math.abs(pt[0] - box.x) <= tol) return 'left'
        if (Math.abs(pt[0] - (box.x + box.w)) <= tol) return 'right'
        if (Math.abs(pt[1] - box.y) <= tol) return 'top'
        if (Math.abs(pt[1] - (box.y + box.h)) <= tol) return 'bottom'
        return null
      }
      function enters(side, prev, end) {
        if (!prev) return false
        var dx = end[0] - prev[0]
        var dy = end[1] - prev[1]
        if (side === 'left') return dx > 0.1 && Math.abs(dy) <= 0.6
        if (side === 'right') return dx < -0.1 && Math.abs(dy) <= 0.6
        if (side === 'top') return dy > 0.1 && Math.abs(dx) <= 0.6
        if (side === 'bottom') return dy < -0.1 && Math.abs(dx) <= 0.6
        return false
      }
      function leaves(side, start, next) {
        if (!next) return false
        var dx = next[0] - start[0]
        var dy = next[1] - start[1]
        if (side === 'left') return dx < -0.1 && Math.abs(dy) <= 0.6
        if (side === 'right') return dx > 0.1 && Math.abs(dy) <= 0.6
        if (side === 'top') return dy < -0.1 && Math.abs(dx) <= 0.6
        if (side === 'bottom') return dy > 0.1 && Math.abs(dx) <= 0.6
        return false
      }
      for (var i = 0; i < state.edges.length; i++) {
        var edge = state.edges[i]
        var pts = edge.points || []
        if (pts.length < 2) continue
        out.checked += 1
        var fromBox = layout.nodes[edge.rel.from]
        var toBox = layout.nodes[edge.rel.to]
        if (!fromBox || !toBox) { out.bad.push(edge.rel.id + ':missing-box'); continue }
        var start = pts[0]
        var end = pts[pts.length - 1]
        var startSide = sideOf(fromBox, start)
        var endSide = sideOf(toBox, end)
        var problems = []
        if (startSide === null) problems.push('start-not-on-card')
        else if (!leaves(startSide, start, pts[1])) problems.push('start-not-perpendicular@' + startSide)
        if (endSide === null) problems.push('end-not-on-card')
        else if (!enters(endSide, pts[pts.length - 2], end)) problems.push('end-not-perpendicular@' + endSide)
        if (problems.length === 0) out.ok += 1
        else out.bad.push(edge.rel.id + ': ' + problems.join('; '))
      }
      return out
    }

    function diagnose() {
      var layout = state.layout
      if (layout === null) return { error: 'not rendered' }
      var cards = []
      var ids = []
      for (var i = 0; i < model.entities.length; i++) {
        var nd = layout.nodes[model.entities[i].id]
        if (!nd) continue
        cards.push(nd)
        ids.push(model.entities[i].id)
      }

      // 卡片重叠
      var cardOverlaps = []
      for (var a = 0; a < cards.length; a++) {
        for (var b = a + 1; b < cards.length; b++) {
          var p = cards[a]
          var q = cards[b]
          if (p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y) {
            cardOverlaps.push(ids[a] + '~' + ids[b])
          }
        }
      }

      // 连线：斜段 / 穿卡
      var diagonal = []
      var wireOnCard = []
      var wireOnAnyCard = []
      var totalSegs = 0
      var e
      for (e = 0; e < state.edges.length; e++) {
        var edge = state.edges[e]
        var pts = edge.points || []
        for (var s = 0; s < pts.length - 1; s++) {
          totalSegs += 1
          var dx = Math.abs(pts[s + 1][0] - pts[s][0])
          var dy = Math.abs(pts[s + 1][1] - pts[s][1])
          if (dx > 0.6 && dy > 0.6) diagonal.push(edge.rel.id + '#' + s)
          var skip = {}
          skip[edge.rel.from] = 1
          skip[edge.rel.to] = 1
          for (var c = 0; c < cards.length; c++) {
            if (segmentHitsRect(pts[s], pts[s + 1], cards[c])) {
              var hitId = edge.rel.id + '#' + s + '@' + ids[c]
              wireOnAnyCard.push(hitId)
              if (!skip[ids[c]]) wireOnCard.push(hitId)
            }
          }
        }
      }

      // 起终点去重：同一起点/终点会让两条线的第一段完全重叠。
      var starts = {}
      var ends = {}
      var sharedStarts = []
      var sharedEnds = []
      for (var pe = 0; pe < state.edges.length; pe++) {
        var pePts = state.edges[pe].points || []
        if (pePts.length < 2 || state.edges[pe].bundleKey) continue
        var sKey = Math.round(pePts[0][0] * 10) / 10 + ',' + Math.round(pePts[0][1] * 10) / 10
        var eKey = Math.round(pePts[pePts.length - 1][0] * 10) / 10 + ',' + Math.round(pePts[pePts.length - 1][1] * 10) / 10
        if (starts[sKey] !== undefined) sharedStarts.push(state.edges[pe].rel.id + '~' + starts[sKey])
        else starts[sKey] = state.edges[pe].rel.id
        if (ends[eKey] !== undefined) sharedEnds.push(state.edges[pe].rel.id + '~' + ends[eKey])
        else ends[eKey] = state.edges[pe].rel.id
      }

      // 连线之间的真实交叉/重叠。注意：共享源/目标卡片、但端口不同的边也要统计——
      // 用户截图里的问题正是「两条边汇入同一张卡时共用了一段竖直通道」。
      var wireCrossings = []
      var wireOverlaps = []
      var wireProximities = []
      var wireTouches = []
      for (var w1 = 0; w1 < state.edges.length; w1++) {
        for (var w2 = w1 + 1; w2 < state.edges.length; w2++) {
          var ea = state.edges[w1]
          var eb = state.edges[w2]
          if (!ea.points || !eb.points) continue
          if (ea.bundleKey && ea.bundleKey === eb.bundleKey) continue
          var sameStart = Math.abs(ea.points[0][0] - eb.points[0][0]) < 0.6 && Math.abs(ea.points[0][1] - eb.points[0][1]) < 0.6
          var sameEnd = Math.abs(ea.points[ea.points.length - 1][0] - eb.points[eb.points.length - 1][0]) < 0.6
            && Math.abs(ea.points[ea.points.length - 1][1] - eb.points[eb.points.length - 1][1]) < 0.6
          var crossed = false
          var overlapped = false
          var touched = false
          var nearest = 0
          for (var sa = 0; sa < ea.points.length - 1; sa++) {
            for (var sb = 0; sb < eb.points.length - 1; sb++) {
              var relation = orthogonalPairRelation([ea.points[sa], ea.points[sa + 1]], [eb.points[sb], eb.points[sb + 1]])
              // 共享端口的第一/最后小段共线不可避免；其余交叉/重叠都要报。
              if (relation === 2 && ((sa === 0 && sb === 0 && sameStart) || (sa === ea.points.length - 2 && sb === eb.points.length - 2 && sameEnd))) continue
              if (relation === 1) crossed = true
              else if (relation === 2) overlapped = true
              else if (segmentsTouch([ea.points[sa], ea.points[sa + 1]], [eb.points[sb], eb.points[sb + 1]])) touched = true
              else {
                var near = wireProximity([ea.points[sa], ea.points[sa + 1]], [eb.points[sb], eb.points[sb + 1]], G.MIN_WIRE_GAP)
                if (near > nearest) nearest = near
              }
            }
          }
          if (crossed) wireCrossings.push(ea.rel.id + '~' + eb.rel.id)
          if (overlapped) wireOverlaps.push(ea.rel.id + '~' + eb.rel.id)
          if (!overlapped && touched) wireTouches.push(ea.rel.id + '~' + eb.rel.id)
          if (!overlapped && nearest > 0) wireProximities.push(ea.rel.id + '~' + eb.rel.id + '@' + Math.round((G.MIN_WIRE_GAP - nearest) * 10) / 10)
        }
      }

      // 标签：压卡片 / 压线 / 越界
      var labelOnCard = []
      var labelOnWire = []
      var labelOut = []
      for (var li = 0; li < state.labels.length; li++) {
        var lb = state.labels[li]
        if (!lb.rect) continue
        for (var ci = 0; ci < cards.length; ci++) {
          var card = cards[ci]
          if (lb.rect.left < card.x + card.w && lb.rect.right > card.x
            && lb.rect.top < card.y + card.h && lb.rect.bottom > card.y) {
            labelOnCard.push(lb.text)
          }
        }
        for (var ei = 0; ei < state.edges.length; ei++) {
          if (state.edges[ei] === lb.edge) continue
          var wpts = state.edges[ei].points || []
          for (var si = 0; si < wpts.length - 1; si++) {
            if (segIntersectsRect(wpts[si], wpts[si + 1], lb.rect.left, lb.rect.top, lb.rect.right, lb.rect.bottom)) {
              labelOnWire.push(lb.text + '@' + state.edges[ei].rel.id)
            }
          }
        }
        if (lb.rect.left < 2 || lb.rect.top < 2
          || lb.rect.right > layout.width - 2 || lb.rect.bottom > layout.height - 2) {
          labelOut.push(lb.text)
        }
      }

      // 文字溢出（ellipsis 触发）
      var overflow = []
      var nodes = content.querySelectorAll('.ehm-name, .ehm-row-text, .ehm-summary, .ehm-stereo')
      for (var n = 0; n < nodes.length; n++) {
        var node = nodes[n]
        if (node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) {
          overflow.push(textOf(node))
        }
      }

      // 卡片实际高度 vs 布局高度（防止 CSS 与估算漂移）
      var heightDrift = []
      var cardEls = content.querySelectorAll('.ehm-card')
      for (var k = 0; k < cardEls.length; k++) {
        var cid = cardEls[k].getAttribute('data-ehm-card')
        var box = layout.nodes[cid]
        if (!box) continue
        if (Math.abs(cardEls[k].offsetHeight - box.h) > 1.5) {
          heightDrift.push(cid + ':' + cardEls[k].offsetHeight + '!=' + Math.round(box.h))
        }
      }

      // 行距：同一分区内相邻成员行的实际布局间距（应为 ROW_H=21）
      // 注意用 offsetTop 而不是 getBoundingClientRect —— 后者被画布 scale 过，
      // k=1.09 时 21px 会量成 23px，是全假阳性。
      var rowPitch = []
      for (var pk = 0; pk < cardEls.length; pk++) {
        var comps = cardEls[pk].querySelectorAll('.ehm-compartment')
        for (var pc = 0; pc < comps.length; pc++) {
          var rows = comps[pc].querySelectorAll('.ehm-row')
          for (var pr = 1; pr < rows.length; pr++) {
            var gap = rows[pr].offsetTop - rows[pr - 1].offsetTop
            if (Math.abs(gap - G.ROW_H) > 1) {
              rowPitch.push(cardEls[pk].getAttribute('data-ehm-card') + ':' + gap)
            }
          }
        }
      }

      return {
        scene: { width: Math.round(layout.width), height: Math.round(layout.height) },
        view: {
          k: Math.round(state.view.k * 1000) / 1000,
          x: Math.round(state.view.x),
          y: Math.round(state.view.y),
        },
        stage: { w: stage.clientWidth, h: stage.clientHeight },
        content: { w: content.offsetWidth, h: content.offsetHeight },
        cards: cards.length,
        relations: model.relations.length,
        drawnEdges: state.edges.length,
        segments: totalSegs,
        labels: state.labels.length,
        cardOverlaps: cardOverlaps,
        diagonalSegments: diagonal,
        wireOnCard: wireOnCard,
        wireOnAnyCard: wireOnAnyCard,
        sharedStarts: sharedStarts,
        sharedEnds: sharedEnds,
        wireProximities: wireProximities,
        wireCrossings: wireCrossings,
        wireOverlaps: wireOverlaps,
        wireTouches: wireTouches,
        labelOnCard: labelOnCard,
        labelOnWire: labelOnWire,
        labelOutOfBounds: labelOut,
        textOverflow: overflow,
        heightDrift: heightDrift,
        rowPitchDeviation: rowPitch,
        droppedRelations: model.dropped.length,
        fanoutPack: state.layoutState ? state.layoutState.pack : null,
        methodPorts: auditMethodPorts(),
        wireEndpoints: auditWireEndpoints(),
      }
    }

    function textOf(node) {
      return (node.textContent || '').slice(0, 42)
    }

    function countTitle(m) {
      var kinds = {}
      for (var i = 0; i < m.entities.length; i++) kinds[m.entities[i].kind] = (kinds[m.entities[i].kind] || 0) + 1
      return m.entities.length + ' 个实体 · ' + m.relations.length + ' 条关系'
    }

    /* ---------- 对外实例 API ---------- */

    var instance = {
      version: VERSION,
      relayout: function () { relayout(); fitView() },
      fit: fitView,
      zoom: zoomBy,
      setTheme: function (t) { return setSkin(t === 'light' ? 'dsh-light' : 'dsh-dark') },
      getTheme: function () { return state.theme },
      setSkin: setSkin,
      getSkin: function () { return state.skin },
      setMethodsMode: function (mode) {
        state.methodsCollapsed = mode === 'collapsed'
        hideBubble()
        relayout()
        fitView()
      },
      diagnose: diagnose,
      /** 供测试/诊断：当前连线的正交点（含 rel id / from / to），不修改任何状态。 */
      debugEdges: function () {
        return (state.edges || []).map(function (e) {
          return { id: e.rel.id, from: e.rel.from, to: e.rel.to, points: e.points, cardHits: e.cardHits, routeKind: e.routeKind }
        })
      },
      routeDebug: function () { return global.__EHM_ROUTE_DEBUG || [] },
      /** 供测试/诊断：双击关系线会跳到的目标（优先 toMethod / fromMethod / 证据行所属成员）。 */
      relationMethodTarget: function (id) {
        for (var i = 0; i < model.relations.length; i++) {
          if (model.relations[i].id === id) return jumpTargetForRelationMethod(model.relations[i])
        }
        return null
      },
      model: model,
      root: root,
      stage: stage,
      content: content,
      bubble: bubbleEl,
      /** 供测试/诊断：读取最近一次气泡定位的调试信息（候选方位、owner/卡片重叠、到鼠标距离）。 */
      bubblePlacement: function () { return bubble.lastPlacement || null },
      /** 供测试：模拟一次跳转（走和点击完全相同的代码路径） */
      simulateJump: function (which) {
        if (which === 'entity') onJump(jumpTargetForEntity(model.entities[0]))
        else if (which === 'relation') onJump(jumpTargetForRelation(model.relations[0]))
        else if (which === 'member') {
          var ent = null
          for (var i = 0; i < model.entities.length; i++) {
            if (model.entities[i].methods.length > 0) { ent = model.entities[i]; break }
          }
          if (ent === null) return null
          var m = measureCard(ent, state.methodsCollapsed)
          onJump(jumpTargetForMember(ent, m.methodRows[0]))
        }
        return null
      },
      destroy: function () {
        container.replaceChildren()
        container.classList.remove('ehm-host')
      },
    }

    relayout()
    fitView()
    PROFILE.totalMs = Math.round((((global.performance && global.performance.now) ? global.performance.now() : Date.now()) - profileStart) * 10) / 10
    return instance
  }

  /* ============================================================
     11. 公共 API
     ============================================================ */

  function render(ir, container, options) {
    return createViewer(ir, container, options)
  }

  /** mount 与 render 同义；保留两个名字以对齐 spec 里的写法。 */
  function mount(ir, container, options) {
    return createViewer(ir, container, options)
  }

  global.EHMViewer = {
    version: VERSION,
    render: render,
    mount: mount,
    /** 供外部复用：IR 归一化（纯函数，返回内部形状，不渲染） */
    normalizeIR: normalizeIR,
    /** 兼容旧名 */
    normalize: normalizeIR,
    /** 版本探测：'spec'（1.x）| 'legacy'（0.x） */
    detectIrPath: detectIrPath,
    /** 供回归测试：正交线段关系（1 交叉 / 2 重叠）与平行净距。 */
    router: {
      pairRelation: orthogonalPairRelation,
      proximity: wireProximity,
      routePorts: routePorts,
    },
    /** 枚举映射表（供测试与文档引用） */
    kinds: {
      relation: RELATION_KINDS,
      entity: ENTITY_KINDS,
      relationCompat: RELATION_KIND_COMPAT,
      entityCompat: ENTITY_KIND_COMPAT,
    },
    /** 供外部复用：无 DOM 的尺寸估算（node 下不可用，需 canvas） */
    _internal: {
      font: FONT,
      geometry: G,
      layoutBase: LAYOUT_BASE,
    },
  }
})(typeof window !== 'undefined' ? window : globalThis)





