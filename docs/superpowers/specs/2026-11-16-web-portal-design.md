# Web 知识门户（可视化前端）设计

日期：2026-11-16
状态：已批准（2026-11-16）
前置文档：`docs/superpowers/specs/2026-11-15-agent-knowledge-mcp-design.md`（本服务整体设计）

## 一、意图与动机（Why）

知识库目前只有 MCP 工具入口，两类痛点：

1. **CLI 管理不直观**：管理员改状态、删条目、禁用户都要 ssh 上服务器敲 `docker exec`，scope 注册表、用户列表没有可视化视图。
2. **非 agent 场景无法检索**：团队成员不开 agent 时（如排队查资料、新人熟悉历史坑），无法浏览/检索知识库。

目标形态：**全团队开发者打开浏览器即可浏览、检索知识；管理员在浏览器里完成全部管理操作**。服务继续跑在现有云服务器容器里，不加新容器、不依赖任何个人电脑常开。

## 二、目标 / 非目标 / 反目标

**目标**

- G1 浏览器访问 `http://<server>:3000/` 即是知识门户（同一端口同时承载 MCP `/mcp` 与门户）
- G2 检索：关键词检索 + domain/scope/status 筛选，结果展示状态、use_count、新鲜度（与 MCP search 同一套打分与向量召回）
- G3 知识增删改查：新增/编辑走与 MCP 完全相同的校验链（domain 枚举、敏感信息拦截、查重提示、scope 规则）
- G4 `mark_used`（"帮到了我"）在详情页一键可点，驱动 draft→verified 晋升
- G5 管理后台（仅 admin）：条目状态变更/删除、scope 注册表管理、用户禁用/启用
- G6 概览统计：各状态/scope/domain 条数、最常用知识 TOP、检索未命中 TOP
- G7 登录：输入"身份令牌"（即 MCP Bearer 后那串字符串）即可，admin 权限服务端识别，前端零额外账号体系

**非目标（v1 不做）**

- 密码/注册/找回体系（鉴权模型与 MCP 完全一致，仍是 token 即身份）
- HTTPS/TLS 终结（沿用 deploy.md 既定路线：后续前置 nginx，本次不变）
- Markdown 渲染（detail 以纯文本 pre-wrap 展示，不引入 markdown 解析器——消除 XSS 面，v1 够用）
- 移动端适配（公司内网桌面浏览器为主，responsive 布局自然降级即可）
- 权限粒度细分（不做"只读身份"等新角色，维持 user/admin 两级）
- 评论/讨论区

**反目标（做了即失败）**

- 前端做成第二个容器/第二个服务，增加 1.6G 小服务器的内存负担与运维面
- 门户绕过现有校验链直连数据库（所有写操作必须复用 handleSave/handleUpdate 等既有 handler）
- 把 token 存到 cookie 并跨域携带（同源 SPA，localStorage + Bearer header 足够）

## 三、约束

- 服务器 2C/1.6G 内存：前端为静态产物（Vite 构建后纯 HTML/JS/CSS），由现有 Fastify 进程托管，增量内存≈0
- 鉴权沿用 `src/auth.ts` 的 `authenticate()`（sha256 token 查 `app_user`）+ 现有 `RateLimiter`；禁用 token 依旧永久封禁
- 公司出口 IP 安全组限制上线前，门户与 MCP 暴露面相同（同端口）——**门户上线加重了安全组配置的紧迫性**，deploy.md 需强调
- 前端构建在 Docker 多阶段构建中完成，不要求开发者本机装 Node
- 现有 MCP 协议路径 `/mcp` 行为不变，回归测试覆盖
- 测试 DB：`TEST_DATABASE_URL="postgresql://akm:akm@localhost:5433/akm_test"`，vitest 全套沿用

## 四、方案对比（Approaches）

| 方案 | 说明 | 取舍 | 结论 |
|---|---|---|---|
| **A. 静态 SPA 内嵌现有 Fastify 容器** | Vite 构建产物放容器内，`@fastify/static` 托管，`/api/*` 新增 REST 路由复用既有 handler | 零新增容器、零新增端口；构建时多一个 stage；Fastify 进程多托管静态文件（可忽略开销） | ✅ 采用 |
| B. 独立 nginx 容器托管前端 + 反代 API | 前后端分离更"标准"，nginx 可顺带做 TLS | 多一个常驻容器（nginx ~10MB 内存尚可但增加 compose/运维面）；服务器拉镜像不便（需 daocloud 代理）；TLS 单独可后置 | ❌ 过度设计，v1 不值 |
| C. 前端部署在用户 Mac，服务器仅转发 | 团队流量依赖个人电脑在线 | 用户已明确否决（"全团队开发者都能打开浏览器"，不能依赖个人 Mac） | ❌ 否决 |

