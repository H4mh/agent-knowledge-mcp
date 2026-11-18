# 阶段一加固（Hardening）设计文档

> 日期：2026-11-17　|　状态：设计已定稿（builder check 完成，用户已确认三项裁定）
> 前置：项目分析与三阶段路线图（会话 2026-11-17），本档只覆盖阶段一。TLS 延后（用户裁定：无域名，自签 CA 破坏一键接入，安全组限源兜底）。

## 意图与动机

项目刚承载第一次真实负载（588 篇文档 + 日常 agent 使用）。核心闭环已跑通，但存在两个正确性缺口：**身份可冒充**（Bearer=名字，知道名字即可冒充他人写/改条目）与 **update 无版本控制**（last-write-wins 静默覆盖，改坏无法回滚、无法追责）。阶段一补这两个缺口，并把文档里写了但没落地的运维项（备份、监控）实际装上。

## 目标 / 非目标 / 反目标

- **目标**：写身份与凭证分离（注册领 token）；每次修改可追溯、可回滚；生产有每日备份且演练过恢复；服务与向量链路有主动探测。
- **非目标**：不做 SSO/OIDC（公司内网 SSO 对接留待后续阶段）；不给 skill 加权限模型；不做 HTTPS；不动多实例部署。
- **反目标**：破坏「零人工开通」的接入体验——这是项目的核心卖点；打断现有 agent 的正常调用。

## 方案取舍（身份 token 化）

- **A. 保留自报注册，注册时下发随机 token（选定）**：首次调用仍可用名字注册，但服务端生成随机 token 经响应返回，agent 存入配置。保住零人工开通，迁移成本目前最低（真实用户极少）。
- **B. 全面管理员发号**：最安全但回到人工开通，与设计初衷相悖。弃。
- **C. 读不验、写验 token**：改动最小但署名仍可冒充，问题只解决一半。弃。

## 设计细节

### 1. 身份 token 化

现状：`app_user(username PK, token_hash, role, enabled)`；`authenticate()` 对未知 token 若匹配 IDENTITY_RE 则自动注册，`token_hash = sha256(bearer)`——即名字本身就是凭证。

改动：

1. **注册流程**：未知 Bearer（合法身份名）首次调用 MCP 工具 → 自动注册，但 `token_hash = sha256(生成的随机token)`（32 字节 hex）。随机 token 以 `identity_token` 字段附加在该次工具调用的响应负载中，并在文本里提示 agent「请把此 token 写入 .mcp.json 的 Authorization: Bearer <token>」。名字此后只是署名，不再是凭证。
2. **迁移（用户裁定：不做 strict 开关）**：
   - ~~AKM_TOKEN_STRICT~~ **不做**——builder check 证明 strict 按原设计是无效开关：迁移完成后"名字当 token"已被用户名占用检查（auth.ts:44-45）天然拒绝；迁移前 strict 又拦不住老用户被冒充（老 token=名字哈希）。冒充漏洞由迁移本身关闭。
   - 老身份（token_hash = sha256(名字)）在补发前继续可用；
   - 管理员新命令 `reset-token <名字>`：生成新随机 token 替换 token_hash，token 明文仅在命令输出出现一次；
   - `listusers --legacy`：比对 token_hash 与 sha256(username)，列出尚未迁移的身份——迁移完成的验收标准。
3. **生产启用 `AKM_JOIN_SECRET`（用户裁定）**：新身份首次注册须携带 `X-Join-Secret` 团队口令，口令随团队模板分发——挡住抢名（同事名字被抢注）与垃圾身份。教程与 deploy.md 标注此项为生产必配。
4. **token 丢失恢复（用户裁定）**：阶段一不做自助找回；唯一出路管理员 `reset-token`。教程加粗提示「注册后立即让 agent 把 token 写回配置」。
5. **门户**：登录即"输入 token"（现在已是如此），行为不变；`verifyOnly` 路径不动。
6. **已知残留风险（记录不处理）**：身份名大小写敏感，`HAMH` 与 `hamh` 可并存为两个身份（署名混淆但非冒充）；改名需求不支持。
7. **配套更新**：integration/setup-akm*.sh、CLAUDE.md.snippet「身份自配置」条款（增：从首次调用响应中取 identity_token 写回配置；JOIN_SECRET 配置）、使用教程、README 双语、deploy.md。

### 2. 乐观锁 + 修订历史

现状：update 直接 UPDATE。**builder check 修正**：skill 已有 version 列（migrations/0003_skill.sql:12，handleUpdateSkill 已做 version+1 并在门户展示 vN）——migration 只给 knowledge 补列。

改动：

