import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { applyMigrations, createPool } from '../../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);

async function seedUser(username: string, token: string, role: string, enabled = true) {
  await pool.query(
    `INSERT INTO app_user (username, token_hash, role, enabled) VALUES ($1,$2,$3,$4)
     ON CONFLICT (username) DO UPDATE SET token_hash = $2, role = $3, enabled = $4`,
    [username, createHash('sha256').update(token).digest('hex'), role, enabled],
  );
}

const app = createApp(
  loadConfig({ DATABASE_URL: url, PORT: '0', RATE_LIMIT_PER_MIN: '1000' }),
  { pool },
);
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const aliceHeaders = auth('alice-token');
const bobHeaders = auth('bob-token'); // admin

beforeAll(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE knowledge, knowledge_usage, search_event, app_user RESTART IDENTITY CASCADE');
  await seedUser('alice', 'alice-token', 'user');
  await seedUser('bob', 'bob-token', 'admin');
});

afterAll(async () => {
  // 清理本文件创建的 autoscope-admin-* 残留（含条目），否则 db.test 的"预置 5 个 scope"
  // 断言在共享测试库上会因并行时序偶发失败
  await pool.query(`DELETE FROM knowledge WHERE scope LIKE 'autoscope-admin-%'`);
  await pool.query(`DELETE FROM scope_registry WHERE scope LIKE 'autoscope-admin-%'`);
  await pool.end();
});

