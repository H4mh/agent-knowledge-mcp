# 部署指南 — 阿里云 your-akm-server

## ⚠️ 安全要求（必读）

写操作与管理端靠 Bearer token 鉴权；`/api` 只读 GET（知识列表/详情、统计、skills 列表/详情）**匿名可访问**（限流按 IP 计，供门户匿名浏览），`/mcp` 全部工具均需 Bearer。因此**必须**在阿里云安全组做来源限制：

- 只放行公司出口 IP 访问 MCP 端口（默认 3000）；**禁止配置 0.0.0.0/0**
- SSH 端口（22）同样仅放行管理用 IP
- 数据库端口 5432 不对公网开放（compose 内部网络，无需映射宿主机）
- **传输加密**：当前服务是纯 HTTP，Bearer token 在公司出口到服务器之间明文传输。安全组来源限制缓解了主要暴露面，但强烈建议任选其一：
  1. 前置 nginx/caddy 做 TLS 终结（推荐，证书可用内网 CA 或 Let's Encrypt），MCP 接入 URL 改为 `https://`；
  2. 或仅经公司内网/VPN 隧道访问该端口（安全组只放 VPN 网关 IP）。

## 首次部署

```bash
# 1. 连接服务器（<密钥路径> 换成你的 SSH 私钥）
ssh -i <密钥路径> root@your-akm-server

# 2. 安装 docker（如未安装）
curl -fsSL https://get.docker.com | bash
systemctl enable --now docker

# 3. 拷贝项目（本机执行，在项目父目录运行）
scp -i <密钥路径> -r ./agent-knowledge-mcp root@your-akm-server:/opt/agent-knowledge-mcp

# 4. 服务器上启动（首次会构建镜像）
#    AKM_JOIN_SECRET 为团队口令（生产必配）：配置后新身份首次注册须携带
#    X-Join-Secret 头，口令随团队模板分发；不配置 = 任何能连通端口的人都能抢注身份（仅限内网试用）
cd /opt/agent-knowledge-mcp
AKM_DB_PASSWORD='<强密码>' AKM_APP_PORT=3000 AKM_JOIN_SECRET='<团队口令>' docker compose up -d --build

# 5. 建管理员账号（容器内执行；token 自定并妥善保存）
docker exec akm-app node dist/scripts/admin.js adduser admin --token '<管理员token>' --role admin
```

数据库迁移（`applyMigrations`）在服务启动时自动执行。

## 向量语义检索（可选）

默认不启用。配置向量模型后，保存/更新的条目自动生成 embedding，检索时叠加向量语义分——零关键词重叠但语义相关的条目也能召回；服务不可用时自动退化为关键词检索，不影响保存与检索主流程。

```bash
# 启动时附加向量配置（协议 openai | ollama | generic）
AKM_DB_PASSWORD='<强密码>' AKM_APP_PORT=3000 \
  AKM_EMBEDDING_PROTOCOL=openai \
  AKM_EMBEDDING_URL='http://<内网模型网关>/v1/embeddings' \
  AKM_EMBEDDING_MODEL='bge-m3' \
  AKM_EMBEDDING_API_KEY='<可选>' \
  docker compose up -d --build

# 为存量条目回填向量（启用向量后或向量服务中断恢复后执行一次；knowledge 与 skill 一并回填，幂等只补缺失）
docker exec akm-app node dist/scripts/admin.js embed
```

协议说明：

- `openai`：OpenAI 兼容 `/embeddings` 接口（OneAPI / vLLM / 大多数模型网关），请求 `{model, input}`，从 `data[0].embedding` 取向量
- `ollama`：Ollama 原生 `/api/embed`，从 `embeddings[0]` 取向量
- `generic`：自定义接口——`AKM_EMBEDDING_BODY_TEMPLATE` 为请求体模板（`{{text}}`/`{{model}}` 占位，如 `{"q":{{text}},"model":"{{model}}"} `），`AKM_EMBEDDING_RESPONSE_PATH` 为响应取值路径（如 `data[0].embedding`）

