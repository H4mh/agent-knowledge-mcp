import { randomBytes } from 'node:crypto';
import type { Pool } from '../db.js';
import { tokenHash } from '../auth.js';
import { ToolError, SCOPE_RE } from '../tools/save.js';
import { insertRevision } from './revisions.js';

/**
 * 管理操作共享服务：admin CLI（scripts/admin.ts）与门户 REST（src/api/routes.ts）共同调用，
 * 保证两侧语义一致（尤其 delete-scope 的"有条目不可删"校验）。
 */

const STATUSES = ['draft', 'verified', 'deprecated'];

export interface ScopeRow {
  scope: string;
  description: string | null;
  enabled: boolean;
  createdBy: string | null;
  entryCount: number;
}

export interface UserRow {
  username: string;
  role: string;
  enabled: boolean;
  createdAt: string;
}

/** FOR UPDATE 锁定行：含修订 snapshot 所需的全部列（pg BIGINT id 为 string，JSONB snapshot 保持） */
interface KnowledgeStatusRow {
  id: string;
  status: string;
  version: number;
}

/**
 * 状态变更（admin CLI / 门户 REST 共用）：写 kind='status' 修订行（changes=旧状态，snapshot=更新前整行）。
 * 事务内 FOR UPDATE 行锁 → 修订行 → UPDATE status → 提交；version 不变（状态流转不推进版本，
 * 持旧 base_version 的 agent 不应因管理员状态变更误报 CONFLICT）。非法 status 先于 DB 校验拒绝。
 */
