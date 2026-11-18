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
  // entry_revision 无外键，CASCADE 不会连带清空，须显式 TRUNCATE
  await pool.query(
    'TRUNCATE knowledge, skill, knowledge_usage, skill_usage, search_event, entry_revision, app_user RESTART IDENTITY CASCADE',
  );
  await seedUser('alice', 'alice-token', 'user');
  await seedUser('bob', 'bob-token', 'admin');
});

afterAll(async () => { await pool.end(); });

async function seedEntry(over: { author?: string } = {}) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO knowledge (title, symptom, solution, domain, scope, status, author)
     VALUES ('修订测试条目', '修订现象', '方案Y', 'java', 'rev-demo', 'draft', $1) RETURNING id`,
    [over.author ?? 'alice'],
  );
  return Number(rows[0].id);
}

async function seedSkill(name: string, over: { author?: string } = {}) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO skill (name, description, instructions, files, scope, tags, status, author)
     VALUES ($1, $2, '种子步骤', $3::jsonb, null, ARRAY['seed']::text[], 'draft', $4)
     RETURNING id`,
    [name, `${name} 的旧描述`, JSON.stringify([{ path: 'scripts/run.sh', content: 'echo hi' }]), over.author ?? 'alice'],
  );
  return { id: Number(rows[0].id), name };
}

/** 把指定 entry 的修订行 created_at 固定为互不相同的确定性时间戳（便于断言 DESC 排序） */
async function pinRevisionTimes(entryKind: 'knowledge' | 'skill', entryId: number, times: string[]) {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM entry_revision WHERE entry_kind = $1 AND entry_id = $2 ORDER BY id',
    [entryKind, entryId],
  );
  expect(rows.length).toBe(times.length);
  for (let i = 0; i < rows.length; i++) {
    await pool.query('UPDATE entry_revision SET created_at = $1::timestamptz WHERE id = $2', [times[i], rows[i].id]);
  }
}

