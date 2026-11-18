import type { Pool } from '../db.js';
import type { Config } from '../config.js';
import { tokenize } from './tokenizer.js';
import type { Embedder } from '../embedding/index.js';

export interface SkillSearchParams {
  query: string;
  scope?: string;
  limit?: number;
}

export interface SkillHit {
  id: number;
  name: string;
  description: string;
  status: string;
  scope: string | null;
  tags: string[];
  author: string;
  version: number;
  use_count: number;
  updated_at: string;
  score: number;
}

function escapeLike(s: string): string {
  return s.replace(/([%_\\])/g, '\\$1');
}

/** trigram 相似度入选门槛：完全不相关的内容相似度远低于此值（与 knowledge 检索同值） */
const TRIGRAM_THRESHOLD = 0.2;

/** 向量召回门槛：余弦距离小于此值的条目即使零关键词重叠也入选（与 knowledge 检索同值） */
const VECTOR_RECALL_DISTANCE = 0.5;

/**
 * skill 混合检索：关键词/标签命中 + trigram 相似度 + verified/scope/use_count 加成；
 * 传入 embedder 时叠加向量语义分（余弦相似度），零关键词重叠的语义相关 skill 也可召回。
 * 检索文本为 name、description、instructions 三列（instructions 与 knowledge 检索的 solution 正文同权重槽）。
 */
export async function searchSkills(
  pool: Pool,
  cfg: Config,
  input: SkillSearchParams,
  queriedBy: string,
  embedder?: Embedder,
): Promise<{ results: SkillHit[] }> {
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
  const nameHit = hitExpr('name');
  const tagsHit = tokens.length
    ? `EXISTS (SELECT 1 FROM unnest(tags) tg WHERE ${tokens.map((t) => `tg ILIKE ${p('%' + escapeLike(t) + '%')}`).join(' OR ')})`
    : 'false';
  const descHit = hitExpr('description');
  const insHit = hitExpr('instructions');

  const qParam = p(input.query);
  const scopeParam = p(input.scope ?? null);
  // 向量参数只在实际拿到查询向量时创建，保持参数顺序与 SQL 文本一致
  const vecExpr = queryVec ? `embedding <=> ${p(queryVec)}::vector` : null;

  const filters: string[] = [];
  // 相关性门槛：命中字段 / trigram 达标 / 向量语义相近，三者其一即可
  const relevant = `((${nameHit}) OR (${tagsHit}) OR (${descHit}) OR (${insHit})
       OR GREATEST(similarity(name, ${qParam}), similarity(description, ${qParam}), similarity(instructions, ${qParam})) >= ${TRIGRAM_THRESHOLD}
       ${vecExpr ? `OR (embedding IS NOT NULL AND ${vecExpr} < ${VECTOR_RECALL_DISTANCE})` : ''})`;
  filters.push(relevant);
  const limitParam = p(limit);

  const sql = `
    SELECT id, name, description, status, scope, tags, author, version, use_count, updated_at,
           ((${nameHit})::int) * ${w.title}
         + ((${tagsHit})::int) * ${w.tags}
         + ((${descHit})::int) * ${w.symptom}
         + ((${insHit})::int) * ${w.solution}
         + ${w.trigram} * GREATEST(similarity(name, ${qParam}), similarity(description, ${qParam}), similarity(instructions, ${qParam}))
         + CASE status WHEN 'verified' THEN ${w.verifiedBoost} ELSE 0 END
         + CASE WHEN ${scopeParam}::text IS NOT NULL AND scope = ${scopeParam}::text THEN ${w.scopeBoost} ELSE 0 END
         + use_count * ${w.useCountBoost}
         + ${vecExpr ? `CASE WHEN embedding IS NULL THEN 0 ELSE ${w.vector} * (1 - (${vecExpr})) END` : '0'} AS score
    FROM skill
    ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
    ORDER BY score DESC
    LIMIT ${limitParam}`;

  const { rows } = await pool.query<SkillHit>(sql, params);
  const hits = rows.map((r) => ({ ...r, id: Number(r.id), version: Number(r.version), use_count: Number(r.use_count), score: Number(r.score) }));

  await pool.query(
    `INSERT INTO search_event (queried_by, query, scope, hit_ids, kind) VALUES ($1,$2,$3,$4,'skill')`,
    [queriedBy, input.query, input.scope ?? null, hits.map((h) => h.id)],
  );

  return { results: hits };
}