方案 A 是唯一同时满足"团队不依赖个人设备 + 不加运维面 + 1.6G 内存可行"的选项。

**技术栈（用户已定）**：Vue 3 + TypeScript + Vite + **Ant Design**——Vue 3 生态下对应组件库为 `ant-design-vue`（4.x），搭配 `@ant-design/icons-vue`。公司技术栈本就是 Vue 系，Ant Design 的表格/表单/抽屉组件成熟，适合本项目大量"列表+筛选+详情抽屉"场景。路由 `vue-router`（history 模式，需服务端 SPA fallback）。不引入 pinia——用一个响应式 auth 模块足够。

## 五、鉴权与权限矩阵

**登录流程**：用户打开门户 → 未登录时弹出登录框（单一输入框："身份令牌"）→ 前端将 token 存 localStorage，后续所有请求带 `Authorization: Bearer <token>` → `GET /api/me` 校验并返回 `{username, role, registered}` → 401 则清除本地 token 回登录框。admin 登录后导航多出"管理后台"入口。

**门户不开放自报注册（用户裁定，2026-11-16）**：`/api/*` 的鉴权为**仅校验**——Bearer token 必须已存在于 `app_user`（复用 `authenticate()` 的已注册分支，跳过自报注册分支；实现上给 `authenticate()` 加 `verifyOnly` 选项或独立的 verify 函数）。未知/格式不合法/被禁用 token 一律 401，错误信息："身份不存在：请先通过 agent 端 MCP 使用一次（首次使用自动注册），或联系管理员创建身份"。这样打错 token 不会静默注册出垃圾身份，门户不成为绕过 `AKM_JOIN_SECRET` 的旁门。新同学获得门户身份的途径：用 agent 接入 MCP 首次使用即自动注册（同名同 token 门户直接可登录），或管理员 `adduser` 发放。

**权限矩阵**（服务端强制，前端仅做导航裁剪）：

| 操作 | user | admin | 复用 |
|---|---|---|---|
| 检索 / 浏览 / 详情 / 统计 | ✅ | ✅ | `searchKnowledge` / 新增 list 查询 |
| 新增知识 | ✅（作者=自己） | ✅ | `handleSave` |
| 编辑知识 | 仅本人条目 | ✅（任意） | `handleUpdate`（已有 author-or-admin 规则） |
| mark_used | ✅ | ✅ | `handleMarkUsed` |
| 状态变更（verified/deprecated/draft） | ❌ | ✅ | admin service |
| 删除知识 | ❌ | ✅ | admin service |
| scope 注册表管理 | ❌ | ✅ | admin service |
| 用户禁用/启用 | ❌ | ✅ | admin service |

说明：MCP 侧用户本就无法变更 status（`handleUpdate` 收到 status 即报 FORBIDDEN），门户 v1 同样不给 user 开放；所有 403 统一返回 `{error: 'FORBIDDEN'}`。

## 六、REST API 设计

新增前缀 `/api/*`，与 `/mcp` 同进程同端口。统一 JSON 响应；错误体 `{error: <CODE>, message?}`，复用 `ToolError` 的 code（SENSITIVE_CONTENT / INVALID_SCOPE / FORBIDDEN / NOT_FOUND 等）。鉴权中间件：取 Bearer → `authenticate()` → 失败 401；`RateLimiter` 按 token 继续生效（门户与 MCP 共享同一限流策略）。

