# EHM IR 规范（1.0.0）

> 定义 EHM 的**唯一可移植边界**：一份 JSON 里该有什么、不该有什么，以及 viewer 与 host 如何用消息互相驱动。任何 Agent 产出 IR，任何宿主渲染 IR。**本文之外不允许出现新的字段语义。**
> 配套：`ehm.ir.schema.json`（机器契约）、`sample.ir.json`（12 实体/13 关系真实样例）、`validate.mjs`（零依赖校验器）。

## 0. 一页结论

**一句话**：IR 只描述「有哪些实体、谁连谁、证据在哪一行、这张图问什么问题」；**不描述坐标、不描述颜色、不描述任何宿主 API**。

十条硬决定：

1. **IR 内没有宿主概念**：没有 `slot`/`service`/`ctx.*`/`panellist`。宿主差异只有两个出口：`x-<host>` 扩展、宿主侧跳转模板（§6.2）。
2. **IR 内没有坐标与样式**：没有 `x/y/width/height`，没有 `color/font/stroke`。像素属 layout，颜色属 render（且只表达状态，P5）。
3. **关系必须带证据**：`evidence{file,line,code}` + `provenance(lsp|ast|heuristic)` + `confidence(0-1)`；没有证据的关系不得进 IR —— 它决定"点击能不能跳、跳得准不准"。
4. **一个视图只有一种边**（P1）：`view.edge.kind` 是**标量**。要两种关系 = 两张图。
5. **视图是「查询 + 折叠参数」**，不是另一份数据：`entities`/`relations` 是去重的池子，视图只做引用与过滤。
6. **diff 墓碑永不跳旧文件**（G5）：`removed` 的 `location` 必须等于 `diff.anchor`、`location.basis` 必须是 `anchor`；旧位置只进 `diff.origin`，永不是跳转目标。
7. **规模可机器校验**：折叠后 ≤60 节点 / ≤120 边。`foldResult` 是**数据**（生成方算好、validate 交叉核对）；超限未折叠 = error，静默截断 = error。
8. **协议命名空间 `ehm.*`**：viewer→host 五个、host→viewer 四个，payload 均有 JSON Schema 片段（§7）；**无任何宿主回调时 viewer 必须优雅降级**。
9. **版本语义化**：MAJOR 破坏 / MINOR 只加可选字段 / PATCH 只修文档。宿主字段一律 `x-<name>`，不得影响其它宿主。
10. **IR 消费是纯函数** `render(ir, container, options)`，内部不含任何"去某处拉数据"的逻辑。依据：MCP client 只桥接 tools、不桥接 resources/prompts（`packages/mcp/mcp-client/README.zh.md:12`「本包只桥接工具；MCP 资源与提示词不受支持」、`:191`；`src/connection.ts:240` 传 `{capabilities:{}}`），数据只能被**推**过来。

**规模现实（实测 §7.5）**：样例 12 实体/13 关系 = 27.9 KiB（传输形态）。按实测单位成本外推，**60 KiB 内联预算只够约 18–27 个实体**。"60 节点上限"是**屏幕预算**，不是**单条传输预算** —— 跨宿主分发必须靠 `deferred`/`slim` 或分片。

## 1. 为什么是 IR

上一版原型（`prototypes/v14/`）把三件事焊死：模型手写、布局绑 dagre 参数、渲染绑 DOM。结果"图"只能活在那一个 demo 里 —— 换布局要改模型，换宿主（webview / 单文件 HTML / MCP iframe）要重写渲染器。

### 1.1 五层分离

```
   源码 ──分析器──►  IR(model)  ──纯 JSON──┬──► layout      坐标（dagre/ELK/自研列布局）
                    entities/relations     ├──► render      样式+绘制（DOM-SVG/Canvas/导出）
                    只讲四件事：有谁、       ├──► interaction 手势/消息（§7 协议）
                    谁连谁、证据在哪、       └──► jump        位置→动作（§6 模板）
                    这张图问什么问题
```

判据：**改 layout 层，schema 不动一个字节；换宿主，IR 逐字节相同。** 输入链：源码→IR；IR+视口→layout；IR+坐标+主题→render；IR 的 `location`→jump。

### 1.2 消费契约：纯函数，禁止拉数据

```js
render(ir, container, options) → handle   // 不读磁盘、不发请求、不读全局状态
```

证据可以内联（`inline`）→ 完全离线；也可以只给 `snippetRef`（`deferred`/`slim`）→ 悬停时才需宿主配合，**缺了必须仍能画图**（气泡退化为 `file:line`）。这不是洁癖，是两条事实逼出来的：① MCP 只能**推**不能**拉**（§0-10）；② 推送有 **64 KiB** 内联上限（Cowork 的 `CallToolResult`），超了不推。所以 **IR 必须自足** —— 最低要求是"光靠 `file:line` 就能画图并跳转"，丰富度都是可选加分项。

### 1.3 契约分层：必读子集 vs 可选丰富度

第三方实现不必实现全部字段：