其他环境变量：`AKM_EMBEDDING_TIMEOUT_MS`（默认 5000）、`W_VECTOR`（向量相似度权重，默认 4）。检索打分各权重也可调（`W_TITLE` / `W_SYMPTOM` / `W_SOLUTION` / `W_TAGS` / `W_SCOPE` / `W_TRIGRAM` / `W_USE` / `W_VERIFIED`，均有默认值，一般无需改动）；`AKM_WEB_DIST_DIR` 为门户静态文件目录覆盖项（默认 `web/dist`，容器内已打包，本地开发才用得上）。

### 向量服务跑在自己的 Mac/内网机器上（SSH 反向隧道）

向量服务必须能被**MCP 服务器**访问到。如果你的 Ollama 跑在个人 Mac 或公司内网机器上，服务器无法直接访问，可以用 SSH 反向隧道把它"带"到服务器上。以 Mac + Ollama 为例：

**第 1 步：本机准备 Ollama（Mac 上）**

```bash
brew install ollama          # 或从 ollama.com 下载
ollama pull bge-m3           # 中文知识库推荐 bge-m3（约 1.2GB）；轻量可换 nomic-embed-text
ollama serve                 # 监听 localhost:11434（保持运行）
curl -s http://localhost:11434/api/embed -d '{"model":"bge-m3","input":"测试"}'   # 验证可用
```

**第 2 步：建立反向隧道（Mac 上，保持终端开启）**

```bash
ssh -N -R 11434:localhost:11434 root@<服务器地址>
# -N 只做端口转发不进 shell；-R 把服务器上的 11434 端口反向映射回本机的 11434
# 断开 = Mac 睡眠/关机 = 服务器失去向量服务（检索自动退化为关键词模式，不报错）
```

**第 3 步：服务器上把隧道端口转发到 docker 网桥（一次性）**

SSH 反向隧道只绑定服务器的 `127.0.0.1`，而容器经 `host.docker.internal`（= docker 网桥 `172.17.0.1`）访问宿主机，sshd 不监听网桥地址——需要 socat 把网桥端口转发到本机回环（**只绑 172.17.0.1，不对公网暴露**）：

```bash
# 服务器上执行；服务器重启后需重跑一次
setsid socat TCP-LISTEN:11434,bind=172.17.0.1,fork,reuseaddr TCP:127.0.0.1:11434 </dev/null >/var/log/socat-akm.log 2>&1 &
ss -tlnp | grep 11434   # 应看到 sshd 绑 127.0.0.1 和 socat 绑 172.17.0.1 两条
```

**第 4 步：服务器上启用向量配置**

容器内 `localhost` 是容器自己，必须用 `host.docker.internal` 访问宿主机（compose 已配好 host-gateway 映射）：

```bash
cd /opt/agent-knowledge-mcp
AKM_DB_PASSWORD='<密码>' AKM_APP_PORT=3000 \
  AKM_EMBEDDING_PROTOCOL=ollama \
  AKM_EMBEDDING_URL='http://host.docker.internal:11434/api/embed' \
  AKM_EMBEDDING_MODEL='bge-m3' \
  docker compose up -d

docker exec akm-app node dist/scripts/admin.js embed    # 存量条目回填（隧道开着时执行）
```

**验证**：

```bash
# 服务器上验证隧道通（应返回向量 JSON）
curl -s http://localhost:11434/api/embed -d '{"model":"bge-m3","input":"测试"}' | head -c 100

# 容器内验证全链路通（socat → 隧道 → 本机 Ollama），应输出"向量维度: 1024"
docker exec akm-app node -e "fetch('http://host.docker.internal:11434/api/embed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'bge-m3',input:'测试'})}).then(r=>r.json()).then(d=>console.log('向量维度:',d.embeddings[0].length))"
```

