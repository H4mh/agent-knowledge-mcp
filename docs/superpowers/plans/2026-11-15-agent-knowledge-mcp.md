# agent-knowledge-mcp 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建企业多 Agent 知识共享 MCP 服务：5 个工具（search / save / update / mark_used / get_context），Postgres+pgvector 存储，Bearer token 鉴权，docker compose 部署到阿里云 your-akm-server。

**Architecture:** 无状态 Fastify HTTP 服务挂载官方 MCP SDK（Streamable HTTP），应用层打分检索（bigram 分词 + trigram 相似度 + 状态/scope/use_count 加成），pgvector 仅预留列。管理操作走 CLI，不走 MCP 工具。

**Tech Stack:** Node 20 + TypeScript(strict) + `@modelcontextprotocol/sdk` + Fastify 4 + `pg` + vitest + docker compose（`pgvector/pgvector:pg16`）

**Spec:** `docs/superpowers/specs/2026-11-15-agent-knowledge-mcp-design.md`（本计划从中取所有具体值；冲突时以 spec 为准）

## Global Constraints

- Node 20 LTS，TypeScript strict；依赖经内网 Nexus 安装（`.npmrc` 提交模板，指向占位源，部署机自行配置）
- Postgres 镜像固定 `pgvector/pgvector:pg16`；迁移需 `CREATE EXTENSION IF NOT EXISTS vector, pg_trgm`
- MCP 传输：Streamable HTTP；鉴权 `Authorization: Bearer <token>` → DB 表 `app_user`（role: `user`/`admin`）
- 检索为软隔离：scope 未传时全库检索；传了 scope 则匹配条目打分加成（spec §7）
- 晋升规则：draft 被 ≥2 个不同用户 mark_used → verified；作者自己的 mark_used 不计入；同用户同条目幂等（spec §5）
- status 变更仅 admin；scope 必须在 `scope_registry` 且 enabled；domain 枚举 `java|frontend|mobile|infra|db|workflow`
- 敏感扫描分级：密钥/凭证/身份证/银行卡硬拒绝；内网 IP 仅警告（spec §5）
- commit 用 conventional 格式 + 中文主题（如 `feat: 实现检索打分`）
- 所有 DB 相关测试连 `TEST_DATABASE_URL`（本地 dev 库由 docker compose 起，端口 5433）

## Review Focus

| # | 易错点 | 期望行为 | 钉住它的测试 |
|---|---|---|---|
| 1 | 中文查询分词：`数据库连接失败` 须命中含 `连接失败` 的条目 | bigram 切分后 ILIKE 命中 | Task 4 / Task 7 |
| 2 | mark_used 防刷 | 同用户重复调用只计一次；作者自己 mark 不触发晋升 | Task 8 |
| 3 | 敏感扫描误伤 | 含内网 IP（10.x）的正常知识能入库，仅返回 warning | Task 3 |
| 4 | 未知 scope 提交 | save 拒绝且错误信息列出可用 scope | Task 6 |
| 5 | 未命中查询 | search_event 仍记录（hit_ids = 空数组） | Task 7 |
| 6 | 无效/禁用 token | 请求被 401 拒绝，不进入 MCP 处理 | Task 5 / Task 10 |

---

### Task 1: 项目骨架与配置加载