describe('REST PUT 放行 base_version（乐观锁）', () => {
  it('a) PUT /api/knowledge/:id 带正确 base_version 更新成功 version+1；过期 base_version → 409 CONFLICT', async () => {
    const id = await seedEntry({ author: 'alice' });
    const ok = await app.inject({
      method: 'PUT', url: `/api/knowledge/${id}`, headers: auth('alice-token'),
      payload: { solution: 'v2方案', base_version: 1 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, version: 2 });

    // 过期乐观锁：REST 侧报 409 CONFLICT（非 500 INTERNAL）
    const stale = await app.inject({
      method: 'PUT', url: `/api/knowledge/${id}`, headers: auth('alice-token'),
      payload: { solution: '过期修改', base_version: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('CONFLICT');
    const { rows } = await pool.query<{ solution: string; version: number }>(
      'SELECT solution, version FROM knowledge WHERE id = $1', [id]);
    expect(rows[0].solution).toBe('v2方案'); // 主表未被过期请求修改
    expect(rows[0].version).toBe(2);
  });

  it('a2) PUT /api/skills/:name 带正确 base_version 更新成功 version+1；过期 → 409 CONFLICT', async () => {
    const { name } = await seedSkill('rev-put-skill', { author: 'alice' });
    const ok = await app.inject({
      method: 'PUT', url: `/api/skills/${name}`, headers: auth('alice-token'),
      payload: { description: '新描述', base_version: 1 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, version: 2 });

    const stale = await app.inject({
      method: 'PUT', url: `/api/skills/${name}`, headers: auth('alice-token'),
      payload: { description: '过期修改', base_version: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('CONFLICT');
    const { rows } = await pool.query<{ description: string }>(
      'SELECT description FROM skill WHERE name = $1', [name]);
    expect(rows[0].description).toBe('新描述');
  });
});

describe('GET /api/knowledge/:id/revisions', () => {
  it('b) 匿名 200：created_at DESC 排序、camelCase 字段、不含 snapshot', async () => {
    const id = await seedEntry({ author: 'alice' });
    // 两次内容修订（v1→v2→v3）+ 一次状态修订（version 不变）
    await app.inject({
      method: 'PUT', url: `/api/knowledge/${id}`, headers: auth('alice-token'),
      payload: { solution: 'v2方案', base_version: 1 },
    });
    await app.inject({
      method: 'PUT', url: `/api/knowledge/${id}`, headers: auth('alice-token'),
      payload: { solution: 'v3方案', base_version: 2 },
    });
    await app.inject({
      method: 'POST', url: `/api/knowledge/${id}/status`, headers: auth('bob-token'),
      payload: { status: 'verified' },
    });

    // 固定时间戳：插入序 r1<r2<r3，但 created_at 令 r1 最新（DESC 排序应得插入序）
    await pinRevisionTimes('knowledge', id, [
      '2026-11-17 10:03:00+08', '2026-11-17 10:02:00+08', '2026-11-17 10:01:00+08',
    ]);

    const r = await app.inject({ method: 'GET', url: `/api/knowledge/${id}/revisions` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Object.keys(body)).toEqual(['revisions']);
    expect(body.revisions.length).toBe(3);

    // 排序：created_at DESC → [v1 content, v2 content, v3 status]（插入序）
    expect(body.revisions.map((x: { version: number; kind: string }) => `${x.version}/${x.kind}`))
      .toEqual(['1/content', '2/content', '3/status']);

    // camelCase 键，无 snapshot、无 snake_case 泄漏；changes 为 JSONB 对象原样
    expect(Object.keys(body.revisions[0]).sort()).toEqual(['changedBy', 'changes', 'createdAt', 'kind', 'version']);
    expect(body.revisions[0].changes).toEqual({ solution: '方案Y' });
    expect(body.revisions[0].changedBy).toBe('alice');
    expect(body.revisions[2].kind).toBe('status');
    expect(body.revisions[2].changes).toEqual({ status: 'draft' });
    expect(body.revisions[2].changedBy).toBe('bob');
    expect(typeof body.revisions[0].createdAt).toBe('string');
    expect(body.revisions[0]).not.toHaveProperty('snapshot');
    expect(body.revisions[0]).not.toHaveProperty('changed_by');
  });

  it('c) 不存在条目 404；存在但无修订 200 空数组；id 非法 404', async () => {
    const miss = await app.inject({ method: 'GET', url: '/api/knowledge/999999/revisions' });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error).toBe('NOT_FOUND');

    const fresh = await seedEntry({ author: 'alice' });
    const empty = await app.inject({ method: 'GET', url: `/api/knowledge/${fresh}/revisions` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ revisions: [] });

    expect((await app.inject({ method: 'GET', url: '/api/knowledge/abc/revisions' })).statusCode).toBe(404);
  });

  it('e) 带非法 token 仍 401（不降级为匿名）', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/knowledge/1/revisions', headers: auth('stranger-xyz') });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('UNAUTHORIZED');
  });
});

describe('GET /api/skills/:name/revisions', () => {
  it('d) skill 同名两项各自解析：name→id 精确，修订互不串；匿名 200', async () => {
    const a = await seedSkill('rev-skill-a', { author: 'alice' });
    const b = await seedSkill('rev-skill-b', { author: 'alice' });
    await app.inject({
      method: 'PUT', url: `/api/skills/${a.name}`, headers: auth('alice-token'),
      payload: { description: 'A 的新描述', base_version: 1 },
    });
    await app.inject({
      method: 'PUT', url: `/api/skills/${b.name}`, headers: auth('alice-token'),
      payload: { description: 'B 的新描述', base_version: 1 },
    });
    await pinRevisionTimes('skill', a.id, ['2026-11-17 11:00:00+08']);
    await pinRevisionTimes('skill', b.id, ['2026-11-17 12:00:00+08']);

    const ra = await app.inject({ method: 'GET', url: `/api/skills/${a.name}/revisions` });
    expect(ra.statusCode).toBe(200);
    const bodyA = ra.json();
    expect(bodyA.revisions.length).toBe(1);
    expect(bodyA.revisions[0]).toMatchObject({ version: 1, kind: 'content', changedBy: 'alice' });
    expect(bodyA.revisions[0].changes).toEqual({ description: 'rev-skill-a 的旧描述' });

    const rb = await app.inject({ method: 'GET', url: `/api/skills/${b.name}/revisions` });
    expect(rb.statusCode).toBe(200);
    expect(rb.json().revisions[0].changes).toEqual({ description: 'rev-skill-b 的旧描述' });
  });

  it('c2) skill 不存在 404；存在但无修订 200 空数组', async () => {
    const miss = await app.inject({ method: 'GET', url: '/api/skills/no-such-skill/revisions' });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error).toBe('NOT_FOUND');

    const fresh = await seedSkill('rev-skill-fresh', { author: 'alice' });
    const empty = await app.inject({ method: 'GET', url: `/api/skills/${fresh.name}/revisions` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ revisions: [] });
  });

  it('e2) 带非法 token 仍 401（不降级为匿名）', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/skills/rev-skill-a/revisions', headers: auth('stranger-xyz') });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('UNAUTHORIZED');
  });
});
