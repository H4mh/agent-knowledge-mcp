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

beforeAll(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE knowledge, knowledge_usage, search_event, app_user RESTART IDENTITY CASCADE');
  await seedUser('alice', 'alice-token', 'user');
  await seedUser('bob', 'bob-token', 'admin');
  await seedUser('carol', 'carol-token', 'user', false);
});

afterAll(async () => { await pool.end(); });

async function seedEntry(over: { author?: string; scope?: string; status?: string } = {}) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO knowledge (title, symptom, solution, domain, scope, status, author)
     VALUES ('测试条目', '现象X', '方案Y', 'java', $1, $2, $3) RETURNING id`,
    [over.scope ?? 'demo-app', over.status ?? 'draft', over.author ?? 'alice'],
  );
  return Number(rows[0].id);
}

describe('REST 鉴权', () => {
  it('GET /api/me：已注册 token 200；未知 token 401 且不注册；禁用 token 401', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/me', headers: auth('alice-token') });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ username: 'alice', role: 'user' });

    const before = (await pool.query('SELECT count(*)::int AS c FROM app_user')).rows[0].c;
    const unknown = await app.inject({ method: 'GET', url: '/api/me', headers: auth('stranger-xyz') });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe('UNAUTHORIZED');
    const after = (await pool.query('SELECT count(*)::int AS c FROM app_user')).rows[0].c;
    expect(after).toBe(before);

    const disabled = await app.inject({ method: 'GET', url: '/api/me', headers: auth('carol-token') });
    expect(disabled.statusCode).toBe(401);
  });
});

describe('REST 列表与详情', () => {
  it('GET /api/knowledge 浏览：200 {mode,total,items,facets}；page=0 与 pageSize=200 → 400', async () => {
    await seedEntry();
    const r = await app.inject({ method: 'GET', url: '/api/knowledge', headers: auth('alice-token') });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.mode).toBe('browse');
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items[0]).toHaveProperty('author');
    expect(body.facets.scopes.length).toBeGreaterThanOrEqual(1);

    expect((await app.inject({ method: 'GET', url: '/api/knowledge?page=0', headers: auth('alice-token') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/knowledge?pageSize=200', headers: auth('alice-token') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/knowledge?page=abc', headers: auth('alice-token') })).statusCode).toBe(400);
  });

  it('GET /api/knowledge?q= 检索：mode=search、total=null', async () => {
    await seedEntry({ scope: 'demo-app' });
    const r = await app.inject({ method: 'GET', url: '/api/knowledge?q=%E7%8E%B0%E8%B1%A1X', headers: auth('alice-token') });
    expect(r.statusCode).toBe(200);
    expect(r.json().mode).toBe('search');
    expect(r.json().total).toBeNull();
    expect(r.json().items.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/knowledge/:id：存在 200 含 detail；不存在 404；id=abc 404', async () => {
    const id = await seedEntry({ author: 'alice' });
    const r = await app.inject({ method: 'GET', url: `/api/knowledge/${id}`, headers: auth('alice-token') });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ detail: null, author: 'alice' });
    expect((await app.inject({ method: 'GET', url: '/api/knowledge/999999', headers: auth('alice-token') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/knowledge/abc', headers: auth('alice-token') })).statusCode).toBe(404);
  });
});

const validInput = {
  title: 'REST 新增条目',
  symptom: 'REST 现象',
  solution: 'REST 方案',
  domain: 'java',
  scope: 'demo-app',
  tags: ['rest'],
};

describe('REST 新增/预检', () => {
  it('POST /api/knowledge：201 返回 id/similar/warnings；敏感内容 400 SENSITIVE_CONTENT', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/knowledge', headers: auth('alice-token'), payload: validInput });
    expect(r.statusCode).toBe(201);
    expect(r.json().id).toBeGreaterThan(0);
    expect(r.json()).toHaveProperty('similar');
    expect(r.json()).toHaveProperty('warnings');

    const bad = await app.inject({
      method: 'POST', url: '/api/knowledge', headers: auth('alice-token'),
      payload: { ...validInput, solution: '私钥 -----BEGIN RSA PRIVATE KEY----- xx' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('SENSITIVE_CONTENT');
  });

  it('POST /api/knowledge/preview：dry-run 不入库', async () => {
    const before = (await pool.query('SELECT count(*)::int AS c FROM knowledge')).rows[0].c;
    const r = await app.inject({
      method: 'POST', url: '/api/knowledge/preview', headers: auth('alice-token'),
      payload: { ...validInput, title: '预检条目', solution: '预检方案', scope: 'autoscope-prev1' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().scopeWillRegister).toBe(true);
    const after = (await pool.query('SELECT count(*)::int AS c FROM knowledge')).rows[0].c;
    expect(after).toBe(before);
  });
});

describe('REST 编辑与 mark_used', () => {
  it('PUT /api/knowledge/:id：作者本人 200；他人 403；admin 任意 200', async () => {
    const id = await seedEntry({ author: 'alice' });
    const own = await app.inject({
      method: 'PUT', url: `/api/knowledge/${id}`, headers: auth('alice-token'),
      payload: { solution: '作者改的方案' },
    });
    expect(own.statusCode).toBe(200);

    await seedUser('mallory', 'mallory-token', 'user');
    const other = await app.inject({
      method: 'PUT', url: `/api/knowledge/${id}`, headers: auth('mallory-token'),
      payload: { solution: '别人改的' },
    });
    expect(other.statusCode).toBe(403);

    const admin = await app.inject({
      method: 'PUT', url: `/api/knowledge/${id}`, headers: auth('bob-token'),
      payload: { solution: '管理员改的', status: 'verified' },
    });
    expect(admin.statusCode).toBe(200);
    const { rows } = await pool.query<{ solution: string; status: string }>(
      'SELECT solution, status FROM knowledge WHERE id = $1', [id]);
    expect(rows[0].solution).toBe('管理员改的');
    expect(rows[0].status).toBe('draft'); // status 不经 PUT 生效
  });

  it('POST /api/knowledge/:id/used：200 返回状态；不存在 404', async () => {
    const id = await seedEntry({ author: 'bob' });
    const r = await app.inject({ method: 'POST', url: `/api/knowledge/${id}/used`, headers: auth('alice-token'), payload: { note: '有用' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBeTruthy();
    const miss = await app.inject({ method: 'POST', url: '/api/knowledge/999999/used', headers: auth('alice-token') });
    expect(miss.statusCode).toBe(404);
  });
});

describe('限流', () => {
  it('RATE_LIMIT_PER_MIN=2 时第 3 次 429', async () => {
    const tight = createApp(loadConfig({ DATABASE_URL: url, PORT: '0', RATE_LIMIT_PER_MIN: '2' }), { pool });
    await seedUser('ratelimit-u', 'ratelimit-token', 'user');
    const codes = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await tight.inject({ method: 'GET', url: '/api/me', headers: auth('ratelimit-token') })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
  });

  it('匿名只读同样受限流：RATE_LIMIT_PER_MIN=2 时第 3 次匿名 GET 429（按 IP 计数）', async () => {
    const tight = createApp(loadConfig({ DATABASE_URL: url, PORT: '0', RATE_LIMIT_PER_MIN: '2' }), { pool });
    const codes = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await tight.inject({ method: 'GET', url: '/api/stats' })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
  });
});

describe('匿名只读访问', () => {
  it('匿名 GET /api/knowledge、/api/knowledge/:id、/api/stats 均 200；检索 queried_by 记 anonymous 且不产生新身份', async () => {
    const id = await seedEntry();
    const usersBefore = (await pool.query('SELECT count(*)::int AS c FROM app_user')).rows[0].c;

    const list = await app.inject({ method: 'GET', url: '/api/knowledge' });
    expect(list.statusCode).toBe(200);
    expect(list.json().mode).toBe('browse');

    const search = await app.inject({ method: 'GET', url: '/api/knowledge?q=%E7%8E%B0%E8%B1%A1X' });
    expect(search.statusCode).toBe(200);
    expect(search.json().mode).toBe('search');

    const detail = await app.inject({ method: 'GET', url: `/api/knowledge/${id}` });
    expect(detail.statusCode).toBe(200);

    const stats = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(stats.statusCode).toBe(200);

    const usersAfter = (await pool.query('SELECT count(*)::int AS c FROM app_user')).rows[0].c;
    expect(usersAfter).toBe(usersBefore);
    const ev = (await pool.query(
      "SELECT queried_by FROM search_event WHERE kind = 'knowledge' ORDER BY id DESC LIMIT 1",
    )).rows[0];
    expect(ev.queried_by).toBe('anonymous');
  });

  it('匿名写操作 401：POST/PUT/DELETE /api/knowledge* 与 preview 均拒绝', async () => {
    const id = await seedEntry();
    const post = await app.inject({ method: 'POST', url: '/api/knowledge', payload: validInput });
    expect(post.statusCode).toBe(401);
    expect(post.json().error).toBe('UNAUTHORIZED');

    const preview = await app.inject({ method: 'POST', url: '/api/knowledge/preview', payload: validInput });
    expect(preview.statusCode).toBe(401);

    const put = await app.inject({ method: 'PUT', url: `/api/knowledge/${id}`, payload: { solution: '匿名改' } });
    expect(put.statusCode).toBe(401);

    const del = await app.inject({ method: 'DELETE', url: `/api/knowledge/${id}` });
    expect(del.statusCode).toBe(401);

    const used = await app.inject({ method: 'POST', url: `/api/knowledge/${id}/used`, payload: {} });
    expect(used.statusCode).toBe(401);
  });

  it('无效 token 在只读端点仍 401（不降级为匿名）', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/knowledge', headers: auth('stranger-xyz') });
    expect(r.statusCode).toBe(401);
  });
});