**行为约定**：

- 隧道断开期间：保存/更新正常入库（仅警告"向量服务不可用，本条未生成向量"），检索自动退化为关键词模式——不会报错、不会阻塞
- 隧道恢复后：新保存的条目自动补上向量；**断开期间入库/更新的条目需要重跑 `admin embed` 回填**（该命令只处理缺失向量的条目，幂等安全）
- `ssh -N` 隧道终端"卡住不动"是正常现象（静默转发）；本机 `ollama serve` 同理
- 此方式仅适合试用验证。生产环境请用公司内网的模型网关（`openai` 协议），或把 Ollama 部署到服务器可达的固定机器上

> 注意：`.npmrc` 默认指向公网 npm 源。若服务器需走公司 Nexus，修改 `/opt/agent-knowledge-mcp/.npmrc` 后重新 `docker compose up -d --build`。

## 接入方式（自报身份注册 + 访问令牌，2026-11-17 起令牌化）

接入无需管理员建号：开发者把 `integration/.mcp.json.example` 复制为 `.mcp.json`，
`Authorization: Bearer <自己的身份名>`，首次调用 MCP 工具即自动注册——服务端生成随机
访问令牌（`identity_token`），**仅在该次响应（含 initialize 提示）中出现一次**，agent 应立即
把它写回 `.mcp.json` 的 `Authorization: Bearer <token>` 并重启会话。身份名此后只是署名，
不再是凭证；已注册身份一律用 `identity_token` 调用。生产环境必须配置 `AKM_JOIN_SECRET`：
未配置 = 任何能连通端口的人都能抢注身份（同事名字被抢注、垃圾身份）。管理员操作：

```bash
# 禁用恶意/垃圾身份
docker exec akm-app node dist/scripts/admin.js disable <名字>
# （可选）给指定人建固定 token，或建管理员
docker exec akm-app node dist/scripts/admin.js adduser <名字> --token '<token>' --role admin
```

### 存量身份迁移（升级到令牌化版本后执行一次）

老账号的 token_hash 仍是 `sha256(用户名)`——补发令牌前继续可用（不被迫下线），但
"知道名字就能冒充"的漏洞要靠迁移关闭。验收标准：`listusers --legacy` 输出为空。

```bash
# 1. 部署新版本，并在启动环境里配置 AKM_JOIN_SECRET（生产必配，见「首次部署」第 4 步）
# 2. 找出仍以用户名作令牌的存量账号
docker exec akm-app node dist/scripts/admin.js listusers --legacy
# 3. 逐个换发随机令牌并线下交付（私发本人，不要走群聊；明文仅在命令输出出现一次，
#    让本人写回 .mcp.json 的 Authorization: Bearer <token> 并重启会话）
docker exec akm-app node dist/scripts/admin.js reset-token <名字>
# 4. 复查，直到 listusers --legacy 输出为空
docker exec akm-app node dist/scripts/admin.js listusers --legacy
```

**scope 自动注册收紧（可选）**：默认任何 agent 首次保存未注册 scope 时自动注册（零人工开通）。若担心拼写错误产生碎片 scope，可在启动时加 `AKM_SCOPE_OPEN=false`——未注册 scope 会被拒绝并提示"请联系管理员先注册"，管理员用 `list-scopes` / `delete-scope` 管理注册表。

## 日常运维