| 方法 | 路径 | 权限 | 说明 / 复用 |
|---|---|---|---|
| GET | `/api/me` | 任意已注册 token | 登录校验（仅校验，不注册），返回 `{username, role}` |
| POST | `/api/knowledge/preview` | 登录 | **提交前预检（dry-run）**：body 同 SaveInput，只跑 guard 敏感扫描 + scope 校验 + 查重（从 `handleSave` 中抽出可复用的预检函数），**不入库**；返回 `{similar: [...], warnings: [...], scopeWillRegister: boolean}`。新增表单提交前自动调用，命中相似条目时让用户选择"仍要新建 / 去看相似条目" |
| GET | `/api/knowledge?q=&domain=&scope=&status=&tag=&page=&pageSize=` | 登录 | 分两种模式：**q 非空 → 检索模式**：`searchKnowledge`（含 embedder 向量召回），最多返回 50 条（MCP 同款），**无分页**——响应 `{items, total: null, mode: 'search'}`，前端在列表底部提示"最多展示 50 条，请细化关键词"；**q 空 → 浏览模式**：新增 `listKnowledge`（纯过滤分页列表，status/domain/scope/tag 过滤，按 updated_at 倒序）——响应 `{items, total, page, pageSize, mode: 'browse'}`。两种模式响应均附 `facets: {domains: [{value, count}], scopes: [{value, count}]}`（当前库内去重值 + 条目数），供筛选下拉与浏览页 scope 目录使用。items 字段：id/title/symptom 摘要/solution 摘要/status/scope/domain/tags/use_count/last_used_at/author/updated_at |
| GET | `/api/knowledge/:id` | 登录 | 全量字段含 detail；404 |
| POST | `/api/knowledge` | 登录 | body=SaveInput → `handleSave`；返回 SaveResult（含 similar 查重提示与 warnings） |
| PUT | `/api/knowledge/:id` | 作者/admin | → `handleUpdate` |
| POST | `/api/knowledge/:id/used` | 登录 | → `handleMarkUsed`，body 可带 `{note}` |
| POST | `/api/knowledge/:id/status` | admin | body `{status}` → admin `set-status` 逻辑 |
| DELETE | `/api/knowledge/:id` | admin | admin `delete-knowledge` 逻辑 |
| GET | `/api/scopes` | admin（user 侧下拉数据走 `/api/knowledge` 的 facets） | scope 注册表全量 + 每个 scope 的条目数 |
| POST | `/api/scopes` | admin | 新增 scope `{scope, description?}`，格式校验用 `SCOPE_RE`（与 save 一致） |
| PATCH | `/api/scopes/:scope` | admin | 改 description / enabled |
| DELETE | `/api/scopes/:scope` | admin | 仅当该 scope 无条目时允许删除。**注意**：现 CLI `delete-scope` 无条目检查、直接删；抽到共享 service 后 CLI 与 REST 统一获得该校验（CLI 行为收紧，属本设计声明的目标语义） |
| GET | `/api/users` | admin | 用户列表（username/role/enabled/created_at，不回 token_hash） |
| POST | `/api/users/:username/disable`<br>`/api/users/:username/enable` | admin | admin CLI 同逻辑 |
| GET | `/api/stats` | 登录 | `{byStatus, byDomain, byScope(前10), topUsed(前10), recentMisses(前10)}` |

**facets 便捷数据**：见 `/api/knowledge` 行——随列表/检索响应附带，user 也能拿到，避免为下拉框开 admin 接口。

**stats 取数**（新查询，只读）：byStatus/byDomain/byScope 为 `GROUP BY` 计数；topUsed 为 `ORDER BY use_count DESC LIMIT 10`；recentMisses 取 `search_event` 中 `hit_ids = '{}'` 的记录按 query 文本聚合计数（近 30 天），给管理员看"大家搜什么搜不到"，反向指导沉淀。

**条目可见性（设计裁定）**：与 MCP 一致——draft/deprecated 对所有登录用户可见（检索结果带状态徽标，deprecated 降权），门户不做额外隐藏；status 筛选为可选参数：`SearchParams` 增加 `status?: string`（undefined 时行为与现在完全一致，MCP 不受影响），浏览模式在 SQL WHERE 中过滤。

**代码组织**：admin CLI（`scripts/admin.ts`）中的 set-status/delete-knowledge/delete-scope/disable/enable 等操作抽为 `src/admin/service.ts` 纯函数，CLI 与 REST 共同调用（消除复制）；`handleSave` 中 guard/scope/查重预检部分抽为可复用函数供 dry-run preview 使用。REST 路由层放 `src/api/`（`src/api/routes.ts` + 按资源的 handler），在 `createApp` 里注册；`@fastify/static` 注册为静态托管 + 非 `/api`、非 `/mcp` 的 GET fallback 到 `index.html`（vue-router history 模式所需）。