async function seedEntry(over: { author?: string; scope?: string } = {}) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO knowledge (title, symptom, solution, domain, scope, author)
     VALUES ('管理测试条目', '现象', '方案', 'java', $1, $2) RETURNING id`,
    [over.scope ?? 'demo-app', over.author ?? 'alice'],
  );
  return Number(rows[0].id);
}

const SCOPE = (s: string) => `autoscope-admin-${s}`;

describe('admin 端点角色矩阵', () => {
  it('user 访问全部 admin 端点 → 403', async () => {
    const id = await seedEntry();
    const checks: [string, 'GET' | 'POST' | 'PATCH' | 'DELETE', unknown][] = [
      [`/api/knowledge/${id}/status`, 'POST', { status: 'verified' }],
      [`/api/knowledge/${id}`, 'DELETE', undefined],
      ['/api/scopes', 'GET', undefined],
      ['/api/scopes', 'POST', { scope: SCOPE('x1') }],
      [`/api/scopes/${SCOPE('x1')}`, 'PATCH', { enabled: false }],
      [`/api/scopes/${SCOPE('x1')}`, 'DELETE', undefined],
      ['/api/users', 'GET', undefined],
      ['/api/users/nobody/disable', 'POST', undefined],
    ];
    for (const [url, method, payload] of checks) {
      const r = await app.inject({ method, url, headers: aliceHeaders, payload });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe('admin 知识端点', () => {
  it('status 变更：admin 生效；非法 status 400；不存在 404', async () => {
    const id = await seedEntry();
    const ok = await app.inject({ method: 'POST', url: `/api/knowledge/${id}/status`, headers: bobHeaders, payload: { status: 'verified' } });
    expect(ok.statusCode).toBe(200);
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM knowledge WHERE id = $1', [id]);
    expect(rows[0].status).toBe('verified');

    const bad = await app.inject({ method: 'POST', url: `/api/knowledge/${id}/status`, headers: bobHeaders, payload: { status: 'foo' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('INVALID_STATUS');
    const miss = await app.inject({ method: 'POST', url: '/api/knowledge/999999/status', headers: bobHeaders, payload: { status: 'draft' } });
    expect(miss.statusCode).toBe(404);
  });

  it('DELETE /api/knowledge/:id：条目与 usage 一并删除；不存在 404', async () => {
    const id = await seedEntry();
    await pool.query('INSERT INTO knowledge_usage (knowledge_id, used_by) VALUES ($1, $2)', [id, 'u1']);
    const ok = await app.inject({ method: 'DELETE', url: `/api/knowledge/${id}`, headers: bobHeaders });
    expect(ok.statusCode).toBe(200);
    expect((await pool.query('SELECT 1 FROM knowledge_usage WHERE knowledge_id = $1', [id])).rowCount).toBe(0);
    const miss = await app.inject({ method: 'DELETE', url: '/api/knowledge/999999', headers: bobHeaders });
    expect(miss.statusCode).toBe(404);
  });
});

describe('admin scope 注册表端点', () => {
  it('CRUD 全流程：GET 含 entryCount；POST/PATCH/DELETE；重名 409；有条目 409', async () => {
    const s = SCOPE('crud');
    const created = await app.inject({ method: 'POST', url: '/api/scopes', headers: bobHeaders, payload: { scope: s, description: '测试 scope' } });
    expect(created.statusCode).toBe(201);

    const dup = await app.inject({ method: 'POST', url: '/api/scopes', headers: bobHeaders, payload: { scope: s } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('SCOPE_EXISTS');

    const bad = await app.inject({ method: 'POST', url: '/api/scopes', headers: bobHeaders, payload: { scope: 'bad scope!' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('INVALID_SCOPE');

    const patched = await app.inject({ method: 'PATCH', url: `/api/scopes/${s}`, headers: bobHeaders, payload: { enabled: false, description: '改过' } });
    expect(patched.statusCode).toBe(200);

    await seedEntry({ scope: s });
    const list = await app.inject({ method: 'GET', url: '/api/scopes', headers: bobHeaders });
    expect(list.statusCode).toBe(200);
    const row = list.json().find((x: { scope: string }) => x.scope === s);
    expect(row).toMatchObject({ description: '改过', enabled: false, entryCount: 1 });

    const delBusy = await app.inject({ method: 'DELETE', url: `/api/scopes/${s}`, headers: bobHeaders });
    expect(delBusy.statusCode).toBe(409);
    expect(delBusy.json().error).toBe('SCOPE_HAS_ENTRIES');

    const empty = SCOPE('empty-del');
    await app.inject({ method: 'POST', url: '/api/scopes', headers: bobHeaders, payload: { scope: empty } });
    const del = await app.inject({ method: 'DELETE', url: `/api/scopes/${empty}`, headers: bobHeaders });
    expect(del.statusCode).toBe(200);
  });
});

describe('admin 用户端点', () => {
  it('GET /api/users 不含 token_hash；disable/enable 生效；不存在 404', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/users', headers: bobHeaders });
    expect(list.statusCode).toBe(200);
    const users = list.json();
    expect(users.length).toBeGreaterThanOrEqual(2);
    expect(users[0]).not.toHaveProperty('token_hash');

    const off = await app.inject({ method: 'POST', url: '/api/users/alice/disable', headers: bobHeaders });
    expect(off.statusCode).toBe(200);
    expect((await pool.query('SELECT enabled FROM app_user WHERE username = $1', ['alice'])).rows[0].enabled).toBe(false);
    const on = await app.inject({ method: 'POST', url: '/api/users/alice/enable', headers: bobHeaders });
    expect(on.statusCode).toBe(200);

    const miss = await app.inject({ method: 'POST', url: '/api/users/nobody/disable', headers: bobHeaders });
    expect(miss.statusCode).toBe(404);
  });
});

describe('GET /api/stats', () => {
  it('user 也能访问；结构齐全', async () => {
    await seedEntry();
    await pool.query(`INSERT INTO search_event (queried_by, query, hit_ids) VALUES ('alice', '未命中词', '{}')`);
    const r = await app.inject({ method: 'GET', url: '/api/stats', headers: aliceHeaders });
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s.byStatus).toMatchObject({ draft: expect.any(Number) });
    expect(s.byDomain).toMatchObject({ java: expect.any(Number) });
    expect(Array.isArray(s.byScope)).toBe(true);
    expect(Array.isArray(s.topUsed)).toBe(true);
    expect(s.recentMisses.some((m: { query: string }) => m.query === '未命中词')).toBe(true);
    expect(s.userCount).toBeGreaterThanOrEqual(2);
  });
});
