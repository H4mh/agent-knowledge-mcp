# 阶段一加固（Hardening）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 身份与凭证分离（注册领随机 token）+ 更新乐观锁与修订历史 + 备份/监控运维落地。

**Architecture:** 注册流程改为"名字注册、随机 token 凭证"，token 经首次工具调用响应一次性下发；knowledge/skill 双写路径改为事务内「FOR UPDATE 行锁 → base_version 校验 → 修订行 → UPDATE version+1 → 提交 → embedding 外呼」；修订历史经共享 `entry_revision` 表向 MCP/REST/CLI 三面暴露。

**Tech Stack:** TypeScript + Fastify 5 + Postgres 17 + MCP SDK（Streamable HTTP）+ Vue 3 门户

**Spec:** docs/superpowers/specs/2026-11-17-hardening-design.md

## Global Constraints

- 所有新行为向后兼容：base_version 可选（不带 = 现状行为 + version+1）；老身份（token_hash=sha256(名字)）补发前继续可用；不做 AKM_TOKEN_STRICT（用户裁定砍掉）
- 迁移文件放 `migrations/0004_*.sql`，启动时幂等执行（模板 src/db.ts:44 的事务模式）
- embedding 外呼必须留在修订+更新事务提交之后（外部 HTTP 慢/挂不得拖住事务）
- 并发原子性：base_version 校验与 version+1 必须在同一事务内 `SELECT ... FOR UPDATE`
- 身份名大小写敏感保持现状（残留风险，已记录不处理）
- 测试跑法：`export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"; export TEST_DATABASE_URL=postgresql://akm:akm@127.0.0.1:5433/akm_test; npm test <file>`（真实 Postgres，fileParallelism: false）
- 提交信息中文前缀（feat:/fix:/docs:），末行 `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- identity_token 32 字符 hex（`randomBytes(16).toString('hex')`），明文仅在注册响应与 reset-token 输出出现一次

## Review Focus

1. **agent 没存 token 就重试**（Bearer=名字再次调用）→ 必须得到 401（占用检查拒绝），且注册那次的错误路径响应也带 identity_token。Task 3 e2e 测试钉住。
2. **embedding 服务宕机时的更新**：事务必须已提交、修订行必须存在、旧向量保留。Task 5 用失败 embedder 测试钉住。
3. **base_version 过期**（带旧版本号更新）→ CONFLICT 错误且主表未被修改。Task 5/6 测试钉住。
4. **状态变更不 bump version**：setStatus/自动晋升写修订但 version 不变，agent 持有的 base_version 不因此失效。Task 7 测试钉住。
5. **老 token 迁移判定**：`listusers --legacy` 恰好列出 token_hash=sha256(username) 的身份。Task 4 测试钉住。

---

### Task 1: migration 0004 — knowledge.version + entry_revision 表

**Files:**
- Create: `migrations/0004_hardening.sql`
- Test: `tests/db.test.ts`（追加）

**Interfaces:**
- Produces: `knowledge.version INT NOT NULL DEFAULT 1`；表 `entry_revision(id BIGSERIAL PK, entry_kind TEXT NOT NULL CHECK (entry_kind IN ('knowledge','skill')), entry_id BIGINT NOT NULL, version INT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('content','status')), changed_by TEXT NOT NULL, changes JSONB NOT NULL, snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`，索引 `(entry_kind, entry_id, created_at DESC)`

- [ ] **Step 1: 写失败测试**（tests/db.test.ts 追加）：迁移后 `information_schema.columns` 含 knowledge.version 且默认 1；`entry_revision` 可插入一行 kind='content' 并能按索引列查询；CHECK 约束拒绝 entry_kind='other' 与 kind='delete'

- [ ] **Step 2: 跑测试确认失败**：`npm test tests/db.test.ts` → FAIL（列不存在）

- [ ] **Step 3: 写 migrations/0004_hardening.sql**：`ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;` + CREATE TABLE（含 CHECK 与索引）。注意 skill 已有 version 列（0003），不要重复添加

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: Commit** `feat(db): migration 0004 knowledge.version 与 entry_revision 修订表`

### Task 2: authenticate 随机 token 注册

**Files:**
- Modify: `src/auth.ts`
- Test: `tests/auth.test.ts`（追加）

**Interfaces:**
- Consumes: 现有 `authenticate(pool, bearer, opts)` 与 `tokenHash`（auth.ts:9）
- Produces: `export interface AuthResult extends AppUser { identityToken?: string }`；`authenticate` 返回类型改为 `Promise<AuthResult | null>`。注册分支生成 `randomBytes(16).toString('hex')`，`token_hash = sha256(identityToken)`，返回时带 identityToken；已注册 token 命中路径与禁用路径行为不变（无 identityToken）。`AppUser` 接口不变（identityToken 是 AuthResult 扩展）

- [ ] **Step 1: 写失败测试**：a) 未知合法名字 Bearer → 返回 user 且 identityToken 为 32 位 hex，库中 token_hash ≠ sha256(名字)；b) 用返回的 identityToken 再次调用 → 命中同一 username；c) 用名字本身再次调用 → null（用户名占用检查拒绝——本计划的 Review Focus #1 前半）；d) JOIN_SECRET 缺失时注册被拒（现有行为回归确认）

- [ ] **Step 2: 跑测试** → FAIL（identityToken undefined）

- [ ] **Step 3: 改 src/auth.ts 注册分支**（约 :38-51）：生成随机 token、存其哈希、AuthResult 携带明文一次

- [ ] **Step 4: 跑测试** → PASS

- [ ] **Step 5: Commit** `feat(auth): 自报注册改为生成随机访问令牌（名字降级为署名）`

### Task 3: MCP 响应注入 identity_token（成功与错误路径）

**Files:**
- Modify: `src/app.ts`
- Test: `tests/server.e2e.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `AuthResult.identityToken`
- Produces: buildServer 的 user 参数类型放宽为 `AuthResult`；本地助手 `const withIdentity = (user: AuthResult, res: { content: ...; isError?: boolean }) => user.identityToken ? { ...res, content: [...res.content, { type: 'text', text: `[身份已注册] 访问令牌（identity_token）：${user.identityToken}。请立即写入 .mcp.json 的 Authorization: Bearer <token> 并重启会话；令牌仅显示这一次。` }] } : res`；**全部 9 个 handler** 的 return（含 toolError 路径）套 withIdentity

