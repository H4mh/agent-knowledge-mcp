import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { createPool, applyMigrations, migrationsDir } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);

describe('applyMigrations', () => {
  it('创建全部数据表', async () => {
    await applyMigrations(pool);
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('knowledge','knowledge_usage','scope_registry','search_event','app_user','schema_migrations')`,
    );
    expect(new Set(rows.map((r) => r.table_name))).toEqual(
      new Set(['knowledge', 'knowledge_usage', 'scope_registry', 'search_event', 'app_user', 'schema_migrations']),
    );
  });

  it('knowledge_usage 有 (knowledge_id, used_by) 唯一约束', async () => {
    await applyMigrations(pool);
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_constraint
       WHERE conrelid = 'knowledge_usage'::regclass
         AND contype = 'u'
         AND array_to_string(conkey::int[], ',') = (
           SELECT array_to_string(array_agg(attnum::int)::int[], ',')
           FROM pg_attribute
           WHERE attrelid = 'knowledge_usage'::regclass AND attnum > 0 AND attname IN ('knowledge_id','used_by')
         )`,
    );
    expect(rows.length).toBe(1);
  });

  it('knowledge.embedding 是无维度约束的 vector', async () => {
    await applyMigrations(pool);
    const { rows } = await pool.query<{ dtype: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS dtype
       FROM pg_attribute a
       WHERE a.attrelid = 'knowledge'::regclass AND a.attname = 'embedding'`,
    );
    expect(rows[0].dtype).toBe('vector');
  });

  it('scope_registry 预置 5 个 scope', async () => {
    await applyMigrations(pool);
    const { rows } = await pool.query<{ scope: string }>('SELECT scope FROM scope_registry');
    expect(rows.map((r) => r.scope).sort()).toEqual(['proj-b', 'proj-a', 'proj-c', 'global', 'demo-app'].sort());
  });

  it('knowledge.version 列存在且默认 1', async () => {
    await applyMigrations(pool);
    const { rows } = await pool.query<{ column_default: string; is_nullable: string; data_type: string }>(
      `SELECT column_default, is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'knowledge' AND column_name = 'version'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].data_type).toBe('integer');
    expect(rows[0].is_nullable).toBe('NO');
    expect(rows[0].column_default).toBe('1');
  });

  it('entry_revision 可插入 kind=content 并按 (entry_kind, entry_id) 查询', async () => {
    await applyMigrations(pool);
    await pool.query(`DELETE FROM entry_revision WHERE entry_kind = 'knowledge' AND entry_id = 0`);
    await pool.query(
      `INSERT INTO entry_revision (entry_kind, entry_id, version, kind, changed_by, changes, snapshot)
       VALUES ('knowledge', 0, 1, 'content', 'tester', '{"solution":"new"}'::jsonb, '{"solution":"old"}'::jsonb)`,
    );
    const { rows } = await pool.query<{ version: number; kind: string; changes: unknown; snapshot: unknown }>(
      `SELECT version, kind, changes, snapshot FROM entry_revision
       WHERE entry_kind = 'knowledge' AND entry_id = 0`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].kind).toBe('content');
    expect(rows[0].changes).toEqual({ solution: 'new' });
    expect(rows[0].snapshot).toEqual({ solution: 'old' });
    const { rows: idx } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_entry_revision_entry'`,
    );
    expect(idx.length).toBe(1);
    expect(idx[0].indexdef).toContain('(entry_kind, entry_id, created_at DESC)');
    await pool.query(`DELETE FROM entry_revision WHERE entry_kind = 'knowledge' AND entry_id = 0`);
  });

  it('entry_revision CHECK 约束拒绝非法 entry_kind 与 kind', async () => {
    await applyMigrations(pool);
    await expect(
      pool.query(
        `INSERT INTO entry_revision (entry_kind, entry_id, version, kind, changed_by, changes, snapshot)
         VALUES ('other', 0, 1, 'content', 'tester', '{}'::jsonb, '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/entry_revision_entry_kind_check|check constraint/i);
    await expect(
      pool.query(
        `INSERT INTO entry_revision (entry_kind, entry_id, version, kind, changed_by, changes, snapshot)
         VALUES ('knowledge', 0, 1, 'delete', 'tester', '{}'::jsonb, '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/entry_revision_kind_check|check constraint/i);
  });

  it('重复执行幂等', async () => {
    await applyMigrations(pool);
    await applyMigrations(pool);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_migrations`,
    );
    const files = readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql'));
    expect(Number(rows[0].n)).toBe(files.length);
  });
});
