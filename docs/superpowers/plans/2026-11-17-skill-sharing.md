# Skill 共享 + 登录页 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 知识库新增 skill 共享：MCP 上传/检索/拉取安装 skill，门户 Skills 模块与 /login 独立登录页。

**Architecture:** 复用 knowledge 全部底座（Bearer 鉴权/限流、guard 扫描、embedder、trigram+向量打分、ToolError 模式、admin CLI），新建 `skill`/`skill_usage` 表与 4 个 MCP 工具、6 个 REST 端点；门户按 SearchPage 模式新增 Skills 页签；登录从模态框迁到独立 /login 路由页（受保护路由白名单：写入与管理后台）。

**Tech Stack:** TypeScript + Fastify 5 + MCP SDK（zod inputSchema）+ Postgres/pgvector + Vue 3 + Ant Design Vue + vitest

**Spec:** docs/superpowers/specs/2026-11-17-skill-sharing-design.md

## Global Constraints

- 限流沿用共享 RateLimiter（60 req/min），REST 与 MCP 同实例
- 敏感扫描：save/update 前对 instructions 与全部文件 content 跑 `scanText(…, guardRules)`，blocked → `ToolError('SENSITIVE_CONTENT', …)`
- 向量可选：embedder 不可用时保存/更新只 push warning 不阻塞；search 静默退化
- 工具错误码风格与文案全中文，复用 `ToolError`（src/tools/save.ts:8）
- name 校验：`SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/`
- files 限制：≤20 个、单文件 ≤64KB、总量 ≤256KB（`Buffer.byteLength` 计，非字符串长度）
- 晋升阈值 `PROMOTION_DISTINCT_USERS = 2`（同 markUsed.ts:15）
- 测试框架 vitest（`npm test`），每个任务先写失败测试
- commit 信息中文 `feat:/fix:` 前缀，末尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`

## Review Focus

1. **路径穿越**：files[].path 含 `../`、绝对路径、反斜杠 → 必须整体拒绝（内容会被 agent 写入本地 skills 目录）——Task 2 测试钉死
2. **字节 vs 字符**：64KB 限制按 UTF-8 字节算（emoji/长中文），`content.length` 会漏判——Task 2 测试钉死
3. **files 整体替换语义**：update 时省略未提文件 = 删除该文件，且 files 未提供时不动原文件——Task 3 测试钉死
4. **零词重叠向量召回**：纯语义查询（trigram < 0.2）仍能召回 skill——Task 4 测试钉死
5. **同用户重复拉取幂等**：同一 user 两次 get_skill，use_count 只 +1——Task 3 测试钉死
6. **登录重定向回环**：未登录访问 /login 自身不得循环跳转；redirect 参数保留并回跳——Task 9 实现后手动验证（web 无单测框架）

**显式缺口（spec 标记「可选低优先」）**：门户管理后台的 skill 状态/删除页面不在本计划内（CLI delete-skill/set-skill-status 已覆盖管理需求）；需要时另开任务。

---

### Task 1: Migration 0003 — skill / skill_usage / search_event.kind

**Files:**
- Create: `migrations/0003_skill.sql`

**Interfaces:**
- Consumes: 无
- Produces: 表 `skill(id, name UNIQUE, description, instructions, files JSONB, scope, tags TEXT[], status DEFAULT 'draft', author, version DEFAULT 1, use_count, last_used_at, embedding vector, created_at, updated_at)`、`skill_usage(skill_id, used_by, note, created_at, UNIQUE(skill_id, used_by))`、`search_event.kind TEXT NOT NULL DEFAULT 'knowledge'`；索引 `idx_skill_scope`、`idx_skill_tags`(gin)、`idx_skill_name_trgm`(gin gin_trgm_ops)、`idx_skill_desc_trgm`(gin, 表达式 `(name || ' ' || description) gin_trgm_ops`)（SQL 语句见 spec「数据库」节，逐字照抄）

- [ ] **Step 1: 写 migration 文件**（spec §数据库的 SQL 逐字落盘，`CREATE EXTENSION IF NOT EXISTS` 不需要——0001 已建）
- [ ] **Step 2: 在本地 dev 库应用并验证**

Run: `psql ... -f migrations/0003_skill.sql && psql ... -c '\d skill'`
Expected: 表与 4 个索引存在；`search_event` 有 `kind` 列

- [ ] **Step 3: Commit** `feat: skill 表与 skill_usage 迁移 + search_event.kind`

### Task 2: save_skill 校验与入库 — src/tools/skill.ts（前半）

**Files:**
- Create: `src/tools/skill.ts`
- Test: `tests/tools/skill.test.ts`

**Interfaces:**
- Consumes: `ToolError`、`checkScope`(save.ts:57)、`scanText`(guard/index.ts)、`normalizeTags`(search/tags.ts)、`Embedder`——签名同 save.ts 用法
- Produces:
  - `export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/`
  - `export interface SkillFile { path: string; content: string }`
  - `export interface SaveSkillInput { name: string; description: string; instructions: string; files?: SkillFile[]; scope?: string; tags?: string[] }`
  - `export interface SkillDeps { aliases: Record<string, string>; guardRules: GuardRules; embedder?: Embedder }`
  - `export function validateSkillFiles(files: SkillFileInput[]): SkillFile[]` — 校验规则（拒绝即 `ToolError('INVALID_SKILL_FILE', 中文原因)`）：path 匹配 `^[^/\\]` 且无 `..` 段、无 `\`、长度 ≤200、basename（大小写不敏感）≠ `'SKILL.md'`；数 ≤20；单 content `Buffer.byteLength ≤ 65536`；总量 ≤262144
  - `export function assembleSkillMd(name: string, description: string, instructions: string): string` — 返回 `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}`
  - `export async function handleSaveSkill(pool, cfg, user: AppUser, input: SaveSkillInput, deps: SkillDeps): Promise<SaveSkillResult>` — `SaveSkillResult = { id: number; status: 'draft'; similar: { id: number; name: string; similarity: number }[]; warnings: string[] }`
  - `export async function findSimilarSkills(pool, cfg, name, description): Promise<SaveSkillResult['similar']>` — `GREATEST(similarity(name,$1), similarity(description,$2)) >= cfg.dedupThreshold`，排除同名自身，LIMIT 3

- [ ] **Step 1: 写失败测试** `tests/tools/skill.test.ts`（参照 tests/tools/ 现有测试的 pool mock/测试库方式）覆盖：合法保存返回 `{status:'draft', similar:[], warnings:[]}`；name 大写/含下划线 → `INVALID_SKILL_NAME`；path 为 `../evil.txt`、`/etc/passwd`、`a\b.txt`、`SKILL.md` → `INVALID_SKILL_FILE`；20 个文件通过、21 个拒绝；64KB 边界（65536 字节通过，65537 拒绝）；敏感内容 → `SENSITIVE_CONTENT`
- [ ] **Step 2: 运行确认 FAIL** — `npx vitest run tests/tools/skill.test.ts`，Expected: FAIL（模块不存在）
- [ ] **Step 3: 实现** validateSkillFiles / assembleSkillMd / findSimilarSkills / handleSaveSkill（保存链：scope 校验复用 checkScope 的 enabled 分支——skill 的 scope 可选，传了才校验；name 唯一冲突 → `ToolError('SKILL_EXISTS', '同名 skill 已存在，请改用 update_skill')`；INSERT 后按 `[name, description, instructions].join('\n')` 生成 embedding，失败 push warning）
- [ ] **Step 4: 运行确认 PASS** — 同命令 Expected: PASS
- [ ] **Step 5: Commit** `feat: save_skill 校验与入库（路径穿越防护 + 相似引导）`

### Task 3: update_skill + get_skill 拉取与晋升 — src/tools/skill.ts（后半）

**Files:**
- Modify: `src/tools/skill.ts`
- Test: `tests/tools/skill.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 全部导出
- Produces:
  - `export interface UpdateSkillInput { name: string; description?: string; instructions?: string; files?: SkillFile[]; scope?: string; tags?: string[] }`
  - `export async function handleUpdateSkill(pool, user, input, deps): Promise<{ ok: true; version: number }>` — 查 author：非作者且非 admin → `ToolError('FORBIDDEN', '仅作者或管理员可修改')`；不存在 → `ToolError('NOT_FOUND', …)`；内容字段实际变化才 `version = version + 1` 并重算 embedding；`files` 提供时**整体替换**（JSONB 覆盖），未提供时保留
  - `export async function handleGetSkill(pool, user, name: string): Promise<{ name: string; description: string; version: number; status: string; files: SkillFile[] }>` — files[0] 为 `{path:'SKILL.md', content: assembleSkillMd(...)}`，后接附加文件；每次成功调用：`INSERT INTO skill_usage … ON CONFLICT (skill_id, used_by) DO NOTHING`，新插入时 `use_count+1, last_used_at=now()`；然后同 markUsed.ts:36-47 的晋升查询（`skill_usage` 表、排除 author、≥2 → `status='verified'`）

