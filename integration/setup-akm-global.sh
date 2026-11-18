#!/usr/bin/env bash
# 团队知识库一键全局接入（Claude Code）——一次配置，本机所有项目生效
# 用法：
#   bash setup-akm-global.sh              # 身份自动取 git email 前缀（中文转不了拼音则报错，请显式指定）
#   bash setup-akm-global.sh zhangsan     # 显式指定身份名
# 幂等：重复执行会更新配置而非重复追加。
set -euo pipefail
URL="${AKM_URL:-http://your-akm-server:3000/mcp}"

command -v claude >/dev/null || { echo "✗ 未找到 claude CLI（需要 Claude Code）"; exit 1; }
command -v node   >/dev/null || { echo "✗ 未找到 node"; exit 1; }

# ---- 1. 身份名：参数 > git email 前缀 > git user.name > hostname ----
sanitize() {  # 清洗为合法身份名：字母/数字开头，仅含 a-zA-Z0-9._-，≤40
  printf '%s' "$1" | sed -e 's/[[:space:]]\+/-/g' -e 's/[^a-zA-Z0-9._-]//g' | cut -c1-40 | sed -E 's/^[^a-zA-Z0-9]+//'
}
NAME="${1:-}"
if [ -z "$NAME" ]; then
  GIT_EMAIL="$(git config --get user.email 2>/dev/null || true)"
  GIT_NAME="$(git config --get user.name 2>/dev/null || true)"
  RAW="${GIT_EMAIL%%@*}"
  if [ -z "$RAW" ] || printf '%s' "$RAW" | grep -q '[^a-zA-Z0-9._-]'; then
    # email 前缀缺失或含中文等非 ASCII → 试 user.name，再不行用机器名
    if [ -n "$GIT_NAME" ] && ! printf '%s' "$GIT_NAME" | grep -q '[^a-zA-Z0-9._- ]'; then
      RAW="$GIT_NAME"
    else
      RAW="$(hostname -s 2>/dev/null || hostname)"
    fi
  fi
  NAME="$(sanitize "$RAW")"
fi
if ! printf '%s' "$NAME" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$'; then
  echo "✗ 身份名不合法: '$NAME'（中文姓名请转拼音后显式指定：bash setup-akm-global.sh zhangsan）"
  exit 1
fi
echo "√ 身份名: $NAME"

# ---- 2. 用户级 MCP server（所有项目可见）----
# Bearer 先填身份名：首次调用 MCP 工具即自动注册，服务端一次性下发 identity_token；
# 之后按 agent 提示把令牌写回这里的 Authorization（服务器配了 AKM_JOIN_SECRET 时还需 X-Join-Secret 头）
claude mcp remove team-knowledge --scope user >/dev/null 2>&1 || true
JOIN_HEADERS=()
if [ -n "${AKM_JOIN_SECRET:-}" ]; then
  JOIN_HEADERS=(-H "X-Join-Secret: $AKM_JOIN_SECRET")
  echo "√ 已附加 X-Join-Secret 头（来自 AKM_JOIN_SECRET 环境变量）"
fi
claude mcp add --transport http --scope user team-knowledge "$URL" \
  -H "Authorization: Bearer $NAME" ${JOIN_HEADERS[@]+"${JOIN_HEADERS[@]}"} >/dev/null
echo "√ 已写入用户级 MCP server（~/.claude.json，所有项目可用）"

# ---- 3. SessionStart hook（用户级，所有项目生效）----
TPL="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.akm"
cp "$TPL/session-start-hook.cjs" "$HOME/.akm/akm-session-start.cjs"
node - <<EOF
const fs = require('fs');
const p = process.env.HOME + '/.claude/settings.json';
let s = {};
try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
s.hooks = s.hooks || {};
s.hooks.SessionStart = (s.hooks.SessionStart || []).filter(h =>
  !(h.hooks || []).some(x => String(x.command || '').includes('akm-session-start'))
);
s.hooks.SessionStart.push({
  hooks: [{ type: 'command', command: 'node ' + process.env.HOME + '/.akm/akm-session-start.cjs' }],
});
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
EOF
echo "√ 已写入用户级 SessionStart hook（~/.claude/settings.json）"

# ---- 4. 全局记忆（所有项目的 agent 都读到使用约束）----
MEMORY="$HOME/.claude/CLAUDE.md"
touch "$MEMORY"
if ! grep -q "团队知识库（agent-knowledge-mcp）使用约束" "$MEMORY"; then
  printf '\n%s\n' "$(cat "$TPL/CLAUDE.md.snippet")" >> "$MEMORY"
  echo "√ 已追加使用约束到 ~/.claude/CLAUDE.md"
else
  echo "√ ~/.claude/CLAUDE.md 已含约束，跳过"
fi

echo ""
echo "完成。重启一次 Claude Code 会话即可在本机所有项目使用知识库。"
echo "注意：首次调用完成注册后，按 agent 提示把响应中的 identity_token 写回"
echo "Authorization: Bearer <token>（令牌只显示一次，丢失需管理员 reset-token），再重启一次。"
echo "验证：随便打开一个项目问 agent「检索一下知识库」。"
