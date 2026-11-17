#!/usr/bin/env node
/**
 * spec/validate.mjs —— EHM IR 零依赖校验器
 *
 *   用法：
 *     node spec/validate.mjs spec/sample.ir.json        # 校验一个文件
 *     node spec/validate.mjs --selftest                 # 跑内建正/负样例（不读外部文件）
 *     node spec/validate.mjs --json spec/sample.ir.json # 结果以 JSON 输出（CI 用）
 *
 * 三层检查：
 *   1. 结构层：按 spec/ehm.ir.schema.json 的 draft-07 子集校验（type / required /
 *      enum / pattern / minItems / maxItems / minimum / maximum / anyOf / oneOf /
 *      additionalProperties / patternProperties / $ref / definitions）。
 *   2. 语义层（schema 表达不了、但"点击能不能跳"依赖的东西）：
 *      R1  id 唯一；method id 在其容器内唯一；view id 唯一
 *      R2  引用完整性：relation.from/to 的 entity 必须存在，member 必须归属该 entity
 *      R3  证据完整性：evidence.code 行数 === endLine-line+1；行号不得超出文件（--check-files 时读盘核对）
 *      R4  位置可达性：diff 节点永不指向旧文件（origin 只能是 origin，不能当 anchor 用）
 *      R5  视图边单一性（P1）：view.edge.kind 是标量；同视图解析出的边只含该 kind
 *      R6  规模约束（P3）：解析后节点 ≤ fold.maxNodes、边 ≤ fold.maxEdges；
 *         超限且 mechanism=aggregate 但没产出聚合节点 → error（不允许静默截断）
 *      R7  折叠可见性：带 folded.count 的实体必须给 members 或由 foldResult.collapsed 交代
 *   3. 预算层：按 UTF-8 字节数给出体积警告（48 KiB warn / 60 KiB error，为 64 KiB 上限留余量）
 *
 * 退出码：0 = 通过（可能有 warning）；1 = 有 error；2 = 用法/读取错误。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(HERE, 'ehm.ir.schema.json')
const SAMPLE_PATH = join(HERE, 'sample.ir.json')

/* ─────────────────────────── 结果收集 ─────────────────────────── */

const results = []
function report (severity, code, path, message) {
  results.push({ severity, code, path, message })
}
const err = (code, path, message) => report('error', code, path, message)
const warn = (code, path, message) => report('warn', code, path, message)

/* ─────────────────── 1. draft-07 子集解释器 ─────────────────── */

const MAX_ERRORS_PER_FILE = 200

function typeOf (v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}
function typeMatches (value, want) {
  const t = typeOf(value)
  if (want === 'number') return t === 'number' || t === 'integer'
  if (want === 'integer') return t === 'integer'
  return t === want
}

/** 编译一次 path 里的 pattern（$ref 会被缓存成已解析的 schema 对象）。 */
const refCache = new Map()
function deref (root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`不支持的 $ref: ${ref}`)
  if (refCache.has(ref)) return refCache.get(ref)
  let node = root
  for (const seg of ref.slice(2).split('/')) {
    node = node[seg.replace(/~1/g, '/').replace(/~0/g, '~')]
    if (node === undefined) throw new Error(`$ref 解析失败: ${ref}`)
  }
  refCache.set(ref, node)
  return node
}

/**
 * 校验 value 是否满足 schema。返回错误数。
 * 注意：这里刻意只实现本项目 schema 实际用到的关键字，遇到不认识的
 * 校验关键字（如 format）静默跳过 —— 需求是"schema 子集校验即可"。
 */