- [ ] **Step 1: 追加失败测试**：作者 update files 全量替换（旧文件消失、新文件在）+ version+1；非作者 update → FORBIDDEN；admin（role:'admin' 的 AppUser）可 update；get 返回 SKILL.md 组装 frontmatter（含 name/description 行）+ 附加文件；同 user 两次 get → use_count=1；两个不同非作者 user get → status='verified'
- [ ] **Step 2: 运行确认 FAIL**
- [ ] **Step 3: 实现** 两个 handler
- [ ] **Step 4: 运行确认 PASS**（全文件跑，旧用例不破）
- [ ] **Step 5: Commit** `feat: update_skill 补丁语义 + get_skill 拉取与双人晋升`

### Task 4: searchSkills — src/search/skill.ts

**Files:**
- Create: `src/search/skill.ts`
- Test: `tests/skill-search.test.ts`

**Interfaces:**
- Consumes: `tokenize`(search/tokenizer.ts)、`Embedder`
- Produces:
  - `export interface SkillSearchParams { query: string; scope?: string; limit?: number }`
  - `export interface SkillHit { id: number; name: string; description: string; status: string; scope: string | null; tags: string[]; author: string; version: number; use_count: number; updated_at: string; score: number }`
  - `export async function searchSkills(pool, cfg, input, queriedBy: string, embedder?: Embedder): Promise<{ results: SkillHit[] }>` — SQL 结构照 search/index.ts:98-112 改写：命中列 = name ILIKE / description ILIKE / tags；trigram = `GREATEST(similarity(name,$q), similarity(description,$q))`；向量召回与向量分同款（`VECTOR_RECALL_DISTANCE = 0.5`）；verifiedBoost/scopeBoost/useCountBoost 复用 `cfg.searchWeights`；`INSERT INTO search_event (queried_by, query, scope, hit_ids, kind) VALUES (…,'skill')`

