# agent-knowledge-mcp

**[English](README.md) | 简体中文**

企业内多 Agent 知识共享 MCP 服务——让团队里所有的编码 agent（Claude Code、Cursor、Trae 等）共用同一个"踩坑经验库"。

一个 agent 踩过的坑，其他所有 agent 不用再踩一遍。

## 解决什么问题

编码 agent 在日常工作中会反复解决同类问题（框架坑、依赖冲突、数据库方言差异……），但这些经验通常随着会话结束就丢掉了。本项目提供一个部署在团队服务器上的 MCP 服务，所有 agent 通过统一的工具协议读写同一份知识库：

- **沉淀**：agent 解决了一个问题后，把现象/方案存入知识库，供全团队复用
- **复用**：接手新任务前先检索，直接拿到前人验证过的解法
- **治理**：知识有状态（draft / verified / deprecated）、有新鲜度（使用次数与最近使用时间）、会老化（长期无人使用的 verified 自动降回 draft）

## 功能特性

### 9 个 MCP 工具

| 工具 | 用途 |
|------|------|
| `search_knowledge` | 检索知识（关键词 + trigram 打分，结果带 `use_count` / `last_used_at` 新鲜度字段） |
| `save_knowledge` | 沉淀新知识（带敏感信息硬拒绝 + 客户数据脱敏检查） |
| `update_knowledge` | 更新已有条目 |
| `mark_used` | 标记某条知识被用过（更新 use_count / last_used_at，反馈给老化治理） |
| `get_context` | 按 scope + module 获取开工上下文 |
| `save_skill` | 沉淀可复用的操作技能（SKILL.md 安装入口由系统自动组装；入库为 draft） |
| `search_skills` | 检索团队 skill 库有无现成技能 |
| `get_skill` | 拉取 skill 的 SKILL.md 与附加文件并返回 install 指引（写入本地 skills 目录）；拉取计入使用，反馈 draft→verified 晋升 |
| `update_skill` | 补充/修正已有 skill（作者本人或管理员；files 整体替换是删除附加文件的唯一途径） |

不提供删除类 MCP 工具——避免 agent 误删；删除、状态强制变更等管理操作全部走管理员 CLI。

### 向量语义检索（可选，默认不启用）

通过环境变量配置内网向量模型后启用（支持 OpenAI 兼容 / Ollama / 自定义接口三种协议，见 [docs/deploy.md](docs/deploy.md)）：

- 保存/更新的条目自动生成 embedding 存入 pgvector；检索时叠加向量语义分，零关键词重叠但语义相关的条目也能召回
- 向量服务不可用时自动退化为关键词检索，保存/更新/检索主流程不受任何影响
- 管理员 `embed` 命令可为存量条目一次性回填向量

### 零人工开通的接入体系

- **开放自报身份**：Bearer 填身份名首次调用即自动注册，无需管理员建号；注册响应一次性下发随机访问令牌（`identity_token`），写回配置后作为后续凭证——名字此后只是署名；`AKM_JOIN_SECRET` 可选作加入口令挡抢注；被禁用的身份永久封禁，防伪造已注册用户名
- **scope 自动注册**：scope 用 git 仓库名（`git remote get-url origin` 末段），首次保存自动注册并记录创建者，杜绝各 agent 自造字符串导致的知识库碎片化
- **一键接入脚本**：`integration/` 下提供 Claude Code 全局/项目级安装脚本（bash + PowerShell），SessionStart hook 自动注入知识库使用规则与本项目的 scope
- **知识老化**：管理员 `decay` 命令把长期无人使用的 verified 条目降回 draft（借鉴 Mem0/Zep 的记忆衰减思路），防止陈年旧知识一直顶着"已验证"光环

### 浏览器知识门户

- 同端口静态 SPA（`http://<server>:3000/`），登录用 MCP 同款身份令牌，门户不注册新身份
- 独立 `/login` 登录页：受保护区域（上传/编辑、管理后台）未登录时带 `?redirect=` 跳转该页，登录后回原位；会话中途 401（token 被禁用）自动跳转登录，登录后回到原页面
- 检索 / 按 scope 浏览 / 详情 mark_used / 新增编辑（查重预检）/ 统计看板 / 管理后台（状态流转、删除、scope、用户）——均可匿名浏览，仅写操作需登录
- Skills 模块：skill 检索 / 浏览 / 详情 / 上传编辑（未登录点"新增 Skill"跳 `/login?redirect=/skills`）；同一份数据经 REST（`/api/skills`）与 MCP skill 工具暴露。附件限额：最多 20 个文件、单文件 64KB、总量 256KB（纯文本 `{path, content}` 清单）

### 安全护栏

- 敏感信息硬拒绝：私钥块、API token、数据库连接串密码等拒绝入库
- 客户敏感数据检查：身份证号、银行卡号正则命中 → 拒绝，要求脱敏后重试
- 按 token 限流，防止失控 agent 死循环刷查询；匿名（无 token）请求按 IP 限流
- 只读 API（`GET /api/knowledge`、`GET /api/stats`、`GET /api/skills`）匿名可访问，供门户匿名浏览；所有写操作与管理端均需 Bearer token
- 知识条目带 scope 软隔离：跨项目可见但同项目加权，适合"一个团队、多个相关项目"的场景

