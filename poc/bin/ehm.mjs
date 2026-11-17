#!/usr/bin/env node
/**
 * ehm —— enhance-mermaid 命令行入口（唯一入口 / npm bin: `ehm`）
 *
 * 一个二进制，多种角色：
 *   · `ehm render`   = **门面**（短命）：找/拉起后端 → 转发 → 打印 JSON/摘要。
 *   · `ehm serve`    = **后端**（长命）：解析 UML、取代码、生成 H5、静态服务、转发 jump。
 *   · `ehm validate` = **校验器**（薄封装）：转交 `spec/validate.mjs`，不重复实现规范。
 *   · `ehm server`   = **后端控制**：status / stop（支持 --json 给机器读）。
 *
 * 从任意 cwd 都可运行（本文件用自身位置定位仓库根 / 校验器）；输入、--root、--out
 * 等路径按调用者的 cwd 解析；后端状态目录由 EHM_HOME 控制（默认 ~/.ehm）。
 *
 * 详细契约见 IMPLEMENTATION-PLAN.md。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const VALIDATOR = join(REPO, 'spec', 'validate.mjs')

/* ──────────────────────────────────────────────────────────
   版本（唯一事实来源：仓库根 package.json）
   ────────────────────────────────────────────────────────── */

let pkgCache
/** 读根 package.json 的 name/version（失败时给安全兜底，不让 --version 崩）。 */
function packageInfo() {
  if (pkgCache !== undefined) return pkgCache
  try {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    pkgCache = {
      name: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : 'enhance-mermaid',
      version: typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0',
    }
  } catch {
    pkgCache = { name: 'enhance-mermaid', version: '0.0.0' }
  }
  return pkgCache
}

/* ──────────────────────────────────────────────────────────
   Help 文本（每个子命令各一份，README 之外的"就地文档"）
   ────────────────────────────────────────────────────────── */

const MAIN_HELP = `ehm —— 把增强 UML 文本变成可交互的代码结构图（${packageInfo().name} ${packageInfo().version}）

用法:
  ehm render <file.ehm.md|-> --root <dir> [--direction lr|tb] [选项]
  ehm serve [--port <n>] [--host <host>] [--quiet]
  ehm validate <ir.json|-> [--json] [--check-files] [--selftest]
  ehm skill [--json]
  ehm server status [--json]
  ehm server stop   [--json]
  ehm --version | -v
  ehm --help | -h

命令:
  render    解析增强 UML（mermaid classDiagram + %% ehm 指令）+ 按 root 取真实代码
            → 生成 H5 快照，打印 URL（后端没跑时自动拉起）
  serve     前台运行后端（长命进程；空闲 30 分钟自动退出）
  validate  用 spec/validate.mjs 校验 EHM IR（等价于直接运行校验器，支持 stdin）
  skill     输出 AI 作者指南 skills/ehm-uml/SKILL.md（--json 返回 {ok,path,content}）
  server    后端状态 / 停止；status、stop 都支持 --json

AI 生成 EHM UML 的硬约束（完整版见 "ehm render --help"，作者指南见 "ehm skill"）:
  1. 类/方法/字段必须给 file/line/lines；lines 覆盖完整声明/实现范围，禁止只给一行
  2. 每个方法必须有 summary="一句话含义"（它做什么 / 为什么存在）
  3. 成员按真实代码写 UML 可见性：+ public / - private / # protected / ~ package，禁止一律 +
  4. file:line 必须对真实源码逐行核对，禁止猜；--root 必须覆盖所有证据文件
  5. 关系与调用点也要 file/line 证据
  6. 关系标签避免出现 -- 等箭头片段（如 --out 会被解析器误判）
  7. 渲染后检查 diagnostics：无 error、尽量无 warning；严格把关时加 --strict

全局:
  -h, --help      显示帮助；"<命令> --help" 显示该命令帮助
  -v, --version   输出版本（${packageInfo().name} <version>，与根 package.json 一致）

状态目录:
  EHM_HOME  覆盖后端状态目录（默认 ~/.ehm）：
            $EHM_HOME/server.json 记录端口/pid，$EHM_HOME/docs/ 存快照

示例:
  ehm render poc/samples/compaction.ehm.md --root D:/dsh-mydsh/deepseek-harness --json
  echo '<mermaid + %% ehm>' | ehm render - --root . --title "架构图"
  ehm render poc/samples/framework.ehm.md --root . --json   # 合规样板：0 diagnostics
  ehm render poc/samples/compaction.ehm.md --root . --strict --json
  ehm validate spec/sample.ir.json
  curl -s http://127.0.0.1:<port>/e/<id>.json | ehm validate -
  ehm skill --json
  ehm server status --json
`

