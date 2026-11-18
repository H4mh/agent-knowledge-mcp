# 企业多 Agent 知识共享 MCP 服务 — 设计文档

日期：2026-11-15
状态：待审批

## 一、背景与意图

公司开发团队约 200 人，大部分使用各自的 agent 工具（Claude Code、Cursor 等）进行开发。每个人的 agent 在本地沉淀了大量踩坑经验、构建/环境知识、项目隐性知识，但彼此不可见，导致不同人遇到同样的问题时重复排查。

目标：建设一个**中央知识库 MCP 服务**。在各项目的 CLAUDE.md 中写入约束，要求 agent：

1. 遇到问题时**先通过 MCP 查询**是否已有相关知识；
2. 解决问题后**将结构化知识上传**到知识库，供他人复用。

MCP 是跨工具协议，一次建设，Claude Code / Cursor 等均可接入。

## 二、目标 / 非目标 / 反目标

### 目标

- 提供统一 MCP 服务（Streamable HTTP），多 agent 工具可接入；
- 结构化知识上传（schema 固化到工具入参定义中）+ 查询；
- 上传时内置查重（相似条目提示，引导更新而非新建）；
- 上传内容进入 `draft` 状态，通过使用行为（`mark_used`）升级为 `verified`，长期无命中归档为 `deprecated`；
- 检索第一版使用关键词 + 全文相似度打分；**向量列预留**，公司未来提供内网 embedding 服务后接入（公司内网目前无 embedding 资源，已确认）；
- 记录贡献者身份与使用统计，支撑后续采纳率度量。

### 非目标（本版不做）

- 不做 Web UI / 搜索门户（后续可加，数据层已兼容）；
- 不做 SSO 对接（v1 使用静态 token，token → 用户映射由服务端配置）；
- 不做个人 memory 自动导出管道（后续阶段）；
- 不实现向量检索本身（仅预留 schema 列与索引位）；
- 不做多租户 / 跨公司隔离。

### 反目标（要防止的失败）

- 知识库被 agent 自动上传灌成垃圾堆 → 靠查重 + draft 状态 + 定期治理缓解；
- 敏感信息（密钥、内网地址、客户数据）入库 → 上传时做敏感信息扫描并拦截/脱敏；
- 知识与代码脱节 → 知识条目带 `code_ref`，正文要求写"结论"而非过程流水账。

## 三、约束

- **全内网部署**：服务器无法访问公网。npm 依赖须通过公司内网 Nexus 源安装；构建产物须可离线部署。
- **Postgres 15+ 且安装 pgvector 扩展**（向量列类型 `vector`，本版不建向量索引，仅建列）。
- 中文内容为主：中文全文检索不引入 zhparser 等需要特殊安装的扩展，检索在应用层实现（ILIKE / 关键词命中 / pg_trgm 相似度），见"检索设计"。
- 数据库方言知识面向 MySQL/Kingbase/达梦/Gauss 等，`tags` 需能承载这类维度。

## 四、总体架构

```
各人的 agent (Claude Code / Cursor / ...)
        │  MCP Streamable HTTP (Bearer token)
        ▼
MCP Server (TypeScript, 无状态, 可横向扩展)
        │  连接池
        ▼
Postgres 15 + pgvector（知识数据 + 向量列预留）
        + 知识正文以 markdown 文件形式导出/备份（git 管理的备份仓库或定时导出目录）
```

- 服务**完全无状态**（不存会话数据），这是横向扩展的前提；
- Postgres 使用连接池，上限可配；
- 核心查询路径建索引（见 schema）；
- 按token 做简单限流，防止失控 agent 死循环刷查询；
- 扩展路径：数千人 → 服务多实例 + 负载均衡、Postgres 读写分离；数万人 → 查询走只读副本、pgvector 加 HNSW 索引；请求吞吐在可见范围内不构成瓶颈，真正的规模瓶颈在知识治理层。