```bash
# 状态与日志
docker compose ps
docker logs -f akm-app

# 用户管理
docker exec akm-app node dist/scripts/admin.js listusers
docker exec akm-app node dist/scripts/admin.js listusers --legacy   # 迁移检查：仍以用户名作令牌的账号
docker exec akm-app node dist/scripts/admin.js reset-token <name>   # 重发随机访问令牌（明文仅此一次显示）
docker exec akm-app node dist/scripts/admin.js disable <name>

# 知识管理（status 变更、删除）
docker exec akm-app node dist/scripts/admin.js set-status 42 verified
docker exec akm-app node dist/scripts/admin.js delete-knowledge 42
docker exec akm-app node dist/scripts/admin.js history 42           # 条目修订历史（最近 50 条）

# scope 管理（新 scope 由首次保存自动注册）
docker exec akm-app node dist/scripts/admin.js list-scopes
docker exec akm-app node dist/scripts/admin.js delete-scope <scope>

# skill 管理（按名字硬删除 / 状态流转）
docker exec akm-app node dist/scripts/admin.js delete-skill <name>
docker exec akm-app node dist/scripts/admin.js set-skill-status <name> <draft|verified|deprecated>
docker exec akm-app node dist/scripts/admin.js history --skill <name>   # skill 修订历史

# 管理员操作（状态流转/删除/scope/用户管理）已可在网页管理后台完成，CLI 保留作兜底

docker cp /path/to/seeds akm-app:/tmp/seeds
docker exec akm-app node dist/scripts/import-markdown.js /tmp/seeds
```

## 知识门户（浏览器访问）

镜像内已打包门户前端（Vue SPA，与 `/mcp`、`/api` 同端口 3000），无需额外容器：

- 访问 `http://<server>:3000/`，功能：检索 / 浏览（按 scope） / 条目详情（mark_used） / 新增编辑（含查重预检） / 统计 / 管理后台（仅 admin）。
- Skills 模块：skill 检索 / 浏览（按 scope） / 详情 / 上传编辑（`/api/skills` REST，同名 MCP 工具 `save_skill`/`search_skills`/`get_skill`/`update_skill`）；未登录点"新增 Skill"会跳 `/login?redirect=/skills`。skill 附件限额固定：最多 20 个附加文件、单文件 64KB、总量 256KB——**无需新增环境变量**。
- 登录用 **MCP 同款访问令牌**（配置里 `Authorization: Bearer` 后那串，即注册时领取的 `identity_token`）。门户不注册新身份：没接入过 MCP 的用户先让 agent 调用一次 MCP 自动注册并把 `identity_token` 写回配置，再到门户登录。
- admin 登录后导航栏出现「管理后台」，可完成状态流转、删除、scope 管理与用户禁用。
- **⚠️ 安全组必须仅放行公司出口 IP 访问 3000 端口，禁止 0.0.0.0/0**：门户上线后浏览器流量也走 3000，端口暴露面从 agent 扩大到所有能连通该端口的人，这一条比纯 MCP 时代更重要（见 §安全要求）。

### 上线前人工 checklist

- [ ] 登录：正确 token 进得来；错误 token 提示"身份不存在…"
- [ ] 匿名访问：未登录可直接浏览检索/统计/Skills 只读页（/api 只读 GET 匿名可访问，限流按 IP），写操作需登录
- [ ] 检索：关键词能命中，超过 50 条时提示"请细化关键词"
- [ ] 浏览：左侧 scope 目录条目数正确，分页正常
- [ ] 详情：mark_used 后"用过 N 次"+1 且按钮变已记录
- [ ] 新增：预检命中相似条目时出卡片，仍要新建/去看相似条目两条路都通
- [ ] 编辑：非本人/非 admin 看不到编辑按钮；admin 可改受限字段
- [ ] 管理后台三页：条目状态流转/删除、scope 增改删（非空 scope 删除被拒）、用户禁用/启用
- [ ] Skills：上传（带附加文件）→ 检索命中 → 详情可见 SKILL.md 与附件 → 编辑清空附加文件/tags/scope 后重开确认已清空；第二个用户拉取后状态转 verified
- [ ] 统计页数字与 CLI `stats` 一致
- [ ] 安全：详情文本里含 `<script>` 的条目只显示文本不执行（XSS 检查）

## 数据备份