const RENDER_HELP = `ehm render —— 增强 UML → H5 快照（门面：按需拉起后端并转发）

用法:
  ehm render <file.ehm.md|-> --root <dir> [--direction lr|tb] [选项]

输入:
  <file.ehm.md>   含 mermaid classDiagram + %% ehm:v1 指令块的 Markdown/UML 文本
  -               从 stdin 读取（Agent 可直接管道传入：... | ehm render - --root .）

选项:
  --root <dir>           工作区根目录（可重复，按顺序解析相对路径，首个命中者胜）  [必填]
  --title <text>         图标题（缺省取第一个实体名；与 --scope 共同决定快照 key）
  --scope <id>           快照作用域（默认 default；同 (scope,title) 重复渲染 = 覆盖同一 URL）
  --strict               严格模式：歧义命中（多个 root 命中同一相对路径）升级为 error E_AMBIGUOUS；
                         图/URL 仍会产出，但只要有 error 诊断就 exit 1
  --jump-endpoint <url>  后端页面点击时把意图 POST 到该地址（宿主提供；缺省降级为复制 file:line:col）
  --jump-action <spec>   配合 --out 静态文件使用；点击动作，可重复：
                           post:http://127.0.0.1:7333/jump   （POST 跳转意图）
                           open:vscode://file/{absPath}:{line}:{column}（打开 IDE/URL scheme）
                           copy                               （复制 file:line:col）
                         占位符：{file} {absPath} {fileUrl} {line} {column} {symbol}
  --jump-actions <json>  动作数组的 JSON 形式，例如
                           '["post:http://127.0.0.1:7333/jump","open:vscode://file/{absPath}:{line}:{column}","copy"]'
  --jump-post <url>      --jump-action post:<url> 的快捷写法，可重复
  --jump-open <template> --jump-action open:<template> 的快捷写法，可重复
  --theme <dark|light>   页面主题，默认 dark
  --direction <lr|tb>    布局方向：lr=横向为主，tb=纵向为主（默认 tb，适合右侧栏/纵向内联会话）；
                          也接受 horizontal / vertical
  --json                 输出机器可读 JSON（含 ok / strict / url / stats / diagnostics / errors）
  --out <file.html>      额外导出一份 HTML 入口（默认外置引擎；加 --bake 则自包含单文件）
  --local                本地模式：只渲染并写 --out 的 HTML，返回 htmlPath；不启动/连接 ehm server
  --external-engine      （默认）HTML 只引用 ~/.dsh-ehm/js/ehm-viewer-engine.js，不内联 viewer/dagre
  --bake, --inline-engine
                         烘焙模式：把 dagre + viewer 内联进单个 HTML，断网/分享单文件时使用
  --serve                --out 时保留旧的 URL/后端行为（默认 --out 为本地模式）
  --quiet                不打印"已拉起后端"的提示
  -h, --help             显示本帮助

AI 生成 EHM UML 的硬约束（渲染前逐条自检；完整作者指南见 "ehm skill"）:
  1. 完整代码范围：类/方法/字段都必须给 file / line / lines，且 lines 覆盖完整声明：
     方法 = 签名 + 函数体；字段 = 完整类型声明；类 = 头部关键成员。
     只给一行 → W_RANGE_THIN（气泡里看不到完整实现，等于没给证据）。
  2. 方法含义：每个方法都必须给 summary="一句话说明它做什么/为什么存在"；
     缺了 → W_MEMBER_NO_SUMMARY。类（%% entity）与字段也建议给 summary。
  3. UML 可见性：按真实代码写 + public / - private / # protected / ~ package，
     不要一律 +；没写 → W_VISIBILITY_DEFAULT。
  4. 证据核对：file:line 必须对真实源码逐行核对后再写（先读文件 / grep 确认），禁止猜；
     --root 必须覆盖所有证据文件，否则 E_PATH / E_LINE。
  5. 关系 / 调用点也要证据：%% rel 与 %% site 都带 file + line，site 另带 column。
  6. 关系标签里避免出现 -- 等箭头片段（例如 --out）：解析器会把标签误判成边；
     改用中文标签，如「输出文件」。
  7. 渲染后必须看 diagnostics：有 error 必须修；有 warning 建议修；严格把关加 --strict。
  8. 给用户的输出：DSH 内调 ehm_render 后，把返回的 \`\`\`ehm fence 原样放进回答正文作为主要输出；
     CLI 场景把 url 交给用户（可配 --out 导出单文件）。

推荐写法（可直接照抄）:
  \`\`\`mermaid
  classDiagram
    class Parser {
      +parse(text) Ast
      -cache: Map~string, Ast~
    }
    Parser ..> Tokenizer : 读取 token
  \`\`\`
  %% ehm:v1
  %% entity Parser file=src/parser.ts line=10 lines=42 summary="把源码文本解析成 AST"
  %% member Parser.parse file=src/parser.ts line=18 lines=24 summary="解析单个文件；语法错误时返回诊断而不是抛异常"
  %% member Parser.cache file=src/parser.ts line=12 lines=3

状态目录:
  EHM_HOME  覆盖后端状态目录（默认 ~/.ehm；快照数据在 $EHM_HOME/docs/）

输出:
  默认打印人类可读摘要；--json 打印单个 JSON 对象。
  退出码: 0 成功（非 strict 允许 warning）；1 渲染失败或 strict 下有 error；2 用法/读取错误。
`

