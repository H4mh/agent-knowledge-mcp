import { describe, expect, it, beforeEach } from 'vitest';
import {
  setStatus,
  setSkillStatus,
  deleteKnowledge,
  listScopes,
  createScope,
  updateScope,
  deleteScope,
  listUsers,
  setUserEnabled,
} from '../src/admin/service.js';
import { applyMigrations, createPool } from '../src/db.js';
import { runAdmin } from '../scripts/admin.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);

beforeEach(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE knowledge, knowledge_usage, skill, skill_usage, search_event, scope_registry, app_user, entry_revision RESTART IDENTITY CASCADE');
  // 迁移里预置的 5 个 scope 随 TRUNCATE 一起没了；并行测试文件（save/admin 等）依赖它们，需重播
  await pool.query(
    `INSERT INTO scope_registry (scope, description) VALUES
       ('global', '跨项目通用知识'),
       ('demo-app', 'demo-app 产品线（人力资源系统）'),
       ('proj-a', '客户示例A（数字人事系统）'),
       ('proj-b', 'proj-b 项目'),
       ('proj-c', 'proj-c 项目')`,
  );
});

async function seedKnowledge(over: { scope?: string; title?: string } = {}) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO knowledge (title, symptom, solution, domain, scope, author)
     VALUES ($1, 'x', 'y', 'java', $2, 'seed') RETURNING id`,
    [over.title ?? '测试条目', over.scope ?? 'demo-app'],
  );
  return Number(rows[0].id);
}

async function seedScope(scope: string, over: { description?: string; enabled?: boolean } = {}) {
  await pool.query(
    `INSERT INTO scope_registry (scope, description, enabled, created_by) VALUES ($1,$2,$3,'seed')`,
    [scope, over.description ?? null, over.enabled ?? true],
  );
}

describe('admin service', () => {
  it('set-status 非法值报 INVALID_STATUS，不存在报 NOT_FOUND', async () => {
    const id = await seedKnowledge();
    await expect(setStatus(pool, id, 'foo', 'admin-cli')).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    await expect(setStatus(pool, 999999, 'verified', 'admin-cli')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('set-status 成功变更状态并刷新 updated_at', async () => {
    const id = await seedKnowledge();
    await setStatus(pool, id, 'verified', 'admin-cli');
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM knowledge WHERE id = $1', [id]);
    expect(rows[0].status).toBe('verified');
  });

  it('setStatus 写 kind=status 修订行：changes=旧状态、snapshot=更新前整行、version 不变', async () => {
    const id = await seedKnowledge();
    await setStatus(pool, id, 'verified', 'admin-cli');
    const rev = await pool.query<{
      entry_kind: string; entry_id: string; version: number; kind: string;
      changed_by: string; changes: Record<string, unknown>; snapshot: Record<string, unknown>;
    }>(
      `SELECT entry_kind, entry_id, version, kind, changed_by, changes, snapshot
       FROM entry_revision WHERE entry_kind = 'knowledge' AND entry_id = $1`,
      [id],
    );
    expect(rev.rowCount).toBe(1);
    expect(rev.rows[0]).toMatchObject({
      kind: 'status',
      changed_by: 'admin-cli',
      version: 1,
      changes: { status: 'draft' },
    });
    expect(rev.rows[0].snapshot).toMatchObject({ id: String(id), status: 'draft' });
    // version 不变（Review Focus #4：状态变更不推进版本，持旧 base_version 的 agent 不误报 CONFLICT）
    const k = await pool.query<{ version: number; status: string }>('SELECT version, status FROM knowledge WHERE id = $1', [id]);
    expect(k.rows[0]).toEqual({ version: 1, status: 'verified' });
  });

  it('deleteKnowledge 删除条目及 usage；不存在报 NOT_FOUND', async () => {
    const id = await seedKnowledge();
    await pool.query('INSERT INTO knowledge_usage (knowledge_id, used_by) VALUES ($1, $2)', [id, 'u1']);
    await deleteKnowledge(pool, id);
    const k = await pool.query('SELECT 1 FROM knowledge WHERE id = $1', [id]);
    const u = await pool.query('SELECT 1 FROM knowledge_usage WHERE knowledge_id = $1', [id]);
    expect(k.rowCount).toBe(0);
    expect(u.rowCount).toBe(0);
    await expect(deleteKnowledge(pool, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('deleteScope 有条目时拒绝（SCOPE_HAS_ENTRIES），无条目时可删', async () => {
    await seedScope('svc-a');
    await seedKnowledge({ scope: 'svc-a' });
    await expect(deleteScope(pool, 'svc-a')).rejects.toMatchObject({ code: 'SCOPE_HAS_ENTRIES' });
    await seedScope('empty-s');
    await expect(deleteScope(pool, 'empty-s')).resolves.toBeUndefined();
    await expect(deleteScope(pool, 'nope-s')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('listScopes 返回描述/启用/创建者/条目数，按 scope 排序', async () => {
    await seedScope('a-scope', { description: 'A 项目', enabled: false });
    await seedScope('b-scope');
    await seedKnowledge({ scope: 'b-scope' });
    await seedKnowledge({ scope: 'b-scope' });
    const rows = await listScopes(pool);
    // 预置的 5 个 scope 也在（global/demo-app/proj-a/b/c），只断言本用例种下的两个
    expect(rows.filter((r) => ['a-scope', 'b-scope'].includes(r.scope)).map((r) => r.scope)).toEqual(['a-scope', 'b-scope']);
    expect(rows[0]).toMatchObject({ description: 'A 项目', enabled: false, createdBy: 'seed', entryCount: 0 });
    expect(rows[1].entryCount).toBe(2);
  });

  it('createScope 非法格式 INVALID_SCOPE、重名 SCOPE_EXISTS', async () => {
    await createScope(pool, 'new-ok', '描述', 'admin');
    await expect(createScope(pool, 'bad scope!', null, 'admin')).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    await expect(createScope(pool, 'new-ok', null, 'admin')).rejects.toMatchObject({ code: 'SCOPE_EXISTS' });
  });

  it('updateScope 改描述/停用；不存在 NOT_FOUND', async () => {
    await seedScope('upd-s');
    await updateScope(pool, 'upd-s', { description: '新描述', enabled: false });
    const { rows } = await pool.query<{ description: string; enabled: boolean }>(
      'SELECT description, enabled FROM scope_registry WHERE scope = $1', ['upd-s']);
    expect(rows[0]).toEqual({ description: '新描述', enabled: false });
    await expect(updateScope(pool, 'nope-s', { enabled: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('setUserEnabled / listUsers 基本行为；不存在 NOT_FOUND', async () => {
    await pool.query(`INSERT INTO app_user (username, token_hash, role) VALUES ('alice', 'h1', 'user'), ('bob', 'h2', 'admin')`);
    await setUserEnabled(pool, 'alice', false);
    const users = await listUsers(pool);
    expect(users.map((u) => u.username)).toEqual(['alice', 'bob']);
    expect(users[0]).toMatchObject({ enabled: false, role: 'user' });
    expect(users[0]).not.toHaveProperty('token_hash');
    await expect(setUserEnabled(pool, 'nope', true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('admin CLI skill 命令（runAdmin）', () => {
  async function seedSkill(name: string, status = 'draft') {
    await pool.query(
      `INSERT INTO skill (name, description, instructions, status, author)
       VALUES ($1, '测试用 skill', '步骤说明', $2, 'seed')`,
      [name, status],
    );
  }

  it('delete-skill 硬删除 skill 及 skill_usage；不存在报 NOT_FOUND', async () => {
    const name = `del-skill-${Date.now()}`;
    await seedSkill(name);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM skill WHERE name = $1', [name]);
    await pool.query('INSERT INTO skill_usage (skill_id, used_by) VALUES ($1, $2)', [rows[0].id, 'u1']);
    const out = await runAdmin(pool, ['delete-skill', name]);
    expect(out).toContain(name);
    const s = await pool.query('SELECT 1 FROM skill WHERE name = $1', [name]);
    const u = await pool.query('SELECT 1 FROM skill_usage WHERE skill_id = $1', [rows[0].id]);
    expect(s.rowCount).toBe(0);
    expect(u.rowCount).toBe(0);
    await expect(runAdmin(pool, ['delete-skill', name])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('set-skill-status 合法值生效并刷新 updated_at', async () => {
    const name = `st-skill-${Date.now()}`;
    await seedSkill(name);
    await pool.query(`UPDATE skill SET updated_at = now() - interval '10 days' WHERE name = $1`, [name]);
    const out = await runAdmin(pool, ['set-skill-status', name, 'verified']);
    expect(out).toContain(name);
    const { rows } = await pool.query<{ status: string; updated_at: Date }>(
      'SELECT status, updated_at FROM skill WHERE name = $1', [name]);
    expect(rows[0].status).toBe('verified');
    expect(rows[0].updated_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('setSkillStatus 写 kind=status 修订行：changes=旧状态、snapshot=更新前整行、version 不变', async () => {
    const name = `rev-skill-${Date.now()}`;
    await seedSkill(name);
    await setSkillStatus(pool, name, 'verified', 'admin-cli');
    const s = await pool.query<{ id: string; status: string; version: number }>(
      'SELECT id::text id, status, version FROM skill WHERE name = $1', [name]);
    expect(s.rows[0].status).toBe('verified');
    const rev = await pool.query<{
      entry_kind: string; entry_id: string; version: number; kind: string;
      changed_by: string; changes: Record<string, unknown>; snapshot: Record<string, unknown>;
    }>(
      `SELECT entry_kind, entry_id, version, kind, changed_by, changes, snapshot
       FROM entry_revision WHERE entry_kind = 'skill' AND entry_id = $1`,
      [Number(s.rows[0].id)],
    );
    expect(rev.rowCount).toBe(1);
    expect(rev.rows[0]).toMatchObject({
      kind: 'status',
      changed_by: 'admin-cli',
      version: 1,
      changes: { status: 'draft' },
    });
    expect(rev.rows[0].snapshot).toMatchObject({ id: s.rows[0].id, status: 'draft' });
    // version 不变：状态流转不推进版本
    expect(s.rows[0].version).toBe(1);
  });

  it('set-skill-status 非法值报 INVALID_STATUS，不存在报 NOT_FOUND', async () => {
    const name = `bad-skill-${Date.now()}`;
    await seedSkill(name);
    await expect(runAdmin(pool, ['set-skill-status', name, 'foo']))
      .rejects.toMatchObject({ code: 'INVALID_STATUS' });
    await expect(runAdmin(pool, ['set-skill-status', 'no-such-skill', 'verified']))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
