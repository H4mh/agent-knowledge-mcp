# Cursor 接入示例

Cursor → Settings → MCP → Add new MCP server：

- Name: `team-knowledge`
- Type: `HTTP`
- URL: `http://your-akm-server:3000/mcp`
- Headers:
  ```json
  { "Authorization": "Bearer <你的身份名，如 zhangsan>" }
  ```

> 注意：Cursor 无法像 Claude Code 那样让 agent 自动改写自己的 MCP 配置，身份名需要人工填一次（先到先得，建议用真实可辨识的名字；中文姓名请用拼音）。身份名只用于首次注册：**首次调用成功后，把响应中的 `identity_token` 换到 Bearer 后面**（令牌只显示这一次，丢失需管理员 reset-token）；若服务器启用了 `AKM_JOIN_SECRET`，还需加 header `{ "X-Join-Secret": "<团队口令>" }`。

接入后建议在项目 `.cursor/rules` 中加入与 `CLAUDE.md.snippet` 相同的使用约束（先查后传），并把其中「身份自配置」一条删掉（对 Cursor 不适用）。