| 层 | 字段 | 效果 |
| --- | --- | --- |
| **L0 必读**（最小消费契约） | `schemaVersion`、`entities[].{id,kind,name,location}`、`fields/methods[].{name,location}`、`relations[].{id,kind,from,to}`、`views[]` | 能画、能跳，**不好看** |
| **L1 推荐** | `+ relations[].label`、`views[].{edge,fold,foldResult}`、`entities[].{stereotype,summary,size}`、`methods[].{params,returns}` | 有语义标签、折叠、档位，**可读** |
| **L2 完整** | `+ evidence`、`provenance`/`confidence`、`sites[]`、`diff`、`heat` | 证据气泡、可信度、墓碑、调用点跳转，**产品形态** |

**实现可停在任意层；数据不得为迁就低层实现而删字段**：只读 L0 的渲染器拿到 L2 数据必须正常出图（忽略未知字段）。

## 2. 概念模型

`kind`：`module`（模块入口）/ `file` / `class`（含抽象）/ `interface` / `function` / `type` / `const` / `capability` / `aggregate`（`+N more`）/ `unknown`。`capability` 是刻意选的**通用词**：说的是"能力不在本工作区，因此没有定义可跳"，不对应任何单一宿主的服务注册机制 —— 换宿主同样的东西可能叫别的名，IR 不用改。`scope`：`dir`→`file`→`symbol`（+`external`）；**下钻不是操作，只是 `query.filter.scopes` 的取值变化**，IR 里没有"展开状态"。**成员（字段/方法）不是实体**，是卡片内的行（端口），挂在 `entity.fields[]`/`methods[]` 下 —— 否则规模上限会被成员数吃光（§7.5）。

> **一个必须区分的边界**：IR 的**字段名与语义**里没有任何宿主概念；但 `evidence.code` 是**被分析仓库的逐字源码**、`entity.name`/`qualifiedName` 是**被分析代码里的真实标识符**——它们出现 `this.ctx.tokenMeter` 之类字样，是在**如实记录那个项目的代码**，不是本规范在定义宿主概念。样例里那 4 个 `capability` 实体就是这类：`name` 照抄源码里的名字（`tokenMeter`），`kind` 一律是通用词 `capability`，`scope` 是 `external`（无定义可跳）。

### 2.1 装饰

`stereotype`（小写 kebab：`plugin`/`abstract`/`sole-implementation`/`capability`/`framework-base`/`function`，卡头小标签，**宿主中立角色词**，不写框架名）、`summary`（≤200 字，"它是干什么的"；**不换行、不进图第二行**）、`size`（`L`/`M`/`S`，**语义强调档位**，不是像素）、`heat`（0..1，render 映射成强调色/亮度）、`entry`（bool，入口/根候选）、`diff`（§5）。

### 2.2 关系

| kind | 方向 | 画 | 用在 | kind | 方向 | 画 | 用在 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `calls` | from 调 to | ✅ | Flow(forward)/Impact(reverse) | `uses` | from 使用 to | ✅ | 弱依赖 |
| `imports` | from 依赖 to | ✅ | Map | `contains` | from 含 to | ❌ **永不画** | 层级事实，用 `entity.parent` |
| `extends`/`implements` | from 继承/实现 to | ✅ | UML 类型面 | `diff-change` | 变更节点之间 | ✅ | Diff |

`contains` 保留在 schema 里是让分析器**如实记录**，不是让渲染器画 —— 它会和层级缩进重复，在 60 节点图上是纯噪声。

### 2.3 证据、来源、可信度（决定"能不能跳"）

```json
"evidence": { "file": "packages/compaction/compaction-basic/src/index.ts", "line": 246,
              "code": "    return summarizeWithLlm(this.ctx, config, input, agent, signal)" },
"provenance": "ast", "confidence": 0.98
```

`evidence` = 促成这条关系的**真实源码位置**（`code` 逐字、不改写/不格式化，行数 = `endLine-line+1`）；`provenance` = `lsp` 语言服务器 / `ast` 静态解析 / `heuristic` 猜测；`confidence` = 0..1，**这一条关系**的把握。消费方用途：证据进悬停气泡且是**跳转第一依据**（点边→跳 evidence 行）；`heuristic` 或 `confidence<0.8` 的边渲染虚线、点击先给候选。

**写死的语义规则**（回答"`meta.capabilities` 会不会让人误判"）：① 可信度**永远只由逐条的 `provenance` + `confidence` 表达**；② `meta.generator.capabilities.{lsp,git}` 只是**生成方自述**，用于解释"为什么有些边是 heuristic"，**禁止**用它推断任何单条边的可信度（validate 不检查、消费方不读）；③ 缺失时的假设：`provenance` 缺 → 按 `heuristic`、`confidence` 缺 → 按 `0.5`（二者在 schema 里 required，"缺失"只在不合法数据时发生，此时按此降级、**不得崩溃**）；④ 可信度**不参与布局、不参与尺寸**，只影响线的样式与点击行为。

### 2.4 位置模型

`location` = `{file, line, column?, endLine?, symbol?, basis?}`。`file` 是**工作区相对路径**（POSIX 分隔符，无反斜杠/前导 `/`/`..`，schema pattern 强制）；绝对路径只在宿主侧生成，IR 内永不出现。`line`/`column` 是 **1-based**（LSP 的 0-based 由生成方转换后写入，消费方无需知道 LSP 存在）。`basis` ∈ `definition`（声明处）/ `usage`（使用处，外部能力无定义）/ `anchor`（墓碑在新代码的落点）—— **它本身编码了点击行为**。