## 五、MCP 工具集（对外接口）

| 工具 | 入参（要点） | 行为 |
|---|---|---|
| `search_knowledge` | `query`（必填）、`domain?`、`scope?`、`tags?`、`limit?`（默认 10） | 检索，返回 top-K（title、symptom、solution、status、code_ref、id）。**scope 省略时检索全部知识，但与调用者传入 scope 匹配的条目在打分上加成**（跨项目通用知识仍可见）。查不到时返回引导文案："未命中。若你后续解决了此问题，请调用 save_knowledge 沉淀。" |
| `save_knowledge` | `title`、`symptom`、`solution`、`domain`、`scope`、`tags`、`detail?`（markdown 正文）、`code_ref?` | **查重为"提示"而非拦截**：入库总是成功（`draft`），但响应中附带相似条目（同 scope + global 范围内相似度 ≥ 阈值 0.6，可配，最多 3 条）及提示"若为同一问题请调用 update_knowledge 补充"。硬拦截会杀死 agent 的上传意愿，防重复靠提示 + 后续 curator 治理。`scope` 必须来自注册表（见下），`author` 从鉴权身份取，不接受 agent 填写 |
| `update_knowledge` | `id`、`symptom?`、`solution?`、`detail?`、`tags?`、`code_ref?` | 补充/修正已有条目；文本字段作者本人或管理员可改。**`status` 变更仅管理员可操作**（作者不能把自己的条目直接置为 verified，晋升只走 mark_used 行为通道） |
| `mark_used` | `id`、`note?` | 标记"这条知识帮到了我"：`use_count +1`、记录 usage 日志。**防刷机制**：同一用户对同一条目幂等（重复 mark_used 只计一次）；**作者自己的 mark_used 不计入晋升**；draft 条目被 **≥2 个不同用户** mark_used 后自动升级 `verified` |
| `get_context` | `scope`、`module?` | 开工时调用：返回该 scope 下 `verified` 优先的"注意事项清单"（title + solution 摘要，按 use_count 与更新时间排序，上限 ~20 条） |

**管理通道**：不提供删除类 MCP 工具（避免 agent 误删）。管理员通过 CLI 脚本（`scripts/admin.ts`）完成：删除条目、强制变更 status、管理用户与 token、数据导出。运维直接 SQL 修数据的方式在部署文档中说明。

**scope 注册表**：`scope` 不是自由文本，来自受控注册表（DB 表 `scope_registry`，含 scope 名、描述、启用状态），预置 `global` 与各产品线（`demo-app`、`proj-a`、`proj-b`、`proj-c`），管理员可增改。`save_knowledge` 校验 scope 必须在注册表内，防止 200 个 agent 各造各的字符串导致知识库碎片化。

敏感信息扫描（分级处理，避免与"内网知识库"的定位自相矛盾）：

- **硬拒绝**：密钥/凭证类（私钥块、API token、数据库连接串密码、`BEGIN RSA PRIVATE KEY` 等）与客户敏感数据（身份证号、银行卡号正则等）→ 拒绝入库，返回命中项，要求脱敏后重试；
- **仅警告**：内网 IP / 主机名 / 内网系统地址 → **放行**。本库本身就是内网服务，"Nexus 地址是 10.x.x.x"这类恰恰是最值得共享的知识；仅在响应中附提醒，由贡献者自行判断；
- 规则列表走配置文件，可由管理员调整分类归属。

