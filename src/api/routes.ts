import type { FastifyInstance } from 'fastify';
import { authenticate, RateLimiter, type AppUser } from '../auth.js';
import { ToolError, handleSave, precheckSave, type SaveDeps, type SaveInput } from '../tools/save.js';
import { handleUpdate } from '../tools/update.js';
import { handleMarkUsed } from '../tools/markUsed.js';
import { listKnowledge, getKnowledgeById, getStats, type ListParams } from './queries.js';
import {
  setStatus, deleteKnowledge, listScopes, createScope, updateScope, deleteScope,
  listUsers, setUserEnabled,
} from '../admin/service.js';
import type { Config } from '../config.js';
import type { Pool } from '../db.js';

/**
 * 门户 REST 路由（/api/*）：鉴权仅校验不注册（verifyOnly），限流与 /mcp 共享同一 RateLimiter 实例。
 * 只读 GET（knowledge 列表/详情/修订历史、stats、skills 列表/详情/修订历史）匿名可访问（限流按客户端 IP）；写操作与 admin 路由需登录。
 * 所有写操作复用既有 handler；错误体 {error: <code>, message}。
 */
export interface ApiCtx {
  pool: Pool;
  cfg: Config;
  toolDeps: SaveDeps;
  limiter: RateLimiter;
}

const UNAUTHORIZED_MESSAGE = '身份不存在：请先通过 agent 端 MCP 使用一次（首次使用自动注册），或联系管理员创建身份';

const STATUS_BY_CODE: Record<string, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SCOPE_HAS_ENTRIES: 409,
  SCOPE_EXISTS: 409,
  INVALID_STATUS: 400,
  INVALID_SCOPE: 400,
  INVALID_DOMAIN: 400,
  INVALID_INPUT: 400,
  SENSITIVE_CONTENT: 400,
  INVALID_SKILL_NAME: 400,
  INVALID_SKILL_FILE: 400,
  SKILL_EXISTS: 400,
  CONFLICT: 409,
};

export function sendError(reply: { code(code: number): { send(body: unknown): unknown } }, e: unknown): unknown {
  if (e instanceof ToolError) {
    return reply.code(STATUS_BY_CODE[e.code] ?? 500).send({ error: e.code, message: e.message });
  }
  return reply.code(500).send({ error: 'INTERNAL', message: (e as Error).message });
}

function bearerOf(header: string | string[] | undefined): string | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

/**
 * 鉴权 + 限流工厂：供 routes/skillRoutes 共用（失败已发送响应时返回 null，handler 直接 return）。
 */