- [ ] **Step 1: 写失败测试**：关键词命中返回结果且 score 含 verifiedBoost；**纯语义查询**（与 description 零词重叠、trigram 低于 0.2、用 mock embedder 返回与目标条目 embedding 接近的向量）仍召回；无命中时 `results: []`；search_event 写入 kind='skill'（可查表断言）
- [ ] **Step 2: 运行确认 FAIL**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行确认 PASS** + `npm test`（全套不破）
- [ ] **Step 5: Commit** `feat: skill 混合检索（trigram+向量）与 search_event.kind 落库`

### Task 5: MCP 工具注册 — src/app.ts

**Files:**
- Modify: `src/app.ts`（在 get_context 注册后追加 4 个 registerTool）
- Test: `tests/server.e2e.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 2/3/4 导出的 handler 与类型
- Produces: MCP 工具 `save_skill`（inputSchema: name/description/instructions 必填 + files/scope/tags 可选，zod `.describe` 中文，files 用 `z.array(z.object({path: z.string(), content: z.string()})).max(20).optional()`）、`search_skills`（query 必填 + scope/limit）、`get_skill`（name）、`update_skill`（name 必填 + 其余可选）；响应文本格式：save_skill 成功 = `已上传 skill "<name>"（draft）。`，similar 非空追加「发现相似 skill，若为同一能力请改用 update_skill」；get_skill 返回 `JSON.stringify({install: '将以下文件逐一写入 ~/.claude/skills/<name>/（团队通用）或项目 .claude/skills/<name>/，然后重启会话使其生效', files}, null, 2)`

- [ ] **Step 1: 追加失败 e2e 测试**：经 /mcp JSON-RPC 调 save_skill → search_skills（按 name 命中）→ get_skill（返回 2 个文件且 SKILL.md 含 frontmatter）→ update_skill（version 变 2）全链路
- [ ] **Step 2: 运行确认 FAIL**
- [ ] **Step 3: 注册 4 个工具**（模式照 app.ts:44-77；错误统一走 `toolError`）
- [ ] **Step 4: 运行确认 PASS** + `npm test`
- [ ] **Step 5: Commit** `feat: MCP 工具 save_skill/search_skills/get_skill/update_skill`

### Task 6: 门户 REST — src/api/skillRoutes.ts

**Files:**
- Create: `src/api/skillRoutes.ts`
- Modify: `src/api/routes.ts`（导出 `ApiCtx` 已有——追加 `export function makeRequireUser(pool, limiter)`，把现闭包 `requireUser` 的逻辑移入；`registerApiRoutes` 内改用工厂返回值）
- Modify: `src/app.ts`（`registerApiRoutes` 调用旁加 `registerSkillRoutes(app, ctx)`）
- Test: `tests/api/skill-api.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4 handlers；`ApiCtx`（routes.ts:18）
- Produces:
  - `GET /api/skills?q=&scope=&page=&pageSize=` → `{ mode: 'search'|'browse', items: SkillHit[]|SkillRow[], total, facets: { scopes: {value,count}[] } }`；有 q 走 searchSkills，无 q 走分页列表（`SELECT … FROM skill ORDER BY updated_at DESC OFFSET/LIMIT`，total 用 count）；facets = `SELECT scope, count(*) FROM skill GROUP BY scope`（scope NULL 归为 'global' 展示值 `null` 不合并——返回原样）
  - `GET /api/skills/:name` → 完整行含 files JSONB（不组装 SKILL.md，原样返回存储值）
  - `POST /api/skills` → handleSaveSkill（user=当前登录者）
  - `PUT /api/skills/:name` → handleUpdateSkill
  - `DELETE /api/skills/:name` → 作者或 admin；否则 403 `{error:'FORBIDDEN'}`