## 六、数据模型（Postgres）

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  symptom       TEXT NOT NULL,          -- 问题现象
  solution      TEXT NOT NULL,          -- 结论/解决办法
  detail        TEXT,                   -- markdown 正文（排查要点、验证方法等，可选）
  domain        TEXT NOT NULL,          -- 领域: java / frontend / mobile / infra / db / workflow ...
  scope         TEXT NOT NULL,          -- 适用范围: 项目线（如 demo-app / proj-a）或 global
  module        TEXT,                   -- 更细的模块（如 core/MicroFront）
  tags          TEXT[] NOT NULL DEFAULT '{}',
  code_ref      TEXT,                   -- 关联代码位置（file:line 或模块路径）
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft / verified / deprecated
  author        TEXT NOT NULL,          -- 来自鉴权身份
  use_count     INT NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  embedding     vector,                 -- 预留：不带维度约束，维度由应用层在未来接入 embedding 服务时统一强制（避免锁死 1536 后维度不符需重建表）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_usage (
  id            BIGSERIAL PRIMARY KEY,
  knowledge_id  BIGINT NOT NULL REFERENCES knowledge(id),
  used_by       TEXT NOT NULL,          -- 来自鉴权身份
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (knowledge_id, used_by)        -- mark_used 幂等：同一用户同一条目只计一次
);

-- scope 注册表：受控词表，防碎片化
CREATE TABLE scope_registry (
  scope         TEXT PRIMARY KEY,
  description   TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT true
);

