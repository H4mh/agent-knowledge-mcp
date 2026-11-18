import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { authenticate, RateLimiter, type AppUser, type AuthResult } from './auth.js';
import { handleSave, DOMAINS, ToolError, type SaveDeps } from './tools/save.js';
import { searchKnowledge } from './search/index.js';
import { handleUpdate } from './tools/update.js';
import { handleMarkUsed } from './tools/markUsed.js';
import { getContext } from './tools/context.js';
import { loadTagAliases } from './search/tags.js';
import { loadGuardRules } from './guard/index.js';
import { createEmbedder } from './embedding/index.js';
import { handleSaveSkill, handleUpdateSkill, handleGetSkill, type SkillDeps } from './tools/skill.js';
import { searchSkills } from './search/skill.js';
import { registerApiRoutes } from './api/routes.js';
import { registerSkillRoutes } from './api/skillRoutes.js';
import type { Config } from './config.js';
import type { Pool } from './db.js';

export interface AppDeps {
  pool: Pool;
}

export function createApp(cfg: Config, deps: AppDeps): FastifyInstance {
  const app = Fastify();
  // 向量检索：配置了向量模型才启用（cfg.embedding 为 undefined 时不生成 embedder，全链路退化为关键词检索）
  const embedder = cfg.embedding ? createEmbedder(cfg.embedding) : undefined;
  const toolDeps: SaveDeps = {
    aliases: loadTagAliases(join(process.cwd(), 'config', 'tag-aliases.json')),
    guardRules: loadGuardRules(join(process.cwd(), 'config', 'guard-rules.json')),
    embedder,
  };
  const limiter = new RateLimiter(cfg.rateLimitPerMin);
  // skill 工具依赖：与 SaveDeps 共享 aliases/guardRules/embedder，另带 cfg（update_skill 校验 scope）
  const skillDeps: SkillDeps = { ...toolDeps, cfg };

  const bearerOf = (header: string | string[] | undefined): string | undefined => {
    const h = Array.isArray(header) ? header[0] : header;
    return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
  };

  const buildServer = (user: AuthResult): McpServer => {
    // 首次自报注册的请求（authenticate 一次性返回 identityToken）：令牌文案同时经
    // initialize 响应的 instructions 与工具响应（含错误路径）下发——真实 MCP 客户端首请求
    // 恒为 initialize，若仅靠工具响应，令牌会随 initialize 白白烧掉
    const identityTokenText = (token: string) =>
      `[身份已注册] 访问令牌（identity_token）：${token}。请立即写入 .mcp.json 的 Authorization: Bearer <token> 并重启会话；令牌仅显示这一次。`;
    const server = new McpServer(
      { name: 'agent-knowledge-mcp', version: '0.1.0' },
      // 已注册身份不传 instructions，initialize 响应保持原样
      user.identityToken ? { instructions: identityTokenText(user.identityToken) } : undefined,
    );

    const withIdentity = (res: { content: { type: 'text'; text: string }[]; isError?: boolean }) =>
      user.identityToken
        ? {
            ...res,
            content: [
              ...res.content,
              {
                type: 'text' as const,
                text: identityTokenText(user.identityToken),
              },
            ],
          }
        : res;

    server.registerTool(
      'save_knowledge',
      {
        title: '上传结构化知识',
        description: '将踩坑经验/解决方案沉淀到团队知识库。入库为 draft 状态；若响应中列出相似条目，请优先调用 update_knowledge 补充。',
        inputSchema: {
          title: z.string(),
          symptom: z.string().describe('问题现象'),
          solution: z.string().describe('结论/解决办法'),
          detail: z.string().optional().describe('markdown 正文：排查要点、验证方法'),
          domain: z.enum(DOMAINS),
          scope: z.string().describe('适用范围，必须来自注册表（demo-app/proj-a/proj-b/proj-c/global）'),
          module: z.string().optional().describe('更细的模块路径，如 core/MicroFront'),
          tags: z.array(z.string()).default([]),
          code_ref: z.string().optional().describe('关联代码位置，如 file:line'),
        },
      },
      async (args) => {
        try {
          const r = await handleSave(deps.pool, cfg, user, args, toolDeps);
          const lines = [`已入库 #${r.id}（draft）。`];
          if (r.scopeRegistered) lines.push(`scope ${args.scope} 已自动注册（首次使用）。`);
          if (r.similar.length) {
            lines.push(
              `发现相似条目，若为同一问题请改用 update_knowledge 补充：${r.similar.map((s) => `#${s.id} ${s.title}`).join('；')}`,
            );
          }
          if (r.warnings.length) lines.push(...r.warnings);
          return withIdentity({ content: [{ type: 'text', text: lines.join('\n') }] });
        } catch (e) {
          return withIdentity(toolError(e));
        }
      },
    );

    server.registerTool(
      'search_knowledge',
      {
        title: '检索知识库',
        description: '排查问题前先检索团队知识库，返回最相关的条目。',
        inputSchema: {
          query: z.string(),
          domain: z.enum(DOMAINS).optional(),
          scope: z.string().optional(),
          tags: z.array(z.string()).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        },
      },
      async (args) => {
        const r = await searchKnowledge(deps.pool, cfg, args, user.username, embedder);
        if (!r.results.length) {
          return withIdentity({
            content: [{
              type: 'text',
              text: '未命中。若你后续解决了此问题，请调用 save_knowledge 沉淀。',
            }],
          });
        }
        return withIdentity({ content: [{ type: 'text', text: JSON.stringify(r.results, null, 2) }] });
      },
    );

    server.registerTool(
      'update_knowledge',
      {
        title: '补充/修正已有知识',
        description: '作者本人或管理员可修改条目文本字段。status 变更不受 MCP 支持，需联系管理员。',
        inputSchema: {
          id: z.number(),
          symptom: z.string().optional(),
          solution: z.string().optional(),
          detail: z.string().optional(),
          tags: z.array(z.string()).optional(),
          code_ref: z.string().optional(),
          module: z.string().optional(),
          base_version: z.number().int().optional().describe('乐观锁：调用方最后读到的 version；不符时返回版本冲突'),
          status: z.string().optional().describe('不支持：status 变更需联系管理员使用 CLI'),
        },
      },
      async (args) => {
        try {
          const r = await handleUpdate(deps.pool, user, args, toolDeps);
          return withIdentity({ content: [{ type: 'text', text: `已更新（v${r.version}）。` }] });
        } catch (e) {
          return withIdentity(toolError(e));
        }
      },
    );

    server.registerTool(
      'mark_used',
      {
        title: '标记知识帮到了我',
        description: '这条知识解决了你的问题？调用此工具帮助它积累可信度（draft 被 2 个不同用户使用后自动转 verified）。',
        inputSchema: {
          id: z.number(),
          note: z.string().optional(),
        },
      },
      async (args) => {
        try {
          const r = await handleMarkUsed(deps.pool, user, args);
          return withIdentity({ content: [{ type: 'text', text: `已记录，条目状态: ${r.status}` }] });
        } catch (e) {
          return withIdentity(toolError(e));
        }
      },
    );

    server.registerTool(
      'get_context',
      {
        title: '获取模块注意事项',
        description: '开工时调用：返回该 scope 下已验证的注意事项清单。',
        inputSchema: {
          scope: z.string(),
          module: z.string().optional(),
        },
      },
      async (args) => {
        const r = await getContext(deps.pool, args);
        return withIdentity({ content: [{ type: 'text', text: r.items.length ? JSON.stringify(r.items, null, 2) : '该 scope 暂无注意事项。' }] });
      },
    );

    server.registerTool(
      'save_skill',
      {
        title: '上传技能',
        description:
          '将可复用的操作技能沉淀到团队 skill 库（SKILL.md 安装入口由系统自动组装）。入库为 draft；若响应中列出相似 skill，请优先调用 update_skill 补充。',
        inputSchema: {
          name: z.string().describe('skill 名：小写字母/数字开头，仅含小写字母、数字、连字符，2-64 字符；即安装目录名，全局唯一'),
          description: z.string().describe('一句话说明该 skill 的用途'),
          instructions: z.string().describe('SKILL.md 正文：执行步骤与要点'),
          files: z
            .array(z.object({ path: z.string(), content: z.string() }))
            .max(20)
            .optional()
            .describe('附加文件列表（SKILL.md 为安装入口保留，不能作为附加文件）'),
          scope: z.string().optional().describe('适用范围，须为已注册 scope（skill 是共享资产，不自动注册 scope）'),
          tags: z.array(z.string()).optional().describe('标签'),
        },
      },
      async (args) => {
        try {
          const r = await handleSaveSkill(deps.pool, cfg, user, args, skillDeps);
          const lines = [`已上传 skill "${args.name}"（draft）。`];
          if (r.similar.length) {
            lines.push(
              `发现相似 skill，若为同一能力请改用 update_skill：${r.similar.map((s) => `#${s.id} ${s.name}`).join('；')}`,
            );
          }
          if (r.warnings.length) lines.push(...r.warnings);
          return withIdentity({ content: [{ type: 'text', text: lines.join('\n') }] });
        } catch (e) {
          return withIdentity(toolError(e));
        }
      },
    );

    server.registerTool(
      'search_skills',
      {
        title: '检索技能库',
        description: '需要可复用的操作技能时先检索团队 skill 库，返回最相关的 skill。',
        inputSchema: {
          query: z.string(),
          scope: z.string().optional(),
          limit: z.number().int().min(1).max(50).optional(),
        },
      },
      async (args) => {
        const r = await searchSkills(deps.pool, cfg, args, user.username, embedder);
        if (!r.results.length) {
          return withIdentity({ content: [{ type: 'text', text: '未命中可用 skill。' }] });
        }
        return withIdentity({ content: [{ type: 'text', text: JSON.stringify(r.results, null, 2) }] });
      },
    );

    server.registerTool(
      'get_skill',
      {
        title: '获取技能安装包',
        description: '返回 skill 的 SKILL.md 与附加文件，按 install 说明写入本地后重启会话生效。',
        inputSchema: {
          name: z.string().describe('skill 名'),
        },
      },
      async (args) => {
        try {
          const s = await handleGetSkill(deps.pool, user, args.name);
          return withIdentity({
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    install: `将以下文件逐一写入 ~/.claude/skills/${args.name}/（团队通用）或项目 .claude/skills/${args.name}/，然后重启会话使其生效`,
                    name: s.name,
                    description: s.description,
                    version: s.version,
                    status: s.status,
                    files: s.files,
                  },
                  null,
                  2,
                ),
              },
            ],
          });
        } catch (e) {
          return withIdentity(toolError(e));
        }
      },
    );

    server.registerTool(
      'update_skill',
      {
        title: '补充/修正已有技能',
        description: '作者本人或管理员可修改 skill 内容字段；files 提供时整体替换（删除附加文件的唯一途径）。',
        inputSchema: {
          name: z.string().describe('skill 名'),
          description: z.string().optional(),
          instructions: z.string().optional(),
          files: z
            .array(z.object({ path: z.string(), content: z.string() }))
            .max(20)
            .optional()
            .describe('附加文件列表，提供时整体替换'),
          scope: z.string().optional(),
          tags: z.array(z.string()).optional(),
          base_version: z.number().int().optional().describe('乐观锁：调用方最后读到的 version；不符时返回版本冲突'),
        },
      },
      async (args) => {
        try {
          const r = await handleUpdateSkill(deps.pool, user, args, skillDeps);
          return withIdentity({ content: [{ type: 'text', text: `已更新 skill "${args.name}"（v${r.version}）。` }] });
        } catch (e) {
          return withIdentity(toolError(e));
        }
      },
    );

    return server;
  };

  const toolError = (e: unknown) => ({
    isError: true as const,
    content: [{ type: 'text' as const, text: e instanceof ToolError ? `[${e.code}] ${e.message}` : `内部错误: ${(e as Error).message}` }],
  });

  app.post('/mcp', async (request, reply) => {
    const joinHeader = request.headers['x-join-secret'];
    const user = await authenticate(deps.pool, bearerOf(request.headers.authorization), {
      joinSecret: cfg.joinSecret,
      joinHeader: Array.isArray(joinHeader) ? joinHeader[0] : joinHeader,
    });
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    if (!limiter.allow(user.username)) return reply.code(429).send({ error: 'rate limited' });

    const server = buildServer(user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
    return reply;
  });

  // 无状态模式：不提供 SSE 长连接与会话删除
  app.get('/mcp', async (_req, reply) => reply.code(405).send({ error: 'method not allowed' }));
  app.delete('/mcp', async (_req, reply) => reply.code(405).send({ error: 'method not allowed' }));

  // 门户 REST：与 /mcp 同进程，鉴权仅校验不注册，限流共享同一实例
  registerApiRoutes(app, { pool: deps.pool, cfg, toolDeps, limiter });
  registerSkillRoutes(app, { pool: deps.pool, cfg, toolDeps, limiter });

  // 门户静态托管：web/dist 存在时托管 SPA，未匹配 GET 落回 index.html（vue-router history 模式）
  if (cfg.webDistDir && existsSync(cfg.webDistDir)) {
    // register 内部由 fastify 在 ready/listen/inject 前统一 await，无需在此等待
    app.register(fastifyStatic, { root: cfg.webDistDir });
    app.setNotFoundHandler((request, reply) => {
      const url = request.raw.url ?? '/';
      if (request.method === 'GET' && !url.startsWith('/api') && !url.startsWith('/mcp')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'NOT_FOUND' });
    });
  }

  return app;
}
