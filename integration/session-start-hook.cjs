#!/usr/bin/env node
/**
 * SessionStart hook：会话启动时注入知识库使用提醒 + 本项目 scope。
 * 安装（项目级，加到 .claude/settings.json）：
 * {
 *   "hooks": {
 *     "SessionStart": [
 *       { "hooks": [ { "type": "command", "command": "node .claude/hooks/akm-session-start.js" } ] }
 *     ]
 *   }
 * }
 * 将本文件放到项目 .claude/hooks/akm-session-start.js
 */
const { execSync } = require('node:child_process');

// 从 git remote 派生 scope：URL 末段去掉 .git；非法字符则不派生
function deriveScope() {
  try {
    const url = execSync('git remote get-url origin', { cwd: process.cwd(), encoding: 'utf8' }).trim();
    const last = url.split('/').pop().replace(/\.git$/i, '');
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/.test(last)) return last;
  } catch {}
  return null;
}

const scope = deriveScope();
const scopeLine = scope
  ? `5. 本项目 scope: ${scope}——get_context 和 save_knowledge 都用它（未注册的 scope 会在首次保存时自动注册）。`
  : '5. 保存知识时 scope 传本项目的 git 仓库名（git remote get-url origin 的末段），跨项目通用知识用 global。';

const reminder = [
  '【团队知识库提醒】本项目接入了团队知识库 MCP（team-knowledge）。',
  '0. 若 MCP 调用 401 或 .mcp.json 的 Bearer 仍是占位符，按 CLAUDE.md「身份自配置」规则：取 git config user.email 前缀（中文转拼音，兜底 hostname）作为身份名写入 .mcp.json 并提示用户重启会话；首次调用完成注册后，从响应取出 identity_token 写回 Authorization: Bearer <token>（令牌只显示一次，丢失需管理员 reset-token）并再次提醒重启；',
  '1. 开工前调用 get_context 获取本模块注意事项；',
  '2. 遇到构建/依赖/环境/框架行为问题，先 search_knowledge 再排查；',
  '3. 解决非琐碎问题后用 save_knowledge 沉淀（勿传密钥与业务敏感数据）；',
  '4. 已有知识帮到了你，调用 mark_used。',
  scopeLine,
].join('\n');
process.stdout.write(JSON.stringify({
  hookSpecificOutput: 'SessionStart',
  additionalContext: reminder,
}));
