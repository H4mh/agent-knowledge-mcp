import type { Pool } from '../db.js';
import type { AppUser } from '../auth.js';
import { insertRevision } from '../admin/revisions.js';
import { ToolError } from './save.js';

export interface MarkUsedInput {
  id: number;
  note?: string;
}

export interface MarkUsedResult {
  ok: true;
  status: string;
}

const PROMOTION_DISTINCT_USERS = 2;

/** 晋升修订 snapshot 所需的列（与 src/tools/update.ts 内容修订快照同一列集，不含 embedding） */
interface KnowledgeRow {
  id: string;
  version: number;
  title: string;
  symptom: string;
  solution: string;
  detail: string | null;
  tags: string[];
  code_ref: string | null;
  module: string | null;
  author: string;
  status: string;
  scope: string;
  domain: string;
}

export async function handleMarkUsed(pool: Pool, user: AppUser, input: MarkUsedInput): Promise<MarkUsedResult> {
  const entry = await pool.query<{ status: string; author: string }>(
    'SELECT status, author FROM knowledge WHERE id = $1',
    [input.id],
  );
  if (!entry.rowCount) throw new ToolError('NOT_FOUND', `条目不存在: ${input.id}`);

  // 幂等：同一用户同一条目只计一次
  const ins = await pool.query(
    `INSERT INTO knowledge_usage (knowledge_id, used_by, note)
     VALUES ($1,$2,$3)
     ON CONFLICT (knowledge_id, used_by) DO NOTHING`,
    [input.id, user.username, input.note ?? null],
  );
  if (ins.rowCount) {
    await pool.query('UPDATE knowledge SET use_count = use_count + 1, last_used_at = now() WHERE id = $1', [input.id]);
  }

  // 晋升：draft 被 ≥2 个不同（非作者）用户 mark_used → verified
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(DISTINCT used_by)::text n
     FROM knowledge_usage ku
     JOIN knowledge k ON k.id = ku.knowledge_id
     WHERE ku.knowledge_id = $1 AND ku.used_by <> k.author`,
    [input.id],
  );
  let status = entry.rows[0].status;
  if (status === 'draft' && Number(rows[0].n) >= PROMOTION_DISTINCT_USERS) {
    // 自动晋升也写修订历史：与 skill 晋升事务模板一致（src/tools/skill.ts:435）——
    // FOR UPDATE 锁行 → 复查仍 draft（并发晋升只写一次）→ kind='status' 修订行
    // （changed_by=触发晋升的标记者，changes=旧状态，snapshot=晋升前整行，version 不变）→ UPDATE → 提交
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query<KnowledgeRow>(
        `SELECT id, version, title, symptom, solution, detail, tags, code_ref, module, author, status, scope, domain
         FROM knowledge WHERE id = $1 FOR UPDATE`,
        [input.id],
      );
      if (cur.rowCount && cur.rows[0].status === 'draft') {
        const row = cur.rows[0];
        await insertRevision(
          client, 'knowledge', Number(row.id), row.version, 'status', user.username,
          { status: row.status }, { ...row },
        );
        await client.query("UPDATE knowledge SET status = 'verified' WHERE id = $1", [input.id]);
      }
      await client.query('COMMIT');
      status = 'verified';
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  return { ok: true, status };
}