const SERVE_HELP = `ehm serve —— 前台运行 ehm 后端（长命进程）

用法:
  ehm serve [--port <n>] [--host <host>] [--quiet]

选项:
  --port <n>    监听端口，0 = 随机端口（默认 0）
  --host <host> 监听地址，默认 127.0.0.1
  --quiet       不打印启动横幅
  -h, --help    显示本帮助

说明:
  · 一般不需要手动运行：ehm render 发现没有后端时会自动拉起一个 detached 的 serve。
  · 启动后把 port/host/baseUrl/pid/version 写入 $EHM_HOME/server.json（默认 ~/.ehm/server.json）。
  · 空闲 30 分钟无请求自动退出；Ctrl+C / SIGTERM 立即退出。
  · HTTP 端点: POST /api/render（支持 strict:true）、GET /e/<id>、GET /e/<id>.json、
    GET /e/<id>/stale、POST /jump/<id>、POST /api/shutdown、GET /healthz
`

const VALIDATE_HELP = `ehm validate —— 校验 EHM IR（等价于 node spec/validate.mjs，直接复用校验器）

用法:
  ehm validate <ir.json|-> [--json] [--check-files]
  ehm validate --selftest

参数:
  <ir.json>       要校验的 IR 文件（通常来自 /e/<id>.json 或 spec/sample.ir.json）
  -               从 stdin 读取（管道：curl -s http://127.0.0.1:<port>/e/<id>.json | ehm validate -）
  --json          以 JSON 输出校验结果（{file, ok, stats, results}）
  --check-files   额外读盘核对 evidence 行号是否超出真实文件
  --selftest      跑校验器内建的正/负样例（不读外部文件）
  -h, --help      显示本帮助

退出码（透传自 spec/validate.mjs）: 0 通过（可含 warning）；1 有 error；2 用法/读取错误。
`

