import type { FastifyInstance } from 'fastify';
import {
  handleSaveSkill, handleUpdateSkill,
  type SaveSkillInput, type UpdateSkillInput, type SkillDeps,
} from '../tools/skill.js';
import { searchSkills, type SkillHit } from '../search/skill.js';
import { makeRequireUser, makeReadGuard, sendError, type ApiCtx } from './routes.js';

/**
 * 门户 skill REST 路由（/api/skills*）：与 knowledge 路由同套鉴权（verifyOnly + 共享限流）与错误映射。
 * 列表/详情/修订历史为直查只读（匿名可访问，限流按 IP）；POST/PUT 复用 MCP handler；DELETE 为作者或 admin 直删（含 skill_usage 清理）。
 */
export interface SkillFacets {
  scopes: { value: string | null; count: number }[];
}

const SKILL_LIST_COLS =
  'id, name, description, scope, tags, status, author, version, use_count, updated_at';

function parseSkillListParams(qs: Record<string, unknown>): { q?: string; scope?: string; page: number; pageSize: number } | null {
  const params: { q?: string; scope?: string; page: number; pageSize: number } = { page: 1, pageSize: 20 };
  if (qs.q !== undefined) params.q = String(qs.q);
  if (qs.scope !== undefined) params.scope = String(qs.scope);
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

async function getSkillFacets(pool: ApiCtx['pool']): Promise<SkillFacets> {
  // scope NULL 不归并为 'global'，原样返回 null 展示值
  const { rows } = await pool.query<{ value: string | null; count: string }>(
    'SELECT scope AS value, COUNT(*) AS count FROM skill GROUP BY scope ORDER BY count DESC',
  );
  return { scopes: rows.map((r) => ({ value: r.value, count: Number(r.count) })) };
}

/** REST 手工调用守卫：files（若提供）须为 {path, content} 字符串对象数组，防止 TypeError→500 */
function isValidSkillFiles(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (f) =>
        f !== null &&
        typeof f === 'object' &&
        !Array.isArray(f) &&
        typeof (f as { path?: unknown }).path === 'string' &&
        typeof (f as { content?: unknown }).content === 'string',
    )
  );
}

