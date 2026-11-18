import { describe, expect, it, beforeEach } from 'vitest';
import { searchKnowledge } from '../src/search/index.js';
import { loadConfig } from '../src/config.js';
import { applyMigrations, createPool } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);
const cfg = loadConfig({ DATABASE_URL: 'postgres://unused' });

interface Seed {
  title: string; symptom: string; solution: string; domain: string; scope: string; status: string;
}

async function seed(s: Seed) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO knowledge (title, symptom, solution, domain, scope, status, author)
     VALUES ($1,$2,$3,$4,$5,$6,'seed') RETURNING id`,
    [s.title, s.symptom, s.solution, s.domain, s.scope, s.status],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE knowledge, search_event RESTART IDENTITY CASCADE');
  await seed({ title: 'MySQL 分页返回全量数据', symptom: '分页查询返回全量数据', solution: '引入 pagehelper 2.x', domain: 'java', scope: 'demo-app', status: 'verified' });
  await seed({ title: 'MyBatis 分页全量返回排查', symptom: '分页查询返回全量数据', solution: '检查 pagehelper 版本冲突', domain: 'java', scope: 'demo-app', status: 'draft' });
  await seed({ title: 'Kingbase 分页语法差异', symptom: 'LIMIT OFFSET 写法不同', solution: '改用 kingbase 方言目录下的 mapper', domain: 'db', scope: 'proj-b', status: 'verified' });
  await seed({ title: '分页插件旧版兼容', symptom: '分页查询返回全量数据', solution: '已废弃方案，升级处理', domain: 'java', scope: 'demo-app', status: 'deprecated' });
});

describe('searchKnowledge', () => {
  it('中文 query 命中同主题条目，verified 排在 draft 前', async () => {
    const r = await searchKnowledge(pool, cfg, { query: '分页返回全量' }, 'alice');
    const ids = r.results.map((x) => x.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids.indexOf(1)).toBeGreaterThan(-1);
    expect(ids.indexOf(1)).toBeLessThan(ids.indexOf(2));
    expect(r.results[0].status).toBe('verified');
  });

  it('结果带新鲜度信息（use_count / last_used_at）供 agent 判断可信度', async () => {
    await pool.query('UPDATE knowledge SET use_count = 7, last_used_at = now() WHERE id = 1');
    const r = await searchKnowledge(pool, cfg, { query: 'MySQL 分页返回全量' }, 'alice');
    const hit = r.results.find((x) => x.id === 1);
    expect(hit.use_count).toBe(7);
    expect(hit.last_used_at).toBeTruthy();
    const unused = r.results.find((x) => x.id === 2);
    expect(unused.use_count).toBe(0);
    expect(unused.last_used_at).toBeNull();
  });

  it('软隔离：带 scope 时其他 scope 条目仍可见', async () => {
    const r = await searchKnowledge(pool, cfg, { query: 'Kingbase 分页', scope: 'demo-app' }, 'alice');
    expect(r.results.some((x) => x.id === 3)).toBe(true);
    // 同 scope 命中的条目应排更前：demo-app 的条目分数加成
    expect(r.results[0].scope === 'demo-app' || r.results[0].id === 3).toBe(true);
  });

  it('不带 scope 时全库检索', async () => {
    const r = await searchKnowledge(pool, cfg, { query: 'Kingbase' }, 'alice');
    expect(r.results.some((x) => x.id === 3)).toBe(true);
  });

  it('deprecated 条目分值低于同主题 draft', async () => {
    const r = await searchKnowledge(pool, cfg, { query: '分页返回全量' }, 'alice');
    const dIdx = r.results.findIndex((x) => x.id === 4);
    const bIdx = r.results.findIndex((x) => x.id === 2);
    expect(dIdx).toBeGreaterThan(-1);
    expect(dIdx).toBeGreaterThan(bIdx);
    expect(r.results[dIdx].score).toBeLessThan(r.results[bIdx].score);
  });

  it('命中时记录 search_event（hit_ids 非空）', async () => {
    await searchKnowledge(pool, cfg, { query: 'Kingbase 分页' }, 'alice');
    const { rows } = await pool.query<{ queried_by: string; hit_ids: number[] }>(
      'SELECT queried_by, hit_ids FROM search_event');
    expect(rows.length).toBe(1);
    expect(rows[0].queried_by).toBe('alice');
    expect(rows[0].hit_ids.length).toBeGreaterThan(0);
  });

  it('未命中仍记录 search_event（hit_ids 空数组）', async () => {
    const r = await searchKnowledge(pool, cfg, { query: '完全不存在的词条xyzq' }, 'alice');
    expect(r.results).toEqual([]);
    const { rows } = await pool.query<{ hit_ids: number[] }>('SELECT hit_ids FROM search_event');
    expect(rows.length).toBe(1);
    expect(rows[0].hit_ids).toEqual([]);
  });

  it('limit 生效', async () => {
    const r = await searchKnowledge(pool, cfg, { query: '分页', limit: 1 }, 'alice');
    expect(r.results.length).toBe(1);
  });

  it('domain 与 tags 过滤生效', async () => {
    const r = await searchKnowledge(pool, cfg, { query: '分页', domain: 'db' }, 'alice');
    expect(r.results.every((x) => x.id === 3)).toBe(true);
  });

  it('启用向量 → 语义相关但零关键词重叠的条目可召回，分数含向量项', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO knowledge (title, symptom, solution, domain, scope, status, author, embedding)
       VALUES ('K8s Pod 启动失败', '容器一直 CrashLoopBackOff', '检查资源限额与探针配置', 'infra', 'demo-app', 'verified', 'seed', '[0.9,0.1,0.0]')
       RETURNING id`);
    const vecId = Number(rows[0].id);
    // query「数据库连接池超时」与该条目零关键词重叠，但向量语义相近
    const embedder = { embed: async () => [0.85, 0.2, 0.05] };
    const r = await searchKnowledge(pool, cfg, { query: '数据库连接池超时' }, 'alice', embedder);
    const hit = r.results.find((x) => x.id === vecId);
    expect(hit).toBeTruthy();
    expect(hit!.score).toBeGreaterThan(0);
  });

  it('未配向量 → 行为与之前一致（零关键词重叠不召回）', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO knowledge (title, symptom, solution, domain, scope, status, author, embedding)
       VALUES ('K8s Pod 启动失败', '容器一直 CrashLoopBackOff', '检查资源限额与探针配置', 'infra', 'demo-app', 'verified', 'seed', '[0.9,0.1,0.0]')
       RETURNING id`);
    const vecId = Number(rows[0].id);
    const r = await searchKnowledge(pool, cfg, { query: '数据库连接池超时' }, 'alice');
    expect(r.results.some((x) => x.id === vecId)).toBe(false);
  });

  it('向量服务不可用 → 自动退化为关键词检索，不报错', async () => {
    const embedder = { embed: async () => { throw new Error('服务挂了'); } };
    const r = await searchKnowledge(pool, cfg, { query: 'MySQL 分页返回全量' }, 'alice', embedder);
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.some((x) => x.id === 1)).toBe(true);
  });
});

describe('门户扩展：status 筛选与字段扩充', () => {
  it('status 筛选只返回该状态；不传时行为不变', async () => {
    const r = await searchKnowledge(pool, cfg, { query: '分页', status: 'verified' }, 'alice');
    expect(r.results.length).toBeGreaterThanOrEqual(1);
    expect(r.results.every((x) => x.status === 'verified')).toBe(true);
    const r2 = await searchKnowledge(pool, cfg, { query: '分页' }, 'alice');
    expect(r2.results.some((x) => x.status === 'draft')).toBe(true);
  });

  it('SearchHit 扩充 domain/author/module/updated_at', async () => {
    const r = await searchKnowledge(pool, cfg, { query: 'Kingbase' }, 'alice');
    expect(r.results.length).toBeGreaterThanOrEqual(1);
    expect(r.results[0]).toMatchObject({ domain: 'db', author: 'seed' });
    expect(r.results[0].updated_at).toBeTruthy();
  });

  it('SearchHit 携带 version（乐观锁 base_version 依据）', async () => {
    const r = await searchKnowledge(pool, cfg, { query: 'Kingbase' }, 'alice');
    expect(r.results.length).toBeGreaterThanOrEqual(1);
    expect(typeof r.results[0].version).toBe('number');
    expect(r.results[0].version).toBeGreaterThanOrEqual(1);
  });
});