export async function setStatus(pool: Pool, id: number, status: string, changedBy: string): Promise<void> {
  if (!STATUSES.includes(status)) {
    throw new ToolError('INVALID_STATUS', 'status 必须是 draft | verified | deprecated');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query<KnowledgeStatusRow>(
      'SELECT * FROM knowledge WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!cur.rowCount) throw new ToolError('NOT_FOUND', `条目不存在: ${id}`);
    const row = cur.rows[0];
    await insertRevision(
      client, 'knowledge', Number(row.id), row.version, 'status', changedBy,
      { status: row.status }, { ...row },
    );
    await client.query(
      'UPDATE knowledge SET status = $1, updated_at = now() WHERE id = $2',
      [status, id],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** FOR UPDATE 锁定行：含修订 snapshot 所需的全部列（pg BIGINT id 为 string） */
interface SkillStatusRow {
  id: string;
  status: string;
  version: number;
}

/**
 * skill 状态变更（admin CLI set-skill-status）：与 setStatus 同一事务形状——
 * FOR UPDATE 锁行 → kind='status' 修订行（changes=旧状态，snapshot=更新前整行）→ UPDATE status → 提交；
 * version 不变。非法 status 先于 DB 校验拒绝。
 */
export async function setSkillStatus(pool: Pool, name: string, status: string, changedBy: string): Promise<void> {
  if (!STATUSES.includes(status)) {
    throw new ToolError('INVALID_STATUS', 'status 必须是 draft | verified | deprecated');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query<SkillStatusRow>(
      'SELECT * FROM skill WHERE name = $1 FOR UPDATE',
      [name],
    );
    if (!cur.rowCount) throw new ToolError('NOT_FOUND', `skill 不存在: ${name}`);
    const row = cur.rows[0];
    await insertRevision(
      client, 'skill', Number(row.id), row.version, 'status', changedBy,
      { status: row.status }, { ...row },
    );
    await client.query(
      'UPDATE skill SET status = $1, updated_at = now() WHERE id = $2',
      [status, row.id],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteKnowledge(pool: Pool, id: number): Promise<void> {
  await pool.query('DELETE FROM knowledge_usage WHERE knowledge_id = $1', [id]);
  const { rowCount } = await pool.query('DELETE FROM knowledge WHERE id = $1', [id]);
  if (!rowCount) throw new ToolError('NOT_FOUND', `条目不存在: ${id}`);
}

export async function listScopes(pool: Pool): Promise<ScopeRow[]> {
  const { rows } = await pool.query<{
    scope: string; description: string | null; enabled: boolean; created_by: string | null; entry_count: string;
  }>(
    `SELECT r.scope, r.description, r.enabled, r.created_by, COUNT(k.id) AS entry_count
     FROM scope_registry r
     LEFT JOIN knowledge k ON k.scope = r.scope
     GROUP BY r.scope, r.description, r.enabled, r.created_by
     ORDER BY r.scope`,
  );
  return rows.map((r) => ({
    scope: r.scope,
    description: r.description,
    enabled: r.enabled,
    createdBy: r.created_by,
    entryCount: Number(r.entry_count),
  }));
}

export async function createScope(pool: Pool, scope: string, description: string | null, createdBy: string): Promise<void> {
  if (!SCOPE_RE.test(scope)) {
    throw new ToolError('INVALID_SCOPE', `scope 名不合法: ${scope}（字母/数字开头，仅含字母数字 . _ -，≤40 字符）`);
  }
  const exists = await pool.query('SELECT 1 FROM scope_registry WHERE scope = $1', [scope]);
  if (exists.rowCount) throw new ToolError('SCOPE_EXISTS', `scope 已存在: ${scope}`);
  await pool.query(
    'INSERT INTO scope_registry (scope, description, enabled, created_by) VALUES ($1, $2, true, $3)',
    [scope, description, createdBy],
  );
}

export async function updateScope(
  pool: Pool,
  scope: string,
  patch: { description?: string | null; enabled?: boolean },
): Promise<void> {
  const exists = await pool.query('SELECT 1 FROM scope_registry WHERE scope = $1', [scope]);
  if (!exists.rowCount) throw new ToolError('NOT_FOUND', `scope 不存在: ${scope}`);
  const sets: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (patch.description !== undefined) sets.push(`description = ${p(patch.description)}`);
  if (patch.enabled !== undefined) sets.push(`enabled = ${p(patch.enabled)}`);
  if (sets.length) await pool.query(`UPDATE scope_registry SET ${sets.join(', ')} WHERE scope = ${p(scope)}`, params);
}

export async function deleteScope(pool: Pool, scope: string): Promise<void> {
  const entries = await pool.query('SELECT 1 FROM knowledge WHERE scope = $1 LIMIT 1', [scope]);
  if (entries.rowCount) {
    throw new ToolError('SCOPE_HAS_ENTRIES', `scope ${scope} 下仍有知识条目，请先处理条目再删除 scope`);
  }
  const { rowCount } = await pool.query('DELETE FROM scope_registry WHERE scope = $1', [scope]);
  if (!rowCount) throw new ToolError('NOT_FOUND', `scope 不存在: ${scope}`);
}

export async function listUsers(pool: Pool): Promise<UserRow[]> {
  const { rows } = await pool.query<{ username: string; role: string; enabled: boolean; created_at: string }>(
    'SELECT username, role, enabled, created_at FROM app_user ORDER BY username',
  );
  return rows.map((r) => ({
    username: r.username,
    role: r.role,
    enabled: r.enabled,
    createdAt: r.created_at,
  }));
}

export async function setUserEnabled(pool: Pool, username: string, enabled: boolean): Promise<void> {
  const { rowCount } = await pool.query('UPDATE app_user SET enabled = $1 WHERE username = $2', [enabled, username]);
  if (!rowCount) throw new ToolError('NOT_FOUND', `用户不存在: ${username}`);
}

export interface RevisionRow {
  version: number;
  kind: string;
  changed_by: string;
  changes: Record<string, unknown>;
  created_at: string;
}

/** 重发随机访问令牌（32 位 hex）：UPDATE token_hash，返回一次性明文；用户不存在 → NOT_FOUND */
export async function resetToken(pool: Pool, username: string): Promise<string> {
  const token = randomBytes(16).toString('hex');
  const { rowCount } = await pool.query(
    'UPDATE app_user SET token_hash = $1 WHERE username = $2',
    [tokenHash(token), username],
  );
  if (!rowCount) throw new ToolError('NOT_FOUND', `用户不存在: ${username}`);
  return token;
}

/** 迁移检测：仍以"用户名本身"作为令牌的存量账号（token_hash = sha256(username)） */
export async function listLegacyUsers(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ username: string; token_hash: string }>(
    'SELECT username, token_hash FROM app_user',
  );
  return rows.filter((r) => r.token_hash === tokenHash(r.username)).map((r) => r.username);
}

/** 修订历史：skill 按 name→id 解析；created_at DESC 限 50；不含 snapshot 大字段 */
export async function listRevisions(
  pool: Pool,
  entryKind: 'knowledge' | 'skill',
  entryIdOrName: number | string,
): Promise<RevisionRow[]> {
  let entryId: number;
  if (entryKind === 'skill') {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM skill WHERE name = $1', [entryIdOrName]);
    if (!rows.length) throw new ToolError('NOT_FOUND', `skill 不存在: ${entryIdOrName}`);
    entryId = Number(rows[0].id);
  } else {
    entryId = Number(entryIdOrName);
    if (!Number.isInteger(entryId)) throw new ToolError('NOT_FOUND', `条目不存在: ${entryIdOrName}`);
    // 不校验条目存在：条目删除后修订行按 spec「供追溯」保留，history 仍应返回（修订行挂在 entry_id 上）
  }
  const { rows } = await pool.query<RevisionRow>(
    `SELECT version, kind, changed_by, changes, created_at FROM entry_revision
     WHERE entry_kind = $1 AND entry_id = $2
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
    [entryKind, entryId],
  );
  return rows;
}