## 技术栈

- TypeScript + 官方 MCP SDK（Streamable HTTP，无状态多实例友好）
- PostgreSQL 17 + pgvector（关键词/trigram 打分为主，向量语义检索可选启用）
- Fastify 5 + Docker Compose 部署

## 快速开始

### 部署服务端

```bash
# 服务器上（需先安装 docker）
cd /opt/agent-knowledge-mcp
AKM_DB_PASSWORD='<强密码>' AKM_APP_PORT=3000 docker compose up -d --build

# 建管理员账号
docker exec akm-app node dist/scripts/admin.js adduser admin --token '<管理员token>' --role admin
```

完整步骤（含 TLS 建议、备份、升级、git 镜像）见 [docs/deploy.md](docs/deploy.md)。

> ⚠️ **安全要求**：写操作与管理端靠 Bearer token 鉴权，只读 API 匿名可访问（按 IP 限流）供门户浏览；务必在云安全组限制 MCP 端口的来源 IP，禁止 0.0.0.0/0。

### Agent 接入

`integration/` 目录提供现成的接入材料：

```bash
# Claude Code 全局接入（一次配置，本机所有项目生效）
bash integration/setup-akm-global.sh          # macOS / Linux
pwsh integration/setup-akm-global.ps1         # Windows

# 或项目级接入
bash integration/setup-akm.sh
```

其他支持 Streamable HTTP MCP 的客户端（Cursor、Trae 等）手动配置：

```json
{
  "mcpServers": {
    "team-knowledge": {
      "type": "http",
      "url": "http://<你的服务器>:3000/mcp",
      "headers": { "Authorization": "Bearer <身份名，注册后换 identity_token>" }
    }
  }
}
```

首次调用自动注册，服务端一次性下发随机访问令牌（`identity_token`）——**立即把它写回 `Authorization: Bearer <token>` 并重启会话**（令牌只显示一次，丢失需管理员 `reset-token` 重发）；身份名此后只是署名。

详细说明与常见问题见 [integration/使用教程.md](integration/使用教程.md)。

### 管理员速查

```bash
docker exec akm-app node dist/scripts/admin.js <command>

adduser <name> --token <token> [--role admin]   # 建号（可选，开放接入下用于特殊账号）
listusers | listusers --legacy                  # 用户管理；--legacy 列出仍以用户名作令牌的存量账号
reset-token <name>                              # 重发随机访问令牌（明文仅此一次显示，线下交付本人）
disable <name> | enable <name>                  # 禁用/启用身份
list-scopes | delete-scope <scope>               # scope 管理
delete-knowledge <id> | set-status <id> <draft|verified|deprecated>
history <id> | history --skill <name>            # 修订历史（最近 50 条）
delete-skill <name> | set-skill-status <name> <draft|verified|deprecated>   # skill 管理
decay [--days 90] [--dry-run]                    # 知识老化：超期未用的 verified 降回 draft
embed                                            # 向量回填：为缺失 embedding 的条目生成向量（需配置向量模型）
export <dir>                                     # 导出全部条目为 frontmatter markdown
```

另有 `import-markdown` 脚本支持从 frontmatter markdown 目录批量导入种子知识（`scripts/seed-example/` 有示例）。

## 项目结构

```
src/
  index.ts            # 入口，启动 HTTP 服务
  app.ts              # Fastify + MCP 路由，工具注册
  auth.ts             # Bearer 鉴权、开放自报身份、限流
  config.ts           # 环境变量配置
  db.ts               # Postgres 连接与迁移
  tools/              # save / search / update / markUsed / context / skill
  search/             # 分词、标签别名、打分检索（知识 + skill）
  admin/              # CLI 与 REST 共用的管理服务
  api/                # 门户 REST 路由与查询（知识 + skill）
scripts/
  admin.ts            # 管理员 CLI
  import-markdown.ts  # markdown 批量导入
  seed-example/       # 种子知识示例
migrations/           # SQL 迁移（启动时幂等执行）
integration/          # 各客户端接入脚本与教程
web/                  # Vue 3 + Ant Design Vue 门户 SPA
tests/                # vitest 测试（含 e2e）
docs/deploy.md        # 部署指南
```

## 开发

```bash
npm install
# 本地起一个测试库（端口 5433）
docker run -d --name akm-test-db -e POSTGRES_USER=akm -e POSTGRES_PASSWORD=akm -e POSTGRES_DB=akm_test -p 5433:5432 postgres:17
TEST_DATABASE_URL="postgresql://akm:akm@localhost:5433/akm_test" npm test
```

测试使用真实 Postgres（trigram 索引与中文分词行为无法用内存库模拟），`fileParallelism: false` 保证共享测试库不互相污染。

## License

MIT