## 3. 字段表

> 机器可读版见 `ehm.ir.schema.json`；"必"=required，"读"=见 §1.3。

### 3.1 顶层与 `meta`

| 字段 | 类型 | 必 | 读 | 含义 / 示例 |
| --- | --- | --- | --- | --- |
| `schemaVersion` | `MAJOR.MINOR.PATCH` | ✔ | L0 | `"1.0.0"` |
| `meta`/`entities`/`relations`/`views` | object / array×3 | ✔ | L0 | 元信息 / 实体池 / 关系池 / 视图（池去重，视图只引用） |
| `diff` / `diagnostics` | object / array | ✖ | L2/— | diff 上下文（仅 diff IR）/ `{severity,message,file?,line?,code?}` 不进图 |
| `x-<host>` | object | ✖ | — | 宿主扩展（§8.2） |
| `meta.locale`/`.generatedAt`/`.evidenceMode` | string / date-time / `inline\|deferred\|slim` | ✔ | | 内容语言（影响 summary/label，不影响字段名）/ 生成时间 / 证据到达方式（§3.4） |
| `meta.generator.{name,version,mode}` | string / semver / `static\|lsp-assisted\|manual` | ✔ | | 谁产出的 |
| `meta.generator.capabilities.{lsp,git}` | bool | ✖ | | **生成方自述**，禁止据此推断单条关系可信度（§2.3-②） |
| `meta.workspace.root`/`.vcs.{kind,base,head}` | string / `git\|none` | root ✔ | | **不透明工作区名**（IR 内所有 `file` 相对它，解析成绝对路径是宿主的事）/ 版本信息 |

### 3.2 `entity`

| 字段 | 类型 | 必 | 含义 |
| --- | --- | --- | --- |
| `id` | string | ✔ | 稳定标识。**禁止数组下标/随机数**（会毁掉 diff 语义与缓存） |
| `kind` / `scope` | enum(10) / `dir\|file\|symbol\|external` | ✔ | §2 |
| `name` / `qualifiedName` | string ≤256 / ≤512 | ✔/✖ | 展示名（最后一段，不带宿主前缀）/ 语言内限定名 |
| `location` | position | ✔ | 定义位置（**点击节点去哪**） |
| `parent` / `folded` | entity id / `{count, members[]}` | ✖ | 所属实体（层级事实，不画边）/ 折叠信息（**只在聚合节点上**） |
| `stereotype`/`summary`/`size`/`heat`/`entry` | §2.1 | ✖ | 装饰 |
| `diff` / `evidence` | object / evidence | ✖ | 变更状态（§5）/ 该实体第一手证据 |
| `fields[]` / `methods[]` | array | ✖ | 卡片内的行（§3.3） |

### 3.3 `field` / `method`

| 字段 | 类型 | 必(f/m) | 含义 |
| --- | --- | --- | --- |
| `name` | string | ✔/✔ | 行上的显示名 |
| `id` | string | —/✔ | **方法 id —— 关系的 `member` 引用它**（用 id 不用 name，重载时 name 不唯一） |
| `type`/`params`/`returns`/`signature` | string | 各自 ✖ | 字段类型 / 参数表 / 返回类型 / 完整签名（`signature` 缺省由前后两者拼） |
| `visibility`/`abstract`/`static`/`summary` | `+ \| - \| # \| ~` / bool / ≤200 字 | ✖ | 可见性 / 修饰符 / 行注释 |
| `location` / `evidence` | position / evidence | ✖ | **该行的跳转目标** / 该行代码块 |

### 3.4 `relation`、`site` 与 `evidence`

| 字段 | 类型 | 必 | 含义 |
| --- | --- | --- | --- |
| `id`/`kind`/`from`/`to` | string / enum(7) / endpoint / endpoint | ✔ | 标识 / §2.2 / `{entity, member?}` —— **成员级端点是一等公民**（§3.5） |
| `evidence`/`provenance`/`confidence` | evidence / enum / 0..1 | ✔ | 促成这条关系的源码（悬停+跳转依据）/ §2.3 |
| `label` | string ≤80 | ✖ | **动作目的**（"触发手动压缩"，不是"调用了"） |
| `sites[]` | array<site> | ✖ | 同一对端点的全部调用点；`×N` = `sites.length` |
| `external`/`cycle`/`role` | bool / `affected\|context` | ✖ | 工作区外 / 成环 / **仅 diff-change** 的可见性修饰（不是第二种边类型） |

`site` = `{file,line,column?,endLine?,code?,snippetRef?,form?}`，`form ∈ direct|method|ctor|reexport|dynamic`。**`sites[]` 就是"点调用点→跳调用处"的数据源**：点第 k 行跳 `sites[k].file:line:column`。

`evidence` = `{file,line,column?,endLine?,code?,snippetRef?,symbol?}`，约束 `anyOf:[required code, required snippetRef]` —— **二选一**，但 `file`+`line` 永远必填：有位置就能跳，有代码才能悬停看内容。`evidenceMode`：`inline`（`code` 全内联，完全离线）/ `deferred`（只给 `file/line/snippetRef`，悬停按需取，气泡退化为 `file:line`）/ `slim`（同 deferred 且**要求 `code` 缺失**，validate warn 名不副实）。三者都满足"能画图"。