**Files:**
- Create: `package.json`、`tsconfig.json`、`vitest.config.ts`、`.npmrc`（Nexus 占位模板）、`.gitignore`、`src/config.ts`、`config/guard-rules.json`、`config/tag-aliases.json`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: Record<string,string|undefined>): Config`，`Config = { port: number; databaseUrl: string; rateLimitPerMin: number; dedupThreshold: number; searchWeights: { title: number; tags: number; symptom: number; solution: number; trigram: number; verifiedBoost: number; scopeBoost: number; useCountBoost: number } }`

- [ ] **Step 1: Write the failing test** — `loadConfig({})` 返回默认值（port 3000、rateLimitPerMin 60、dedupThreshold 0.6、weights 全 1、verifiedBoost 2、scopeBoost 3、useCountBoost 0.1）；`loadConfig({ PORT: '4000', DATABASE_URL: 'postgres://x' })` 覆盖生效；`DATABASE_URL` 缺失时抛错
- [ ] **Step 2:** `npx vitest run tests/config.test.ts` → FAIL（模块不存在）
- [ ] **Step 3:** 实现 `src/config.ts`（env 解析 + 默认值；无第三方 schema 库，手写解析）
- [ ] **Step 4:** 测试 PASS
- [ ] **Step 5:** Commit `chore: 项目骨架与配置加载`

### Task 2: 数据库迁移与连接池

**Files:**
- Create: `migrations/0001_init.sql`、`src/db.ts`、`docker-compose.dev.yml`（testdb: pgvector/pg16，端口 5433）
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces: `createPool(databaseUrl: string): Pool`；`applyMigrations(pool: Pool): Promise<void>`（按文件名顺序执行 `migrations/*.sql`，记录于 `schema_migrations` 表，幂等）

- [ ] **Step 1:** `docker compose -f docker-compose.dev.yml up -d testdb`；写失败测试：`applyMigrations` 后 `information_schema` 中存在 `knowledge`、`knowledge_usage`（含 `UNIQUE(knowledge_id, used_by)`）、`scope_registry`、`search_event`、`app_user`、`schema_migrations`；`knowledge.embedding` 列类型为 `vector`（无 typmod）；重复调用 `applyMigrations` 不报错不重复执行
- [ ] **Step 2:** 对 `TEST_DATABASE_URL` 运行 → FAIL
- [ ] **Step 3:** 实现 `0001_init.sql`（spec §六 的全部 DDL，含 pg_trgm/vector 扩展、trigram GIN 索引、`scope_registry` 预置 `global/demo-app/proj-a/proj-b/proj-c` 五行）与 `src/db.ts`
- [ ] **Step 4:** 测试 PASS
- [ ] **Step 5:** Commit `feat: 数据库迁移与连接池`

### Task 3: 敏感信息扫描（guard）

**Files:**
- Create: `src/guard/index.ts`
- Test: `tests/guard.test.ts`

**Interfaces:**
- Consumes: `config/guard-rules.json`
- Produces: `loadGuardRules(path: string): GuardRules`；`scanText(text: string, rules: GuardRules): GuardResult`，`GuardResult = { blocked: boolean; warnings: string[]; hits: { rule: string; match: string }[] }`；`GuardRules = { hardReject: {name, pattern}[]; warnOnly: {name, pattern}[] }`

- [ ] **Step 1:** 失败测试，断言：`BEGIN RSA PRIVATE KEY` 块 → blocked；`AKIAIOSFODNN7EXAMPLE` → blocked；18 位身份证号 → blocked；16~19 位银行卡号 → blocked；`连接 Nexus：10.2.3.4:8081` → 不 blocked、warnings 含内网 IP 提醒；`192.168.1.10` 同上；正常中文文本 → 全空
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3:** 实现 `src/guard/index.ts`（规则从 JSON 读正则；默认规则文件含上述六类）；Review Focus #3 的断言在本任务测试中
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: 敏感信息分级扫描`

### Task 4: 分词与 tag 归一化

**Files:**
- Create: `src/search/tokenizer.ts`、`src/search/tags.ts`
- Test: `tests/tokenizer.test.ts`、`tests/tags.test.ts`

**Interfaces:**
- Produces: `tokenize(query: string): string[]`（CJK 连续段切 bigram，单字段保留原字；拉丁/数字按非字母数字切分并小写）；`loadTagAliases(path): Record<string,string>`；`normalizeTags(tags: string[], aliases: Record<string,string>): string[]`（trim → 小写 → 别名映射 → 去重，保持首次出现顺序）

- [ ] **Step 1:** 失败测试：`tokenize('数据库连接失败')` 含 `'数据','据库','连接','失败'`（及组合中间 bigram，具体集合以实现为准——测试断言 `'连接' ∈ result && '失败' ∈ result && 'select' ∉ result`）；`tokenize('Spring Boot 超时')` 含 `'spring','boot','超时'`；`normalizeTags(['达梦',' DM8 ','vue','vue'])` → `['dameng','vue']`（`config/tag-aliases.json` 预置 `达梦/dm/DM8→dameng`、`kingbase→kingbase`、`人大金仓→kingbase`、`mysql→mysql`、`前端→frontend`）
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** 实现两模块
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: 中文分词与 tag 归一化`

### Task 5: 鉴权与限流

**Files:**
- Create: `src/auth.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Consumes: Task 2 的 pool；spec §八
- Produces: `authenticate(pool: Pool, bearer: string | undefined): Promise<AppUser | null>`，`AppUser = { username: string; role: 'user' | 'admin' }`（token 用 sha256 存 `app_user.token_hash`；`enabled=false` 或不匹配 → null）；`class RateLimiter { constructor(maxPerMin: number); allow(key: string): boolean }`（内存滑动窗口，每分钟超限返回 false）

- [ ] **Step 1:** 失败测试：预置 app_user（alice/user、bob/admin、carol/disabled）；`authenticate(pool, <alice 的 token>)` → alice/user；错误 token → null；carol 的 token → null；`RateLimiter(3)` 第 4 次 `allow('t1')` → false，`allow('t2')` → true
- [ ] **Step 2:** FAIL（对 TEST_DATABASE_URL 运行）
- [ ] **Step 3:** 实现；Review Focus #6 的鉴权断言在本任务
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: Bearer 鉴权与令牌限流`

### Task 6: save_knowledge 工具

**Files:**
- Create: `src/tools/save.ts`
- Test: `tests/tools/save.test.ts`

**Interfaces:**
- Consumes: Task 2~5 全部产出
- Produces: `handleSave(pool: Pool, cfg: Config, user: AppUser, input: SaveInput): Promise<SaveResult>`；`SaveInput = { title: string; symptom: string; solution: string; detail?: string; domain: string; scope: string; module?: string; tags: string[]; code_ref?: string }`；`SaveResult = { id: number; status: 'draft'; similar: { id: number; title: string; similarity: number }[] }`；domain 不在枚举 → 抛 `ToolError`（code `INVALID_DOMAIN`）；scope 不在 registry/enabled → `ToolError`（code `INVALID_SCOPE`，message 列出可用 scope）；guard blocked → `ToolError`（code `SENSITIVE_CONTENT`，含命中项）；否则入库 draft 并返回 similar（同 scope + global 内 trigram 相似度 ≥ `cfg.dedupThreshold`，按相似度取 3 条）

- [ ] **Step 1:** 失败测试：合法保存 → 返回 id、status draft、author 为当前用户、tag 已归一化；未知 scope → INVALID_SCOPE 且 message 含 `demo-app`；未知 domain → INVALID_DOMAIN；含私钥块的 detail → SENSITIVE_CONTENT 且库中无记录；含 `10.0.0.5` 的 solution → 保存成功；再保存 title 相似条目 → similar 非空；global 范围的相似条目也能命中 similar
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** 实现（`ToolError` 类定义在本文件并导出，含 `code` 与 `message`，后续工具复用）；Review Focus #4 在本任务
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: save_knowledge 工具`

### Task 7: search_knowledge 与检索打分

**Files:**
- Create: `src/search/index.ts`
- Test: `tests/search.test.ts`

**Interfaces:**
- Consumes: Task 4 tokenizer/tags、Task 2 表结构
- Produces: `searchKnowledge(pool: Pool, cfg: Config, input: { query: string; domain?: string; scope?: string; tags?: string[]; limit?: number }): Promise<{ results: { id: number; title: string; symptom: string; solution: string; status: string; code_ref: string | null; score: number }[] }>`；每次调用向 `search_event` 写一行（queried_by 由 server 层传入，见 Task 10 接口——实际签名在此追加第 4 参 `queriedBy: string`）

- [ ] **Step 1:** 失败测试（预置数据：scope demo-app 的 verified 条目 A「MySQL 分页返回全量数据」、同 scope draft 条目 B 同主题、scope proj-b 的 verified 条目 C「Kingbase 分页」、deprecated 条目 D）：中文 query「分页返回全量」命中 A、B 且 A 在 B 前（verified 加成）→ Review Focus #1；query「Kingbase 分页」带 `scope: demo-app` 时 C 仍出现在结果中（软隔离：不在过滤内，但同 scope 条目排名更高）→ 不带 scope 时全库检索；`deprecated` 条目 D 排最后且分值低于同主题 draft；命中时 `search_event.hit_ids` 非空；query「完全不存在的词条xyzq」→ results 空、`search_event` 新增一行 hit_ids=`{}` → Review Focus #5；`limit: 1` 只返回 1 条
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** 实现（打分 SQL：ILIKE 命中 × 字段权重 + `similarity()` × trigram 权重 + 状态/scope/use_count 加成，全部常量来自 `cfg.searchWeights`）
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: 检索打分与 search_event 记录`

### Task 8: update_knowledge 与 mark_used

**Files:**
- Create: `src/tools/update.ts`、`src/tools/markUsed.ts`
- Test: `tests/tools/update.test.ts`、`tests/tools/markUsed.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `ToolError`
- Produces: `handleUpdate(pool, user, input: { id: number; symptom?/solution?/detail?/tags?/code_ref?/module? }): Promise<{ ok: true }>`——文本字段作者本人或 admin 可改，他人 → `ToolError('FORBIDDEN')`；`handleMarkUsed(pool, user, input: { id: number; note?: string }): Promise<{ ok: true; status: string }>`——`INSERT ... ON CONFLICT (knowledge_id, used_by) DO NOTHING`；若 `knowledge_usage` 中**非作者**的不同用户数 ≥ 2 且 status=draft → 升级 verified；返回升级后 status

- [ ] **Step 1:** 失败测试（Review Focus #2 全部在此）：作者 alice 保存条目 → alice mark_used → 仍 draft；bob mark_used → 仍 draft（仅 1 个非作者用户）；carol mark_used → 变 verified；alice 再次 mark_used → usage 表仍 1 行、use_count 不再增长；非作者 dave update → FORBIDDEN；admin 可改任何条目文本字段；作者 update solution 生效；非 admin 传 status 变更请求 → FORBIDDEN（`handleUpdate` 忽略或拒绝 status 字段——实现为拒绝）
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** 实现两工具
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: update_knowledge 与 mark_used`

### Task 9: get_context

**Files:**
- Create: `src/tools/context.ts`
- Test: `tests/tools/context.test.ts`

**Interfaces:**
- Consumes: Task 2 表结构
- Produces: `getContext(pool, input: { scope: string; module?: string }): Promise<{ items: { id: number; title: string; solution: string }[] }>`——该 scope（+ 可选 module 前缀匹配）下 status 非 deprecated 条目，verified 优先，组内按 use_count 降序、再按 updated_at 降序，最多 20 条

- [ ] **Step 1:** 失败测试：scope 混合 verified/draft/deprecated 条目 → 返回不含 deprecated；verified 在 draft 前；21 条时只返回 20 条；`module: 'core/MicroFront'` 只返回该 module 开头的条目
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** 实现
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: get_context 工具`

### Task 10: MCP 服务装配（Streamable HTTP）

**Files:**
- Create: `src/server.ts`（McpServer 实例 + 5 工具注册）、`src/index.ts`（Fastify 启动、鉴权钩子、限流、优雅退出）
- Test: `tests/server.e2e.test.ts`

**Interfaces:**
- Consumes: Task 1~9 全部
- Produces: `createApp(cfg: Config): FastifyInstance`（可注入 pool 便于测试）；工具注册把 `queriedBy`（鉴权用户名）传入 `searchKnowledge`；启动命令 `npm start`

- [ ] **Step 1:** 失败 e2e 测试：起 `createApp` 于随机端口 → 用 MCP 官方 client（Streamable HTTP，header 带 alice 的 token）`listTools` 得到 5 个工具名；`callTool('save_knowledge', {...合法输入...})` 成功返回 id；`callTool('search_knowledge', { query })` 命中刚存的条目；不带 token 请求 → HTTP 401；禁用用户 token → 401；限流阈值内正常、超限 → 429；admin 通过 `callTool('update_knowledge', { id, status 由 server 端拒绝 })` 路径验证 status 不暴露给任何 MCP 调用方
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** 实现装配（工具的 zod input schema 固化 domain 枚举与必填字段；search 未命中时在结果 text 中附引导文案「未命中。若你后续解决了此问题，请调用 save_knowledge 沉淀。」；Review Focus #6 的 401 在本任务 e2e 复验）
- [ ] **Step 4:** PASS（全部 vitest 通过）
- [ ] **Step 5:** Commit `feat: MCP 服务装配与端到端测试`

### Task 11: 管理 CLI

**Files:**
- Create: `scripts/admin.ts`
- Test: `tests/admin.test.ts`

**Interfaces:**
- Produces: 子命令 `adduser <name> [--role admin]`、`listusers`、`disable <name>`、`enable <name>`、`delete-knowledge <id>`、`set-status <id> <status>`、`export <dir>`（全部条目导出为 spec §十二 frontmatter 格式 markdown，文件名 `<id>-<title slug>.md`）；运行方式 `npx tsx scripts/admin.ts <cmd>`，连 `DATABASE_URL`

- [ ] **Step 1:** 失败测试（对 TEST_DATABASE_URL）：`adduser alice --role admin` 后 `listusers` 含 alice/admin；`disable alice` 后该用户鉴权失败（复用 Task 5 `authenticate`）；`delete-knowledge` 后条目及其 usage 行消失；`export` 导出的 markdown 能被 Task 12 的导入脚本读回且字段一致（先于 Task 12 写测试时，仅断言文件存在 + frontmatter 含 title/domain/scope）
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** 实现
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: 管理员 CLI`

### Task 12: 种子数据导入脚本

**Files:**
- Create: `scripts/import-markdown.ts`、`scripts/seed-example/`（2 个示例条目 md）
- Test: `tests/import.test.ts`

**Interfaces:**
- Consumes: Task 2 表；frontmatter 格式 = spec §十二（title/domain/scope/module/tags/code_ref/symptom/solution 必填校验，缺项报错并指明文件）
- Produces: `importMarkdown(pool, dir: string): Promise<{ imported: number; errors: string[] }>`——status 固定 `verified`、author `import`、tags 经 Task 4 归一化；运行 `npx tsx scripts/import-markdown.ts <dir>`

- [ ] **Step 1:** 失败测试：导入 `scripts/seed-example/` → imported=2、库中 2 条 verified；缺 symptom 的坏文件 → errors 含文件名且不中断其他文件；重复运行同一目录 → 因（title, scope）重复而跳过（幂等，断言 imported=0）
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** 实现 + 2 个示例条目（一个 `demo-app`/`java`、一个 `global`/`frontend`，内容取自现有 CLAUDE.md 风格）
- [ ] **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: 种子数据导入脚本`

### Task 13: Docker 化与部署

**Files:**
- Create: `Dockerfile`、`docker-compose.yml`（app + db，含 healthcheck、volume）、`docs/deploy.md`

**Interfaces:**
- Consumes: 全部前序任务的 `npm run build` 产物（tsc → `dist/`）

- [ ] **Step 1:** 编写 `Dockerfile`（多阶段：`npm ci` → `tsc` → 运行镜像只含 dist + node_modules + config + migrations + scripts）；`docker-compose.yml`：`db` 用 `pgvector/pgvector:pg16`、volume 持久化、healthcheck `pg_isready`；`app` 依赖 db 健康，环境变量 `DATABASE_URL`、`PORT`
- [ ] **Step 2:** 本机 `docker compose up --build` 验证：容器全绿；`curl` 服务端口返回可建立 MCP 会话（401 无 token 即为预期行为，证明服务活着）
- [ ] **Step 3:** 编写 `docs/deploy.md`：阿里云 your-akm-server 部署步骤（ssh -i `<密钥路径>`、安装 docker、拷贝 compose 文件与镜像、`applyMigrations` 自动执行、admin adduser 建首批账号）；**显著标注安全要求：安全组仅放行公司出口 IP 访问 MCP 端口，禁用 0.0.0.0/0**；备份方案（pg_dump 定时 + `admin export` 导出 markdown）
- [ ] **Step 4:** Commit `feat: Docker 化与部署文档`

### Task 14: 接入集成模板

**Files:**
- Create: `integration/CLAUDE.md.snippet`、`integration/.mcp.json.example`、`integration/session-start-hook.js`（+使用说明 `integration/README.md`、`integration/cursor.example.md`）

- [ ] **Step 1:** 编写四个文件：CLAUDE.md 片段（何时必须 search、何时必须 save、开工先 get_context，中文）；`.mcp.json.example`（Streamable HTTP 指向 `http://your-akm-server:<PORT>/mcp`，header 带 token 占位）；SessionStart hook（向会话注入知识库使用提醒 + 提示调用 get_context，标准 Claude Code hook 格式）；README 汇总接入步骤与 Cursor 说明
- [ ] **Step 2:** 人工核对片段中的 URL/工具名与本实现一致（5 个工具名逐一比对）
- [ ] **Step 3:** Commit `feat: 接入集成模板`

---

## 交付验收

1. `npx vitest run` 全绿（单测 + e2e）
2. `docker compose up --build` 后用 MCP client 带 token 走通「save → search → mark_used → get_context」闭环
3. `docs/deploy.md` 完整可照做；安全组要求为必读项
4. 上线前用 Task 12 脚本导入首批真实种子数据（从各项目 CLAUDE.md 提取，另行人工+agent 转写，不在本计划内）
