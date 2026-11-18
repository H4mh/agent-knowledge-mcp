import type { PoolClient } from 'pg';

export type RevisionKind = 'content' | 'status';

/**
 * 修订记录：必须在事务内调用（client 为事务内连接，模板见 src/db.ts:44），
 * 与主表 UPDATE 同事务提交，保证「修订行存在 ⇔ 该版本变更存在」。
 * snapshot 为该版本变更前的整行 JSON，changes 为本次变更字段的旧值。
 */
export async function insertRevision(
  client: PoolClient,
  entryKind: 'knowledge' | 'skill',
  entryId: number,
  version: number,
  kind: RevisionKind,
  changedBy: string,
  changes: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO entry_revision (entry_kind, entry_id, version, kind, changed_by, changes, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [entryKind, entryId, version, kind, changedBy, JSON.stringify(changes), JSON.stringify(snapshot)],
  );
}