- [ ] **Step 1: 写失败 e2e 测试**：新名字调 tools/call save_knowledge → 响应 content 含 `identity_token`；用该 token 再调 search_knowledge → 成功；再用名字调 → 401。另测 SENSITIVE_CONTENT 触发的错误路径响应也含 identity_token

- [ ] **Step 2: 跑测试** → FAIL（响应无 identity_token）

- [ ] **Step 3: 实现 withIdentity 并逐 handler 应用**（app.ts:49-292 九处 return）

- [ ] **Step 4: 跑测试** → PASS（全套 e2e 回归）

- [ ] **Step 5: Commit** `feat(mcp): 首次注册响应携带 identity_token（成功与错误路径）`

### Task 4: admin CLI — reset-token / listusers --legacy / history

**Files:**
- Modify: `src/admin/service.ts`、`scripts/admin.ts`
- Test: `tests/admin.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 entry_revision 表
- Produces: `resetToken(pool, username): Promise<string>`（生成随机 token、UPDATE token_hash、返回明文；用户不存在 → ToolError NOT_FOUND）；`listLegacyUsers(pool): Promise<string[]>`（token_hash = sha256(username) 的 username 列表）；`listRevisions(pool, entryKind, entryIdOrName): Promise<RevisionRow[]>`（skill 按 name→id 解析；按 created_at DESC 限 50；返回 {version, kind, changed_by, changes, created_at}，**不含 snapshot**）。CLI：`reset-token <名字>`、`listusers --legacy`、`history <id>`、`history --skill <name>`

- [ ] **Step 1: 写失败测试**：a) resetToken 后旧 token 401（authenticate 查不到）、新 token 命中、返回值 ≠ 用户名；b) 名字注册的用户出现在 listLegacyUsers，resetToken 后消失；c) listRevisions 返回插入的修订行（先手工 INSERT 两行）且 skill 名解析正确；d) 不存在的 id/name → NOT_FOUND

- [ ] **Step 2: 跑测试** → FAIL

- [ ] **Step 3: 实现 service 三函数 + CLI 四命令**（scripts/admin.ts 按 :65-207 既有 case 模式）

- [ ] **Step 4: 跑测试** → PASS

- [ ] **Step 5: Commit** `feat(admin): reset-token 补发令牌、listusers --legacy 迁移检测、history 修订查询`

### Task 5: update_knowledge 乐观锁 + 修订（事务重写）

**Files:**
- Create: `src/admin/revisions.ts`
- Modify: `src/tools/update.ts`
- Test: `tests/tools/update.test.ts`（追加；文件不存在则新建）

**Interfaces:**
- Consumes: Task 1 entry_revision；Task 2 无关
- Produces: `src/admin/revisions.ts` 导出 `export type RevisionKind = 'content' | 'status';` 与 `export async function insertRevision(client: PoolClient, entryKind: 'knowledge'|'skill', entryId: number, version: number, kind: RevisionKind, changedBy: string, changes: Record<string, unknown>, snapshot: Record<string, unknown>): Promise<void>`（client 为事务内连接，模板见 src/db.ts:44）。`UpdateInput` 增 `base_version?: number`；`UpdateResult` 改为 `{ ok: true; version: number }`

- [ ] **Step 1: 写失败测试**：a) 带 base_version=1 更新存在条目 → 成功且返回 version=2，entry_revision 有一行（changes 含旧字段值、snapshot 为更新前整行）；b) 带 base_version=2（过期）→ ToolError CONFLICT 且主表 symptom 未变、version 仍为 2；c) 不带 base_version → 成功 version+1（兼容）；d) 内容无实际变化（传相同 symptom）→ version 不变、无修订行；e) deps.embedder 为总是 reject 的 embedder → 更新成功、修订行存在、embedding 保持旧值（Review Focus #2）

- [ ] **Step 2: 跑测试** → FAIL

- [ ] **Step 3: 重写 handleUpdate**：`pool.connect()` + BEGIN → `SELECT ... FOR UPDATE`（含 version、title、symptom、solution、detail、tags、code_ref、module、author、status、scope、domain）→ 权限校验（保持现有 author/admin 规则与 SENSITIVE_CONTENT 前置扫描不变）→ base_version 校验（不符 ROLLBACK 后 throw CONFLICT，message 提示重新 search 获取最新 version）→ changed 检测（仅实际提交且值变化的字段进 sets）→ 有变化：insertRevision（kind='content'，changes={field: oldValue}，snapshot=旧行 JSON）→ UPDATE（`version = version + 1, updated_at = now()`）→ COMMIT → COMMIT 后跑现有 embedding 重生成块（失败保留旧向量）→ 返回新 version

- [ ] **Step 4: 跑测试** → PASS

- [ ] **Step 5: Commit** `feat(update): knowledge 更新乐观锁（FOR UPDATE + base_version）与修订记录`

### Task 6: update_skill base_version + 修订

**Files:**
- Modify: `src/tools/skill.ts`（handleUpdateSkill，:238-336）
- Test: tests/tools/ 下 skill 更新测试文件（按现有文件命名）

**Interfaces:**
- Consumes: Task 5 的 `insertRevision`
- Produces: `UpdateSkillInput` 增 `base_version?: number`；handleUpdateSkill 返回不变（{ok, version}）

- [ ] **Step 1: 写失败测试**：a) base_version 过期 → CONFLICT 且内容未变；b) base_version 正确 → version+1 + 修订行（snapshot 为更新前整行，含 files JSON）；c) 无变化早返回路径不写修订（现状行为回归）；d) scope 清空（null）路径照常记账

- [ ] **Step 2: 跑测试** → FAIL

- [ ] **Step 3: 改 handleUpdateSkill**：SELECT 增加 FOR UPDATE 语义——改为 `pool.connect()` 事务内执行现有 SELECT + 校验 + insertRevision（changed 时）+ UPDATE（原有 version+1 逻辑）+ COMMIT；embedding 块留在 COMMIT 后（现状顺序保持）；base_version 在权限校验后、变更检测前校验

- [ ] **Step 4: 跑测试** → PASS（skill 全套回归）

- [ ] **Step 5: Commit** `feat(skill): update_skill 乐观锁与修订记录`

### Task 7: 状态变更入修订（admin setStatus + get_skill 自动晋升）

**Files:**
- Modify: `src/admin/service.ts`（setStatus :26-35）、`src/tools/skill.ts`（handleGetSkill 晋升块，约 :376-379）
- Test: `tests/admin-service.test.ts`、skill 测试文件（追加）

**Interfaces:**
- Consumes: Task 5 的 insertRevision
- Produces: `setStatus(pool, id, status, changedBy: string)`（**签名变更**：新增第三参 changedBy；调用方 scripts/admin.ts 与 src/api/routes.ts:238 同步传 CLI 用户名/门户 username）。修订行 version 取当前 knowledge.version、kind='status'、changes={status: 旧值}、snapshot=更新前整行；**不改 version**（Review Focus #4）。自动晋升同样写 kind='status' 修订（changedBy=触发拉取的 username，changes={status:'draft'}）

- [ ] **Step 1: 写失败测试**：a) setStatus 后修订行存在且 knowledge.version 未变、changes.status=旧状态；b) 第二个非作者用户 get_skill 晋升 verified 后修订行存在；c) 非法 status 仍 INVALID_STATUS（回归）

- [ ] **Step 2: 跑测试** → FAIL

- [ ] **Step 3: 实现两处修订写入**（status 更新用小事务：connect/BEGIN/SELECT FOR UPDATE/insertRevision/UPDATE/COMMIT——改动量小，直接在函数内做）

- [ ] **Step 4: 跑测试** → PASS

- [ ] **Step 5: Commit** `feat(admin): 状态流转与自动晋升写入修订历史（version 不变）`

### Task 8: 查询负载补 version + MCP update 响应带版本

**Files:**
- Modify: `src/search/index.ts`（SELECT 列表 :99）、`src/tools/context.ts`（:29）、`src/api/queries.ts`（LIST_COLS 常量）、`src/app.ts`（update_knowledge 响应文本 :130）
- Test: `tests/search.test.ts`、tests/api/ 相应文件（追加断言）

**Interfaces:**
- Consumes: Task 1 的 knowledge.version
- Produces: search_knowledge 命中项、get_context 条目、门户列表/详情 JSON 均含 `version` 字段（search_skills/get_skill 已有，不动）；update_knowledge 工具响应文本改为 `已更新（v${r.version}）。`

- [ ] **Step 1: 写失败断言**：search 结果对象含 version:number；context 条目含 version；门户 listKnowledge items 含 version；详情含 version

- [ ] **Step 2: 跑测试** → FAIL

- [ ] **Step 3: 三处 SELECT 补 version 列**（queries.ts 只改 LIST_COLS 一处常量；映射函数若逐字段拷贝需同步）+ app.ts 响应文本（r.version 来自 Task 5）

- [ ] **Step 4: 跑测试** → PASS

- [ ] **Step 5: Commit** `feat(api): 检索/上下文/门户负载携带 version 字段`

### Task 9: REST — base_version 放行 + 修订历史只读端点

**Files:**
- Modify: `src/api/routes.ts`（PUT :195-209 白名单与新增端点）、`src/api/skillRoutes.ts`（PUT :150-161）
- Test: `tests/api/` 追加

**Interfaces:**
- Consumes: Task 5/6 的 CONFLICT 语义；Task 4 的 listRevisions（这里直接内联查询更简单：两处 GET 直接 SQL 查 entry_revision，不经 service——与端点轻查询风格一致）
- Produces: `GET /api/knowledge/:id/revisions` 与 `GET /api/skills/:name/revisions`：readGuard（匿名只读，模式同 routes.ts:224-228 的 /api/stats）；404 当条目不存在；200 体 `{ revisions: [{ version, kind, changed_by, changes, created_at }] }` 按 created_at DESC 限 50，不含 snapshot。PUT 端点不再剥除 `base_version`

- [ ] **Step 1: 写失败测试**：a) PUT /api/knowledge/:id 带 base_version 更新成功（走 Task 5 路径）；b) GET revisions 匿名 200 且排序正确；c) 不存在条目 404；d) skill 同名两项；e) readGuard 拒绝逻辑回归（带非法 token 401）

- [ ] **Step 2: 跑测试** → FAIL

- [ ] **Step 3: 实现白名单调整与两个 GET 端点**（skillRoutes GET 需先 name→id）

- [ ] **Step 4: 跑测试** → PASS

- [ ] **Step 5: Commit** `feat(api): PUT 放行 base_version，新增修订历史只读端点`

### Task 10: 门户修订历史面板

**Files:**
- Modify: `web/src/components/KnowledgeDetailDrawer.vue`、`web/src/components/SkillDetailDrawer.vue`、`web/src/api.ts`
- Test: `npm run build`（web 无单测，构建通过 + 手工验证步骤）

**Interfaces:**
- Consumes: Task 9 的 GET revisions 端点
- Produces: 两抽屉新增「修订历史」折叠面板（a-collapse）：每行显示时间（RelativeTime）、changed_by、kind（内容修改/状态流转）、changes 的字段名与旧值摘要（JSON 前 120 字符）；打开抽屉时懒加载，失败静默不阻塞详情

- [ ] **Step 1: web/src/api.ts 增 `fetchRevisions(kind: 'knowledge'|'skill', idOrName): Promise<Revision[]>`**

- [ ] **Step 2: 两个 Drawer 增折叠面板**（遵循现有 a-collapse/相对时间组件用法）

- [ ] **Step 3: `npm run build`（web 目录）** → 构建通过

- [ ] **Step 4: Commit** `feat(web): 知识与 skill 详情抽屉增加修订历史面板`

### Task 11: 配套文档与接入材料

**Files:**
- Modify: `integration/.mcp.json.example`（如含 JOIN_SECRET 注释示例）、`integration/CLAUDE.md.snippet`（身份自配置条款重写：注册→取 identity_token→写回配置→重启；加粗提示令牌仅显示一次）、`integration/setup-akm.sh`、`integration/setup-akm-global.sh`、`integration/setup-akm-global.ps1`（Bearer 名字仍作为首次注册载体，脚本输出提示改为"首次调用后按 agent 提示回写 token"）、`integration/使用教程.md`、`integration/README.md`、`README.md`、`README.zh-CN.md`、`docs/deploy.md`
- Test: 无（文档）

**Interfaces:**
- Consumes: Task 2-4 的对外行为
- Produces: 文档与代码一致。deploy.md 增补：`AKM_JOIN_SECRET` 生产必配说明、迁移操作序列（部署后 `listusers --legacy` → 逐个 `reset-token <名字>` 并线下交付 token → 复查 legacy 为空）、reset-token/history 命令

- [ ] **Step 1: 逐文件更新**（对照本任务 Files 清单与 spec §1.7）

- [ ] **Step 2: 校对**：`grep -rn "Bearer 填名字即自动注册\|Bearer token 填自己的名字" *.md docs/ integration/` → 0 命中（旧描述清空）

- [ ] **Step 3: Commit** `docs: 接入材料与文档同步身份令牌化（注册领凭证）`

### Task 12: 运维落地（controller 执行，不派实现者；生产操作需用户授权）

**Files:**
- Create: `scripts/ops/monitor.sh`
- Modify: `docs/deploy.md`（备份/监控节落成可复制命令）
- 生产操作（服务器 your-akm-server）：
  - [ ] crontab 落地每日备份（`0 2 * * *` pg_dump|gzip，find -mtime +30 -delete 清理）
  - [ ] 恢复演练：取 dump 建临时库导回，行数比对（knowledge/skill/app_user），记录结果后删临时库
  - [ ] 部署 monitor.sh（/opt/akm-monitor/ + crontab 每 5 分钟；webhook.env 留空仅日志）
  - [ ] .env 增 `AKM_JOIN_SECRET`（与用户确认口令）后 `docker compose up -d`
  - [ ] `listusers --legacy` → `reset-token <名字>`（token 交付用户本人）；admin 账号同
- [ ] **Step 1: 写 scripts/ops/monitor.sh**（健康检查 + 向量链路检查 + 边沿判重 + WEBHOOK_URL POST，超时 10s）
- [ ] **Step 2: deploy.md 更新**（备份/监控/迁移三节）
- [ ] **Step 3: Commit** `chore(ops): 监控脚本与备份/迁移运维配方`
- [ ] **Step 4: 生产执行上述清单**（用户授权窗口）

---

## Self-Review 记录

- Spec 覆盖：§1 各条 → Task 2/3/4/11/12（strict 已砍、JOIN_SECRET 配置化、无自助找回）；§2 → Task 5/6/7/8/9/10；§3/§4 → Task 12。无缺口。
- 类型一致：AuthResult.identityToken（Task 2 产 → Task 3 消）；insertRevision 签名（Task 5 产 → Task 6/7 消）；UpdateResult.version（Task 5 产 → Task 8 消）；setStatus changedBy 第三参（Task 7 内自洽，调用方同步改）。
- Step 扫描：无 TBD/空指令；事务重排细节在 Task 5 Step 3 给足（FOR UPDATE、changed 检测、embedding 后置）。
- Review Focus 1→Task 3/2→Task 5(d/e)/3→Task 5(b)/4→Task 7/5→Task 4(b)，均已落测试。
- 比例：计划 ≈ spec 的 2 倍，均为接口/测试/事务顺序等实现者必需信息，无代码转写。