## 七、页面设计（5 个模块）

### ① 检索页（首页 `/`）

页内两个标签：**「检索」**与**「浏览」**。

**检索标签**（默认，带关键词时）：

```
┌──────────────────────────────────────────────────────┐
│  团队知识库          [检索页] [统计] [管理后台*]  张三▾ │ ← * 仅 admin 可见
├──────────────────────────────────────────────────────┤
│  [ 检索 | 浏览 ]                                       │
├──────────────────────────────────────────────────────┤
│  🔍 [ 输入现象/关键词……                        ] [搜索] │
│  筛选: domain▾  scope▾  status▾  tag▾                │
├──────────────────────────────────────────────────────┤
│  ▸ #42 Qiankun 子应用切换白屏           [verified]    │
│      现象: 子应用单独访问正常，主应用加载后白屏……      │
│      scope: proj-a · frontend · 用过 5 次 · 3 天前     │
│  ▸ #17 MyBatis 分页失效                  [draft]      │
│      ……                                              │
├──────────────────────────────────────────────────────┤
│                              [< 1 2 3 >]  共 87 条    │ ← 浏览模式显示分页；
└──────────────────────────────────────────────────────┘   关键词检索模式无分页（MCP 同款 top 50，
                                                            底部提示"请细化关键词"）
```

**浏览标签**（按 scope 看全量知识，走浏览模式 API）：

```
┌──────────────────────────────────────────────────────┐
│  [ 检索 | 浏览 ]                                       │
├───────────────┬──────────────────────────────────────┤
│ 全部 (87)      │  proj-a · 32 条        [domain▾][status▾]│
│ proj-a  (32)   │  ┌──────────────────────────────────┐ │
│ proj-c (21)    │  │ #42 Qiankun 子应用切换白屏 [verified]│ │
│ global  (18)   │  │ #17 MyBatis 分页失效       [draft]  │ │
│ proj-b  (9)    │  │ ……                               │ │
│ ……             │  └──────────────────────────────────┘ │
│                │                    [< 1 2 3 >]         │
└───────────────┴──────────────────────────────────────┘
```

- 左侧 scope 目录来自 facets（scope + 条目数），点选即过滤；右侧为该 scope 全量条目分页表格，可再叠加 domain/status 筛选——这就是"按项目查看所有知识文档"的入口
- 浏览标签下点条目同样弹详情抽屉（无关键词不打分，按 updated_at 倒序）
- 空库/未命中显示引导文案（"库里还没人沉淀过——解决后记得让 agent 沉淀"）
- 行点击 → 详情抽屉（Drawer，右侧滑出，不跳页，保持检索上下文）

### ② 知识详情抽屉

```
┌───────────────────────────────┐
│ #42 Qiankun 子应用切换白屏  [✎]│ ← 编辑按钮：本人或 admin 可见
│ [verified] proj-a · frontend   │
│ 现象  子应用单独访问正常……      │
│ 解决  检查 publicPath 是否……   │
│ 详情  （detail 全文，纯文本）   │
│ 标签  qiankun · white-screen   │
│ 代码  src/main.ts:42           │
│ 作者 张三 · 用过 5 次 · 最近 3 天前│
│ [✋ 帮到了我（mark_used）]      │ ← 点击后变灰 + 提示成功
└───────────────────────────────┘
```

### ③ 新增 / 编辑表单

- 新增：与 MCP save_knowledge 同字段（title/symptom/solution/detail/domain/scope/module/tags/code_ref）
- **查重前置（dry-run 预检）**：点击提交先调 `POST /api/knowledge/preview`（不入库），命中相似条目时表单上方展示相似卡片，用户二选一：**「仍要新建」**（确认后走真正 save）或 **「去看相似条目」**（关闭表单跳详情，可编辑补充）；无相似则直接 save。`warnings`（如内网 IP）与"该 scope 将自动注册"提示同样在预检结果中展示
- 编辑：仅 symptom/solution/detail/tags/code_ref/module 可改（与 handleUpdate 输入一致），status 不出现于表单
- domain 下拉用枚举，scope 下拉来自 facets，新增 scope 场景提供"手动输入"选项（受服务端 scope 规则约束，AKM_SCOPE_OPEN=false 时报错原样透出）

### ④ 管理后台（admin，`/admin`）

