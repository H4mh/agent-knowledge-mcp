# Web 知识门户实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Fastify 容器内为 agent-knowledge-mcp 增加浏览器知识门户：`/api/*` REST 层复用既有 handler，`web/` 下的 Vue 3 + Ant Design Vue 静态 SPA 由同进程托管，管理员在浏览器完成全部管理操作。

**Architecture:** 后端先做四项抽取/扩展（admin service、verifyOnly 鉴权、search 扩展、save 预检），再搭 `/api/*` 路由层与静态托管，最后写 `web/` SPA（检索/浏览、详情抽屉、表单、管理后台、统计）。每项后端改动独立可测、保持现有 MCP 测试全绿。

**Tech Stack:** TypeScript + Fastify 5 + `@fastify/static`；Vue 3 + Vite + TypeScript + ant-design-vue 4.x + vue-router；vitest + Postgres 17/pgvector 测试库。

**Spec:** `docs/superpowers/specs/2026-11-16-web-portal-design.md`

## Global Constraints

- 所有测试命令需 `TEST_DATABASE_URL="postgresql://akm:akm@localhost:5433/akm_test"`（测试库容器见 README 开发环境一节，`docker run --name akm-test-db -e POSTGRES_PASSWORD=akm -e POSTGRES_USER=akm -e POSTGRES_DB=akm_test -p 5433:5432 pgvector/pgvector:pg17`）
- 门户鉴权**仅校验不注册**：`/api/*` 上任何未知 token 不得在 `app_user` 产生新行；`/mcp` 自报注册行为不变
- 所有写操作复用既有 handler / admin service，禁止 REST 层直连 SQL 写库（只读查询层 `src/api/queries.ts` 例外）
- 现有全量测试套件必须保持绿（`npm test`）；`/mcp` 行为不变
- 前端不引入 markdown 渲染器、不引入 pinia、不引入图表库（统计页用 AntD Progress）；组件库 ant-design-vue 4.x
- 用户可见文案用中文，与 spec 中的措辞一致
- 每个任务结束时 `npx vue-tsc --noEmit && npm run build`（web 相关任务）或 `npm test`（后端任务）必须通过；commit message 末尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- 生产仓库勿回灌：测试代码一律用 demo-app/proj-a 等脱敏 scope 名

## Review Focus

1. **超长文本**：symptom/solution 超长（数千字）时列表接口必须截断返回（80 字符 + '…'），detail 仅在详情接口返回——测试在 Task 5
2. **非法分页参数**：`page=0`、`pageSize=999`、非数字 → 400 INVALID_INPUT，pageSize 上限 100——测试在 Task 6
3. **未知 token 打写接口**：`POST /api/knowledge` 带拼写错误的 token → 401 且 `app_user` 无新行——测试在 Task 6
4. **浏览模式不产生检索事件**：无关键词的浏览不得写 `search_event`（否则 recentMisses 统计被人肉浏览污染）——测试在 Task 5
5. **XSS**：条目文本含 `<script>` 时不得出现任何 `v-html` 渲染路径（Vue 插值自动转义 + detail 纯文本 pre-wrap）——代码评审检查项 + Task 14 人工 checklist

---

### Task 1: admin service 抽取（CLI 与 REST 共用）

**Files:**
- Create: `src/admin/service.ts`
- Modify: `scripts/admin.ts`（set-status / delete-knowledge / list-scopes / delete-scope / disable / enable 改为调用 service）
- Modify: `src/tools/save.ts`（`SCOPE_RE` 加 export）
- Test: `tests/admin-service.test.ts`（新增）、`tests/admin.test.ts`（补 delete-scope 有条目用例）

**Interfaces:**
- Consumes: `ToolError`（`src/tools/save.js`，已有：`constructor(code, message)`）
- Produces（`src/admin/service.ts`，后续 Task 7 全部依赖）:
  - `setStatus(pool, id: number, status: string): Promise<void>` — status ∉ {draft,verified,deprecated} → `ToolError('INVALID_STATUS', …)`；条目不存在 → `ToolError('NOT_FOUND', …)`
  - `deleteKnowledge(pool, id: number): Promise<void>` — 不存在 → `NOT_FOUND`；存在则先删 `knowledge_usage` 再删 `knowledge`
  - `listScopes(pool): Promise<ScopeRow[]>` — `ScopeRow = { scope: string; description: string | null; enabled: boolean; createdBy: string | null; entryCount: number }`，按 scope 排序，entryCount 来自 `knowledge` 表 LEFT JOIN 计数
  - `createScope(pool, scope: string, description: string | null, createdBy: string): Promise<void>` — 格式不过 `SCOPE_RE` → `ToolError('INVALID_SCOPE', …)`；已存在 → `ToolError('SCOPE_EXISTS', …)`
  - `updateScope(pool, scope: string, patch: { description?: string | null; enabled?: boolean }): Promise<void>` — 不存在 → `NOT_FOUND`
  - `deleteScope(pool, scope: string): Promise<void>` — 不存在 → `NOT_FOUND`；该 scope 在 `knowledge` 表有条目 → `ToolError('SCOPE_HAS_ENTRIES', …)`
  - `listUsers(pool): Promise<UserRow[]>` — `UserRow = { username: string; role: string; enabled: boolean; createdAt: string }`（不查 token_hash），按 username 排序
  - `setUserEnabled(pool, username: string, enabled: boolean): Promise<void>` — 不存在 → `NOT_FOUND`