### 3.5 `endpoint`：为什么是对象不是裸字符串

```json
"from": { "entity": "BasicCompactionEngine", "member": "summarize" },
"to":   { "entity": "summarizeWithLlm",     "member": "summarizeWithLlm" }
```

① **方法级端点是一等需求，不是未来功能。** 核心交互是"点调用点→跳调用处""点边→跳被调方法"。裸字符串 `"A#m"` 只能靠约定表达"这一端是哪个方法"（脆、无法给好错误）；具名对象让 `member` 与 `entity` **同层**，schema 直接表达，validate 能精确报错。② **`member` 用 id 不用 name**：同名重载的 name 不唯一（`#foo(string)`/`#foo(number)`），只有 id 唯一。③ **可扩展不破坏**：未来加 `memberKind`/`overload` 是加可选字段；裸字符串要改解析规则（MAJOR）。④ **错误可读**：validate 报「成员 "notAMethod" 不属于实体 "commandCompact"（该实体方法：apply, executeCompact）」。

schema 里**没有**独立的 `fromMethod`/`toMethod` —— `from.member`/`to.member` 就是它，一个地址空间不搞两套。三种跳转的数据来源：点节点 → `entity.location` 或 `methods[].location`；点 `×N` 第 k 行 → `relation.sites[k].{file,line,column}`；点边中点 → `relation.to.member` 对应方法的 `location`。

### 3.6 `view`

| 字段 | 类型 | 必 | 含义 |
| --- | --- | --- | --- |
| `id` / `type` | string / `map\|flow\|impact\|diff\|uml` | ✔ | 视图标识 / 问什么问题 |
| `facet` | kebab | **uml 必填** | 同类型下的「面」：`calls`（调用面）/ `types`（类型面） |
| `edge` | `{kind, direction}` | ✔ | **`kind` 是标量**（P1）；`direction ∈ forward\|reverse` 只改渲染方向、**不产生新数据** |
| `query` | `{root?, depth?, filter?}` | ✔ | `root` endpoint（flow/impact 必填）、`depth` 1..8、`filter.{entityKinds,scopes,diffKinds,excludeTests}` |
| `fold` | `{maxNodes,maxEdges,mechanism,aggregationOrder?,aggregateLabel?}` | ✔ | 折叠参数；`aggregateLabel` 必须含 `{n}` |
| `layoutFamily`/`foldResult` | `columns\|layered\|uml\|auto` / `{nodes,edges,collapsed,hitBudget}` | ✖ | **布局族（抽象名，不是算法）**，layout 层映射到具体实现 / **数据**：折叠后实际计数（§4.3） |

**下钻 = 改 `filter.scopes`**（`["dir"]`→`["file"]`→`["symbol"]`），不产生新字段。**`facet` 为什么必须存在**：`uml` 是"类卡片"图，但卡片有两种连线语义 —— 调用面（方法端口连线，原型最终形态）与类型面（继承/实现，UML 惯例）；允许一个视图混两种边就破了 P1，`facet` 让"一个视图一种边"在 UML 卡片形态下依然成立。

## 4. 视图与折叠

### 4.1 一个视图一种边（P1）

```json
{ "id": "view.flow.compactNow", "type": "flow",
  "edge": { "kind": "calls", "direction": "forward" },
  "query": { "root": { "entity": "BasicCompactionEngine", "member": "compactNow" }, "depth": 3 },
  "fold": { "maxNodes": 60, "maxEdges": 120, "mechanism": "aggregate",
            "aggregationOrder": ["depth", "degree"], "aggregateLabel": "+{n} more" } }
```

`edge.direction: reverse` 只是**渲染方向**（Impact 图：被调方在左）—— 同一份 `calls` 数据既能画 Flow 也能画 Impact。五个视图类型：`map`（dir/file + `imports`，列=责任组）/ `flow`（symbol + `calls/forward`，列=调用深度）/ `impact`（symbol + `calls/reverse`）/ `diff`（变更符号 + `diff-change`）/ `uml`（类+成员端口，`calls` 或 `extends|implements`，由 `facet` 定）。只有前四者配 `columns`/`layered`，uml 配 `uml`。

### 4.2 视图解析规则（生成方与消费方必须一致）

① 取 `relations` 中 `kind === view.edge.kind` 的全部关系；② 有 `query.root`：从根按 `direction` 走 ≤`depth` 跳收集端点；③ 否则收集两端都通过 `query.filter` 的关系两端；④ **计数口径**：`flow`/`impact` 一个端点（`entity#member`）一个盒子，`uml`/`map`/`diff` 一个**实体**一个节点（成员是卡片内端口，不占节点预算）；⑤ 边 = 两端都在节点集内的关系，按 `(from节点→to节点)` 去重。**这条口径必须写死在生成方与 validate 里**，否则 `foldResult` 对不上（validate 报 `R6.foldresult-mismatch`）。

### 4.3 折叠与规模

