# Skill 共享 + 门户登录页 设计文档

日期：2026-11-17 ｜ 状态：待批准

## 意图

知识库目前只沉淀"经验"（问题→方案），本设计增加"能力"共享：团队成员把打磨好的 agent skill（Claude Code skill 格式：SKILL.md + 可选附带文件）上传到 MCP 服务；本地 agent 接到任务时先检索有无可用 skill，有则下载安装到本地 skills 目录后直接使用；也支持用户通过 MCP 与门户主动上传、更新 skill。另附一个独立小需求：门户增加专门的 /login 登录页（替换现在的未登录弹窗）。

## 目标 / 非目标

**目标**
- MCP 三件套：save_skill（上传/更新）、search_skills（语义+关键词检索）、get_skill（取完整文件清单+安装指引）
- 门户 skill 模块：检索/浏览页、详情抽屉（文件预览）、上传/编辑表单
- skill 向量化，与知识条目共用 embedder 与打分底座
- /login 独立页面，未登录访问受保护路由时跳转该页

**非目标**
- 二进制文件、tar.gz 打包（文件清单为纯文本 {path, content}）
- 自动安装 hook（安装动作由 agent 执行，规则模板里写纪律）
- 版本历史（只保留当前版本 + version 计数）
- 其他 CLI（Cursor 等）的 skill 格式适配

## 方案取舍

- **已选：文件清单+内容**——skill 存为 JSONB 数组 [{path, content}]，MCP 返回全部文件，agent 逐个 Write 落盘。零新增存储设施，覆盖 SKILL.md + 文本脚本的绝大多数场景。局限：不适合大二进制。
- 落选「单文件 SKILL.md」：带脚本的 skill 装不下，脚本只能内联正文。
- 落选「tar.gz + 下载端点」：需新建文件存储、上传协议、解压步骤，复杂度不成比例。

## 数据库（migration 0003_skill.sql）

```sql
CREATE TABLE skill (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,   -- kebab-case，安装目录名
  description  TEXT NOT NULL,          -- 检索与展示用
  instructions TEXT NOT NULL,          -- SKILL.md 正文（不含 frontmatter）
  files        JSONB NOT NULL DEFAULT '[]',  -- [{path, content}] 相对目录的附加文件
  scope        TEXT,                   -- 可选关联项目 scope（scope_registry 校验）
  tags         TEXT[] NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'draft',
  author       TEXT NOT NULL,
  version      INT NOT NULL DEFAULT 1,
  use_count    INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  embedding    vector,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_skill_scope ON skill(scope);
CREATE INDEX idx_skill_tags ON skill USING gin(tags);
CREATE INDEX idx_skill_name_trgm ON skill USING gin(name gin_trgm_ops);
CREATE INDEX idx_skill_desc_trgm ON skill USING gin((name || ' ' || description) gin_trgm_ops);

CREATE TABLE skill_usage (
  id         BIGSERIAL PRIMARY KEY,
  skill_id   BIGINT NOT NULL REFERENCES skill(id),
  used_by    TEXT NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, used_by)
);

-- search_event 增加来源列（区分知识检索与 skill 检索，hit_ids 语义随之限定）
ALTER TABLE search_event ADD COLUMN kind TEXT NOT NULL DEFAULT 'knowledge';
```

SKILL.md 由 name/description/instructions 在返回时组装（frontmatter name+description），files 为附带文件。检索文本 = name + description + instructions。

**状态生命周期（与知识条目同哲学）**：get_skill 拉取时记 skill_usage（每人一条，UNIQUE skill_id+used_by）；被 **2 个不同非作者用户**拉取后 draft→verified 自动晋升（同 markUsed.ts 的 PROMOTION_DISTINCT_USERS=2）；search 对 verified 施加与知识条目相同的加权；admin 可 set-status。version：仅当 description/instructions/files/scope/tags 任一内容字段实际变化时 +1，纯重复提交不加。

## MCP 工具

