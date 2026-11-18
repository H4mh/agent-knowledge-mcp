import type { Pool } from '../db.js';
import type { Config } from '../config.js';
import { searchKnowledge, type SearchHit } from '../search/index.js';
import type { Embedder } from '../embedding/index.js';

/**
 * 门户 REST 只读查询层：浏览列表 / 详情 / facets / 统计。
 * 写操作不在此层（复用 handleSave/handleUpdate/admin service）。
 */

export interface ListParams {
  q?: string;
  domain?: string;
  scope?: string;
  status?: string;
  tag?: string;
  page?: number;
  pageSize?: number;
}

export interface ListItem {
  id: number;
  title: string;
  symptom: string;
  solution: string;
  status: string;
  scope: string;
  domain: string;
  module: string | null;
  tags: string[];
  author: string;
  version: number;
  use_count: number;
  last_used_at: string | null;
  updated_at: string;
}

export interface Facets {
  domains: { value: string; count: number }[];
  scopes: { value: string; count: number }[];
}

export type KnowledgeRow = ListItem & {
  detail: string | null;
  code_ref: string | null;
  created_at: string;
  score?: number;
};

export interface Stats {
  byStatus: Record<string, number>;
  byDomain: Record<string, number>;
  byScope: { value: string; count: number }[];
  topUsed: { id: number; title: string; use_count: number }[];
  recentMisses: { query: string; count: number }[];
  userCount: number;
}

/** 列表摘要截断：详情正文只在详情接口返回 */
function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function toListItem(r: {
  id: number | string; title: string; symptom: string; solution: string; status: string;
  scope: string; domain: string; module: string | null; tags: string[];
  author: string; version: number; use_count: number | string; last_used_at: string | null; updated_at: string;
}): ListItem {
  return {
    id: Number(r.id),
    title: r.title,
    symptom: truncate(r.symptom),
    solution: truncate(r.solution),
    status: r.status,
    scope: r.scope,
    domain: r.domain,
    module: r.module,
    tags: r.tags,
    author: r.author,
    version: r.version,
    use_count: Number(r.use_count),
    last_used_at: r.last_used_at,
    updated_at: r.updated_at,
  };
}

const LIST_COLS = 'id, title, symptom, solution, status, scope, domain, module, tags, author, version, use_count, last_used_at, updated_at';

export async function getFacets(pool: Pool): Promise<Facets> {
  const [d, s] = await Promise.all([
    pool.query<{ value: string; count: string }>('SELECT domain AS value, COUNT(*) AS count FROM knowledge GROUP BY domain ORDER BY count DESC'),
    pool.query<{ value: string; count: string }>('SELECT scope AS value, COUNT(*) AS count FROM knowledge GROUP BY scope ORDER BY count DESC'),
  ]);
  return {
    domains: d.rows.map((r) => ({ value: r.value, count: Number(r.count) })),
    scopes: s.rows.map((r) => ({ value: r.value, count: Number(r.count) })),
  };
}

export async function listKnowledge(
  pool: Pool,
  cfg: Config,
  params: ListParams,
  embedder?: Embedder,
  queriedBy = 'portal',
): Promise<{ mode: 'search' | 'browse'; items: ListItem[]; total: number | null; facets: Facets }> {
  const facets = await getFacets(pool);

  // 检索模式：与 MCP search 同一套打分与向量召回，top 50，无分页
  if (params.q !== undefined && params.q !== '') {
    const r = await searchKnowledge(
      pool, cfg,
      {
        query: params.q,
        domain: params.domain,
        scope: params.scope,
        status: params.status,
        tags: params.tag ? [params.tag] : undefined,
        limit: 50,
      },
      queriedBy,
      embedder,
    );
    return {
      mode: 'search',
      items: r.results.map((h: SearchHit) => ({
        ...toListItem(h),
        score: h.score,
      })),
      total: null,
      facets,
    };
  }

  // 浏览模式：纯过滤分页列表，不打分、不记 search_event
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  const where: string[] = [];
  const wp: unknown[] = [];
  const p = (v: unknown) => `$${wp.push(v)}`;
  if (params.domain) where.push(`domain = ${p(params.domain)}`);
  if (params.scope) where.push(`scope = ${p(params.scope)}`);
  if (params.status) where.push(`status = ${p(params.status)}`);
  if (params.tag) where.push(`tags @> ARRAY[${p(params.tag)}]::text[]`);

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const whereParams = [...wp]; // count 查询不带 LIMIT/OFFSET 参数，先快照
  const rowsSql =
    `SELECT ${LIST_COLS} FROM knowledge ${whereSql} ORDER BY updated_at DESC LIMIT $${wp.length + 1} OFFSET $${wp.length + 2}`;
  const [countRows, rows] = await Promise.all([
    pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM knowledge ${whereSql}`, whereParams),
    pool.query<Omit<ListItem, 'id' | 'use_count'> & { id: string; use_count: string }>(
      rowsSql, [...wp, pageSize, (page - 1) * pageSize],
    ),
  ]);
  return {
    mode: 'browse',
    items: rows.rows.map(toListItem),
    total: Number(countRows.rows[0].count),
    facets,
  };
}

export async function getKnowledgeById(pool: Pool, id: number): Promise<KnowledgeRow | null> {
  const { rows } = await pool.query<
    Omit<KnowledgeRow, 'id' | 'use_count' | 'score'> & { id: string; use_count: string }
  >(
    `SELECT ${LIST_COLS}, detail, code_ref, created_at FROM knowledge WHERE id = $1`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { ...toListItem(r), detail: r.detail, code_ref: r.code_ref, created_at: r.created_at, symptom: r.symptom, solution: r.solution };
}

export async function getStats(pool: Pool): Promise<Stats> {
  const [byStatus, byDomain, byScope, topUsed, misses, users] = await Promise.all([
    pool.query<{ status: string; count: string }>('SELECT status, COUNT(*) AS count FROM knowledge GROUP BY status'),
    pool.query<{ domain: string; count: string }>('SELECT domain, COUNT(*) AS count FROM knowledge GROUP BY domain'),
    pool.query<{ scope: string; count: string }>('SELECT scope, COUNT(*) AS count FROM knowledge GROUP BY scope ORDER BY count DESC LIMIT 10'),
    pool.query<{ id: string; title: string; use_count: string | number }>(
      'SELECT id, title, use_count FROM knowledge ORDER BY use_count DESC, id LIMIT 10'),
    pool.query<{ query: string; count: string }>(
      `SELECT query, COUNT(*) AS count FROM search_event
       WHERE hit_ids = '{}' AND created_at >= now() - interval '30 days'
       GROUP BY query ORDER BY count DESC, query LIMIT 10`),
    pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM app_user'),
  ]);
  const toRecord = (rows: { k: string; count: string }[]) =>
    Object.fromEntries(rows.map((r) => [r.k, Number(r.count)]));
  return {
    byStatus: toRecord(byStatus.rows.map((r) => ({ k: r.status, count: r.count }))),
    byDomain: toRecord(byDomain.rows.map((r) => ({ k: r.domain, count: r.count }))),
    byScope: byScope.rows.map((r) => ({ value: r.scope, count: Number(r.count) })),
    topUsed: topUsed.rows.map((r) => ({ id: Number(r.id), title: r.title, use_count: Number(r.use_count) })),
    recentMisses: misses.rows.map((r) => ({ query: r.query, count: Number(r.count) })),
    userCount: Number(users.rows[0].count),
  };
}
