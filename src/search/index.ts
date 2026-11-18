import type { Pool } from '../db.js';
import type { Config } from '../config.js';
import { tokenize } from './tokenizer.js';
import type { Embedder } from '../embedding/index.js';

export interface SearchParams {
  query: string;
  domain?: string;
  scope?: string;
  /** 门户用：只返回该状态；undefined 时行为与 MCP 完全一致 */
  status?: string;
  tags?: string[];
  limit?: number;
}

export interface SearchHit {
  id: number;
  title: string;
  symptom: string;
  solution: string;
  status: string;
  scope: string;
  domain: string;
  module: string | null;
  tags: string[];
  code_ref: string | null;
  author: string;
  version: number;
  use_count: number;
  last_used_at: string | null;
  updated_at: string;
  score: number;
}

function escapeLike(s: string): string {
  return s.replace(/([%_\\])/g, '\\$1');
}

/** trigram 相似度入选门槛：完全不相关的内容相似度远低于此值 */
const TRIGRAM_THRESHOLD = 0.2;

/** 向量召回门槛：余弦距离小于此值的条目即使零关键词重叠也入选（余弦相似度 > 0.5） */
const VECTOR_RECALL_DISTANCE = 0.5;

/**
 * 混合检索：关键词/标签命中 + trigram 相似度 + verified/scope/use_count 加成；
 * 传入 embedder 时叠加向量语义分（余弦相似度），零关键词重叠的语义相关条目也可召回。
 */
export async function searchKnowledge(
  pool: Pool,
  cfg: Config,
  input: SearchParams,
  queriedBy: string,
  embedder?: Embedder,
): Promise<{ results: SearchHit[] }> {
  const limit = Math.min(input.limit ?? 10, 50);
  const tokens = tokenize(input.query);
  const w = cfg.searchWeights;

  // 查询向量化：服务不可用则静默退化为纯关键词检索
  let queryVec: string | null = null;
  if (embedder) {
    try {
      queryVec = JSON.stringify(await embedder.embed(input.query));
    } catch {
      queryVec = null;
    }
  }

  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;

  // 参数必须按 SQL 文本中的出现顺序创建：SELECT 子句（命中表达式 → query → scope）→ WHERE 过滤 → LIMIT
  const hitExpr = (col: string) =>
    tokens.length ? tokens.map((t) => `${col} ILIKE ${p('%' + escapeLike(t) + '%')}`).join(' OR ') : 'false';
  const titleHit = hitExpr('title');
  const tagsHit = tokens.length
    ? `EXISTS (SELECT 1 FROM unnest(tags) tg WHERE ${tokens.map((t) => `tg ILIKE ${p('%' + escapeLike(t) + '%')}`).join(' OR ')})`
    : 'false';
  const symptomHit = hitExpr('symptom');
  const solutionHit = hitExpr('solution');

  const qParam = p(input.query);
  const scopeParam = p(input.scope ?? null);
  // 向量参数只在实际拿到查询向量时创建，保持参数顺序与 SQL 文本一致
  const vecExpr = queryVec ? `embedding <=> ${p(queryVec)}::vector` : null;

  const filters: string[] = [];
  if (input.domain) filters.push(`domain = ${p(input.domain)}`);
  if (input.tags?.length) filters.push(`tags && ${p(input.tags)}`);
  if (input.status) filters.push(`status = ${p(input.status)}`);
  // 相关性门槛：命中字段 / trigram 达标 / 向量语义相近，三者其一即可
  const relevant = `((${titleHit}) OR (${tagsHit}) OR (${symptomHit}) OR (${solutionHit})
       OR GREATEST(similarity(title, ${qParam}), similarity(symptom, ${qParam}), similarity(solution, ${qParam})) >= ${TRIGRAM_THRESHOLD}
       ${vecExpr ? `OR (embedding IS NOT NULL AND ${vecExpr} < ${VECTOR_RECALL_DISTANCE})` : ''})`;
  filters.push(relevant);
  const limitParam = p(limit);

  const sql = `
    SELECT id, title, symptom, solution, status, scope, domain, module, tags, code_ref, author, version, use_count, last_used_at, updated_at,
           ((${titleHit})::int) * ${w.title}
         + ((${tagsHit})::int) * ${w.tags}
         + ((${symptomHit})::int) * ${w.symptom}
         + ((${solutionHit})::int) * ${w.solution}
         + ${w.trigram} * GREATEST(similarity(title, ${qParam}), similarity(symptom, ${qParam}), similarity(solution, ${qParam}))
         + CASE status WHEN 'verified' THEN ${w.verifiedBoost} WHEN 'deprecated' THEN -${w.verifiedBoost} ELSE 0 END
         + CASE WHEN ${scopeParam}::text IS NOT NULL AND scope = ${scopeParam}::text THEN ${w.scopeBoost} ELSE 0 END
         + use_count * ${w.useCountBoost}
         + ${vecExpr ? `CASE WHEN embedding IS NULL THEN 0 ELSE ${w.vector} * (1 - (${vecExpr})) END` : '0'} AS score
    FROM knowledge
    ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
    ORDER BY score DESC
    LIMIT ${limitParam}`;

  const { rows } = await pool.query<SearchHit>(sql, params);
  const hits = rows.map((r) => ({ ...r, id: Number(r.id), score: Number(r.score) }));

  await pool.query(
    `INSERT INTO search_event (queried_by, query, scope, hit_ids) VALUES ($1,$2,$3,$4)`,
    [queriedBy, input.query, input.scope ?? null, hits.map((h) => h.id)],
  );

  return { results: hits };
}
