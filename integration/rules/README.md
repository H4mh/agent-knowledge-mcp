# 各 agent 工具的规则样板

知识库工具的调用格式由 MCP 协议自动下发（`tools/list` 携带参数 schema），但**何时该检索、何时该沉淀、何时该复用现成 skill、scope 怎么选**这些工作流纪律，需要写进各工具的规则文件里 agent 才会自觉遵守。

本目录按常见工具各出一份样板，内容同源（6 条纪律一致），差异仅在「身份」一条——各工具的 MCP 配置方式不同：

| 工具 | 样板文件 | 复制到（项目根目录相对路径） |
|------|----------|------------------------------|
| Claude Code | `../CLAUDE.md.snippet` | `CLAUDE.md`（追加）或由 `setup-akm.sh` 自动安装 |
| Codex CLI 等通用 agent | `AGENTS.md` | `AGENTS.md`（追加） |
| Gemini CLI | `gemini-GEMINI.md` | `GEMINI.md`（追加） |
| Cursor | `cursor-rules.mdc` | `.cursor/rules/team-knowledge.mdc` |
| Trae | `trae-project-rules.md` | `.trae/rules/project_rules.md`（追加） |
| Windsurf | `windsurf-rules.md` | `.windsurf/rules/team-knowledge.md` |
| GitHub Copilot | `copilot-instructions.md` | `.github/copilot-instructions.md`（追加） |

追加方式：文件已存在就复制粘贴到末尾；不存在就整个复制过去。

身份条款分两种（描述的都是"身份名注册 → 响应中取 identity_token 写回配置 → 重启"的令牌流程，令牌只显示一次）：

- **CLI 型**（Claude Code / Codex / Gemini CLI）：agent 自己读写 MCP 配置文件完成自配置，并在注册后把令牌写回配置
- **UI 型**（Cursor / Trae / Windsurf / Copilot）：MCP header 由用户在设置界面手动填，agent 负责提醒用户先填名字注册、注册成功后把令牌换上