- [ ] **Step 1: 写失败测试**（参照 tests/api/ 现有 REST 测试的 inject 方式）：列表/详情/POST/PUT/DELETE 各一例 + 非作者 DELETE 403
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现**（先重构 makeRequireUser，再写路由）
- [ ] **Step 4: 确认 PASS** + `npm test`
- [ ] **Step 5: Commit** `feat: 门户 skill REST 端点`

### Task 7: admin CLI — delete-skill / set-skill-status

**Files:**
- Modify: `scripts/admin.ts`（case 'embed' 后追加两个 case，usage 字符串与可用命令列表同步）
- Test: `tests/admin-service.test.ts`（追加）

**Interfaces:**
- Consumes: `runAdmin(pool, args, deps)` 现有模式（scripts/admin.ts:52）
- Produces: `delete-skill <name>`（硬删除 skill + skill_usage 级联）与 `set-skill-status <name> <draft|verified|deprecated>`；未知命令报错文案的可用列表追加这两个

- [ ] **Step 1: 追加失败测试**：delete 后查无此行；set-status 合法值生效、非法值报错
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 确认 PASS** + `npm test`
- [ ] **Step 5: Commit** `feat: admin CLI delete-skill / set-skill-status`

### Task 8: 门户 Skills 模块 — api.ts / SkillsPage / Drawer / Form

**Files:**
- Modify: `web/src/api.ts`（追加 `SkillItem`/`SkillRow`/`SkillFiles` 接口与 `searchSkills`/`listSkills`/`getSkill`/`saveSkill`/`updateSkill`/`deleteSkill` 函数，模式照现有 knowledge 函数）
- Create: `web/src/pages/SkillsPage.vue`（结构照 SearchPage.vue：检索/浏览双页签 + scope facets + 列表卡片：name、description、tags、scope、作者、use_count、version、状态 tag）
- Create: `web/src/components/SkillDetailDrawer.vue`（元信息 + SKILL.md 说明 + files 逐个 `<pre>` 代码块预览）
- Create: `web/src/components/SkillForm.vue`（照 KnowledgeForm.vue 模式：name/description/instructions/ tags/scope 选择 + **附加文件动态编辑器**——数组每项 path 输入框 + content textarea，可增删行；编辑模式加载 `GET /api/skills/:name` 回填）
- Modify: `web/src/router.ts`（追加 `{ path: '/skills', name: 'skills', component: SkillsPage }`）
- Modify: `web/src/App.vue`（nav-menu 追加 `<a-menu-item key="skills">Skills</a-menu-item>`）

