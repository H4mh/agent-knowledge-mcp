import { describe, expect, it, beforeEach } from 'vitest';
import { handleMarkUsed } from '../../src/tools/markUsed.js';
import { applyMigrations, createPool } from '../../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);

const alice = { username: 'alice', role: 'user' as const };
const bob = { username: 'bob', role: 'user' as const };
const carol = { username: 'carol', role: 'user' as const };

let entryId: number;

beforeEach(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE knowledge, knowledge_usage, entry_revision RESTART IDENTITY CASCADE');
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO knowledge (title, symptom, solution, domain, scope, status, author)
     VALUES ('测试条目', '现象', '办法', 'java', 'demo-app', 'draft', 'alice') RETURNING id`,
  );
  entryId = Number(rows[0].id);
});

describe('handleMarkUsed', () => {
  it('作者自己 mark_used → 记录但不晋升', async () => {
    const r = await handleMarkUsed(pool, alice, { id: entryId });
    expect(r.status).toBe('draft');
    const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text n FROM knowledge_usage');
    expect(Number(rows[0].n)).toBe(1);
  });

  it('同用户重复 mark_used 幂等', async () => {
    await handleMarkUsed(pool, alice, { id: entryId });
    await handleMarkUsed(pool, alice, { id: entryId });
    const { rows } = await pool.query<{ n: string; uc: string }>(
      'SELECT (SELECT count(*)::text FROM knowledge_usage) n, (SELECT use_count::text FROM knowledge WHERE id=$1) uc',
      [entryId]);
    expect(Number(rows[0].n)).toBe(1);
    expect(Number(rows[0].uc)).toBe(1);
  });

  it('仅 1 个非作者用户 → 仍 draft', async () => {
    await handleMarkUsed(pool, alice, { id: entryId });
    const r = await handleMarkUsed(pool, bob, { id: entryId });
    expect(r.status).toBe('draft');
  });

  it('≥2 个非作者用户 → 晋升 verified', async () => {
    await handleMarkUsed(pool, alice, { id: entryId });
    await handleMarkUsed(pool, bob, { id: entryId });
    const r = await handleMarkUsed(pool, carol, { id: entryId });
    expect(r.status).toBe('verified');
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM knowledge WHERE id=$1', [entryId]);
    expect(rows[0].status).toBe('verified');
  });

  it('两个不同非作者 user mark_used → 晋升且写 kind=status 修订行（version 不变）', async () => {
    await handleMarkUsed(pool, bob, { id: entryId });
    const r = await handleMarkUsed(pool, carol, { id: entryId });
    expect(r.status).toBe('verified');
    // 自动晋升写修订：changed_by=触发晋升的标记者，changes=旧状态，version 不变，snapshot=晋升前整行
    const rev = await pool.query<{
      version: number; kind: string; changed_by: string;
      changes: Record<string, unknown>; snapshot: Record<string, unknown>;
    }>(
      `SELECT version, kind, changed_by, changes, snapshot
       FROM entry_revision WHERE entry_kind = 'knowledge' AND entry_id = $1`,
      [entryId],
    );
    expect(rev.rowCount).toBe(1);
    expect(rev.rows[0]).toMatchObject({
      kind: 'status',
      changed_by: 'carol',
      version: 1,
      changes: { status: 'draft' },
    });
    expect(rev.rows[0].snapshot).toMatchObject({ id: String(entryId), status: 'draft', title: '测试条目' });
    const db = await pool.query<{ version: number }>('SELECT version FROM knowledge WHERE id=$1', [entryId]);
    expect(db.rows[0].version).toBe(1);
  });

  it('已晋升后再次 mark_used → 不再写修订行（并发守卫）', async () => {
    await handleMarkUsed(pool, bob, { id: entryId });
    await handleMarkUsed(pool, carol, { id: entryId });
    const r = await handleMarkUsed(pool, bob, { id: entryId });
    expect(r.status).toBe('verified');
    const rev = await pool.query(
      `SELECT 1 FROM entry_revision WHERE entry_kind = 'knowledge' AND entry_id = $1`,
      [entryId],
    );
    expect(rev.rowCount).toBe(1);
  });
});
