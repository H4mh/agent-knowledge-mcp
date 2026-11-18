#!/usr/bin/env bash
# 团队知识库一键接入脚本（Claude Code）
# 用法：在本仓库 integration/ 目录下执行：
#   bash setup-akm.sh /path/to/你的项目
# 幂等：重复执行无副作用。Cursor 用户看 README.md（需人工填身份）。
set -euo pipefail
DIR="${1:?用法: bash setup-akm.sh <目标项目路径>}"
TPL="$(cd "$(dirname "$0")" && pwd)"

# 1. .mcp.json（已接入则跳过）
if [ -f "$DIR/.mcp.json" ] && grep -q team-knowledge "$DIR/.mcp.json"; then
  echo "√ .mcp.json 已存在，跳过"
else
  cp "$TPL/.mcp.json.example" "$DIR/.mcp.json"
  echo "√ 已写入 $DIR/.mcp.json（身份由 agent 按 CLAUDE.md 规则自动填充）"
fi

# 2. CLAUDE.md 追加使用约束（带标记防重复追加）
touch "$DIR/CLAUDE.md"
if grep -q "团队知识库（agent-knowledge-mcp）使用约束" "$DIR/CLAUDE.md"; then
  echo "√ CLAUDE.md 已含约束，跳过"
else
  printf '\n%s\n' "$(cat "$TPL/CLAUDE.md.snippet")" >> "$DIR/CLAUDE.md"
  echo "√ 已追加到 $DIR/CLAUDE.md"
fi

# 3. SessionStart hook + settings.json 合并
mkdir -p "$DIR/.claude/hooks"
cp "$TPL/session-start-hook.cjs" "$DIR/.claude/hooks/akm-session-start.cjs"
node - "$DIR" <<'EOF'
const fs = require('fs');
const dir = process.argv[2];
const p = `${dir}/.claude/settings.json`;
let s = {};
try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
s.hooks = s.hooks || {};
// 去重：移除旧的 akm hook 再追加
s.hooks.SessionStart = (s.hooks.SessionStart || []).filter(h =>
  !(h.hooks || []).some(x => String(x.command || '').includes('akm-session-start'))
);
s.hooks.SessionStart.push({
  hooks: [{ type: 'command', command: 'node .claude/hooks/akm-session-start.cjs' }],
});
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
console.log('√ 已写入 ' + p);
EOF

echo ""
echo "完成。下一步：重启 Claude Code 会话，agent 会按 CLAUDE.md「身份自配置」"
echo "规则注册身份（git email 前缀）并领取访问令牌。首次调用后按 agent 提示"
echo "把响应中的 identity_token 写回 .mcp.json（令牌只显示一次），再重启一次即永久生效。"