**硬预算**：单视图 ≤**60 节点** / ≤**120 边**。schema 里 `fold.maxNodes ≤ 60`、`maxEdges ≤ 120`（机器可读，写不错）。折叠顺序（依次尝试直到进入预算）：`directory`（同目录 ≥3 合并）→ `degree`（保 Top-N，其余进一个聚合节点）→ `depth`（减一层）。

**`foldResult` 是数据，不是查询参数**（二选一已拍板）：消费方拿到的实体池**已经是折叠过的**，原始数量不复存在 —— 所以只能由生成方算。但它**必须交叉核对**：validate 按 §4.2 自己解析一遍，与 `foldResult` 不一致 = error。"生成方算"不会变成"生成方乱报"。**折叠永远可见**（P3）：`collapsed > 0` 必须有 `kind:"aggregate"` 实体承载、其 `folded.count` 求和 = `foldResult.collapsed`；`hitBudget:true` 且 `collapsed:0` = **静默截断** = error。

## 5. Diff 语义

### 5.1 四类变更（`diffKind` 枚举，按优先级命中即停）

| `diff.kind` | 判定 | 跳转目标 |
| --- | --- | --- |
| `signature` | 同名同 kind，签名文本变了 | 新代码的**签名行** |
| `modified` | 同名同 kind，签名未变，符号区间内 ≥1 行 hunk | 新代码该符号**第一个 hunk** 起始行 |
| `added` | 只在新版本存在 | 新文件定义行 |
| `removed` | 只在旧版本存在 | **新代码中的 hunk 锚点**（墓碑） |

未变更的符号不进入 diff 视图。

### 5.2 墓碑节点（G5 的核心）

用户原文承诺：**"diff 图的跳转只跳转到当前代码。"**

```json
{ "id": "matchLegacy", "kind": "function", "scope": "symbol",
  "location": { "file": "src/legacy.ts", "line": 128, "basis": "anchor" },
  "diff": { "kind": "removed",
            "anchor": { "file": "src/legacy.ts", "line": 128, "basis": "hunk-anchor" },
            "origin": { "file": "src/legacy.ts", "line": 41 },
            "originalSignature": "export function matchLegacy(input: string): Match | null",
            "addedLines": 0, "removedLines": 14 } }
```

三条不能破的规则（validate 逐条查）：① **`location` 必须等于 `diff.anchor`**、`location.basis` 必须是 `anchor` —— `location` 就是"点击后去哪"，只能是新代码落点；② **`diff.origin` 永不作跳转目标**，只用于展示"原来在第 41 行"，anchor 与 origin 重合 = error；③ **整文件删除**：`fileDeleted:true` 且 `anchor.basis` 必须是 `none`（不可跳，只提供"复制原路径"），此时 `location.basis` 不能是 `definition`。`anchor.basis` 六值：`definition`/`first-hunk`/`signature`/`hunk-anchor`/`file-start`/`none` —— **它本身编码了"能不能跳"**。diff 视图的边是 `diff-change`，两段式：`role:"affected"`（变更节点之间，正常绘制）、`role:"context"`（未变更但被牵连，点线低透明度）；`role` **不是第二种边类型**（否则违反 P1），而是同一种边的可见性修饰。

### 5.3 颜色语义映射（P5：颜色只表达状态）

IR 里**一个颜色值都没有**；渲染层按下表映射：

| IR 状态 | 颜色语义 | **不可省略的非颜色标记** |
| --- | --- | --- |
| `added` | success（绿） | 左侧色条 |
| `removed` | error（红） | **删除线** + 名字变淡 + "已删除"文本 |
| `modified` / `signature` | warn（黄） | 左侧色条（signature 另在详情栏说明差异） |
| `heat` 高 / `external` | 强调色 / 无颜色 | 无（热度仅提示）/ **虚线边框**（形状） |
| 选中/聚焦/命中 | 品牌色描边/透明度 | 形状与透明度 |

**约束**：`removed` 必须同时有删除线 + 文本标注，不能只靠红绿区分（NFR-4）；亮暗主题下同一张图含义完全一致 —— 因为分类靠**位置**表达，不靠颜色。

## 6. 位置与跳转契约

### 6.1 IR 只给位置，不给命令

IR 里**没有** `url`/`command`/`editor`/`slot`，只有 `location{file,line,column,symbol}`。把位置变成动作是**宿主**的事。

### 6.2 十种跳转目标模板（宿主侧配置，不属于 IR）

| # | 目标 id | 模板（示意） | 可用性 |
| --- | --- | --- | --- |
| 1 | `sidebar` | `open(file,{line})` | 恒可用（默认） |
| 2 | `vscode` | `code -g {abs}:{line}:{column}` | 探测 PATH/注册表；Windows 需解析出 `Code.exe`（裸 `code` 是 .cmd） |
| 3 | `cursor` / `windsurf` | `cursor -g {abs}:{line}:{column}` | 同上 |
| 4 | `jetbrains` | `idea --line {line} --column {column} {abs}` | 同上（idea/webstorm/pycharm/rider/studio） |
| 5 | `sublime` / `notepadpp` | `subl {abs}:{line}:{column}` / `notepad++ -n{line} -c{column} {abs}` | 同上 |
| 6 | `system` / `explorer` | `start "" {abs}` / `open` / `xdg-open` / 打开所在目录并选中 | 恒可用（只开文件或目录，不定位行） |
| 7 | `clipboard` | `{file}:{line}:{column}` → 剪贴板 | 恒可用，**永远的最后回退** |
| 8 | `command` | 自定义模板，变量 `{file}{abs}{line}{column}{symbol}{workspace}` | 用户启用；argv 逐项传，不过 shell |