function validateSchema (value, schema, root, path, depth = 0) {
  if (depth > 60) throw new Error('schema 递归过深（可能是循环 $ref）')
  let errors = 0

  if (schema.$ref !== undefined) {
    errors += validateSchema(value, deref(root, schema.$ref), root, path, depth + 1)
    // $ref 与同级关键字（draft-07 里同级关键字仍生效）一起校验
  }

  if (schema.type !== undefined) {
    const wants = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!wants.some(w => typeMatches(value, w))) {
      err('schema.type', path, `类型应为 ${wants.join('|')}，实际 ${typeOf(value)}`)
      return errors + 1
    }
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      err('schema.enum', path, `值 ${JSON.stringify(value)} 不在枚举 [${schema.enum.join(', ')}] 中`)
      errors++
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    err('schema.const', path, `值应为常量 ${JSON.stringify(schema.const)}`)
    errors++
  }

  if (typeOf(value) === 'string') {
    const len = [...value].length
    if (schema.minLength !== undefined && len < schema.minLength) {
      err('schema.minLength', path, `长度 ${len} < minLength ${schema.minLength}`)
      errors++
    }
    if (schema.maxLength !== undefined && len > schema.maxLength) {
      err('schema.maxLength', path, `长度 ${len} > maxLength ${schema.maxLength}`)
      errors++
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      err('schema.pattern', path, `值 ${JSON.stringify(value.slice(0, 80))} 不匹配 /${schema.pattern}/`)
      errors++
    }
  }

  if (typeOf(value) === 'integer' || typeOf(value) === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      err('schema.minimum', path, `${value} < minimum ${schema.minimum}`)
      errors++
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      err('schema.maximum', path, `${value} > maximum ${schema.maximum}`)
      errors++
    }
  }

  if (typeOf(value) === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      err('schema.minItems', path, `数组长度 ${value.length} < minItems ${schema.minItems}`)
      errors++
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      err('schema.maxItems', path, `数组长度 ${value.length} > maxItems ${schema.maxItems}`)
      errors++
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => { errors += validateSchema(item, schema.items, root, `${path}[${i}]`, depth + 1) })
    }
  }

  if (typeOf(value) === 'object') {
    const keys = Object.keys(value)
    for (const req of schema.required ?? []) {
      if (!(req in value)) {
        err('schema.required', path, `缺少必填字段 "${req}"`)
        errors++
      }
    }
    const declared = schema.properties ?? {}
    const patternProps = schema.patternProperties ?? {}
    for (const k of keys) {
      let matched = false
      if (k in declared) {
        matched = true
        errors += validateSchema(value[k], declared[k], root, `${path}.${k}`, depth + 1)
      }
      for (const [pat, sub] of Object.entries(patternProps)) {
        if (new RegExp(pat).test(k)) {
          matched = true
          errors += validateSchema(value[k], sub, root, `${path}.${k}`, depth + 1)
        }
      }
      if (!matched && schema.additionalProperties === false) {
        err('schema.additionalProperties', `${path}.${k}`, `不允许的字段 "${k}"（宿主私有字段必须用 x-<name> 形式）`)
        errors++
      } else if (!matched && typeof schema.additionalProperties === 'object') {
        errors += validateSchema(value[k], schema.additionalProperties, root, `${path}.${k}`, depth + 1)
      }
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const matching = schema.anyOf.filter(sub => countErrors(value, sub, root, path, depth + 1) === 0)
    if (matching.length === 0) {
      err('schema.anyOf', path, `不满足 anyOf 中任何一支（${schema.anyOf.length} 个候选）`)
      errors++
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matching = schema.oneOf.filter(sub => countErrors(value, sub, root, path, depth + 1) === 0)
    if (matching.length !== 1) {
      err('schema.oneOf', path, `应恰好命中 oneOf 的 1 支，实际命中 ${matching.length} 支`)
      errors++
    }
  }

  return errors
}

/** 静默数错误（用于 anyOf/oneOf 分支探测，不写进 results）。 */
function countErrors (value, schema, root, path, depth) {
  const before = results.length
  try {
    validateSchema(value, schema, root, path, depth)
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
  const added = results.length - before
  const sliced = results.splice(before, added)
  return sliced.filter(r => r.severity === 'error').length
}

/* ─────────────────── 2. 语义层检查 ─────────────────── */

const endpointKey = (ep) => (ep.member ? `${ep.entity}#${ep.member}` : ep.entity)
const entityIdOf = (ep) => ep.entity

/** R1 + R2：唯一性与引用完整性。 */
function checkReferences (ir) {
  const entityIds = new Map()
  ir.entities.forEach((e, i) => {
    if (entityIds.has(e.id)) {
      err('R1.duplicate-id', `entities[${i}].id`, `实体 id "${e.id}" 重复（首次出现于 entities[${entityIds.get(e.id)}]）`)
    } else {
      entityIds.set(e.id, i)
    }
    const memberIds = new Set()
    const members = [...(e.fields ?? []).map(f => ({ kind: 'field', id: f.name, m: f })), ...(e.methods ?? []).map(m => ({ kind: 'method', id: m.id, m }))]
    for (const { kind, id, m } of members) {
      if (kind === 'method') {
        if (memberIds.has(id)) err('R1.duplicate-member', `entity "${e.id}"`, `方法 id "${id}" 在容器内重复`)
        memberIds.add(id)
      }
      if (m.visibility === undefined) warn('R2.missing-visibility', `entity "${e.id}" ${kind} "${id}"`, '未声明 visibility（渲染时按 + 处理）')
    }
    e.__members = memberIds
  })

  ir.relations.forEach((r, i) => {
    const p = `relations[${i}](${r.id})`
    for (const side of ['from', 'to']) {
      const ep = r[side]
      const owner = entityIds.get(entityIdOf(ep))
      if (owner === undefined) {
        err('R2.dangling-endpoint', `${p}.${side}`, `端点实体 "${entityIdOf(ep)}" 不存在`)
        continue
      }
      if (ep.member !== undefined) {
        const target = ir.entities[owner]
        const methodIds = new Set((target.methods ?? []).map(m => m.id))
        if (!methodIds.has(ep.member)) {
          err('R2.dangling-member', `${p}.${side}`, `成员 "${ep.member}" 不属于实体 "${ep.entity}"（该实体方法：${[...methodIds].join(', ') || '无'}）`)
        }
      }
    }
    if (r.kind === 'contains' && r.evidence !== undefined) {
      warn('R2.contains-has-evidence', `${p}`, 'contains 是层级事实，不参与绘制；带 evidence 说明生成方可能想画它，检查是否该用 parent 字段')
    }
  })

  const viewIds = new Set()
  ir.views.forEach((v, i) => {
    if (viewIds.has(v.id)) err('R1.duplicate-view', `views[${i}].id`, `视图 id "${v.id}" 重复`)
    viewIds.add(v.id)
    if (v.type === 'uml' && v.facet === undefined) {
      err('R2.uml-facet', `views[${i}]`, 'uml 视图必须声明 facet（calls=调用面 / types=类型面），否则一个视图会混两种边，违反 P1')
    }
    const root = v.query?.root
    if (root !== undefined) {
      const owner = entityIds.get(entityIdOf(root))
      if (owner === undefined) {
        err('R2.dangling-root', `views[${i}].query.root`, `根实体 "${entityIdOf(root)}" 不存在`)
      } else if (root.member !== undefined && !(ir.entities[owner].methods ?? []).some(m => m.id === root.member)) {
        err('R2.dangling-root-member', `views[${i}].query.root`, `根成员 "${root.member}" 不属于实体 "${root.entity}"`)
      }
    }
  })
}

/** R3：证据行数自洽 + 位置不越界（可选读盘）。 */
function checkEvidence (ir, opts) {
  let checked = 0
  const fileLines = new Map()
  function lineCount (file) {
    if (!opts.checkFiles) return null
    if (!fileLines.has(file)) {
      try {
        const abs = join(opts.workspaceRoot, file)
        fileLines.set(file, readFileSync(abs, 'utf8').split(/\r?\n/).length)
      } catch {
        fileLines.set(file, -1)
      }
    }
    return fileLines.get(file)
  }
  function visit (ev, p) {
    if (ev === undefined) return
    checked++
    if (ev.code !== undefined) {
      const lines = ev.code.split('\n').length
      if (ev.endLine !== undefined) {
        const want = ev.endLine - ev.line + 1
        if (lines !== want) {
          err('R3.evidence-lines', p, `evidence.code 有 ${lines} 行，但 line..endLine 跨越 ${want} 行（${ev.line}..${ev.endLine}）`)
        }
      } else if (lines > 1) {
        err('R3.evidence-lines', p, `evidence.code 有 ${lines} 行，但只声明了单行 line=${ev.line}（要么给 endLine，要么把 code 收窄到一行）`)
      }
    } else if (ev.snippetRef === undefined) {
      err('R3.evidence-empty', p, 'evidence 既没有 code 也没有 snippetRef（无法展示，也无法按需取）')
    }
    const total = lineCount(ev.file)
    if (total === -1) {
      warn('R3.missing-file', p, `evidence.file "${ev.file}" 在 ${opts.workspaceRoot} 下不存在（IR 与工作区可能不同步）`)
    } else if (total !== null) {
      for (const [field, n] of [['line', ev.line], ['endLine', ev.endLine]]) {
        if (n !== undefined && n > total) err('R3.line-out-of-range', `${p}.${field}`, `${ev.file} 只有 ${total} 行，${field}=${n} 越界`)
      }
    }
  }
  ir.entities.forEach((e, i) => {
    visit(e.evidence, `entities[${i}].evidence`)
    ;(e.fields ?? []).forEach((f, j) => visit(f.evidence, `entities[${i}].fields[${j}].evidence`))
    ;(e.methods ?? []).forEach((m, j) => visit(m.evidence, `entities[${i}].methods[${j}].evidence`))
  })
  ir.relations.forEach((r, i) => {
    visit(r.evidence, `relations[${i}].evidence`)
    ;(r.sites ?? []).forEach((s, j) => {
      if (s.code === undefined && s.snippetRef === undefined) {
        err('R3.site-no-code', `relations[${i}].sites[${j}]`, '调用点既没有 code 也没有 snippetRef')
      }
    })
  })
  return checked
}

/** R4：diff 语义 —— 墓碑永不指向旧文件。 */
function checkDiff (ir) {
  const diffViews = ir.views.filter(v => v.type === 'diff')
  let diffNodes = 0
  ir.entities.forEach((e, i) => {
    if (e.diff === undefined) return
    diffNodes++
    const p = `entities[${i}](${e.id}).diff`
    if (diffNodes > 0 && diffViews.length === 0) {
      err('R4.diff-without-view', p, '有 diff 节点但没有 type=diff 的视图（数据与视图不一致）')
    }
    const { kind, anchor, origin, fileDeleted } = e.diff
    if (!anchor || typeof anchor.file !== 'string') {
      err('R4.anchor-missing', `${p}.anchor`, 'diff 节点必须有 anchor.file/line —— 墓碑也必须落到现存代码')
      return
    }
    if (origin !== undefined) {
      if (origin.file === anchor.file && origin.line === anchor.line && kind === 'removed') {
        err('R4.tombstone-points-old', `${p}.anchor`, 'removed 节点的 anchor 与 origin 完全重合：墓碑落点必须是新代码位置，不能是旧位置')
      }
    }
    if (kind === 'removed') {
      if (anchor.basis !== 'hunk-anchor' && anchor.basis !== 'file-start') {
        err('R4.removed-basis', `${p}.anchor.basis`, `removed 节点的 anchor.basis 应为 hunk-anchor（新代码锚点）或 file-start（退化），实际 "${anchor.basis}"`)
      }
      if (anchor.file === origin?.file && anchor.line === origin?.line) {
        err('R4.tombstone-old-file', `${p}.anchor`, 'removed 节点指向旧文件位置；G5 要求只跳当前代码')
      }
    }
    if (fileDeleted === true && anchor.basis !== 'none') {
      err('R4.deleted-file-jumpable', `${p}.anchor.basis`, '整文件删除的节点必须 anchor.basis="none"（不可跳），否则会跳到不存在的文件')
    }
    if (fileDeleted === true && e.location?.basis === 'definition') {
      err('R4.deleted-file-loc', `${p}`, '整文件删除的节点 location.basis 不能是 definition（定义已不存在）')
    }
    // G5 的硬保证：entity.location 就是"点击后去哪"，所以 diff 节点的 location 必须落在当前代码上。
    // removed（墓碑）节点的 location 必须等于 anchor（新代码锚点），basis 必须是 anchor。
    if (kind === 'removed') {
      if (e.location?.basis !== 'anchor') {
        err('R4.tombstone-location', `entities[${i}](${e.id}).location.basis`, `removed 节点的 location.basis 必须是 "anchor"（墓碑落点是新代码锚点），实际 "${e.location?.basis}"`)
      }
      if (e.location?.file !== anchor.file || e.location?.line !== anchor.line) {
        err('R4.tombstone-location', `entities[${i}](${e.id}).location`, `removed 节点的 location 必须等于 diff.anchor（${anchor.file}:${anchor.line}），实际 ${e.location?.file}:${e.location?.line}；否则点击会落到旧代码`)
      }
      if (origin !== undefined && e.location?.file === origin.file && e.location?.line === origin.line) {
        err('R4.tombstone-location', `entities[${i}](${e.id}).location`, 'removed 节点的 location 与旧位置 origin 重合：等于在跳旧文件，违反 G5')
      }
    }
    if (kind === 'added' && e.location?.basis === 'anchor') {
      err('R4.added-anchor', `entities[${i}](${e.id}).location.basis`, 'added 节点的 location 不应是 anchor（新符号有真实定义行，应给 definition）')
    }
    if ((anchor.basis === 'hunk-anchor' || anchor.basis === 'file-start') && kind !== 'removed') {
      warn('R4.anchor-basis', `${p}.anchor.basis`, `${kind} 节点通常用 definition/first-hunk/signature，hunk-anchor 只用于墓碑`)
    }
    if (kind === 'added' && origin !== undefined) {
      warn('R4.added-has-origin', `${p}.origin`, 'added 节点一般没有旧位置（origin 多余）')
    }
  })
  return diffNodes
}

/** R5 + R6 + R7：视图边单一性、规模预算、折叠可见性。 */
function checkViews (ir) {
  const kindCount = new Map()
  ir.relations.forEach(r => kindCount.set(r.kind, (kindCount.get(r.kind) ?? 0) + 1))
  const byId = new Map(ir.entities.map(e => [e.id, e]))

  ir.views.forEach((v, i) => {
    const p = `views[${i}](${v.id})`
    if (Array.isArray(v.edge?.kind)) {
      err('R5.multi-edge-kind', `${p}.edge.kind`, '一个视图只能有一种边（P1）；要两种关系请拆成两个视图')
    }
    const present = kindCount.get(v.edge.kind) ?? 0
    if (present === 0) {
      warn('R5.empty-edge-kind', `${p}.edge.kind`, `IR 里没有任何 kind="${v.edge.kind}" 的关系；该视图会渲染成空态`)
    }

    const resolved = resolveView(ir, v, byId)
    const { maxNodes, maxEdges, mechanism } = v.fold
    const fr = v.foldResult

    if (fr !== undefined) {
      // 生成方自报了折叠后计数：核对它与解析结果一致，且不超预算
      if (fr.nodes > maxNodes) {
        err('R6.over-budget', `${p}.foldResult.nodes`, `折叠后仍有 ${fr.nodes} 个节点 > maxNodes ${maxNodes}；${mechanism === 'aggregate' ? '折叠规则没有生效（+N more 聚合节点必须把数量拉回预算内）' : 'mechanism=none 时超限应直接进空态'}`)
      }
      if (fr.edges > maxEdges) {
        err('R6.over-budget', `${p}.foldResult.edges`, `折叠后仍有 ${fr.edges} 条边 > maxEdges ${maxEdges}`)
      }
      if (resolved.nodes !== fr.nodes) {
        err('R6.foldresult-mismatch', `${p}.foldResult.nodes`, `生成方自报 ${fr.nodes}，按 query 解析应为 ${resolved.nodes}（计数口径：uml/map/diff 按实体计，flow/impact 按端点计）`)
      }
      if (resolved.edges !== fr.edges) {
        err('R6.foldresult-mismatch', `${p}.foldResult.edges`, `生成方自报 ${fr.edges}，按 query 解析应为 ${resolved.edges}`)
      }
      if (fr.hitBudget === true && fr.collapsed === 0) {
        err('R6.silent-truncation', `${p}.foldResult`, 'hitBudget=true 但 collapsed=0：命中预算却没有折叠任何东西，等于静默截断（禁止）')
      }
      if (fr.collapsed > 0) {
        const agg = ir.entities.filter(e => e.kind === 'aggregate')
        if (agg.length === 0) {
          err('R7.no-aggregate-node', `${p}`, `foldResult.collapsed=${fr.collapsed} 但没有 kind="aggregate" 的节点承载被折叠项（+N more 必须可见）`)
        } else {
          const total = agg.reduce((s, e) => s + (e.folded?.count ?? 0), 0)
          if (total !== fr.collapsed) {
            err('R7.aggregate-count', `${p}`, `聚合节点 folded.count 求和 ${total} ≠ foldResult.collapsed ${fr.collapsed}`)
          }
        }
      }
    } else if (resolved.nodes > maxNodes || resolved.edges > maxEdges) {
      if (mechanism === 'aggregate') {
        err('R6.over-budget', p, `按 query 解析出 ${resolved.nodes} 节点 / ${resolved.edges} 边，超过预算 ${maxNodes}/${maxEdges}；aggregate 机制必须在 IR 内产出聚合节点，并回填 foldResult`)
      } else {
        err('R6.over-budget', p, `按 query 解析出 ${resolved.nodes} 节点 / ${resolved.edges} 边，超过预算 ${maxNodes}/${maxEdges}`)
      }
    }

    // R7：折叠可见
    for (const e of ir.entities) {
      if (e.folded === undefined) continue
      if (e.folded.members === undefined) {
        warn('R7.folded-without-members', `entity "${e.id}".folded`, '折叠节点没有 members 清单：图上只显示 +N more，用户无法看到被折叠了什么')
      } else if (e.folded.members.length !== e.folded.count) {
        err('R7.folded-count-mismatch', `entity "${e.id}".folded`, `count=${e.folded.count} 但 members 有 ${e.folded.members.length} 项`)
      }
    }
  })
}

/**
 * 视图解析：给定 view 的 edge/query，算出会渲染出的节点与边。
 * 这套规则必须与生成方实现完全一致，否则 foldResult 对不上（R6.foldresult-mismatch）。
 *   计数口径：flow/impact 一个端点（entity#member）一个盒子；uml/map/diff 一个实体一个节点
 *   （成员在同实体的卡片里是端口，不单独占节点预算）。
 */
function resolveView (ir, view, byId) {
  const { kind, direction } = view.edge
  const filter = view.query.filter ?? {}
  const pass = (e) => {
    if (!e) return false
    if (filter.entityKinds && !filter.entityKinds.includes(e.kind)) return false
    if (filter.scopes && !filter.scopes.includes(e.scope)) return false
    return true
  }
  const rels = ir.relations.filter(r => r.kind === kind)
  let endpoints
  if (view.query.root !== undefined) {
    const depth = view.query.depth ?? 4
    endpoints = new Set([endpointKey(view.query.root)])
    let frontier = [endpointKey(view.query.root)]
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next = []
      for (const a of frontier) {
        for (const r of rels) {
          const A = endpointKey(r.from); const B = endpointKey(r.to)
          const other = direction === 'reverse' ? (B === a ? A : null) : (A === a ? B : null)
          if (other === null || endpoints.has(other)) continue
          if (!pass(byId.get(other.split('#')[0]))) continue
          endpoints.add(other); next.push(other)
        }
      }
      frontier = next
    }
  } else {
    endpoints = new Set()
    for (const r of rels) {
      const A = endpointKey(r.from); const B = endpointKey(r.to)
      if (pass(byId.get(A.split('#')[0])) && pass(byId.get(B.split('#')[0]))) { endpoints.add(A); endpoints.add(B) }
    }
  }
  const unit = (view.type === 'flow' || view.type === 'impact') ? (x => x) : (x => x.split('#')[0])
  const nodes = new Set([...endpoints].map(unit))
  const edges = new Set()
  for (const r of rels) {
    if (!endpoints.has(endpointKey(r.from)) || !endpoints.has(endpointKey(r.to))) continue
    edges.add(`${unit(endpointKey(r.from))}->${unit(endpointKey(r.to))}`)
  }
  return { nodes: nodes.size, edges: edges.size }
}

/**
 * 预算层：UTF-8 字节数。
 *
 * 关键口径：MCP tool result 的 64 KiB 内联上限约束的是**传输形态**，
 * 也就是 JSON.stringify(ir)（无缩进）的字节数，不是磁盘上带缩进的漂亮文件。
 * 所以阈值作用在 minBytes 上；rawBytes 只作为参考一并报出。
 * 留余量：48 KiB warn / 60 KiB error（64 KiB 上限减去 4 KiB 的 result 包装与转义开销）。
 */
const WARN_BYTES = 48 * 1024
const ERROR_BYTES = 60 * 1024
function checkSize (raw, ir) {
  const rawBytes = Buffer.byteLength(raw, 'utf8')
  const minBytes = Buffer.byteLength(JSON.stringify(ir), 'utf8')
  const kib = (minBytes / 1024).toFixed(1)
  const ctx = `传输形态 ${minBytes} B (${kib} KiB)，文件形态 ${rawBytes} B`
  if (minBytes > ERROR_BYTES) {
    err('BUDGET.size', '$', `${ctx} > ${ERROR_BYTES} B (60 KiB)。三选一：① 切 meta.evidenceMode="deferred"（只留 file/line/snippetRef，代码按需取）② 用视图 query 收窄范围、把视图拆成多张 ③ 分片传递（见 §7.3 chunk 协议），不要单条 tool result 硬塞`)
  } else if (minBytes > WARN_BYTES) {
    warn('BUDGET.size', '$', `${ctx} > ${WARN_BYTES} B (48 KiB)。距 60 KiB 硬线不远；首选 evidenceMode="deferred"`)
  }
  return { rawBytes, minBytes }
}

/** R8：evidenceMode 名实相符。slim/deferred 声称不内联代码，就不能偷偷带 code。 */
function checkEvidenceMode (ir) {
  const mode = ir.meta?.evidenceMode
  if (mode === undefined) return 0
  let inlineCodes = 0
  let deferredRefs = 0
  const visit = (ev) => {
    if (ev === undefined) return
    if (typeof ev.code === 'string' && ev.code.length > 0) inlineCodes++
    if (typeof ev.snippetRef === 'string') deferredRefs++
  }
  ir.entities.forEach((e) => {
    visit(e.evidence)
    ;(e.fields ?? []).forEach(f => visit(f.evidence))
    ;(e.methods ?? []).forEach(m => visit(m.evidence))
  })
  ir.relations.forEach((r) => {
    visit(r.evidence)
    ;(r.sites ?? []).forEach(s => { if (typeof s.code === 'string' && s.code.length > 0) inlineCodes++ })
  })

  if (mode === 'slim' || mode === 'deferred') {
    if (inlineCodes > 0) {
      warn('R8.evidence-mode', '$.meta.evidenceMode', `evidenceMode="${mode}" 声称不内联代码，但仍有 ${inlineCodes} 处 evidence.code 非空。要么改回 "inline"，要么剥掉 code 只留 snippetRef（deferred/slim 的收益全在体积上，名不副实会让消费方误判能否离线渲染）`)
    }
    if (deferredRefs === 0 && inlineCodes === 0) {
      warn('R8.evidence-mode', '$.meta.evidenceMode', `evidenceMode="${mode}" 但既没有 snippetRef 也没有 code：悬停将无内容可取`)
    }
  }
  if (mode === 'inline' && deferredRefs > 0) {
    warn('R8.evidence-mode', '$.meta.evidenceMode', `evidenceMode="inline" 但存在 ${deferredRefs} 处 snippetRef；inline 模式下消费方不应再发起按需请求`)
  }
  return inlineCodes
}

/* ─────────────────── 3. 顶层校验流程 ─────────────────── */

export function validate (raw, opts = {}) {
  results.length = 0
  const options = { checkFiles: false, workspaceRoot: opts.workspaceRoot ?? null, size: true, ...opts }
  let ir
  try {
    ir = JSON.parse(raw)
  } catch (e) {
    err('JSON.parse', '$', `不是合法 JSON：${e.message}`)
    return { ok: false, results, stats: null }
  }

  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
  validateSchema(ir, schema, schema, '$')

  if (results.filter(r => r.severity === 'error').length === 0) {
    checkReferences(ir)
    const evidenceChecked = checkEvidence(ir, options)
    const inlineCodes = checkEvidenceMode(ir)
    const diffNodes = checkDiff(ir)
    checkViews(ir)
    const size = options.size ? checkSize(raw, ir) : { rawBytes: Buffer.byteLength(raw, 'utf8'), minBytes: Buffer.byteLength(JSON.stringify(ir), 'utf8') }
    const viewStats = ir.views.map(v => ({
      id: v.id,
      type: v.type,
      ...(v.facet ? { facet: v.facet } : {}),
      edge: `${v.edge.kind}/${v.edge.direction}`,
      ...resolveView(ir, v, new Map(ir.entities.map(e => [e.id, e]))),
    }))
    const stats = {
      schemaVersion: ir.schemaVersion,
      bytes: size.minBytes,
      rawBytes: size.rawBytes,
      kib: Number((size.minBytes / 1024).toFixed(1)),
      evidenceMode: ir.meta.evidenceMode,
      inlineCodes,
      entities: ir.entities.length,
      relations: ir.relations.length,
      views: ir.views.length,
      diffNodes,
      evidenceChecked,
      relationKinds: [...new Set(ir.relations.map(r => r.kind))].sort(),
      viewStats,
    }
    return { ok: !results.some(r => r.severity === 'error'), results, stats }
  }
  return { ok: false, results, stats: null }
}

/* ─────────────────── 4. --selftest 内建正/负样例 ─────────────────── */

function loadSample () {
  return readFileSync(SAMPLE_PATH, 'utf8')
}

function selftest () {
  const cases = []
  const sample = loadSample()
  cases.push(['正例：spec/sample.ir.json 原样通过', sample, (r) => r.ok])

  const broken = [
    ['负例：悬空 relation 端点', (ir) => { ir.relations[0].to.entity = 'NoSuchEntity' }],
    ['负例：成员不属于该实体', (ir) => { ir.relations[2].from.member = 'notAMethod' }],
    ['负例：evidence 行数对不上', (ir) => { ir.entities[0].evidence.endLine += 3 }],
    ['负例：视图混两种边', (ir) => { ir.views[0].edge.kind = ['calls', 'extends'] }],
    ['负例：超预算且声称已折叠', (ir) => { ir.views[0].fold.maxNodes = 3; ir.views[0].foldResult.nodes = 3 }],
    ['负例：墓碑指向旧位置', (ir) => {
      ir.entities.push({
        id: 'staleSymbol', kind: 'function', name: 'staleSymbol', scope: 'symbol',
        location: { file: 'a.ts', line: 10, column: 1, basis: 'anchor' },
        diff: {
          kind: 'removed',
          anchor: { file: 'a.ts', line: 10, column: 1, basis: 'hunk-anchor' },
          origin: { file: 'a.ts', line: 10, column: 1 },
        },
      })
      ir.views.push({ id: 'view.diff', type: 'diff', edge: { kind: 'diff-change', direction: 'forward' }, query: {}, fold: { maxNodes: 60, maxEdges: 120, mechanism: 'aggregate', aggregationOrder: ['directory'], aggregateLabel: '+{n} more' } })
    }],
    ['负例：墓碑的 location.basis 不是 anchor', (ir) => {
      ir.entities.push({
        id: 'goneSymbol', kind: 'function', name: 'goneSymbol', scope: 'symbol',
        location: { file: 'a.ts', line: 40, column: 1, basis: 'definition' },
        diff: {
          kind: 'removed',
          anchor: { file: 'a.ts', line: 40, column: 1, basis: 'hunk-anchor' },
          origin: { file: 'a.ts', line: 12, column: 1 },
        },
      })
      ir.views.push({ id: 'view.diff', type: 'diff', edge: { kind: 'diff-change', direction: 'forward' }, query: {}, fold: { maxNodes: 60, maxEdges: 120, mechanism: 'aggregate', aggregationOrder: ['directory'], aggregateLabel: '+{n} more' } })
    }],
    ['负例：宿主私有字段写成非 x- 前缀', (ir) => { ir.meta.dshSlot = { id: 'main' } }],
    ['负例：uml 视图缺 facet', (ir) => { delete ir.views[0].facet }],
    ['负例：schemaVersion 非语义化', (ir) => { ir.schemaVersion = 'v1' }],
    ['负例：绝对路径进 IR', (ir) => { ir.entities[0].location.file = 'D:/repo/src/index.ts' }],
  ]
  for (const [name, mutate] of broken) {
    const ir = JSON.parse(sample)
    mutate(ir)
    cases.push([name, JSON.stringify(ir), (r) => !r.ok && r.results.some(x => x.severity === 'error')])
  }
  // 只引发 warning 的负例（验证器按设计不拒绝，但必须给出警告）
  const warned = [
    ['警告例：slim 却内联了代码', (ir) => { ir.meta.evidenceMode = 'slim' }, 'R8.evidence-mode'],
  ]
  for (const [name, mutate, code] of warned) {
    const ir = JSON.parse(sample)
    mutate(ir)
    cases.push([name, JSON.stringify(ir), (r) => r.ok && r.results.some(x => x.severity === 'warn' && x.code === code)])
  }

  let pass = 0
  const lines = []
  for (const [name, text, judge] of cases) {
    const r = validate(text)
    const verdict = judge(r)
    if (verdict) pass++
    const first = r.results.find(x => x.severity === 'error') ?? r.results[0]
    lines.push(`${verdict ? 'PASS' : 'FAIL'}  ${name}`)
    if (first) lines.push(`        → ${first.severity} ${first.code} @ ${first.path}: ${first.message.slice(0, 110)}`)
  }
  console.log(lines.join('\n'))
  console.log(`\nselftest: ${pass}/${cases.length} 通过`)
  return pass === cases.length
}

/* ─────────────────── 5. CLI ─────────────────── */

function main (argv) {
  const args = argv.slice(2)
  if (args.includes('--selftest')) {
    const ok = selftest()
    process.exit(ok ? 0 : 1)
  }
  const json = args.includes('--json')
  const checkFiles = args.includes('--check-files')
  const files = args.filter(a => !a.startsWith('--'))
  if (files.length === 0 || files.length > 1) {
    console.error('用法: node spec/validate.mjs <ir.json|-> [--check-files] [--json]')
    console.error('      node spec/validate.mjs --selftest')
    console.error('      curl -s http://127.0.0.1:<port>/e/<id>.json | node spec/validate.mjs -')
    process.exit(2)
  }
  const file = files[0]
  let raw
  try {
    // `-` 表示从 stdin 读：让"GET /e/<id>.json 通过校验器"可以直接管道执行
    raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8')
  } catch (e) {
    console.error(`读取失败: ${file}: ${e.message}`)
    process.exit(2)
  }
  const r = validate(raw, { checkFiles, workspaceRoot: 'D:/dsh-mydsh/deepseek-harness' })
  if (json) {
    console.log(JSON.stringify({ file, ok: r.ok, stats: r.stats, results: r.results }, null, 2))
  } else {
    const errors = r.results.filter(x => x.severity === 'error')
    const warnings = r.results.filter(x => x.severity === 'warn')
    if (r.stats) {
      const s = r.stats
      console.log(`EHM IR ${s.schemaVersion} — ${file}`)
      console.log(`  实体 ${s.entities} · 关系 ${s.relations} · 视图 ${s.views} · 传输体积 ${s.bytes} B (${s.kib} KiB) · 文件体积 ${s.rawBytes} B · evidenceMode=${s.evidenceMode}`)
      console.log(`  关系类型: ${s.relationKinds.join(', ')}`)
      for (const v of s.viewStats) console.log(`  视图 ${v.id}: ${v.nodes} 节点 / ${v.edges} 边  (${v.edge})`)
      console.log(`  证据 ${s.evidenceChecked} 处${s.diffNodes ? ` · diff 墓碑 ${s.diffNodes} 个` : ''}`)
    }
    for (const x of warnings) console.log(`  warn  ${x.code} @ ${x.path}: ${x.message}`)
    for (const x of errors) console.log(`  ERROR ${x.code} @ ${x.path}: ${x.message}`)
    const n = r.results.length
    console.log(r.ok
      ? `\n✓ 通过${n ? `（${warnings.length} warning）` : ''}`
      : `\n✗ 失败：${errors.length} error / ${warnings.length} warning`)
  }
  process.exit(r.ok ? 0 : 1)
}

const isCli = process.argv[1] !== undefined && /(^|[\\/])validate\.mjs$/.test(process.argv[1])
if (isCli) main(process.argv)