1. **migration 0004**：`knowledge` 加 `version INT NOT NULL DEFAULT 1`；新表 `entry_revision(id, entry_kind ('knowledge'|'skill'), entry_id, version, changed_by, kind ('content'|'status'), changes JSONB, snapshot JSONB, created_at)`——snapshot 存修改前的整行，changes 记 `{field: old_value}` 映射（builder 拍板）。
2. **写路径**：`update_knowledge` / `update_skill` 新增可选输入 `base_version`：
   - 提供：与当前 version 不符 → 报错 `CONFLICT`（提示重新 search 后再改，带上最新 version）；相符 → 更新成功，version+1；
   - 不提供：行为同现状（更新成功，version+1）——老 agent 不被打断。
   - 修订行 + 主表更新在**同一事务**（`pool.connect()` + BEGIN/COMMIT，模板见 src/db.ts:44 迁移事务）；**embedding 外呼必须留在事务提交之后**（现状顺序即如此，保持——外部 HTTP 慢/挂不能拖住事务）。
   - **并发原子性**：base_version 校验用 `SELECT ... FOR UPDATE` 行锁，否则两个并发 update 会双双通过（builder check 指出的缺陷）。
   - **空更新不记账**：knowledge 采用 skill 已有的变更检测（无语义变化 → 不 version+1、不写修订行）。
3. **状态变更也入修订**（builder check 指出的追溯缺口）：管理员 set-status（CLI 与 REST 同路径 src/admin/service.ts）与 get_skill 自动晋升（draft→verified）都写 `kind='status'` 修订行（记 old→new status），不改 version。删除条目不写修订（修订行保留供追溯）。
4. **查询**：search_knowledge 命中项、get_context 条目、search_skills、门户列表/详情查询统一补 `version` 字段（get_skill 已有）。
5. **REST**：PUT /api/knowledge/:id 与 /api/skills/:name 白名单放行 `base_version`（门户表单暂不发，行为不变）；新增修订历史只读端点 `GET /api/knowledge/:id/revisions` 与 `GET /api/skills/:name/revisions`（builder 拍板：走 readGuard 匿名只读，与详情一致；两个详情抽屉都加面板）。
6. **门户**：详情抽屉（知识与 Skill 两处）加「修订历史」折叠面板：时间、修改人、变更字段/状态；暂不做 diff 渲染、不做回滚 UI（回滚走管理员 CLI，新增 `history <id>` / `history --skill <name>` 查看命令即可）。

### 3. 备份实装 + 恢复演练（纯运维，无代码）

1. 服务器 crontab 落地：`0 2 * * * docker exec akm-db pg_dump -U akm akm | gzip > /opt/backup/akm-$(date +\%F).sql.gz`，并保留 30 天（find -mtime +30 -delete）。
2. 恢复演练（验收条件）：取当日 dump 在服务器上建临时测试库导回，跑行数比对查询（knowledge/skill/app_user 计数一致），输出演练记录。不动生产数据。

### 4. 轻量监控（纯运维，无应用代码）

1. 服务器 `/opt/akm-monitor/monitor.sh`，crontab 每 5 分钟：
   - `curl http://127.0.0.1:3000/api/stats` 健康检查（非 200 = 服务异常）；
   - `docker exec akm-app node -e "fetch('http://host.docker.internal:11434/api/embed',...)"` 向量链路检查（失败/超时 = 隧道断）。
2. 异常时：写 `/var/log/akm-monitor.log`；若 `/opt/akm-monitor/webhook.env` 配置了 `WEBHOOK_URL` 则 POST 通用 JSON（兼容钉钉/企业微信机器人 text 格式）。恢复后发一条恢复通知（用临时状态文件判边沿，避免每 5 分钟重复告警）。
3. WEBHOOK_URL 未配置时仅记日志（用户后续建机器人填 URL 即生效）。

## 约束

- 不破坏现有测试与已部署行为；所有新行为向后兼容（base_version 可选、注册流程对老客户端透明）
- 迁移按既有模式（migrations/ 启动幂等执行）
- monitor.sh 归档进仓库（scripts/ops/）供复现，服务器上部署为 cron
- 涉及生产的部署/快照操作按本会话惯例：用户授权后执行

## 实施者已定决策（builder check 拍板，不再开放）

- identity_token：统一包装器附加到 result 内容顶层 + 文本提示；成功与工具错误路径都带
- entry_revision.changes 结构：`{field: old_value}` 映射；kind 区分 content/status
- reset-token 默认只换 token（禁用身份用既有 disable 命令）
- monitor.sh 向量检查超时 10s
- `history <id>`（知识）与 `history --skill <name>`（skill）