> 上表是**宿主能力清单**，不是 IR 的一部分。第二个宿主可以只有第 1/7 项，IR 不需要改 —— 这就是"宿主差异只能通过 `x-*` 与 jumpTarget 模板表达"的落地方式。

### 6.3 一次点击的完整链路

```
点节点 → render 命中 entity.id（不是坐标！）→ viewer 发 ehm.jump { target:{entity,member?}, reason:"node" }
  → host 解析：member? → methods[m].location : entity.location → 按用户配置的模板把 location 变成动作
  → 无 host：viewer 降级为复制 "file:line:col" + toast（§7.4）
```

## 7. 交互事件协议

### 7.1 总则

命名空间 **`ehm.*`**，JSON 消息（WebSocket / postMessage / CustomEvent 皆可，**消息体与传输无关**）；每条都有 `type` + `payload`；**只放 IR 的地址空间**（endpoint / entity.id），不放坐标、不放 DOM、不放宿主 API 名；全部消息都是**可选的** —— 缺任何一条，viewer 仍须能画图（§7.4）。

### 7.2 viewer → host（五个）

```json
"address": { "type": "object", "required": ["entity"],
  "properties": { "entity": {"type":"string","minLength":1}, "member": {"type":"string","minLength":1},
                  "siteIndex": {"type":"integer","minimum":0} },
  "additionalProperties": false }
```

| 消息 | payload 片段 |
| --- | --- |
| **`ehm.jump`** | `{ "target": <address>, "reason": {"enum":["node","site","edge","search"]} }`，required `target`+`reason` |
| **`ehm.copy`** | `{ "text": {"type":"string","maxLength":4096}, "format": {"enum":["file:line:column","file:line","absolute"]} }`，required `text`，`format` 缺省 `file:line:column` |
| **`ehm.select`** | `{ "target": <address> \| null }`（null = 清空） |
| **`ehm.expand`** | `{ "target": <address>, "kind": {"enum":["neighbors","aggregate","directory"]}, "depthDelta": {"type":"integer","minimum":1,"maximum":4} }`，required `target`+`kind` |
| **`ehm.hoverEvidence`** | `{ "snippetRef": {"type":"string"}, "want": {"enum":["code","range","both"]} }` —— 仅 `evidenceMode != "inline"` 时用；host 用同命名空间的 `ehm.hoverEvidenceResult { snippetRef, code(maxLength 8000), found }` 应答 |

### 7.3 host → viewer（四个）

| 消息 | payload 片段 |
| --- | --- |
| **`ehm.theme`** | `{ "mode": {"enum":["light","dark"]}, "tokens": {"type":"object","additionalProperties":{"type":"string"}} }`，required `mode`；**`tokens` 是可选的语义令牌覆盖**（viewer 必须有内置默认） |
| **`ehm.focus`** | `{ "targets": {"type":"array","items":<address>,"maxItems":64}, "mode": {"enum":["select","focus","path","none"]} }`，required 两者 |
| **`ehm.reload`** | `{ "ir": {"type":"object"}, "viewId": {"type":"string"}, "reason": {"enum":["refresh","edit","drill","config"]} }`，`ir` 或 `viewId` 至少给一个 |
| **`ehm.diff`** | `{ "base": {"type":"string"}, "head": {"type":"string"}, "source": {"enum":["patch","git-refs","worktree"]}, "ir": {"type":"object"} }`，required 前三者 |

`ehm.theme` 是**唯一携带样式的消息**，且 `tokens` 可选 —— 这样"换主题不改 IR"成立。

### 7.4 无宿主回调时的降级行为（硬要求）

| 场景 | 降级行为 |
| --- | --- |
| `jump` / `copy` 无人应答 | **降级为复制 `file:line:column` 到剪贴板** + toast「已复制位置」（3s）；剪贴板不可用则显示可选中复制的文本框 |
| `expand` 无人应答 | 只在**本地**展开：聚合节点显示 `folded.members` 清单（IR 里已有），不请求新数据 |
| `hoverEvidence` 无人应答 / `inline` | 气泡显示 **`file:line`**（IR 里永远有）；有 `code` 就用。不显示加载态 |
| `theme` / `focus` / `reload` 未收到 | 用 `prefers-color-scheme` 推断亮暗+内置默认令牌 / 无聚焦态（本地点击仍可临时高亮 1 跳邻居）/ 首渲染用传入 IR，不自动刷新 |
| **单文件 HTML（`file://`）** | 以上全部适用 —— 最强的"无宿主"场景，必须完全可用 |

一句话：**IR 自足 → 图一定画得出；宿主缺席 → 少的是跳转与实时刷新，不是图本身。**

### 7.5 体积预算（实测）