- [ ] **Step 1: 写失败测试** `tests/admin-service.test.ts`（沿用 tests/search.test.ts 的 pool/applyMigrations/TRUNCATE 模式，TRUNCATE `knowledge, knowledge_usage, scope_registry, app_user`）：

```ts
it('set-status 非法值报 INVALID_STATUS，不存在报 NOT_FOUND', async () => {
  await seedKnowledge({}); // 最简 insert，返回 id
  await expect(setStatus(pool, id, 'foo')).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  await expect(setStatus(pool, 999999, 'verified')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('deleteScope 有条目时拒绝（SCOPE_HAS_ENTRIES），无条目时可删', async () => {
  await seedScope('proj-a'); await seedKnowledge({ scope: 'proj-a' });
  await expect(deleteScope(pool, 'proj-a')).rejects.toMatchObject({ code: 'SCOPE_HAS_ENTRIES' });
  await seedScope('empty-s'); await deleteScope(pool, 'empty-s'); // 不抛
});
it('listScopes 返回描述/启用/创建者/条目数', async () => { /* seed 2 scope + 1 条目，断言 entryCount */ });
it('createScope 非法格式 INVALID_SCOPE、重名 SCOPE_EXISTS', async () => { /* 断言两个 rejects */ });
it('setUserEnabled / listUsers / updateScope 基本行为', async () => { /* disable 后 enabled=false；不存在 NOT_FOUND */ });
```

- [ ] **Step 2: 跑测试确认失败**：`npm test -- tests/admin-service.test.ts`，Expected: FAIL（模块不存在）
- [ ] **Step 3: 实现** `src/admin/service.ts`——八个函数按上面签名；SQL 从 `scripts/admin.ts` 对应 case 平移（set-status 带 `updated_at = now()`）；`SCOPE_RE` 从 `src/tools/save.ts` export 并在此 import
- [ ] **Step 4: 重构 CLI** `scripts/admin.ts`：六个 case 的 SQL 替换为 service 调用，错误输出改为 `[<code>] <message>` 格式；`list-scopes` 输出格式不变（scope/enabled/created_by 三列）
- [ ] **Step 5: 跑测试通过**：`npm test`（全量，确认 CLI 测试与全部现有用例绿）；若 tests/admin.test.ts 中 delete-scope 用例与"有条目拒绝"冲突，按新语义修正该用例
- [ ] **Step 6: Commit** `git commit -m "refactor: extract admin service shared by CLI and REST"`

### Task 2: authenticate 仅校验模式（verifyOnly）

**Files:**
- Modify: `src/auth.ts`（`AuthOptions` 加 `verifyOnly?: boolean`）
- Test: `tests/auth.test.ts`（追加用例）

**Interfaces:**
- Produces: `authenticate(pool, bearer, opts: AuthOptions & { verifyOnly?: boolean })` — `verifyOnly: true` 时跳过自报注册分支：未知 token、格式不合法、被禁用一律返回 `null`，且不产生任何 INSERT

- [ ] **Step 1: 写失败测试**（追加到 tests/auth.test.ts，沿用该文件现有 seed 模式）：

```ts
it('verifyOnly: 未知 token 返回 null 且不注册新用户', async () => {
  const u = await authenticate(pool, 'stranger-abc', { verifyOnly: true });
  expect(u).toBeNull();
  const { rows } = await pool.query(`SELECT * FROM app_user WHERE username = 'stranger-abc'`);
  expect(rows.length).toBe(0);
});
it('verifyOnly: 已注册 token 正常返回；不带 verifyOnly 时未知 token 仍自报注册（MCP 行为不变）', async () => { /* 两段断言 */ });
```

- [ ] **Step 2: 跑测试确认失败**：`npm test -- tests/auth.test.ts`，Expected: FAIL（opts 里没有 verifyOnly 效果——未知 token 被注册）
- [ ] **Step 3: 实现**：`authenticate` 中，在自报注册分支前加 `if (!opts.verifyOnly) { …原注册逻辑… }`
- [ ] **Step 4: 跑测试通过**：`npm test`（全量）
- [ ] **Step 5: Commit** `git commit -m "feat: verifyOnly auth mode for portal (no self-registration via /api)"`

### Task 3: searchKnowledge 扩展（status 筛选 + 字段扩充）

**Files:**
- Modify: `src/search/index.ts`
- Test: `tests/search.test.ts`（追加用例）

**Interfaces:**
- Consumes: 现有 `searchKnowledge(pool, cfg, input, queriedBy, embedder?)`
- Produces:
  - `SearchParams` 增加 `status?: string`
  - `SearchHit` 增加 `domain: string; module: string | null; author: string; updated_at: string`（SELECT 增列，打分逻辑零改动）
  - `input.status` 存在时 WHERE 追加 `status = $n`；undefined 时 SQL 与现在完全一致（MCP 不受影响）

- [ ] **Step 1: 写失败测试**（追加到 tests/search.test.ts，复用其 beforeEach 种子）：