export function registerSkillRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  const { pool, cfg, toolDeps, limiter } = ctx;
  const requireUser = makeRequireUser(pool, limiter);
  const readGuard = makeReadGuard(pool, limiter);
  const skillDeps: SkillDeps = { ...toolDeps, cfg };

  app.get('/api/skills', async (request, reply) => {
    const auth = await readGuard(request, reply);
    if (!auth) return reply;
    const params = parseSkillListParams(request.query as Record<string, unknown>);
    if (!params) {
      reply.code(400).send({ error: 'INVALID_INPUT', message: 'page/pageSize 必须是正整数，pageSize ≤ 100' });
      return reply;
    }
    const facets = await getSkillFacets(pool);

    // 检索模式：与 MCP search_skills 同一套混合检索（top 50，无分页，total 为 null）；匿名检索 queried_by 记 'anonymous'
    if (params.q !== undefined && params.q !== '') {
      const r = await searchSkills(pool, cfg, { query: params.q, scope: params.scope, limit: 50 }, auth.user?.username ?? 'anonymous', toolDeps.embedder);
      return { mode: 'search', items: r.results, total: null, facets };
    }

    // 浏览模式：分页列表，不打分、不记 search_event
    const where: string[] = [];
    const wp: unknown[] = [];
    const p = (v: unknown) => `$${wp.push(v)}`;
    if (params.scope) where.push(`scope = ${p(params.scope)}`);
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [countRows, rows] = await Promise.all([
      pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM skill ${whereSql}`, [...wp]),
      pool.query<Omit<SkillHit, 'score' | 'id' | 'version' | 'use_count'> & { id: string; version: string; use_count: string }>(
        `SELECT ${SKILL_LIST_COLS} FROM skill ${whereSql} ORDER BY updated_at DESC LIMIT $${wp.length + 1} OFFSET $${wp.length + 2}`,
        [...wp, params.pageSize, (params.page - 1) * params.pageSize],
      ),
    ]);
    return {
      mode: 'browse',
      items: rows.rows.map((r) => ({
        ...r,
        id: Number(r.id),
        version: Number(r.version),
        use_count: Number(r.use_count),
      })),
      total: Number(countRows.rows[0].count),
      facets,
    };
  });

  app.get('/api/skills/:name', async (request, reply) => {
    const auth = await readGuard(request, reply);
    if (!auth) return reply;
    const name = (request.params as { name: string }).name;
    // 详情直查完整行（files JSONB 原样返回，不组装 SKILL.md）：门户预览/编辑用，不计使用量
    const { rows } = await pool.query<{
      id: string; name: string; description: string; instructions: string;
      files: { path: string; content: string }[]; scope: string | null; tags: string[];
      status: string; author: string; version: string; use_count: string;
      last_used_at: string | null; created_at: string; updated_at: string;
    }>(
      `SELECT id, name, description, instructions, files, scope, tags, status, author, version, use_count, last_used_at, created_at, updated_at
       FROM skill WHERE name = $1`,
      [name],
    );
    if (!rows.length) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `skill 不存在: ${name}` });
    }
    const r = rows[0];
    return {
      ...r,
      id: Number(r.id),
      version: Number(r.version),
      use_count: Number(r.use_count),
    };
  });

  app.get('/api/skills/:name/revisions', async (request, reply) => {
    const auth = await readGuard(request, reply);
    if (!auth) return reply;
    const name = (request.params as { name: string }).name;
    // 修订历史挂在 id 上：先 name→id，skill 不存在 404（存在但无修订 → 200 空数组）
    const { rows: skillRows } = await pool.query<{ id: string }>('SELECT id FROM skill WHERE name = $1', [name]);
    if (!skillRows.length) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `skill 不存在: ${name}` });
    }
    // 修订历史轻查询：内联 SQL 直查 entry_revision（不取 snapshot），id DESC 兜底同时间戳行
    const { rows } = await pool.query<{
      version: number; kind: string; changed_by: string;
      changes: Record<string, unknown>; created_at: Date;
    }>(
      `SELECT version, kind, changed_by, changes, created_at FROM entry_revision
       WHERE entry_kind = 'skill' AND entry_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 50`,
      [Number(skillRows[0].id)],
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

  app.post('/api/skills', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const body = request.body as SaveSkillInput | undefined;
    if (body?.files !== undefined && !isValidSkillFiles(body.files)) {
      return reply.code(400).send({ error: 'INVALID_SKILL_FILE', message: 'files 须为 {path, content} 对象数组（path/content 均为字符串）' });
    }
    try {
      const r = await handleSaveSkill(pool, cfg, user, body as SaveSkillInput, skillDeps);
      return reply.code(201).send(r);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.put('/api/skills/:name', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const name = (request.params as { name: string }).name;
    if ((request.body as { files?: unknown } | null)?.files !== undefined && !isValidSkillFiles((request.body as { files: unknown }).files)) {
      return reply.code(400).send({ error: 'INVALID_SKILL_FILE', message: 'files 须为 {path, content} 对象数组（path/content 均为字符串）' });
    }
    // name 以路由参数为准，body 中同名段剥除
    const body = { ...(request.body as Record<string, unknown>), name };
    delete (body as Record<string, unknown>).id;
    try {
      return await handleUpdateSkill(pool, user, body as UpdateSkillInput, skillDeps);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.delete('/api/skills/:name', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const name = (request.params as { name: string }).name;
    const { rows } = await pool.query<{ id: number; author: string }>(
      'SELECT id, author FROM skill WHERE name = $1',
      [name],
    );
    if (!rows.length) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `skill 不存在: ${name}` });
    }
    if (user.role !== 'admin' && user.username !== rows[0].author) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: '仅作者或管理员可删除' });
    }
    await pool.query('DELETE FROM skill_usage WHERE skill_id = $1', [rows[0].id]);
    await pool.query('DELETE FROM skill WHERE id = $1', [rows[0].id]);
    return { ok: true };
  });
}
