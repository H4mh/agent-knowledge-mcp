import type { Pool } from '../db.js';

export interface GetContextInput {
  scope: string;
  module?: string;
}

export interface ContextItem {
  id: number;
  title: string;
  solution: string;
  version: number;
}

export interface GetContextResult {
  items: ContextItem[];
}

const MAX_ITEMS = 20;

export async function getContext(pool: Pool, input: GetContextInput): Promise<GetContextResult> {
  const params: unknown[] = [input.scope];
  let moduleFilter = '';
  if (input.module) {
    params.push(input.module + '%');
    moduleFilter = 'AND module LIKE $2';
  }

  const { rows } = await pool.query<{ id: string; title: string; solution: string; status: string; version: number }>(
    `SELECT id, title, solution, status, version FROM knowledge
     WHERE scope = $1 AND status <> 'deprecated' ${moduleFilter}
     ORDER BY CASE status WHEN 'verified' THEN 0 ELSE 1 END, use_count DESC, updated_at DESC
     LIMIT ${MAX_ITEMS}`,
    params,
  );

  return { items: rows.map((r) => ({ id: Number(r.id), title: r.title, solution: r.solution, version: r.version })) };
}