约束来源：MCP Apps 的 Cowork 实现给 `CallToolResult` 的内联上限 **64 KiB**，超出不推数据 → 单条 tool result 里的 IR 必须 <60 KiB（留 4 KiB 给包装与转义）。实测（本样例 = 12 实体 / 13 关系 / 19 方法 / 12 调用点）：

| 形态 | 文件形态 | **传输形态（minified）** | 说明 |
| --- | --- | --- | --- |
| `inline`（样例原样） | 41928 B (40.9 KiB) | **28612 B (27.9 KiB)** | 代码全内联，完全离线 |
| `deferred` | 38299 B (37.4 KiB) | 24803 B (24.2 KiB) | 换掉 61 处 `code`，省 13% |
| `slim`/L0 子集 | 23981 B (23.4 KiB) | 15443 B (15.1 KiB) | 省 46% |

> **关键口径**：预算作用在**传输形态**（`JSON.stringify(ir)`，无缩进）上；磁盘上带缩进的漂亮文件不是传输单位。validate 两个都报，判定用传输形态。

**单位成本**（实测）：实体骨架 ≈345 B / 方法 ≈504 B / 字段 ≈347 B / 关系 ≈581 B / 实体级证据 ≈172 B；`meta`+`views` 固定 ≈2 KB。**外推**：

| 形态 | 每实体 | 60 节点 | 120 节点 | 60 KiB 内能装 |
| --- | --- | --- | --- | --- |
| `inline`（每实体 4 方法+证据+sites） | ≈2369 B | ≈139 KiB ❌ | ≈278 KiB ❌ | **≈18 实体** |
| `deferred` | ≈2067 B | ≈121 KiB ❌ | ≈242 KiB ❌ | ≈19 实体 |
| `slim`/L0 | ≈1287 B | ≈75 KiB ❌ | ≈151 KiB ❌ | ≈26 实体 |

**结论（必须承认）**：**60 节点是屏幕预算，不是单条传输预算。** 64 KiB 下"内容完整"的 IR 实际只装得下 ~18–27 个实体。三条对策（IR 已留好位置）：① **`evidenceMode:"deferred"`/`"slim"`**（代码不进 IR，悬停时 `ehm.hoverEvidence` 按需取，省 13–46%）；② **一个视图一张 IR**（`views` 允许只带一个视图，`ehm.reload` 换 `viewId`，不要一次推四个视图的数据）；③ **分片**（超大图按 `foldResult` 分片，每片独立可渲染、各自聚合节点保证 ≤60 节点，用 `x-<host>.chunk` 串联 —— 宿主私有编排，不进核心契约）。`validate.mjs` 判定：**传输形态 >48 KiB 记 warning，>60 KiB 记 error**；两个数字都打印。

## 8. 版本与扩展

`schemaVersion: "MAJOR.MINOR.PATCH"`（schema pattern 强制三段）。**MAJOR** = 删字段/改语义/收紧枚举/可选改必填（如删 `views[].edge.kind`）；**MINOR** = 只加可选字段/枚举加分支/加诊断码（如加 `method.async`）；**PATCH** = 文档笔误/注释/非语义澄清。消费方规则：**读 `MAJOR`，忽略 `MINOR`/`PATCH` 差异**；`MAJOR` 不认识就拒绝渲染并给可读错误（不要"尽力而为"地画错）。

**宿主私有扩展**：字段名必须匹配 `^x-[a-z0-9]+(-[a-z0-9]+)*$`（schema 的 `patternProperties` 到处挂了这条，`additionalProperties:false` 挡掉其它脏字段）；`x-*` **不得成为任何必填语义的来源**（删掉所有 `x-*` 后 IR 必须仍通过 validate）；一个宿主的 `x-*` 不得影响另一个宿主，跨宿主传递时**未知 `x-*` 必须原样保留**（不删不改）让数据能往返。示例：`"x-dsh": {"panelId":"main"}`、`"x-vscode": {"webviewId":"..."}`、`"x-chunk": {"of":3,"index":0,"group":"flow-1"}`。

**发新版前自检**：① 旧 IR 能否被新 validate 通过？② 新 IR 能否被旧渲染器出图？③ `x-*` 是否全部可删？④ 有没有字段从"有值"变"必填"？（那是 MAJOR）⑤ 枚举是否只增不改？

## 9. 与导出格式的关系

**IR 是模型；mermaid / PlantUML / DOT / SVG 是导出层。** FORMATS.md 的实测结论定了这条边界：

| 事实（FORMATS.md 实证） | 对 IR 的意义 |
| --- | --- |
| Mermaid **不能**连到方法端点（`A::f --> B::g` 解析失败；`A:p1 --> B:p2` 静默变新节点） | **不能**为迁就 mermaid 而取消方法级端点 |
| PlantUML `A::m --> B::p`、DOT `<TD PORT>` 能连成员行 | 导出时 `relation.from.member` 有真实去处 |
| 无文本格式能表达"点方法这行→跳调用点第 3 行"、`×N`、悬停代码、折叠下钻 | 这些只能存在于 IR + viewer，不能寄望导出格式 |