```ts
it('status 筛选只返回该状态；不传时行为不变', async () => {
  const r = await searchKnowledge(pool, cfg, { query: '分页', status: 'verified' }, 'alice');
  expect(r.results.every((x) => x.status === 'verified')).toBe(true);
  const r2 = await searchKnowledge(pool, cfg, { query: '分页' }, 'alice'); // 回归：不筛
  expect(r2.results.some((x) => x.status === 'draft')).toBe(true);
});
it('SearchHit 扩充 domain/author/module/updated_at', async () => {
  const r = await searchKnowledge(pool, cfg, { query: 'Kingbase' }, 'alice');
  expect(r.results[0]).toMatchObject({ domain: 'db', author: 'seed' });
  expect(r.results[0].updated_at).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认失败**：`npm test -- tests/search.test.ts`，Expected: FAIL（status 被忽略、字段 undefined）
- [ ] **Step 3: 实现**：SELECT 列表加 `domain, module, author, updated_at`；`SearchHit` 接口加四字段；filters 追加 status 分支（放在 domain 过滤旁，注意 `p()` 参数顺序与 SQL 文本一致——status 参数在 relevant 表达式之后、LIMIT 之前）
- [ ] **Step 4: 跑测试通过**：`npm test`（全量——重点 MCP e2e 不回归）
- [ ] **Step 5: Commit** `git commit -m "feat: searchKnowledge status filter and enriched hit fields for portal"`

### Task 4: save 预检抽取（dry-run preview 基座）

**Files:**
- Modify: `src/tools/save.ts`
- Test: `tests/tools/save.test.ts`（追加用例）

**Interfaces:**
- Consumes: 现有 handleSave 内部逻辑（scope 校验/注册、domain 枚举、guard 扫描、查重查询）
- Produces（均 export 自 `src/tools/save.js`）:
  - `checkScope(pool, cfg: Config, scope: string): Promise<'enabled' | 'disabled' | 'invalid-format' | 'closed' | 'will-register'>`
  - `findSimilar(pool, cfg: Config, title: string, symptom: string, solution: string, scope: string): Promise<SaveResult['similar']>` — 现 handleSave 中的查重 SQL 平移
  - `precheckSave(pool, cfg: Config, input: SaveInput, deps: SaveDeps): Promise<{ similar: SaveResult['similar']; warnings: string[]; scopeWillRegister: boolean }>` — 依次跑 checkScope（'disabled'/'invalid-format'/'closed' → 抛对应 ToolError）、domain 枚举（不过 → `INVALID_DOMAIN`）、scanText（blocked → `SENSITIVE_CONTENT`）、findSimilar；**不 INSERT 任何表**
  - handleSave 重构为调用 checkScope/findSimilar，行为与现在逐字节等价（'will-register' 分支仍在 handleSave 里 INSERT scope_registry）

- [ ] **Step 1: 写失败测试**（追加到 tests/tools/save.test.ts，复用该文件现有 deps/pool 构造）：

```ts
it('precheckSave 不入库：返回 similar/warnings/scopeWillRegister，行数不变', async () => {
  await seedEntry({ title: '已存在的分页问题', scope: 'demo-app', status: 'draft' }); // 相似度超阈值
  const before = await countKnowledge();
  const r = await precheckSave(pool, cfg, { title: '分页问题再次出现', symptom: '分页查询返回全量', solution: '调整 pagehelper', domain: 'java', scope: 'new-scope-x', tags: [] }, deps);
  expect(r.similar.length).toBeGreaterThanOrEqual(1);
  expect(r.scopeWillRegister).toBe(true);
  expect(await countKnowledge()).toBe(before); // 未插入
});
it('precheckSave 敏感内容抛 SENSITIVE_CONTENT；非法 domain 抛 INVALID_DOMAIN；关闭自注册时未注册 scope 抛 INVALID_SCOPE', async () => { /* 三个断言，closed 场景用 cfg.scopeOpen=false */ });
it('handleSave 行为不变：will-register 时注册 scope（回归由现有用例覆盖）', async () => { /* 现有用例保持绿即可 */ });
```

- [ ] **Step 2: 跑测试确认失败**：`npm test -- tests/tools/save.test.ts`，Expected: FAIL（precheckSave 不存在）
- [ ] **Step 3: 实现**：按 Interfaces 逐个抽出；handleSave 改为 `const sc = await checkScope(...)` 后 switch 四分支
- [ ] **Step 4: 跑测试通过**：`npm test`（全量）
- [ ] **Step 5: Commit** `git commit -m "feat: extract save precheck (dry-run) for portal form"`

### Task 5: REST 查询层（listKnowledge / detail / stats）

**Files:**
- Create: `src/api/queries.ts`
- Test: `tests/api/queries.test.ts`

**Interfaces:**
- Consumes: `searchKnowledge`（Task 3 后的签名与 SearchHit）、`Config`
- Produces（Task 6/7 依赖）:

```ts
export interface ListParams {
  q?: string; domain?: string; scope?: string; status?: string; tag?: string;
  page?: number; pageSize?: number;
}
export interface ListItem {
  id: number; title: string; symptom: string; solution: string; status: string;
  scope: string; domain: string; module: string | null; tags: string[];
  author: string; use_count: number; last_used_at: string | null; updated_at: string;
}
export interface Facets { domains: { value: string; count: number }[]; scopes: { value: string; count: number }[] }
export type KnowledgeRow = ListItem & {
  detail: string | null; code_ref: string | null; created_at: string; score?: number;
};
export interface Stats {
  byStatus: Record<string, number>; byDomain: Record<string, number>;
  byScope: { value: string; count: number }[];            // 前 10
  topUsed: { id: number; title: string; use_count: number }[]; // 前 10
  recentMisses: { query: string; count: number }[];        // 近 30 天 hit_ids='{}' 按 query 聚合，前 10
  userCount: number;
}
export async function listKnowledge(pool, cfg, params: ListParams, embedder?, queriedBy = 'portal'):
  Promise<{ mode: 'search' | 'browse'; items: ListItem[]; total: number | null; facets: Facets }>