- **save_skill**：参数 {name, description, instructions, files?, scope?, tags?}。校验：name 匹配 `^[a-z0-9][a-z0-9-]{1,63}$`；同名即报错（更新走 update_skill）；scope 可选且须已注册；files 数 ≤20、单文件 ≤64KB、总量 ≤256KB；**files[].path 校验**：相对 POSIX 路径（拒绝绝对路径、含 `..` 段、反斜杠），不得为 `SKILL.md`（大小写不敏感，与组装文件冲突），长度 ≤200 字符，嵌套不限、扩展名不限（纯文本内容本身已受限）；敏感扫描复用 guard 扫 instructions 与全部文件内容；embedder 可用时生成向量（失败仅警告）；**返回 similar 相似列表**（按 name/description 相似度，引导 agent 优先 update 而非另起名字），与 save_knowledge 的引导模式一致。
- **search_skills**：参数 {query, limit?, scope?}。trigram（name/description/instructions）+ 向量余弦（W_VECTOR 复用），返回元数据列表（不含文件内容），附 score/use_count/version/verified 加权；查询事件记 search_event（kind='skill'）。
- **get_skill**：参数 {name}。返回 {name, description, version, status, files: [{path:'SKILL.md', content:<组装后>}, ...附加文件]}，并在文本指引中写明安装方法：把文件逐一写入 `~/.claude/skills/<name>/`（全局）或项目 `.claude/skills/<name>/`（本项目），然后重启会话或让 Claude Code 重新扫描 skills。每次成功调用 use_count+1、last_used_at 更新，并记 skill_usage（用于 2 人拉取自动晋升 verified）。
- **update_skill**：**补丁语义（与 update_knowledge 一致）**：参数 {name, description?, instructions?, files?, scope?, tags?}，全部内容字段可选；**files 提供时整体替换**（这是删除附加文件的唯一途径）；`name` 不可改（改名会破坏已安装的本地目录）；仅作者或 admin 可调；version 仅在内容字段实际变化时 +1；重算向量。
- 删除走管理端（admin CLI 增 delete-skill 命令），与知识条目 delete-knowledge 同模式。

## REST / 门户

REST（verify-only 鉴权，与现有 /api 一致）：
- `GET /api/skills`（搜索/浏览 + facets）`GET /api/skills/:name`（详情含文件内容，供预览/编辑）
- `POST /api/skills`、`PUT /api/skills/:name`（作者或 admin）、`DELETE /api/skills/:name`（作者或 admin）

门户新增（复用 SearchPage 的结构与组件风格）：
- 路由 `skill` + 菜单项「Skills」→ `SkillPage.vue`：检索/浏览双页签、scope facets、列表卡片（name、description、tags、作者、use_count、version）
- `SkillDetailDrawer.vue`：元信息 + 文件预览（SKILL.md 渲染 + 附加文件代码块）
- `SkillForm.vue`：name/description/instructions/标签/scope + 附加文件动态编辑器（每行 path + content textarea），编辑模式加载现有值
- Admin 后台增加 skill 状态/删除管理（复用 AdminKnowledge 模式，可选低优先）

## /login 独立页

- 新路由 `login` + `LoginPage.vue`：居中卡片，token 输入 + 登录按钮 + 错误提示（现 App.vue 模态框逻辑迁移），删除原模态框
- **受保护页面白名单**：`SkillForm`（上传/编辑入口）与管理后台三页需要登录；检索、统计、Skills 检索/浏览**保持匿名可看**（沿用现状，不因 login 页面引入而收紧）——未登录点击"上传 skill"或进入 /admin 时跳 `/login?redirect=<原路径>`
- 中途 401（token 失效/被禁用）：apiFetch 内 logout 后改为跳转 `/login?redirect=<当前路径>`（现行为是抛错不跳转）；loadMe 失效同样跳转，硬刷新后回到登录页并可回跳
- App.vue 头部保留现有「退出」按钮（已实现），登录入口改为跳转 /login

## 接入规则

integration/rules/ 六份规则样板各增加一条纪律：「接到开发任务后，除 get_context 外先调 search_skills 检索有无可用 skill；命中则 get_skill 按指引安装到本地再使用，没有才自行解决；好用的做法沉淀为 skill 上传」（编号顺延，保持与其他五条同源结构）。rules/README.md 同步。

## 约束

- 复用现有：Bearer 鉴权/限流、scope_registry、guard 敏感扫描、embedder、trigram+向量打分、search_event、admin CLI 模式
- 限流沿用 60 req/min；get_skill 返回体积受 files 上限约束
- 前端沿用 Vue3 + AntD Vue + 现有 api.ts 模式

## 留给实现者的决定

- migration 具体顺序与 up/down 语句细节
- MCP tool schema 的 zod 定义细节、错误码文案
- SkillPage/SkillForm 的组件拆分与状态管理细节
- search SQL 中 trigram 列与权重微调
