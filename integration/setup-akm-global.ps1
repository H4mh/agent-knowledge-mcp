# 团队知识库一键全局接入（Claude Code / Windows PowerShell）
# 用法（在本文件所在目录）：
#   .\setup-akm-global.ps1              # 身份自动取 git email 前缀（中文转不了拼音则报错，请显式指定）
#   .\setup-akm-global.ps1 zhangsan     # 显式指定身份名（中文姓名请转拼音）
# 幂等：重复执行会更新配置而非重复追加。
# 首次执行若被策略拦截：powershell -ExecutionPolicy Bypass -File .\setup-akm-global.ps1
param([string]$Name)

$ErrorActionPreference = 'Stop'
$Url = if ($env:AKM_URL) { $env:AKM_URL } else { 'http://your-akm-server:3000/mcp' }
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "✗ 未找到 claude CLI（需要已安装 Claude Code）"; exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "✗ 未找到 node（https://nodejs.org 安装 LTS 版）"; exit 1
}

# ---- 1. 身份名：参数 > git email 前缀 > 纯 ASCII 的 git user.name > 机器名 ----
function Sanitize([string]$s) {
  $s = ($s -replace '\s+', '-') -replace '[^a-zA-Z0-9._-]', ''
  if ($s.Length -gt 40) { $s = $s.Substring(0, 40) }
  return ($s -replace '^[^a-zA-Z0-9]+', '')
}
if (-not $Name) {
  $gitEmail = ''
  $gitName  = ''
  try { $out = git config --get user.email 2>$null; if ($LASTEXITCODE -eq 0) { $gitEmail = "$out" } } catch {}
  try { $out = git config --get user.name  2>$null; if ($LASTEXITCODE -eq 0) { $gitName  = "$out" } } catch {}
  $raw = if ($gitEmail) { ($gitEmail -split '@')[0] } else { '' }
  if (-not $raw -or ($raw -match '[^a-zA-Z0-9._-]')) {
    # email 前缀缺失或含中文等非 ASCII → 试纯 ASCII 的 user.name，再不行用机器名
    if ($gitName -and ($gitName -notmatch '[^a-zA-Z0-9._- ]')) { $raw = $gitName }
    else { $raw = $env:COMPUTERNAME; if (-not $raw) { $raw = $env:HOSTNAME } }
  }
  $Name = Sanitize $raw
}
if ($Name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$') {
  Write-Host "✗ 身份名不合法: '$Name'（中文姓名请转拼音后显式指定：.\setup-akm-global.ps1 zhangsan）"
  exit 1
}
Write-Host "√ 身份名: $Name"

# ---- 2. 用户级 MCP server（所有项目可见）----
# Bearer 先填身份名：首次调用 MCP 工具即自动注册，服务端一次性下发 identity_token；
# 之后按 agent 提示把令牌写回这里的 Authorization（服务器配了 AKM_JOIN_SECRET 时还需 X-Join-Secret 头）
claude mcp remove team-knowledge --scope user 2>$null | Out-Null
$joinHeaders = @()
if ($env:AKM_JOIN_SECRET) {
  $joinHeaders = @('-H', "X-Join-Secret: $env:AKM_JOIN_SECRET")
  Write-Host "√ 已附加 X-Join-Secret 头（来自 AKM_JOIN_SECRET 环境变量）"
}
claude mcp add --transport http --scope user team-knowledge $Url -H "Authorization: Bearer $Name" @joinHeaders | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "✗ claude mcp add 失败"; exit 1 }
Write-Host "√ 已写入用户级 MCP server（$HomeDir\.claude.json，所有项目可用）"

# ---- 3. SessionStart hook（用户级，所有项目生效）----
$AkmDir = Join-Path $HomeDir '.akm'
New-Item -ItemType Directory -Force -Path $AkmDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'session-start-hook.cjs') (Join-Path $AkmDir 'akm-session-start.cjs') -Force

$env:AKM_HOME = $HomeDir
$mergeJs = @'
const fs = require('fs');
const p = process.env.AKM_HOME.replace(/\\/g, '/') + '/.claude/settings.json';
let s = {};
try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
s.hooks = s.hooks || {};
s.hooks.SessionStart = (s.hooks.SessionStart || []).filter(h =>
  !(h.hooks || []).some(x => String(x.command || '').includes('akm-session-start'))
);
s.hooks.SessionStart.push({
  hooks: [{ type: 'command', command: 'node ' + process.env.AKM_HOME.replace(/\\/g, '/') + '/.akm/akm-session-start.cjs' }],
});
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
'@
$mergeJs | node
if ($LASTEXITCODE -ne 0) { Write-Host "✗ settings.json 合并失败"; exit 1 }
Write-Host "√ 已写入用户级 SessionStart hook（$HomeDir\.claude\settings.json）"

# ---- 4. 全局记忆（所有项目的 agent 都读到使用约束）----
$memory = Join-Path $HomeDir '.claude\CLAUDE.md'
New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir '.claude') | Out-Null
if (-not (Test-Path $memory)) { Set-Content -Path $memory -Value '' -Encoding UTF8 }
$marker = '团队知识库（agent-knowledge-mcp）使用约束'
if (-not ((Get-Content $memory -Raw) -match [regex]::Escape($marker))) {
  $snippet = Get-Content (Join-Path $PSScriptRoot 'CLAUDE.md.snippet') -Raw
  Add-Content -Path $memory -Value "`n$snippet" -Encoding UTF8
  Write-Host "√ 已追加使用约束到 $memory"
} else {
  Write-Host "√ $memory 已含约束，跳过"
}

Write-Host ""
Write-Host "完成。重启一次 Claude Code 会话即可在本机所有项目使用知识库。"
Write-Host "注意：首次调用完成注册后，按 agent 提示把响应中的 identity_token 写回"
Write-Host "Authorization: Bearer <token>（令牌只显示一次，丢失需管理员 reset-token），再重启一次。"
Write-Host "验证：随便打开一个项目问 agent「检索一下知识库」。"