const SERVER_HELP = `ehm server —— 后端状态 / 停止

用法:
  ehm server status [--json]   查看后端是否在运行
  ehm server stop   [--json]   让后端退出

选项:
  --json      输出机器可读 JSON：
              status: {ok, running, port, baseUrl, pid, version, docs, uptime, uptimeMs, startedAt}
              stop:   {ok, stopped, port} 或 {ok:false, stopped:false, reason}
  -h, --help  显示本帮助

退出码: status 运行中 0 / 未运行 1；stop 已停止 0 / 未停止 1；用法错误 2。
状态目录: EHM_HOME（默认 ~/.ehm），后端信息在 $EHM_HOME/server.json。
`

const SKILL_HELP = `ehm skill —— 输出 AI 作者指南（skills/ehm-uml/SKILL.md）

用法:
  ehm skill           把 SKILL.md 原文打印到 stdout（可直接喂给 AI / 安装到 DSH）
  ehm skill --json    输出 {ok, path, content} JSON
  ehm skill --help    显示本帮助

说明:
  · 内容 = AI 生成 EHM UML 的完整约束：完整代码范围、方法 summary、UML 可见性、
    证据核对、关系/调用点、诊断修复、DSH 内联渲染（ehm_render 返回的 ehm fence）流程。
  · 文件缺失时 exit 1 并提示（安装不完整）。
  · 安装到 DSH：把 skills/ehm-uml/SKILL.md 复制到 DSH_HOME/skills/ehm-uml/SKILL.md。
`

/* ──────────────────────────────────────────────────────────
   参数解析
   ────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = {
    input: null, roots: [], title: undefined, scope: undefined, jumpEndpoint: undefined,
    jumpActions: [],
    theme: 'dark', json: false, out: null, quiet: false, strict: false, local: false, serve: false,
    direction: 'tb',
    port: 0, host: '127.0.0.1', help: false,
  }
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} 缺少值`)
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') out.help = true
    else if (a === '--root') { out.roots.push(need(i, a)); i++ }
    else if (a.startsWith('--root=')) out.roots.push(a.slice(7))
    else if (a === '--title') { out.title = need(i, a); i++ }
    else if (a.startsWith('--title=')) out.title = a.slice(8)
    else if (a === '--scope') { out.scope = need(i, a); i++ }
    else if (a.startsWith('--scope=')) out.scope = a.slice(8)
    else if (a === '--jump-endpoint') { out.jumpEndpoint = need(i, a); i++ }
    else if (a.startsWith('--jump-endpoint=')) out.jumpEndpoint = a.slice(16)
    else if (a === '--jump-action') { out.jumpActions.push(need(i, a)); i++ }
    else if (a.startsWith('--jump-action=')) out.jumpActions.push(a.slice(14))
    else if (a === '--jump-actions') {
      let parsed
      try { parsed = JSON.parse(need(i, a)) } catch (e) { throw new Error('--jump-actions 必须是 JSON 数组: ' + e.message) }
      if (!Array.isArray(parsed)) throw new Error('--jump-actions 必须是 JSON 数组')
      out.jumpActions.push(...parsed)
      i++
    } else if (a.startsWith('--jump-actions=')) {
      let parsed
      try { parsed = JSON.parse(a.slice(15)) } catch (e) { throw new Error('--jump-actions 必须是 JSON 数组: ' + e.message) }
      if (!Array.isArray(parsed)) throw new Error('--jump-actions 必须是 JSON 数组')
      out.jumpActions.push(...parsed)
    } else if (a === '--jump-post') { out.jumpActions.push('post:' + need(i, a)); i++ }
    else if (a.startsWith('--jump-post=')) out.jumpActions.push('post:' + a.slice(12))
    else if (a === '--jump-open') { out.jumpActions.push('open:' + need(i, a)); i++ }
    else if (a.startsWith('--jump-open=')) out.jumpActions.push('open:' + a.slice(12))
    else if (a === '--theme') { out.theme = need(i, a); i++ }
    else if (a.startsWith('--theme=')) out.theme = a.slice(8)
    else if (a === '--direction') { out.direction = need(i, a); i++ }
    else if (a.startsWith('--direction=')) out.direction = a.slice(12)
    else if (a === '--out') { out.out = need(i, a); i++ }
    else if (a.startsWith('--out=')) out.out = a.slice(6)
    else if (a === '--local') out.local = true
    else if (a === '--external-engine') out.externalEngine = true
    else if (a === '--bake' || a === '--inline-engine') out.bakeEngine = true
    else if (a === '--serve') out.serve = true
    else if (a === '--json') out.json = true
    else if (a === '--quiet') out.quiet = true
    else if (a === '--strict') out.strict = true
    else if (a === '--port') { out.port = Number.parseInt(need(i, a), 10); i++ }
    else if (a.startsWith('--port=')) out.port = Number.parseInt(a.slice(7), 10)
    else if (a === '--host') { out.host = need(i, a); i++ }
    // 裸 `-` 是 stdin 输入（约定），必须在"未知参数"判断之前接住
    else if (a === '-') {
      if (out.input !== null) throw new Error(`多余的位置参数: ${a}`)
      out.input = a
    }
    else if (a.startsWith('-')) throw new Error(`未知参数: ${a}`)
    else if (out.input === null) out.input = a
    else throw new Error(`多余的位置参数: ${a}`)
  }
  if (out.theme !== 'dark' && out.theme !== 'light') throw new Error('--theme 只能是 dark / light')
  const dir = String(out.direction).toLowerCase()
  if (dir === 'lr' || dir === 'horizontal' || dir === 'h') out.direction = 'LR'
  else if (dir === 'tb' || dir === 'vertical' || dir === 'v') out.direction = 'TB'
  else throw new Error('--direction 只能是 lr / tb（也接受 horizontal / vertical）')
  return out
}

/* ──────────────────────────────────────────────────────────
   子命令
   ────────────────────────────────────────────────────────── */