```bash
# 数据库每日备份（crontab）+ 30 天自动清理
mkdir -p /opt/backup
crontab -e  # 加入：
0 2 * * * docker exec akm-db pg_dump -U akm akm | gzip > /opt/backup/akm-$(date +\%F).sql.gz && find /opt/backup -name 'akm-*.sql.gz' -mtime +30 -delete

# 知识正文导出（可入库 git 仓库存档）
docker exec akm-app node dist/scripts/admin.js export /opt/backup/knowledge-md
```

### 恢复演练（升级/换库后建议重跑一次）

```bash
# 1. 用最近的 dump 建临时库导回（不动生产库 akm）
docker exec akm-db psql -U akm -c 'CREATE DATABASE akm_restore_test;'
gunzip -c /opt/backup/akm-$(date +%F).sql.gz | docker exec -i akm-db psql -U akm -d akm_restore_test -q
# 2. 行数比对：三个核心表与生产一致即演练通过
docker exec akm-db psql -U akm -d akm -tAc \
  "select 'knowledge',count(*) from knowledge union all select 'skill',count(*) from skill union all select 'app_user',count(*) from app_user"
docker exec akm-db psql -U akm -d akm_restore_test -tAc \
  "select 'knowledge',count(*) from knowledge union all select 'skill',count(*) from skill union all select 'app_user',count(*) from app_user"
# 3. 清理临时库
docker exec akm-db psql -U akm -c 'DROP DATABASE akm_restore_test;'
```

## 轻量监控

脚本在仓库 `scripts/ops/monitor.sh`，部署到服务器每 5 分钟跑一次：检查 `/api/stats` 健康（非 200 即异常）与向量链路（配置了 `AKM_EMBEDDING_URL` 时容器内真实发一次 embed 请求，失败判隧道断/模型未起）。异常写日志、恢复也通知一条（状态文件判边沿，不会每 5 分钟重复告警）。

```bash
# 一次性部署（服务器上）
mkdir -p /opt/akm-monitor
# 把仓库 scripts/ops/monitor.sh 放到 /opt/akm-monitor/monitor.sh
crontab -e  # 加入：
*/5 * * * * /opt/akm-monitor/monitor.sh
# 可选告警（钉钉/企业微信机器人 text 格式通用）：
echo 'WEBHOOK_URL=https://...' > /opt/akm-monitor/webhook.env
# 没配 webhook.env 时只记日志：/var/log/akm-monitor.log
```

## 知识库 git 镜像（可选，借鉴 basic-memory 的文件即版本历史思路）

把每日导出的 markdown 提交进一个 git 仓库，获得逐日 diff、任意时点回溯、以及脱离 MCP 服务的纯文件可读副本：

```bash
# 一次性初始化（服务器上）
mkdir -p /opt/backup/knowledge-md && cd /opt/backup/knowledge-md
git init && git add -A && git commit -m "init: 知识库镜像"

# 每日导出 + 提交（crontab，追加到上面 2:00 备份之后）
15 2 * * * cd /opt/agent-knowledge-mcp && \
  docker exec akm-app node dist/scripts/admin.js export /opt/backup/knowledge-md && \
  cd /opt/backup/knowledge-md && \
  git add -A && git diff --cached --quiet || git commit -m "daily export $(date +\%F)"
```

说明：

- 导出为幂等覆盖写，无变化时 `git diff --cached --quiet` 保证不产生空提交。
- 该镜像只是**备份视图**，不回写数据库——编辑镜像文件不会影响 MCP 服务中的知识条目。
- 如需异地容灾，把 `/opt/backup/knowledge-md` 作为普通 git 仓库 push 到内网 Git 服务即可。
- 数据库 dump 仍是权威备份（含 usage 统计、search_event 等镜像不含的数据）；git 镜像是人可读的补充。

## 升级

```bash
cd /opt/agent-knowledge-mcp
git pull   # 或重新 scp
AKM_DB_PASSWORD='<密码>' AKM_APP_PORT=3000 docker compose up -d --build
```

迁移按文件名顺序幂等执行，升级无需手工处理 schema。