Tab 布局：

1. **知识管理**：全量条目表格（筛选同检索页）+ 行操作「设为 verified / 设为 deprecated / 恢复 draft / 删除（二次确认）」
2. **Scope 注册表**：表格（scope/描述/启用/条目数）+ 行操作「编辑描述 / 停用 / 删除（无条目时）」+ 新增 scope
3. **用户管理**：表格（用户名/角色/状态/注册时间）+ 行操作「禁用 / 启用（二次确认，提示 token 将永久封禁）」

### ⑤ 统计页（`/stats`）

- 顶部数字卡：总条数 / verified 数 / draft 数 / 注册用户数
- 条形/饼图区：各 domain 条数、各 scope 条数（纯 CSS/AntD Progress 实现，不引图表库）
- 最常用知识 TOP10（表格：标题 + use_count）
- 检索未命中 TOP10（表格：查询词 + 次数）——管理员据此提醒团队沉淀

## 八、前端工程结构

```
web/                    # 新增目录（Vite 项目根）
  src/
    main.ts             # 入口，挂载 AntD + router
    router.ts           # / 、/stats、/admin、/admin/scopes、/admin/users
    auth.ts             # token 存取 + 当前用户响应式状态 + fetch 封装（自动带 Bearer、401 统一登出）
    api.ts              # 各 REST 端点的类型化调用函数
    pages/
      SearchPage.vue
      StatsPage.vue
      AdminKnowledge.vue / AdminScopes.vue / AdminUsers.vue
    components/
      KnowledgeDetailDrawer.vue
      KnowledgeForm.vue        # 新增/编辑共用
      SearchFilters.vue
  index.html
  vite.config.ts        # dev 代理 /api → localhost:3000；build.outDir=dist
  package.json
```

依赖：`vue` `vue-router` `ant-design-vue` `@ant-design/icons-vue` `typescript` `vite` `@vitejs/plugin-vue`。按需引入 AntD 组件（unplugin-vue-components 或手动 import，构建时定）。

## 九、构建与部署

Dockerfile 改为多阶段：

1. `build-web`：node:20 → `cd web && npm ci && npm run build`（产出 `web/dist`）
2. `build-server`：现有 tsc 编译
3. `runtime`：现镜像基础上 COPY `web/dist` → `/app/web/dist`

服务器部署流程不变（`docker compose up -d --build`），端口、环境变量、迁移全部不变。开发时本机 `npm run dev`（Vite dev server + 代理）。

文档更新：`docs/deploy.md` 增加"知识门户"一节（访问地址、登录方式、admin 入口说明）；`integration/使用教程.md` FAQ 增加"浏览器访问"；README 提及门户。

## 十、测试策略

- **REST 层（TDD 严格）**：vitest + 测试 DB，fastify `inject()` 覆盖——鉴权（401/403/角色矩阵每格一条；**门户仅校验不注册**：未知 token 401 且不产生新用户行，`/mcp` 自报注册行为不受影响）、preview dry-run（不入库、similar/warnings 返回、敏感内容拦截）、list/search 两模式（检索无分页/浏览分页 total 正确）、status 筛选（含 MCP 默认行为不变回归）、save 查重与敏感拦截透传、update 作者权限、admin 各端点（含 delete-scope 有条目拒绝）、stats 聚合数字、SPA fallback（GET `/` 返回 HTML、GET `/admin` 返回同一 HTML、GET `/mcp` 不受影响）
- **前端**：`vue-tsc` 类型检查 + 构建通过为硬门槛；组件级测试 v1 不强制（界面逻辑薄，主要靠 REST 层测试 + 上线前人工 checklist：登录/检索/详情/mark_used/新增/编辑/admin 三页/统计）
- **回归**：现有全量测试套件必须保持绿（重点 `/mcp` 行为不变）

## 十一、留给构建者的问题

- AntD 组件按需引入的具体方案（unplugin vs 手动）与主题定制（主色）——构建者定
- 检索结果"摘要"字段截断策略（symptom 前 N 字）——构建者定，v1 无需高亮
- 分页默认 pageSize（建议 20）、列表排序细节——构建者定
- 统计页图表若 Progress 不够用是否引入轻量图表库——倾向不引，构建者可给更优纯 CSS 方案
- 时间显示格式（相对时间"3 天前"需要小工具函数）——构建者定