async function cmdRender(argv) {
  const args = parseArgs(argv)
  if (args.help) { console.log(RENDER_HELP); return 0 }
  if (args.input === null) { console.error('缺少输入文件（用 - 表示从 stdin 读）\n'); console.error(RENDER_HELP); return 2 }
  if (args.roots.length === 0) { console.error('缺少 --root（至少一个工作区根目录）'); return 2 }

  const { normalizeJumpActions } = await import('../src/html.mjs')
  let jumpActions
  try {
    const endpointAction = args.jumpEndpoint !== undefined && args.out !== null && /^https?:\/\//iu.test(args.jumpEndpoint)
      ? 'post:' + args.jumpEndpoint
      : null
    const rawActions = args.jumpActions.length > 0
      ? args.jumpActions
      : (endpointAction !== null ? [endpointAction] : [])
    jumpActions = normalizeJumpActions(rawActions)
  } catch (e) {
    console.error('跳转动作配置错误: ' + e.message)
    return 2
  }
  if (args.jumpActions.length > 0 && args.out === null) {
    console.error('--jump-action / --jump-actions 只作用于 --out 静态 HTML；请同时传 --out <file.html>')
    return 2
  }
  if (args.local && args.out === null) {
    console.error('--local 需要同时传 --out <file.html>（CLI 只负责生成并返回本地路径）')
    return 2
  }
  // --out 默认走本地模式：只生成 HTML、返回 htmlPath，不启动 ehm server。
  // 需要旧的 URL/后端能力时显式加 --serve。
  const localMode = args.local || (args.out !== null && args.serve !== true)

  const uml = args.input === '-'
    ? readFileSync(0, 'utf8')
    : readFileSync(resolve(args.input), 'utf8')

  const strict = args.strict === true
  // ── 本地模式（无 ehm server）：解析 → 物化 → 单文件 HTML → 写盘 → 返回路径 ──
  if (localMode) {
    const roots = args.roots.map((r) => resolve(r))
    const scope = args.scope ?? 'default'
    const title = args.title
    const id = createHash('sha1').update(`${scope}\u0000${title ?? ''}\u0000${uml}`, 'utf8').digest('hex').slice(0, 12)
    // 旧 Host 没有 /ehm/engine.js；这种插件式调用先烘焙，避免侧栏必然加载失败。
    const bakeEngine = args.bakeEngine === true || (args.local && args.json && args.quiet && args.externalEngine !== true)
    let built
    try {
      const { renderDocument } = await import('../src/server.mjs')
      built = renderDocument({
        uml,
        roots,
        title,
        theme: args.theme,
        docId: id,
        jumpUrl: null,
        jumpActions,
        strict,
        direction: args.direction,
        htmlPath: resolve(args.out),
        externalEngine: args.externalEngine === true ? true : undefined,
        // 兼容旧 Host：旧版 ehm_render 不会传 --external-engine，也没有 /ehm/engine.js
        // 路由；这种“插件式调用”先烘焙，避免生成一个侧栏必然加载失败的外置 HTML。
        // 新 Host 会显式传 --external-engine，走默认外置链路。
        bakeEngine,
      })
    } catch (e) {
      const msg = String(e && e.message ? e.message : e)
      if (args.json) console.log(JSON.stringify({ ok: false, local: true, error: msg }, null, 2))
      else console.error('ehm render --local 失败: ' + msg)
      return 1
    }
    const diagnostics = built.diagnostics ?? []
    const errors = diagnostics.filter((d) => d.level === 'error')
    if (built.ir === null) {
      const msg = 'UML 解析后没有任何实体'
      if (args.json) console.log(JSON.stringify({ ok: false, local: true, error: msg, diagnostics }, null, 2))
      else console.error('ehm render --local 失败: ' + msg)
      return 1
    }
    const outPath = resolve(args.out)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, built.html, 'utf8')
    const stats = {
      entities: built.ir.entities.length,
      relations: built.ir.relations.length,
      sites: built.ir.relations.reduce((n, r) => n + (Array.isArray(r.sites) ? r.sites.length : 0), 0),
      htmlBytes: Buffer.byteLength(built.html, 'utf8'),
    }
    const result = {
      ok: true,
      local: true,
      strict,
      engineMode: bakeEngine ? 'baked' : 'external',
      id,
      htmlPath: outPath,
      title: built.ir.meta?.title ?? title ?? 'untitled',
      scope,
      stats,
      diagnostics,
      errors,
      renderedAt: built.ir.meta?.generatedAt ?? new Date().toISOString(),
    }
    if (args.json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`EHM 本地渲染完成${strict ? '（strict）' : ''}`)
      console.log(`  html: ${outPath}`)
      console.log(`  实体/关系/调用点: ${stats.entities}/${stats.relations}/${stats.sites}`)
      for (const d of diagnostics) console.log(`  ${d.level} ${d.code} ${d.message}`)
    }
    return strict && errors.length > 0 ? 1 : 0
  }

  const { renderRemote } = await import('../src/facade.mjs')
  const res = await renderRemote({
    uml,
    roots: args.roots.map((r) => resolve(r)),
    title: args.title,
    scope: args.scope,
    jumpEndpoint: args.jumpEndpoint,
    theme: args.theme,
    quiet: args.quiet,
    strict: args.strict,
    direction: args.direction,
  })

  const diagnostics = res.diagnostics ?? []
  const errors = diagnostics.filter((d) => d.level === 'error')

  if (res.ok !== true) {
    const msg = res.error ?? '渲染失败'
    if (args.json) console.log(JSON.stringify({ ok: false, strict, error: msg, diagnostics, errors }, null, 2))
    else { console.error('ehm render 失败: ' + msg); for (const d of diagnostics) console.error(`  ${d.level} ${d.code} ${d.message}`) }
    return 1
  }

  // 可选：额外导出单文件（file:// 兜底 / 分享产物）
  if (args.out !== null) {
    const { renderDocument } = await import('../src/server.mjs')
    const built = renderDocument({
      uml,
      roots: args.roots.map((r) => resolve(r)),
      title: args.title ?? res.title,
      theme: args.theme,
      docId: res.id,
      jumpUrl: null,
      jumpActions,
      roots: args.roots.map((r) => resolve(r)),
      strict,
      direction: args.direction,
      // serve 模式 HTML 走 http://，不能加载 file:// 引擎；强制烘焙。
      bakeEngine: true,
    })
    const outPath = resolve(args.out)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, built.html, 'utf8')
    res.outPath = outPath
  }

  // strict 的判定：只要出现 error 诊断就算失败（exit 1），但图/URL 已经产出，照常打印
  const strictFailed = strict && errors.length > 0
  if (args.json) {
    console.log(JSON.stringify({ ...res, strict, ok: !strictFailed, errors }, null, 2))
  } else {
    console.log(`EHM 渲染完成${strict ? '（strict）' : ''}`)
    console.log(`  url       = ${res.url}`)
    console.log(`  data      = ${res.dataPath}`)
    console.log(`  title     = ${res.title}   scope=${res.scope}`)
    console.log(`  实体/关系  = ${res.stats.entities} / ${res.stats.relations}`)
    console.log(`  调用点    = ${res.stats.sites ?? 0}`)
    console.log(`  html/ir   = ${(res.stats.htmlBytes / 1024).toFixed(1)} KiB / ${(res.stats.irBytes / 1024).toFixed(1)} KiB`)
    if (res.outPath) console.log(`  out       = ${res.outPath}`)
    for (const d of diagnostics) console.log(`  ${d.level.toUpperCase()} ${d.code}  ${String(d.message).split('\n')[0]}`)
    if (strictFailed) console.error(`ehm render: strict 模式判定失败（${errors.length} 个 error）→ exit 1；图/URL 仍然有效`)
  }
  return strictFailed ? 1 : 0
}