export async function getKnowledgeById(pool, id: number): Promise<KnowledgeRow | null>
export async function getStats(pool): Promise<Stats>
```

- `listKnowledge` 语义：`q` 非空 → `searchKnowledge(pool, cfg, { query: q, domain, scope, status, tags: tag ? [tag] : undefined, limit: 50 }, queriedBy, embedder)`，`total: null`；`q` 空/缺 → SQL 浏览查询（WHERE domain/scope/status/`tags @> ARRAY[tag]`，ORDER BY updated_at DESC，LIMIT/OFFSET，另发 COUNT(*) 得 total）。symptom/solution 均截断 80 字符（`s.length > 80 ? s.slice(0,80) + '…' : s`）。**浏览模式不发 search_event**（不调 searchKnowledge 即可）
- 浏览查询只 SELECT ListItem 所需列（不含 detail/embedding）

- [ ] **Step 1: 写失败测试** `tests/api/queries.test.ts`（pool + TRUNCATE 模式，种子 4 条：不同 scope/domain/status，其中 1 条 symptom 200 字符）：

```ts
it('浏览模式：分页 total 正确、按 updated_at 倒序、scope/status/domain/tag 过滤', async () => { /* page=1&pageSize=2 → total=4；filter 断言 */ });
it('浏览模式不写 search_event', async () => {
  await listKnowledge(pool, cfg, { scope: 'demo-app' });
  const { rows } = await pool.query('SELECT * FROM search_event');
  expect(rows.length).toBe(0);
});
it('检索模式：mode=search、total=null、结果来自 searchKnowledge；超长 symptom 截断为 80 字符 + …', async () => { /* 断言 mode/total/长度 */ });
it('facets：domains/scopes 带条目数', async () => { /* 断言 {value,count} */ });
it('getKnowledgeById：存在返回全字段含 detail/code_ref/created_at；不存在返回 null', async () => { /* */ });
it('getStats：byStatus/byDomain/byScope/topUsed/recentMisses/userCount 数字正确', async () => {
  /* seed：2 条目（1 条 use_count=5）+1 用户+1 条空命中 search_event（hit_ids='{}'，created_at=now()） */
});
```

- [ ] **Step 2: 跑测试确认失败**：`npm test -- tests/api/queries.test.ts`，Expected: FAIL（模块不存在）
- [ ] **Step 3: 实现** `src/api/queries.ts`
- [ ] **Step 4: 跑测试通过**：`npm test -- tests/api/queries.test.ts`
- [ ] **Step 5: Commit** `git commit -m "feat: REST query layer (list/detail/facets/stats) for portal"`

### Task 6: REST 路由 — 鉴权与知识端点

**Files:**
- Create: `src/api/routes.ts`
- Modify: `package.json`（dependencies 加 `"@fastify/static": "^8.0.0"`，`npm install` 实际写入版本）
- Test: `tests/api/routes.test.ts`

**Interfaces:**
- Consumes: Task 1–5 全部产物；`authenticate(…, { verifyOnly: true })`；`RateLimiter`
- Produces（Task 7/8 依赖）:

```ts
export interface ApiCtx { pool: Pool; cfg: Config; toolDeps: SaveDeps; limiter: RateLimiter }
export function registerApiRoutes(app: FastifyInstance, ctx: ApiCtx): void
```

- 实现约定：
  - 每个路由 handler 先 `const bearer = request.headers.authorization` → `authenticate(pool, bearer, { verifyOnly: true })` → null 则 `reply.code(401).send({ error: 'UNAUTHORIZED', message: '身份不存在：请先通过 agent 端 MCP 使用一次（首次使用自动注册），或联系管理员创建身份' })`；再 `limiter.allow(user.username)` 不过 → 429 `{error:'RATE_LIMITED'}`
  - ToolError → HTTP 映射：FORBIDDEN→403、NOT_FOUND→404、SCOPE_HAS_ENTRIES/SCOPE_EXISTS→409、INVALID_* / SENSITIVE_CONTENT→400，其余→500；响应体 `{ error: <code>, message }`
  - Task 6 注册：`GET /api/me`（→ `{username, role}`）、`GET /api/knowledge`（query string 解析到 ListParams；page/pageSize 校验：缺失默认 1/20，非正整数或 pageSize>100 → `400 INVALID_INPUT`）、`GET /api/knowledge/:id`、`POST /api/knowledge`（→ handleSave，201）、`POST /api/knowledge/preview`（→ precheckSave，200）、`PUT /api/knowledge/:id`（→ handleUpdate，body 剔除 id/title/domain/scope/status）、`POST /api/knowledge/:id/used`（→ handleMarkUsed）
  - id 参数非数字 → 404（Fastify 路由用 `/api/knowledge/:id` + `parseInt` 校验）

- [ ] **Step 1: 写失败测试** `tests/api/routes.test.ts`：beforeAll 里 `createApp(cfg, { pool })` → `app.inject()`（cfg 用 `loadConfig({DATABASE_URL: url, RATE_LIMIT_PER_MIN: '1000'})`；seed app_user：alice/user、bob/admin、carol/disabled）。用例：

```ts
it('GET /api/me：已注册 token 200 {username,role}；未知 token 401 且不注册；禁用 token 401', async () => { /* 3 断言，401 后查 app_user 行数不变 */ });
it('角色矩阵：POST /api/knowledge/:id/status 与 DELETE /api/knowledge/:id 对 user 403（Task 7 端点在本任务先只测 404/403 防线，不实现——本用例移至 Task 7）', async () => {}); // 本任务此条省略
it('GET /api/knowledge 浏览：200 {mode: browse, items, total, facets}；page=0 → 400 INVALID_INPUT；pageSize=200 → 400', async () => { /* */ });
it('GET /api/knowledge?q= 检索：mode=search、total=null', async () => { /* */ });
it('GET /api/knowledge/:id：存在 200 含 detail；不存在 404 NOT_FOUND；id=abc 404', async () => { /* */ });
it('POST /api/knowledge：alice 保存成功 201（含 id/similar/warnings）；敏感内容 400 SENSITIVE_CONTENT；INVALID_SCOPE 400', async () => { /* body 用 SaveInput 全字段 */ });
it('POST /api/knowledge/preview：dry-run 不入库、similar 返回', async () => { /* 保存前 count == 保存后 count */ });
it('PUT /api/knowledge/:id：作者本人 200；他人 403 FORBIDDEN；admin 任意 200；body 带 status 不生效', async () => { /* */ });
it('POST /api/knowledge/:id/used：200 返回状态；不存在 404', async () => { /* */ });
it('429：RATE_LIMIT_PER_MIN=2 的独立 app 实例连打 3 次第 3 次 429', async () => { /* 单独 createApp + inject */ });
```

- [ ] **Step 2: 跑测试确认失败**：`npm test -- tests/api/routes.test.ts`，Expected: FAIL（/api 路由 404）
- [ ] **Step 3: 实现** `src/api/routes.ts`（Task 7 的 admin 端点留到下一任务，本文件结构一次到位）并在 `src/app.ts` 的 `createApp` 末尾调用 `registerApiRoutes(app, { pool: deps.pool, cfg, toolDeps, limiter })`
- [ ] **Step 4: 跑测试通过**：`npm test`（全量，MCP e2e 不回归）
- [ ] **Step 5: Commit** `git commit -m "feat: /api REST routes — verify-only auth, knowledge CRUD endpoints"`

### Task 7: REST 路由 — admin 端点与统计

**Files:**
- Modify: `src/api/routes.ts`
- Test: `tests/api/admin-routes.test.ts`（新增）

**Interfaces:**
- Consumes: Task 1 admin service 全部函数、Task 5 `getStats`、Task 6 路由骨架与错误映射
- Produces（追加路由）: `POST /api/knowledge/:id/status`（body `{status}` → setStatus）、`DELETE /api/knowledge/:id`（→ deleteKnowledge）、`GET /api/scopes`（→ listScopes）、`POST /api/scopes`（body `{scope, description?}` → createScope，createdBy=user.username）、`PATCH /api/scopes/:scope`（→ updateScope）、`DELETE /api/scopes/:scope`（→ deleteScope）、`GET /api/users`（→ listUsers）、`POST /api/users/:username/disable` 与 `/enable`（→ setUserEnabled）、`GET /api/stats`（→ getStats，登录即可）

- [ ] **Step 1: 写失败测试** `tests/api/admin-routes.test.ts`（同 Task 6 的 app/inject 模式）：

```ts
it('角色矩阵：以下端点 user 全部 403、admin 200——status/delete/scopes CRUD/users disable/enable', async () => { /* 逐个双身份断言 */ });
it('POST /api/knowledge/:id/status：admin 改 verified 后 DB 生效；非法 status 400 INVALID_STATUS；不存在 404', async () => { /* */ });
it('DELETE /api/knowledge/:id：admin 删除后 usage 一并消失；不存在 404', async () => { /* */ });
it('scopes：GET 全量含 entryCount；POST 新增 201、重名 409 SCOPE_EXISTS、非法格式 400；PATCH 停用；DELETE 有条目 409 SCOPE_HAS_ENTRIES、无条目 200', async () => { /* */ });
it('users：GET 列表不含 token_hash 字段；disable/enable 生效；不存在 404', async () => { /* */ });
it('GET /api/stats：user 也能访问，结构含 byStatus/byDomain/byScope/topUsed/recentMisses/userCount', async () => { /* */ });
```

- [ ] **Step 2: 跑测试确认失败**：`npm test -- tests/api/admin-routes.test.ts`，Expected: FAIL（端点 404）
- [ ] **Step 3: 实现**：routes.ts 追加上述路由（复用 Task 6 的鉴权/错误映射 helper）
- [ ] **Step 4: 跑测试通过**：`npm test`（全量）
- [ ] **Step 5: Commit** `git commit -m "feat: /api admin routes (status/delete/scopes/users) and stats"`

### Task 8: 静态托管 + SPA fallback

**Files:**
- Modify: `src/config.ts`（Config 加 `webDistDir?: string`；loadConfig 读 `AKM_WEB_DIST_DIR`，默认 `join(process.cwd(), 'web', 'dist')`）
- Modify: `src/app.ts`（createApp 内：webDistDir 存在时注册 `@fastify/static` + setNotFoundHandler）
- Test: `tests/api/static.test.ts`（新增）、`tests/config.test.ts`（webDistDir 默认值用例）

**Interfaces:**
- Consumes: Task 6/7 已注册的 `/api` 路由
- Produces: 行为——`webDistDir` 目录存在时：`GET /` 与任意未匹配的 GET（非 `/api/*`、非 `/mcp*`）返回 `index.html`；目录不存在（测试/无前端构建）时行为与现在完全一致。`Config.webDistDir?: string`

- [ ] **Step 1: 写失败测试**：`tests/config.test.ts` 追加 `loadConfig({DATABASE_URL:'x'})` 含 `webDistDir` 默认值（以 `web/dist` 结尾）与 `AKM_WEB_DIST_DIR` 覆盖用例；`tests/api/static.test.ts` 用 mkdtemp 造 fixture（`index.html` 内容 `<html>portal</html>`），`loadConfig({..., AKM_WEB_DIST_DIR: fixtureDir})` 建 app：

```ts
it('GET / 返回 index.html；GET /admin 同样返回 index.html（SPA fallback）', async () => {
  const r = await app.inject({ method: 'GET', url: '/' });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('portal');
  expect((await app.inject({ method: 'GET', url: '/admin/scopes' })).body).toContain('portal');
});
it('未知 /api/xxx 返回 404 JSON（不落 SPA fallback）', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/nonexistent' });
  expect(r.statusCode).toBe(404);
  expect(JSON.parse(r.body)).toHaveProperty('error');
});
it('GET /mcp 仍 405；webDistDir 不存在时不影响任意路由（404 JSON）', async () => { /* */ });
```

- [ ] **Step 2: 跑测试确认失败**：`npm test -- tests/api/static.test.ts tests/config.test.ts`，Expected: FAIL
- [ ] **Step 3: 实现**：config 加字段；app.ts 里 `if (cfg.webDistDir && existsSync(cfg.webDistDir))` → `await app.register(fastifyStatic, { root: cfg.webDistDir })`，然后 `app.setNotFoundHandler((req, reply) => { if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/mcp')) return reply.sendFile('index.html'); reply.code(404).send({ error: 'NOT_FOUND' }); })`（注意 setNotFoundHandler 必须在路由注册后仍生效；`/mcp` 的 405 是显式路由不受影响）
- [ ] **Step 4: 跑测试通过**：`npm test`（全量）
- [ ] **Step 5: Commit** `git commit -m "feat: serve portal SPA from Fastify with history-mode fallback"`

### Task 9: web 脚手架 + 登录 + 应用骨架

**Files:**
- Create: `web/package.json`、`web/vite.config.ts`、`web/tsconfig.json`、`web/index.html`、`web/src/main.ts`、`web/src/router.ts`、`web/src/auth.ts`、`web/src/api.ts`、`web/src/App.vue`、`web/src-env.d.ts`（全局类型）
- Modify: 根 `.dockerignore`（追加 `web/node_modules`、`web/dist`）

**Interfaces:**
- Consumes: Task 6 的 `GET /api/me`
- Produces（后续前端任务依赖）:
  - `web/src/auth.ts`：`export const currentUser = ref<{ username: string; role: 'user' | 'admin' } | null>(null)`；`export async function login(token: string): Promise<boolean>`（调 /api/me，成功写 localStorage 并置 currentUser）；`export function logout(): void`；`export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T>`（自动加 Bearer；401 时 logout 并 throw `{error:'UNAUTHORIZED'}`）
  - `web/src/api.ts`：`export function me(): Promise<{username, role}>`（后续任务逐个补 knowledge/scopes/users/stats 函数）
  - `web/src/router.ts`：路由 `/`（SearchPage 占位）、`/stats`（占位）、`/admin`、`/admin/scopes`、`/admin/users`（admin 三个占位 + 全局 beforeEach：无 currentUser → 弹登录）；登录用 AntD `Modal` 组件在 App.vue 内实现（单输入框"身份令牌"），登录成功后跳回原路由
  - App.vue：`a-layout` 骨架——顶部 header（站名"团队知识库"、菜单：检索 / 统计 / 管理后台（仅 admin 显示）、右侧当前用户名 + 退出）

- [ ] **Step 1: 脚手架**：`web/` 下手写上述文件（不跑 create-vite，直接写；`web/package.json` deps: `vue@^3.5` `vue-router@^4.4` `ant-design-vue@^4.2` `@ant-design/icons-vue@^7`，devDeps: `vite@^5` `@vitejs/plugin-vue@^5` `typescript@^5.5` `vue-tsc@^2`；scripts: `dev`/`build` = `vue-tsc --noEmit && vite build`）。`vite.config.ts` dev 代理 `'/api'` → `http://localhost:3000`；AntD 用手动按需 import（main.ts `import 'ant-design-vue/dist/reset.css'`，组件在 SFC 里显式 import——不用 unplugin，构建简单可控）
- [ ] **Step 2: 安装与构建门槛**：`cd web && npm install && npm run build`，Expected: PASS（vue-tsc 零错误 + vite 产物生成）
- [ ] **Step 3: 手动冒烟**：`node dist/src/index.js`（本地连测试库）+ `cd web && npm run dev`，浏览器 `http://localhost:5173` 出现登录框，用 `alice-token`（seed 过的测试身份）登录后显示骨架与用户名；错误 token 显示"身份不存在…"提示。—— 无法自动化，构建通过 + Task 10 联调覆盖
- [ ] **Step 4: Commit** `git commit -m "feat(web): portal scaffold with AntD Vue, token login and app shell"`

### Task 10: 检索/浏览页 + 详情抽屉 + mark_used

**Files:**
- Create: `web/src/pages/SearchPage.vue`、`web/src/components/SearchFilters.vue`、`web/src/components/KnowledgeDetailDrawer.vue`、`web/src/components/RelativeTime.vue`（相对时间小工具，3 天前/2 周前）
- Modify: `web/src/api.ts`（补 `searchOrList(params)`、`getKnowledge(id)`、`markUsed(id, note?)`）
- Modify: `web/src/router.ts`（`/` 挂 SearchPage）

**Interfaces:**
- Consumes: Task 6 `GET /api/knowledge`（两模式）、`GET /api/knowledge/:id`、`POST /api/knowledge/:id/used`；Task 9 auth/apiFetch
- Produces: `KnowledgeDetailDrawer.vue` props `{ id: number | null }`（null=关闭），emit `edit(k: KnowledgeRow)`（Task 11 表单接）、`saved`（mark_used 成功后通知父级刷新 use_count）；`SearchFilters.vue` v-model 式 filters 对象 `{ domain?, scope?, status?, tag? }`（选项来自响应 facets）

- [ ] **Step 1: 实现 api.ts 三个函数**（类型对齐 Task 5 的 ListItem/Facets/KnowledgeRow）
- [ ] **Step 2: 实现 SearchPage**：`a-tabs` 两个页签——「检索」（输入框 + SearchFilters + 结果列表 + 检索模式底部提示"最多展示 50 条，请细化关键词"）与「浏览」（左侧 `a-menu` scope 目录带条目数 + 右侧 `a-list` 分页 pageSize=20 + 叠加 domain/status 筛选）；行点击打开 Drawer
- [ ] **Step 3: 实现 KnowledgeDetailDrawer**：字段分区展示（现象/解决/详情 pre-wrap/标签 Tag/代码 ref/作者·用过 N 次·最近 RelativeTime），`a-tag` 状态徽标（draft=default、verified=green、deprecated=red）；「帮到了我」按钮点击调 markUsed 后 disabled + message.success；编辑按钮 `v-if` 当前用户是 author 或 admin，emit edit
- [ ] **Step 4: 构建门槛**：`cd web && npm run build`，Expected: PASS
- [ ] **Step 5: Commit** `git commit -m "feat(web): search/browse tabs, filters, detail drawer with mark_used"`

### Task 11: 新增/编辑表单（dry-run 预检流）

**Files:**
- Create: `web/src/components/KnowledgeForm.vue`
- Modify: `web/src/api.ts`（补 `preview(input)`、`saveKnowledge(input)`、`updateKnowledge(id, patch)`）
- Modify: `web/src/pages/SearchPage.vue`（顶部"新增知识"按钮挂表单；接 Drawer 的 edit 事件打开编辑模式）

**Interfaces:**
- Consumes: Task 6 `POST /api/knowledge/preview` / `POST /api/knowledge` / `PUT /api/knowledge/:id`；Task 10 Drawer 的 edit 事件
- Produces: `KnowledgeForm.vue` props `{ open: boolean; editId?: number }`，emit `close`、`saved(id: number)`；内部状态机：填写 → 提交调 preview → `similar.length` 时展示相似条目卡片 + 两按钮「仍要新建」（调 save）/「去看相似条目」（emit close 并由父级打开 Drawer）；`warnings` 与 `scopeWillRegister` 以 `a-alert` 展示；编辑模式仅 symptom/solution/detail/tags/code_ref/module 可改

- [ ] **Step 1: 实现 api.ts 三函数与表单组件**（domain 下拉硬编码 DOMAINS 枚举 `['java','frontend','mobile','infra','db','workflow']`——与后端 DOMAINS 一致，写入组件顶部常量并注释来源 `src/tools/save.ts`；scope 下拉来自最近一次 facets + "手动输入"选项）
- [ ] **Step 2: 构建门槛**：`cd web && npm run build`，Expected: PASS
- [ ] **Step 3: Commit** `git commit -m "feat(web): knowledge form with dry-run dedup preview"`

### Task 12: 管理后台三页

**Files:**
- Create: `web/src/pages/AdminKnowledge.vue`、`web/src/pages/AdminScopes.vue`、`web/src/pages/AdminUsers.vue`
- Modify: `web/src/api.ts`（补 status/delete/scopes CRUD/users disable/enable/stats 函数）、`web/src/router.ts`（三个 admin 路由挂真实页面 + admin 守卫：非 admin 访问 → 跳 `/` + message）

**Interfaces:**
- Consumes: Task 7 全部 admin 端点；Task 10 的 Drawer（AdminKnowledge 行点击复用查看）
- Produces: 三个页面。AdminKnowledge：浏览模式表格（复用 SearchFilters）+ 行操作下拉「设为 verified / 设为 deprecated / 恢复 draft / 删除」（删除与禁用均 `a-popconfirm` 二次确认）；AdminScopes：表格（scope/描述/启用 Switch/条目数）+ 新增 Modal + 描述编辑 + 删除（409 时 message 提示"该 scope 下仍有条目"）；AdminUsers：表格（用户名/角色/状态/注册时间）+ 禁用（确认文案含"该 token 将永久封禁"）/启用

- [ ] **Step 1: 实现 api.ts 函数与三个页面、路由守卫**
- [ ] **Step 2: 构建门槛**：`cd web && npm run build`，Expected: PASS
- [ ] **Step 3: Commit** `git commit -m "feat(web): admin console — knowledge status/delete, scope registry, user management"`

### Task 13: 统计页

**Files:**
- Create: `web/src/pages/StatsPage.vue`
- Modify: `web/src/api.ts`（补 `getStats()`）、`web/src/router.ts`（`/stats` 挂真实页面）

**Interfaces:**
- Consumes: Task 7 `GET /api/stats`
- Produces: StatsPage——顶部 4 个 `a-statistic` 数字卡（总条数=byStatus 求和 / verified / draft / 注册用户）；domain 与 scope 条数用 `a-progress` 横条（count / max 归一化）；topUsed 与 recentMisses 两个 `a-table`（各 10 行）

- [ ] **Step 1: 实现 api 函数与页面**
- [ ] **Step 2: 构建门槛**：`cd web && npm run build`，Expected: PASS
- [ ] **Step 3: Commit** `git commit -m "feat(web): stats dashboard (counts, top used, recent misses)"`

### Task 14: Docker 多阶段构建 + 文档 + 全量验证

**Files:**
- Modify: `Dockerfile`（新增 build-web stage）、`.dockerignore`（确认含 `web/node_modules` `web/dist`）
- Modify: `docs/deploy.md`、`integration/使用教程.md`、`README.md`

**Interfaces:**
- Consumes: Task 8–13 全部产物
- Produces: 可部署镜像 + 文档

- [ ] **Step 1: Dockerfile**：在现有 build stage 前加 `FROM node:20-slim AS build-web`（WORKDIR /webbuild，COPY `web/package.json web/package-lock.json web/.npmrc ./`，`npm ci`，COPY `web/` 其余文件，`npm run build` 产出 /webbuild/dist）；runtime stage 加 `COPY --from=build-web /webbuild/dist ./web/dist`。若 web 无 lock 文件则本任务先在本地 `npm install` 生成 `web/package-lock.json` 并提交
- [ ] **Step 2: 全量验证**：根目录 `npm test`（全绿）+ `npm run build` + `cd web && npm run build`
- [ ] **Step 3: 文档**——
  - `docs/deploy.md`：新增「知识门户」一节（访问 `http://<server>:3000/`；登录用 MCP 同款身份令牌，门户不注册新身份；admin 登录后见管理后台；**加粗强调安全组仅放行公司出口 IP**——门户使浏览器流量也走 3000 端口）；日常运维一节补"管理员操作已可在网页完成，CLI 保留作兜底"
  - `integration/使用教程.md`：FAQ 增加一行"浏览器访问：打开 `http://your-akm-server:3000/`，登录身份令牌 = MCP 配置里 Bearer 后那串；没注册过身份先让 agent 接入一次"；§3.3 验证步骤补浏览器入口
  - `README.md`：功能清单加"浏览器知识门户（检索/浏览/管理后台/统计）"
- [ ] **Step 4: 人工上线 checklist（写入 deploy.md 门户一节末尾）**：登录（正确/错误 token）、检索、浏览按 scope、详情 mark_used、新增（相似条目拦截）、编辑、admin 三页、统计、`<script>` 文本不被执行（XSS 检查）
- [ ] **Step 5: Commit** `git commit -m "feat: multi-stage docker build with web portal + docs"`

## Self-Review 结论

- Spec 覆盖：G1–G7、preview、facets、stats、SPA fallback、verifyOnly、权限矩阵、五页面、多阶段构建、文档——均有对应任务；§十一 留给构建者的项已在 Task 9/10/11 定死（手动按需 import、80 字符截断、pageSize 20/100 上限、Progress 图、RelativeTime 组件）
- 类型一致性：`registerApiRoutes(app, ctx)` / `ApiCtx` 在 Task 6 定义、Task 7/8 复用；`KnowledgeRow`/`ListItem`/`Facets` 在 Task 5 定义、Task 6 测试与 Task 10/11 前端类型对齐；admin service 函数名 Task 1↔Task 7 一致
- Review Focus 五项均有归属（Task 5/6 测试 + Task 14 checklist）
- 比例：14 个任务、每任务测试/实现/验证/提交四段，与 spec 体量相称
