# 接入指南

## 一键全局接入（Claude Code，推荐）——一次配置，所有项目生效

拿到本仓库后执行一次：

```bash
bash integration/setup-akm-global.sh            # 身份自动取 git email 前缀
bash integration/setup-akm-global.sh zhangsan   # 或显式指定身份名（中文姓名请转拼音）
```

写入的都是**用户级配置**：`~/.claude.json`（MCP server）、`~/.claude/settings.json`（SessionStart hook）、`~/.claude/CLAUDE.md`（使用约束）。重启一次 Claude Code 会话，本机所有项目全部生效。

### Windows 用户

```powershell
# 在 integration 目录下（首次被策略拦截时用：powershell -ExecutionPolicy Bypass -File .\setup-akm-global.ps1）
.\setup-akm-global.ps1              # 身份自动取 git email 前缀
.\setup-akm-global.ps1 zhangsan     # 显式指定身份名（中文姓名请转拼音）
```

写的是 `%USERPROFILE%` 下的同样三份用户级配置，效果相同。

> 项目级脚本 `setup-akm.sh` 是 bash，Windows 下需在 Git Bash 中运行；一般用不上——全局版已覆盖。

## 项目级接入（可选，只影响单个项目）

```bash
bash integration/setup-akm.sh /path/to/你的项目
```

适合：想让某个项目带自己的约束、或不想动全局配置的场景。脚本幂等（重复执行无副作用），自动完成：写项目 `.mcp.json`、追加约束到项目 `CLAUDE.md`、安装项目 hook。

脚本幂等（重复执行无副作用），自动完成三件事：写 `.mcp.json`、把使用约束追加到 `CLAUDE.md`、安装 SessionStart hook。之后**重启一次 Claude Code 会话**，agent 按 CLAUDE.md「身份自配置」规则自动注册身份（git email 前缀，中文姓名自动转拼音），并按提示**把注册响应中的 `identity_token` 写回配置**（令牌只显示一次），再重启一次即永久生效。

## 人工接入（或理解脚本做了什么）

**接入 = 把 `.mcp.json.example` 复制为 `.mcp.json`，Bearer 后填一个身份名**，首次调用自动注册；**注册响应会一次性下发随机访问令牌（`identity_token`），立即把它写回 `Authorization: Bearer <identity_token>` 并重启会话**——此后名字只是署名，令牌才是凭证（令牌只显示这一次，丢失需管理员 `reset-token` 重发）。

三种填法，任选其一：

1. **agent 自动配置（推荐，方案 A）**：把 `CLAUDE.md.snippet` 追加到项目 `CLAUDE.md` 后，agent 会按其中"身份自配置"规则自动完成——取 `git config user.email` 前缀（中文姓名自动转拼音，兜底 hostname）作为身份名写入 `.mcp.json`，注册后把 `identity_token` 写回配置并提示重启。
2. **人工填写**：编辑 `.mcp.json`，`"Authorization": "Bearer zhangsan"`（字母/数字开头，仅含字母、数字、`. _ -`，≤40 字符）先注册；随后把首次调用响应中的 `identity_token` 换到 Bearer 后面。
3. **管理员建号**：`docker exec akm-app node dist/scripts/admin.js adduser <名字> --token <token>`，把 token 给本人填入。

规则：

- 身份名先到先得；请用真实可辨识的名字（作者归属、`mark_used` 晋升都靠它）
- **令牌只显示一次**：注册后立即让 agent 把 `identity_token` 写回配置；丢失只能找管理员 `reset-token` 重发
- 若服务器启用了 `AKM_JOIN_SECRET`，新身份首次注册还需带 header `"X-Join-Secret": "<口令>"`（口令随团队模板分发，找管理员拿）；已注册的老身份不受影响

### Claude Code

把 `.mcp.json.example` 复制为项目根目录 `.mcp.json`（项目级）或写入 `~/.claude.json`（用户级），改掉 Bearer 名字即可。

### Cursor / 其他 MCP 客户端

见 `cursor.example.md`。任何支持 Streamable HTTP MCP 的客户端均可接入：URL `http://your-akm-server:3000/mcp`，header `Authorization: Bearer <身份名>`（首次注册用；注册成功后按响应提示换成本人 `identity_token`）。

## 项目约束（必做）

把工具对应的规则样板追加进项目的规则文件——这是 agent 主动使用知识库的关键：

- Claude Code：`CLAUDE.md.snippet` → 项目 `CLAUDE.md` 末尾
- Cursor / Trae / Windsurf / Codex / Gemini CLI / Copilot 等其他工具：见 [`rules/README.md`](rules/README.md) 的对照表，各工具样板已按其 MCP 配置方式调整好身份条款

## SessionStart 提醒（推荐）

把 `session-start-hook.cjs` 放到项目 `.claude/hooks/akm-session-start.cjs`，在 `.claude/settings.json` 加：

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node .claude/hooks/akm-session-start.cjs" } ] }
    ]
  }
}
```

## 工具清单（与实现一一对应）

| 工具 | 用途 |
|---|---|
| `search_knowledge` | 检索知识库（排查前先查） |
| `save_knowledge` | 上传结构化知识（自动查重提示 → draft） |
| `update_knowledge` | 补充/修正已有条目（作者或管理员） |
| `mark_used` | 标记"帮到了我"（驱动 draft → verified 晋升） |
| `get_context` | 开工时拉取模块注意事项清单 |
| `save_skill` | 上传可复用的操作技能（SKILL.md 安装入口自动组装 → draft） |
| `search_skills` | 接任务先检索团队 skill 库有无现成技能 |
| `get_skill` | 拉取 SKILL.md 与附加文件并返回安装指引（拉取计入使用，2 人拉取自动转 verified） |
| `update_skill` | 补充/修正已有 skill（作者或管理员；files 整体替换是删除附加文件的唯一途径） |

## 管理员操作（仅异常情况需要）

- 禁用恶意/垃圾身份：`docker exec akm-app node dist/scripts/admin.js disable <名字>`
- 重发访问令牌（成员令牌丢失时）：`docker exec akm-app node dist/scripts/admin.js reset-token <名字>`——新令牌明文仅在命令输出出现一次，线下交付本人写回配置
- 列出仍以用户名作令牌的存量账号（迁移检查）：`docker exec akm-app node dist/scripts/admin.js listusers --legacy`
- 给指定人建固定 token（可选，个人 token 与自报名字并存）：
  `docker exec akm-app node dist/scripts/admin.js adduser <名字> --token <token>`
- 管理员账号：`adduser <名字> --token <token> --role admin`
- skill 管理：`delete-skill <name>` / `set-skill-status <name> <draft|verified|deprecated>`
