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
  await pool.query('TRUNCATE skill, skill_usage, search_event, app_user RESTART IDENTITY CASCADE');
  await seedUser('alice', 'alice-token', 'user');
  await seedUser('bob', 'bob-token', 'admin');
  await seedUser('mallory', 'mallory-token', 'user');
});

afterAll(async () => { await pool.end(); });

async function seedSkill(over: { name?: string; author?: string; scope?: string | null; status?: string } = {}) {
  const name = over.name ?? 'seed-skill';
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO skill (name, description, instructions, files, scope, tags, status, author)
     VALUES ($1, '种子 skill 描述', '种子步骤', $2::jsonb, $3, ARRAY['seed']::text[], $4, $5)
     RETURNING id`,
    [
      name,
      JSON.stringify([{ path: 'scripts/run.sh', content: 'echo hi' }]),
      over.scope ?? null,
      over.status ?? 'draft',
      over.author ?? 'alice',
    ],
  );
  return { id: Number(rows[0].id), name };
}

describe('GET /api/skills 列表与检索', () => {
  it('browse 模式：分页列表 + total + facets.scopes；非法分页参数 400', async () => {
    await seedSkill({ name: 'browse-skill' });
    const r = await app.inject({ method: 'GET', url: '/api/skills', headers: auth('alice-token') });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.mode).toBe('browse');
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items[0]).toMatchObject({ name: expect.any(String), author: expect.any(String) });
    expect(Array.isArray(body.facets.scopes)).toBe(true);
    expect(body.facets.scopes[0]).toHaveProperty('value');
    expect(body.facets.scopes[0]).toHaveProperty('count');

    expect((await app.inject({ method: 'GET', url: '/api/skills?page=0', headers: auth('alice-token') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/skills?pageSize=200', headers: auth('alice-token') })).statusCode).toBe(400);
  });

  it('search 模式：q= 命中 name，mode=search 且 total=null', async () => {
    await seedSkill({ name: 'deploy-helper' });
    const r = await app.inject({ method: 'GET', url: '/api/skills?q=deploy', headers: auth('alice-token') });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.mode).toBe('search');
    expect(body.total).toBeNull();
    expect(body.items.some((s: { name: string }) => s.name === 'deploy-helper')).toBe(true);
  });

  it('匿名可看：未带 token GET 列表/检索 200，检索 queried_by 记 anonymous 且不产生新身份', async () => {
    const usersBefore = (await pool.query('SELECT count(*)::int AS c FROM app_user')).rows[0].c;

    const browse = await app.inject({ method: 'GET', url: '/api/skills' });
    expect(browse.statusCode).toBe(200);
    expect(browse.json().mode).toBe('browse');

    const search = await app.inject({ method: 'GET', url: '/api/skills?q=deploy' });
    expect(search.statusCode).toBe(200);
    expect(search.json().mode).toBe('search');

    const detail = await app.inject({ method: 'GET', url: '/api/skills/browse-skill' });
    expect(detail.statusCode).toBe(200);

    const usersAfter = (await pool.query('SELECT count(*)::int AS c FROM app_user')).rows[0].c;
    expect(usersAfter).toBe(usersBefore);
    const ev = (await pool.query(
      "SELECT queried_by FROM search_event WHERE kind = 'skill' ORDER BY id DESC LIMIT 1",
    )).rows[0];
    expect(ev.queried_by).toBe('anonymous');
  });

  it('匿名写操作 401：POST/PUT/DELETE /api/skills* 均拒绝', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/skills', payload: validInput });
    expect(post.statusCode).toBe(401);
    expect(post.json().error).toBe('UNAUTHORIZED');

    const put = await app.inject({ method: 'PUT', url: '/api/skills/seed-skill', payload: { description: '匿名改' } });
    expect(put.statusCode).toBe(401);

    const del = await app.inject({ method: 'DELETE', url: '/api/skills/seed-skill' });
    expect(del.statusCode).toBe(401);
  });
});

describe('GET /api/skills/:name 详情', () => {
  it('返回完整行含 files JSONB 原样（不组装 SKILL.md）；不存在 404', async () => {
    const { name } = await seedSkill({ name: 'detail-skill' });
    const r = await app.inject({ method: 'GET', url: `/api/skills/${name}`, headers: auth('alice-token') });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ name: 'detail-skill', author: 'alice', status: 'draft' });
    expect(body.files).toEqual([{ path: 'scripts/run.sh', content: 'echo hi' }]);
    expect(body.instructions).toBe('种子步骤');

    const miss = await app.inject({ method: 'GET', url: '/api/skills/no-such-skill', headers: auth('alice-token') });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error).toBe('NOT_FOUND');
  });
});

const validInput = {
  name: 'rest-new-skill',
  description: 'REST 新增 skill 描述',
  instructions: 'REST 新增步骤',
  tags: ['rest'],
};

describe('POST /api/skills', () => {
  it('201 返回 id/status/similar/warnings；同名 400 SKILL_EXISTS', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/skills', headers: auth('alice-token'), payload: validInput });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.id).toBeGreaterThan(0);
    expect(body.status).toBe('draft');
    expect(body).toHaveProperty('similar');
    expect(body).toHaveProperty('warnings');

    const dup = await app.inject({ method: 'POST', url: '/api/skills', headers: auth('alice-token'), payload: validInput });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error).toBe('SKILL_EXISTS');
  });

  it('files 非数组 / 元素缺字段 → 400 INVALID_SKILL_FILE（不入库）', async () => {
    const notArray = await app.inject({
      method: 'POST', url: '/api/skills', headers: auth('alice-token'),
      payload: { ...validInput, name: 'files-guard-a', files: 5 },
    });
    expect(notArray.statusCode).toBe(400);
    expect(notArray.json().error).toBe('INVALID_SKILL_FILE');

    const badElement = await app.inject({
      method: 'POST', url: '/api/skills', headers: auth('alice-token'),
      payload: { ...validInput, name: 'files-guard-b', files: [{ path: 1, content: 'x' }] },
    });
    expect(badElement.statusCode).toBe(400);
    expect(badElement.json().error).toBe('INVALID_SKILL_FILE');

    const count = await pool.query("SELECT count(*)::int AS c FROM skill WHERE name LIKE 'files-guard-%'");
    expect(count.rows[0].c).toBe(0);
  });
});

describe('PUT /api/skills/:name', () => {
  it('作者本人 200 返回 version+1；他人 403', async () => {
    const { name } = await seedSkill({ name: 'put-skill', author: 'alice' });
    const own = await app.inject({
      method: 'PUT', url: `/api/skills/${name}`, headers: auth('alice-token'),
      payload: { description: '作者改的描述' },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({ ok: true, version: 2 });

    const other = await app.inject({
      method: 'PUT', url: `/api/skills/${name}`, headers: auth('mallory-token'),
      payload: { description: '别人改的' },
    });
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe('FORBIDDEN');
  });

  it('files 元素非法（缺 content）→ 400 INVALID_SKILL_FILE', async () => {
    const { name } = await seedSkill({ name: 'put-files-guard', author: 'alice' });
    const r = await app.inject({
      method: 'PUT', url: `/api/skills/${name}`, headers: auth('alice-token'),
      payload: { files: [{ path: 'a.txt' }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('INVALID_SKILL_FILE');
  });
});

describe('DELETE /api/skills/:name', () => {
  it('作者本人删除 200 且行消失；非作者 403 {error:FORBIDDEN}；admin 可删；不存在 404', async () => {
    const a = await seedSkill({ name: 'del-skill-alice', author: 'alice' });
    const other = await app.inject({ method: 'DELETE', url: `/api/skills/${a.name}`, headers: auth('mallory-token') });
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe('FORBIDDEN');

    const own = await app.inject({ method: 'DELETE', url: `/api/skills/${a.name}`, headers: auth('alice-token') });
    expect(own.statusCode).toBe(200);
    expect(own.json().ok).toBe(true);
    const gone = await pool.query('SELECT 1 FROM skill WHERE name = $1', [a.name]);
    expect(gone.rowCount).toBe(0);

    const b = await seedSkill({ name: 'del-skill-bob', author: 'alice' });
    const admin = await app.inject({ method: 'DELETE', url: `/api/skills/${b.name}`, headers: auth('bob-token') });
    expect(admin.statusCode).toBe(200);

    const miss = await app.inject({ method: 'DELETE', url: '/api/skills/no-such-skill', headers: auth('bob-token') });
    expect(miss.statusCode).toBe(404);
  });
});