**Interfaces:**
- Consumes: Task 6 REST 端点；`apiFetch`
- Produces: 路由名 `skills`；`SkillForm` 的 props/emits 照 KnowledgeForm（open / edit-name: string | undefined / @close / @saved / @view）

- [ ] **Step 1: 实现**（web 无单测框架，验证以构建为准）
- [ ] **Step 2: 验证** Run: `cd web && npm run build` — Expected: 构建成功无类型错误
- [ ] **Step 3: 手动验证** `npm run dev` 下：列表加载、详情抽屉、表单新增（带 2 个附加文件）→ 列表出现新条目
- [ ] **Step 4: Commit** `feat(web): Skills 检索/浏览/详情/上传编辑模块`

### Task 9: /login 独立页 + 路由守卫改造

**Files:**
- Create: `web/src/pages/LoginPage.vue`（居中卡片：token 输入、登录按钮、错误 alert；登录成功 `router.push(route.query.redirect ?? {name:'search'})`——redirect 是字符串时需 `router.push(String(redirect))`）
- Modify: `web/src/router.ts`（追加 `{ path: '/login', name: 'login', component: LoginPage }`；beforeEach 追加：`to.meta.auth && !currentUser.value` → `return { name: 'login', query: { redirect: to.fullPath } }`，**/login 自身不加 auth meta**）
- Modify: `web/src/router.ts`（admin 三页 meta 追加 `auth: true`，SkillForm 的入口保护放 Task 10）
- Modify: `web/src/auth.ts`（`apiFetch` 401 分支与 `loadMe` 失效分支：logout 后 `window.location.assign('/login?redirect=' + encodeURIComponent(当前 path+query))`，替代仅抛错）
- Modify: `web/src/App.vue`（删除 login 模态框与其状态；未登录头部按钮改为 `@click="router.push({name:'login', query:{redirect: route.fullPath}})"`；保留退出按钮）

**Interfaces:**
- Consumes: `login`/`logout`/`loadMe`（auth.ts 现有签名不变）
- Produces: 路由名 `login`；受保护页面约定 = route meta `{ auth: true }`

- [ ] **Step 1: 实现**
- [ ] **Step 2: 验证** Run: `cd web && npm run build` — Expected: 成功
- [ ] **Step 3: 手动验证**：未登录访问 /admin → 跳 /login?redirect=/admin，登录后回 /admin；未登录访问 /login 不循环；token 置为非法值后点任意需请求的页面 → 跳登录页；退出按钮正常
- [ ] **Step 4: Commit** `feat(web): 独立 /login 页与登录守卫（401 自动回跳）`

### Task 10: SkillForm 登录保护 + 接入规则 + 文档

**Files:**
- Modify: `web/src/pages/SkillsPage.vue`（"新增 Skill"按钮与卡片"编辑"入口：`!currentUser` 时跳 `/login?redirect=/skills`）
- Modify: `integration/rules/` 六份规则样板（claude-project-rules.md / cursor-project-rules.mdc / trae-project-rules.md / windsurf-project-rules.md / agents-md-sample.md / gemini-project-rules.md / copilot-instructions.md——以目录实际文件名为准，`ls integration/rules/` 确认）各追加第 6 条纪律：「接到开发任务后，除 get_context 外先调 search_skills 检索有无可用 skill；命中则 get_skill 按返回的 install 指引安装到本地 skills 目录再使用，没有才自行解决；打磨好的做法调用 save_skill 上传共享」
- Modify: `integration/rules/README.md`（纪律条数同步）
- Modify: `README.md` 与 `docs/deploy.md`（MCP 工具清单加 4 个 skill 工具一句话说明；deploy.md 加 skill 相关环境变量无新增——仅提示 files 限额）

**Interfaces:**
- Consumes: Task 8/9 页面与路由
- Produces: 无代码接口

- [ ] **Step 1: 实现**（规则文案六份同源，仅格式按各自模板）
- [ ] **Step 2: 验证** Run: `cd web && npm run build && cd .. && npm test` — Expected: 均通过
- [ ] **Step 3: 手动验证** 未登录点"新增 Skill" → /login?redirect=/skills，登录后回到 Skills 页
- [ ] **Step 4: Commit** `feat: skill 接入规则第 6 条纪律 + 文档与入口登录保护`