导出是 `IR → string` 的**纯函数**（`IR ─┬► viewer（主交互） ├► mermaid（进 README） ├► plantuml/DOT（方法级精度） └► SVG/PNG（静态分发）`），可单测、不回写。**不做反向解析**（不把 mermaid 读回 IR）：会丢掉证据、可信度、sites，等于丢一半信息。导出必须显式声明损失：`member` 端点 → mermaid 只能到实体级（降级并告警）；`evidence` → 文本格式无位置概念（丢弃）。

## 10. 校验器与样例

三层检查：**结构层**（draft-07 子集：`type/required/enum/pattern/minItems/maxItems/minimum/maximum/anyOf/additionalProperties/patternProperties/$ref`，error）；**语义层 R1–R8**（R1 唯一性 · R2 引用完整性（端点/成员/根）· R3 证据行数自洽 · R4 **墓碑只跳新代码** · R5 视图单一性 · R6 **规模预算与折叠** · R7 折叠可见性 · R8 evidenceMode 名实相符，error/warn）；**预算层**（传输形态 >48 KiB warn、>60 KiB error）。

真实输出（`node spec/validate.mjs spec/sample.ir.json`，exit 0）：

```
EHM IR 1.0.0 — spec/sample.ir.json
  实体 12 · 关系 13 · 视图 4 · 传输体积 28612 B (27.9 KiB) · 文件体积 41928 B · evidenceMode=inline
  关系类型: calls, extends
  视图 view.uml.calls: 11 节点 / 9 边  (calls/forward)
  视图 view.uml.types: 4 节点 / 2 边  (extends/forward)
  视图 view.flow.compactNow: 4 节点 / 3 边  (calls/forward)
  视图 view.impact.compactNow: 2 节点 / 1 边  (calls/reverse)
  证据 49 处

✓ 通过
```

负例自测（`node spec/validate.mjs --selftest`，**13/13 通过**）—— 校验器必须**能失败**才算数。覆盖：悬空 relation 端点、成员不属于该实体、evidence 行数对不上、视图混两种边（schema 拒收数组）、超预算且 `foldResult` 自报不符、墓碑指向旧位置、墓碑 `location.basis` 不是 `anchor`、宿主私有字段非 `x-` 前缀、uml 缺 `facet`、`schemaVersion` 非语义化、绝对路径进 IR，加一条警告例（`slim` 却内联代码 → `R8` warn）。片段：

```
PASS  负例：悬空 relation 端点
        → error R2.dangling-endpoint @ relations[0](extends.BasicCompactionEngine).to: 端点实体 "NoSuchEntity" 不存在
PASS  负例：墓碑的 location.basis 不是 anchor
        → error R4.tombstone-location @ entities[12](goneSymbol).location.basis: removed 节点的 location.basis 必须是 "anchor"（墓碑落点是新代码锚点），实际 "definition"

selftest: 13/13 通过
```

**样例**（`sample.ir.json`）：来源是 `prototypes/v14/demo/uml-model.js` 的 12 个真实类/函数 + 13 条真实关系。每条 `evidence.code` **逐字**取自 `D:/dsh-mydsh/deepseek-harness` 的真实源码（`extract.mjs` 的 `DECLS`/`RELS` 行号），行号与列号由脚本按源码计算，非手写。规模：12 实体 / 13 关系 / 19 方法 / 5 字段 / 12 调用点 / 4 视图；`--check-files` 会回读真实文件核对行号（已通过）。

## 11. 未定问题

| # | 问题 | 倾向 |
| --- | --- | --- |
| Q1 | `heat` 计算口径（行数？被引用数？变更频次？） | 生成方自定，第一阶段不填 |
| Q2 | `sites[]` 上限 200 够不够（巨型文件可上千调用点） | 按文件聚合，保留前 200 + `truncated` 标记（需加字段→MINOR） |
| Q3 | 跨语言 `qualifiedName` 规范化（`A.B::c` vs `A::B.c`） | 各 analyzer 自定，IR 不强制 |
| Q4 | 分片（§7.5 对策 ③）的合并语义 | 先留 `x-*`，第二个宿主真需要时升 MINOR |
| Q5 | `foldResult` 预算明细 / 时间维度（同 IR 两次生成如何比较） | 靠 `entity.folded.members` / 用 `generatedAt` + 外部比较，IR 不做历史 |
| Q6 | `uml` 第三种 facet（如 `states`）/ 双语 `summary` | 加 facet = MINOR；要 `{zh,en}` 需 MAJOR |

## 附：硬性要求落点（逐条可查）

① 无 DSH 概念：全文 + `capability` 通用词 + `x-*` 唯一出口（§8），selftest 有 `dshSlot` 负例。② 五层分离：§1.1；无坐标（§0-2）、无样式（§5.3）。③ `evidence`+`provenance`+`confidence`：§2.3、§3.4（`relation` 三者均 required）。④ 每视图一种边：§4.1 + `edge.kind` 标量 + `facet` + validate R5。⑤ diff 墓碑 + diffKind + 颜色语义：§5.1/§5.2/§5.3 + validate R4。⑥ 规模可机器校验：§4.3 + schema `fold.maxNodes ≤ 60` + validate R6。⑦ 协议 5+4 + payload + 降级：§7.2/§7.3/§7.4。⑧ 版本策略 + `x-*`：§8。