export function makeRequireUser(pool: Pool, limiter: RateLimiter) {
  return async function requireUser(request: { headers: Record<string, unknown> }, reply: {
    code(code: number): { send(body: unknown): unknown };
  }): Promise<AppUser | null> {
    const user = await authenticate(pool, bearerOf(request.headers.authorization as string | undefined), { verifyOnly: true });
    if (!user) {
      reply.code(401).send({ error: 'UNAUTHORIZED', message: UNAUTHORIZED_MESSAGE });
      return null;
    }
    if (!limiter.allow(user.username)) {
      reply.code(429).send({ error: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' });
      return null;
    }
    return user;
  };
}

/**
 * 只读 GET 匿名放行守卫：无 token → 匿名通过（限流按客户端 IP，request.ip；不记录任何用户身份）；
 * 带 token → 与 requireUser 同一套校验（无效/禁用 token 仍 401，限流按用户名）。
 * 返回 null 表示响应已发送（401/429），handler 直接 return；{ user: null } 表示匿名通过。
 */
export type ReadAuth = { user: AppUser | null } | null;

export function makeReadGuard(pool: Pool, limiter: RateLimiter) {
  return async function readGuard(
    request: { headers: Record<string, unknown>; ip: string },
    reply: { code(code: number): { send(body: unknown): unknown } },
  ): Promise<ReadAuth> {
    const bearer = bearerOf(request.headers.authorization as string | undefined);
    if (!bearer) {
      if (!limiter.allow(`ip:${request.ip}`)) {
        reply.code(429).send({ error: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' });
        return null;
      }
      return { user: null };
    }
    const user = await authenticate(pool, bearer, { verifyOnly: true });
    if (!user) {
      reply.code(401).send({ error: 'UNAUTHORIZED', message: UNAUTHORIZED_MESSAGE });
      return null;
    }
    if (!limiter.allow(user.username)) {
      reply.code(429).send({ error: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' });
      return null;
    }
    return { user };
  };
}

export function registerApiRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  const { pool, cfg, toolDeps, limiter } = ctx;
  const requireUser = makeRequireUser(pool, limiter);
  const readGuard = makeReadGuard(pool, limiter);

  function requireAdmin(user: AppUser, reply: { code(code: number): { send(body: unknown): unknown } }): AppUser | null {
    if (user.role !== 'admin') {
      reply.code(403).send({ error: 'FORBIDDEN', message: '需要管理员权限' });
      return null;
    }
    return user;
  }

  function parseId(raw: string): number | null {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  function parseListParams(qs: Record<string, unknown>): ListParams | null {
    const params: ListParams = {};
    if (qs.q !== undefined) params.q = String(qs.q);
    if (qs.domain !== undefined) params.domain = String(qs.domain);
    if (qs.scope !== undefined) params.scope = String(qs.scope);
    if (qs.status !== undefined) params.status = String(qs.status);
    if (qs.tag !== undefined) params.tag = String(qs.tag);
    if (qs.page !== undefined) {
      const n = Number(qs.page);
      if (!Number.isInteger(n) || n < 1) return null;
      params.page = n;
    }
    if (qs.pageSize !== undefined) {
      const n = Number(qs.pageSize);
      if (!Number.isInteger(n) || n < 1 || n > 100) return null;
      params.pageSize = n;
    }
    return params;
  }

  app.get('/api/me', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    return { username: user.username, role: user.role };
  });

  app.get('/api/knowledge', async (request, reply) => {
    const auth = await readGuard(request, reply);
    if (!auth) return reply;
    const params = parseListParams(request.query as Record<string, unknown>);
    if (!params) {
      reply.code(400).send({ error: 'INVALID_INPUT', message: 'page/pageSize 必须是正整数，pageSize ≤ 100' });
      return reply;
    }
    // 匿名检索不落任何用户身份：queried_by 记 'anonymous'（search_event 非空列约束）
    return listKnowledge(pool, cfg, params, toolDeps.embedder, auth.user?.username ?? 'anonymous');
  });

  app.get('/api/knowledge/:id', async (request, reply) => {
    const auth = await readGuard(request, reply);
    if (!auth) return reply;
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    const k = await getKnowledgeById(pool, id);
    if (!k) return reply.code(404).send({ error: 'NOT_FOUND', message: `条目不存在: ${id}` });
    return k;
  });

  app.post('/api/knowledge/preview', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    try {
      return await precheckSave(pool, cfg, request.body as SaveInput, toolDeps);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/knowledge', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    try {
      const r = await handleSave(pool, cfg, user, request.body as SaveInput, toolDeps);
      return reply.code(201).send(r);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.put('/api/knowledge/:id', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    const body = { ...(request.body as Record<string, unknown>) };
    // 表单可达字段之外全部剥除：id/title/domain/scope/status 不经此端点修改
    for (const k of ['id', 'title', 'domain', 'scope', 'status']) delete body[k];
    try {
      const r = await handleUpdate(pool, user, { id, ...body }, toolDeps);
      // 返回新版本号：乐观锁调用方下一次 PUT 的 base_version 依赖它（与 skill PUT 响应一致）
      return { ok: true, version: r.version };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/knowledge/:id/revisions', async (request, reply) => {
    const auth = await readGuard(request, reply);
    if (!auth) return reply;
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    const exists = await pool.query('SELECT 1 FROM knowledge WHERE id = $1', [id]);
    if (!exists.rowCount) return reply.code(404).send({ error: 'NOT_FOUND', message: `条目不存在: ${id}` });
    // 修订历史轻查询：内联 SQL 直查 entry_revision（不取 snapshot），id DESC 兜底同时间戳行
    const { rows } = await pool.query<{
      version: number; kind: string; changed_by: string;
      changes: Record<string, unknown>; created_at: Date;
    }>(
      `SELECT version, kind, changed_by, changes, created_at FROM entry_revision
       WHERE entry_kind = 'knowledge' AND entry_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 50`,
      [id],
    );
    return {
      revisions: rows.map((r) => ({
        version: r.version,
        kind: r.kind,
        changedBy: r.changed_by,
        changes: r.changes,
        createdAt: r.created_at,
      })),
    };
  });

  app.post('/api/knowledge/:id/used', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    try {
      const body = (request.body ?? {}) as { note?: string };
      return await handleMarkUsed(pool, user, { id, note: body.note });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/stats', async (request, reply) => {
    const auth = await readGuard(request, reply);
    if (!auth) return reply;
    return getStats(pool);
  });

  // ---- 以下为 admin 专用端点（403 体 {error: 'FORBIDDEN'}） ----

  app.post('/api/knowledge/:id/status', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user || !requireAdmin(user, reply)) return reply;
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    try {
      await setStatus(pool, id, (request.body as { status: string }).status, user.username);
      return { ok: true };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.delete('/api/knowledge/:id', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user || !requireAdmin(user, reply)) return reply;
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    try {
      await deleteKnowledge(pool, id);
      return { ok: true };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/scopes', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user || !requireAdmin(user, reply)) return reply;
    return listScopes(pool);
  });

  app.post('/api/scopes', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user || !requireAdmin(user, reply)) return reply;
    const body = (request.body ?? {}) as { scope?: string; description?: string };
    if (!body.scope) return reply.code(400).send({ error: 'INVALID_INPUT', message: '缺少 scope' });
    try {
      await createScope(pool, body.scope, body.description ?? null, user.username);
      return reply.code(201).send({ ok: true });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.patch('/api/scopes/:scope', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user || !requireAdmin(user, reply)) return reply;
    const scope = (request.params as { scope: string }).scope;
    try {
      await updateScope(pool, scope, request.body as { description?: string | null; enabled?: boolean });
      return { ok: true };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.delete('/api/scopes/:scope', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user || !requireAdmin(user, reply)) return reply;
    const scope = (request.params as { scope: string }).scope;
    try {
      await deleteScope(pool, scope);
      return { ok: true };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/users', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user || !requireAdmin(user, reply)) return reply;
    return listUsers(pool);
  });

  app.post('/api/users/:username/disable', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user || !requireAdmin(user, reply)) return reply;
    try {
      await setUserEnabled(pool, (request.params as { username: string }).username, false);
      return { ok: true };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/users/:username/enable', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user || !requireAdmin(user, reply)) return reply;
    try {
      await setUserEnabled(pool, (request.params as { username: string }).username, true);
      return { ok: true };
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