-- 检索事件日志：支撑"未命中"统计（长期无命中→归档的依据）与采纳率度量；写入为轻量 INSERT，随查询路径记录
CREATE TABLE search_event (
  id            BIGSERIAL PRIMARY KEY,
  queried_by    TEXT NOT NULL,          -- 来自鉴权身份
  query         TEXT NOT NULL,
  scope         TEXT,
  hit_ids       BIGINT[],               -- 本次返回的条目 id（空数组即未命中）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_user (                 -- 鉴权身份表（DB 托管，便于多实例共享与将来 SSO 迁移）
  username      TEXT PRIMARY KEY,       -- 来自鉴权身份
  token_hash    TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',   -- user / admin
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_search_event_query ON search_event USING gin (query gin_trgm_ops);
CREATE INDEX idx_search_event_created ON search_event(created_at);

-- 索引
CREATE INDEX idx_knowledge_scope ON knowledge(scope);
CREATE INDEX idx_knowledge_domain ON knowledge(domain);
CREATE INDEX idx_knowledge_status ON knowledge(status);
CREATE INDEX idx_knowledge_tags ON knowledge USING gin(tags);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_knowledge_trgm ON knowledge USING gin (title gin_trgm_ops, symptom gin_trgm_ops, solution gin_trgm_ops);
```

## 七、检索设计（第一版）

应用层打分，单条 SQL（或两步）完成：

1. **过滤**：按 `scope` / `domain` / `tags` 精确过滤（provided 时）；`domain` 为受控枚举（`java` / `frontend` / `mobile` / `infra` / `db` / `workflow`，固化在工具入参 schema 与服务端校验中）；`tags` 自由填写，但入库时经**别名归一化映射表**（配置文件，如 `达梦`/`dm`/`DM8` → `dameng`）归一，防词表碎片化；
2. **候选召回**：query 分词（应用层按空格/标点切分 + 简单中文二元切分 bigram）后，用 `ILIKE` 命中 `title`/`symptom`/`solution`/`tags`；
3. **排序打分**：字段命中权重（title > tags > symptom > solution）+ `pg_trgm` 相似度 + 状态加成（`verified` > `draft`，`deprecated` 降权）+ `use_count` 加成 + **scope 加成**（调用者传入 scope 且条目 scope 匹配时加分，跨项目条目仍可见）；
4. 返回 top-K，同时向 `search_event` 写一条记录（query、命中 id 列表）。

字段权重、状态加成为配置项，便于后续调优。embedding 列预留（无维度约束）：未来接入内网 embedding API 后，补"入库时生成向量 + 查询时生成向量 + 余弦排序"的逻辑，检索接口签名不变。

**v1 的归档机制**：`deprecated` 状态在 v1 由管理员经 CLI 手工设置（依据 `search_event` 的未命中统计报告）；自动归档属于后续 curator 批处理（见十三）。

## 八、鉴权与身份

- MCP HTTP 请求携带 `Authorization: Bearer <token>`；
- token → 用户映射由 DB 表 `app_user` 维护（多实例部署下天然共享，也便于将来 SSO 迁移）；v1 由管理员通过 `scripts/admin.ts` 手动分配，含 `role` 字段（`user` / `admin`）；
- `author` / `used_by` 一律取自鉴权身份，agent 不可自报；
- 限流按 token 计，v1 为单实例内存计数（多实例部署时为近似限流，可接受；精确限流推给网关层）；
- 未来接 SSO 时仅需替换鉴权中间件，工具层无感。

## 九、技术栈与项目结构

- **TypeScript + Node 20 LTS**，官方 MCP SDK（`@modelcontextprotocol/sdk`），Streamable HTTP transport；
- Postgres 驱动：`pg`（node-postgres，连接池）；
- HTTP 框架：Express 或 Fastify（builder 定，倾向 Fastify）；
- 测试：vitest，工具层 + 检索打分逻辑单测覆盖；
- 依赖安装走公司内网 Nexus（`.npmrc` 配置），文档中注明。

```
agent-knowledge-mcp/
├── docs/superpowers/specs/          # 本设计文档
├── src/
│   ├── index.ts                     # 服务启动、HTTP + MCP 挂载
│   ├── auth.ts                      # token 鉴权、限流
│   ├── db.ts                        # 连接池、迁移
│   ├── tools/                       # 5 个 MCP 工具的实现
│   ├── search/                      # 打分检索逻辑
│   ├── guard/                       # 敏感信息扫描
│   └── config.ts
├── migrations/                      # SQL 迁移（含 pgvector/pg_trgm 扩展）
├── scripts/
│   ├── admin.ts                     # 管理员 CLI：用户/token 管理、删除条目、status 变更、数据导出
│   └── import-markdown.ts           # 种子数据导入（见十二）
├── integration/                     # 集成模板（见十一）
├── docker-compose.yml               # app + postgres(pgvector) 一键起
├── Dockerfile
└── package.json
```

## 十、部署

- `docker compose`：app 容器 + `postgres:16`(含 pgvector 扩展的镜像，如 `pgvector/pgvector:pg16`)，内网单机起步；
- 配置项全部走环境变量：`DATABASE_URL`、限流阈值、敏感信息规则路径、tag 归一化映射路径（token→用户映射在 DB 表 `app_user` 中，经 admin CLI 管理）；
- 数据备份：Postgres 定时 `pg_dump` + 知识正文定期导出为 markdown 目录（schema 导出脚本），可用 git 管理备份。

## 十一、接入集成模板（随服务交付）

- `integration/CLAUDE.md.snippet`：项目约束模板（何时必须查询、何时必须上传、get_context 的使用时机）；
- `integration/.mcp.json.example`：接入配置（HTTP MCP server 地址 + header token）；
- `integration/session-start-hook.md`：SessionStart hook 脚本与说明（会话启动注入知识库使用提醒 + 尝试 get_context）；
- `integration/cursor.example.md`：Cursor 等其他工具的接入说明。

## 十二、种子数据

上线前从现有项目的 CLAUDE.md（如 proj-a、proj-b、ZTJ 及 demo-app 各仓库）提取已沉淀知识，人工 + agent 辅助转写为标准条目，通过 `scripts/import-markdown.ts` 导入（支持 frontmatter 格式的 markdown 目录，导入为 `verified` 状态）。目标：上线首日库内有数百条真实有用的知识。

## 十三、后续演进（不在本版范围）

1. 内网 embedding 服务可用后启用向量检索；
2. SSO 鉴权；
3. 个人 memory 自动导出 PR / 定时收集管道；
4. curator 治理批处理（合并相似条目、归档长期无命中 draft、置信度报告）；
5. 简单 Web 检索门户；
6. `get_context` 升级为按任务描述的语义推送。