async function cmdServe(argv) {
  const args = parseArgs(argv)
  if (args.help) { console.log(SERVE_HELP); return 0 }
  const { startServer } = await import('../src/server.mjs')
  const srv = await startServer({ port: args.port, host: args.host })
  if (!args.quiet) {
    console.log(`ehm server listening on ${srv.url}  (pid ${process.pid})`)
    console.log('按 Ctrl+C 停止；空闲 30 分钟会自动退出。')
  }
  const stop = async () => { await srv.close(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  // 前台常驻：不主动退出
  await new Promise(() => {})
  return 0
}

async function cmdServer(argv) {
  const unknown = argv.filter((a) => a.startsWith('-') && !['--json', '-h', '--help'].includes(a))
  if (unknown.length > 0) { console.error(`ehm server: 未知参数 ${unknown[0]}\n`); console.error(SERVER_HELP); return 2 }
  if (argv.includes('-h') || argv.includes('--help')) { console.log(SERVER_HELP); return 0 }
  const json = argv.includes('--json')
  const sub = argv.find((a) => !a.startsWith('-'))

  const { serverStatus, stopServer } = await import('../src/facade.mjs')

  if (sub === 'status' || sub === undefined) {
    const st = await serverStatus()
    if (!st.running) {
      if (json) {
        console.log(JSON.stringify({
          ok: false,
          running: false,
          reason: st.staleState ? 'stale-state' : 'not-running',
          ...(st.staleState ? { state: st.staleState } : {}),
        }, null, 2))
      } else {
        console.log('ehm server: 未运行')
      }
      return 1
    }
    if (json) {
      console.log(JSON.stringify({
        ok: true,
        running: true,
        port: st.port,
        baseUrl: st.baseUrl,
        pid: st.pid,
        version: st.version,
        docs: st.health.docs,
        uptime: Math.round(st.health.uptimeMs / 1000),
        uptimeMs: st.health.uptimeMs,
        startedAt: st.startedAt,
      }, null, 2))
    } else {
      console.log(`ehm server: 运行中  ${st.baseUrl}  (pid ${st.pid}, v${st.version})`)
      console.log(`  文档数 = ${st.health.docs}, 已运行 ${Math.round(st.health.uptimeMs / 1000)}s`)
    }
    return 0
  }

  if (sub === 'stop') {
    const r = await stopServer()
    if (json) {
      if (r.stopped) console.log(JSON.stringify({ ok: true, stopped: true, port: r.port }, null, 2))
      else console.log(JSON.stringify({ ok: false, stopped: false, reason: r.reason ?? 'unknown' }, null, 2))
    } else {
      console.log(r.stopped ? `ehm server: 已停止（端口 ${r.port}）` : `ehm server: 未停止（${r.reason ?? '未知'}）`)
    }
    return r.stopped ? 0 : 1
  }

  console.error(`未知子命令: server ${sub}（可用 status / stop）\n`)
  console.error(SERVER_HELP)
  return 2
}

/**
 * `ehm validate` —— 直接转交 spec/validate.mjs（唯一校验实现）。
 * 退出码 0/1/2 原样透传；`-` 表示从 stdin 读，这里替子进程把内容喂进去。
 */
function cmdValidate(argv) {
  if (argv.includes('-h') || argv.includes('--help')) { console.log(VALIDATE_HELP); return 0 }
  if (!existsSync(VALIDATOR)) {
    console.error(`ehm validate: 找不到校验器 ${VALIDATOR}（安装不完整？）`)
    return 2
  }
  let input
  if (argv.includes('-')) {
    try {
      input = readFileSync(0, 'utf8')
    } catch (e) {
      console.error(`ehm validate: 读取 stdin 失败：${e && e.message ? e.message : e}`)
      return 2
    }
  }
  const r = spawnSync(process.execPath, [VALIDATOR, ...argv], {
    input,
    encoding: 'utf8',
    env: process.env,
    timeout: 120_000,
  })
  if (r.error) {
    console.error(`ehm validate: 无法启动校验器：${r.error.message}`)
    return 2
  }
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  return typeof r.status === 'number' ? r.status : 1
}

/**
 * `ehm skill` —— 输出 AI 作者指南 skills/ehm-uml/SKILL.md（唯一事实来源是仓库文件）。
 * 默认原样输出正文；`--json` 返回 {ok, path, content}；文件缺失 exit 1。
 */
function cmdSkill(argv) {
  if (argv.includes('-h') || argv.includes('--help')) { console.log(SKILL_HELP); return 0 }
  const unknown = argv.filter((a) => a.startsWith('-') && a !== '--json')
  if (unknown.length > 0) { console.error(`ehm skill: 未知参数 ${unknown[0]}\n`); console.error(SKILL_HELP); return 2 }
  const json = argv.includes('--json')
  const skillPath = join(REPO, 'skills', 'ehm-uml', 'SKILL.md')
  if (!existsSync(skillPath)) {
    if (json) console.log(JSON.stringify({ ok: false, path: skillPath, error: 'skills/ehm-uml/SKILL.md 不存在（安装不完整？）' }, null, 2))
    else console.error(`ehm skill: 找不到 ${skillPath}（安装不完整？）`)
    return 1
  }
  const content = readFileSync(skillPath, 'utf8')
  if (json) console.log(JSON.stringify({ ok: true, path: skillPath, content }, null, 2))
  else process.stdout.write(content)
  return 0
}

/* ──────────────────────────────────────────────────────────
   入口
   ────────────────────────────────────────────────────────── */

async function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === '-h' || cmd === '--help' || cmd === 'help') { console.log(MAIN_HELP); return 0 }
  if (cmd === '-v' || cmd === '--version' || cmd === 'version') {
    const p = packageInfo()
    console.log(`${p.name} ${p.version}`)
    return 0
  }
  if (cmd === 'render') return cmdRender(rest)
  if (cmd === 'serve') return cmdServe(rest)
  if (cmd === 'validate') return cmdValidate(rest)
  if (cmd === 'skill') return cmdSkill(rest)
  if (cmd === 'server') return cmdServer(rest)
  console.error(`未知命令: ${cmd}\n`)
  console.error(MAIN_HELP)
  return 2
}

const isMain = (() => {
  try {
    if (process.argv[1] === undefined) return false
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch { return false }
})()

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((e) => {
      console.error('ehm: ' + (e && e.message ? e.message : e))
      if (process.env.EHM_DEBUG === '1' && e && e.stack) console.error(e.stack)
      process.exitCode = 1
    })
}

export { parseArgs, main, packageInfo }
