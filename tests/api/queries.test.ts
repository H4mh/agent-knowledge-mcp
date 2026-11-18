import { describe, expect, it, beforeEach } from 'vitest';
import { listKnowledge, getKnowledgeById, getStats } from '../../src/api/queries.js';
import { loadConfig } from '../../src/config.js';
import { applyMigrations, createPool } from '../../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);
const cfg = loadConfig({ DATABASE_URL: 'postgres://unused' });

const LONG = '很长的现象描述。'.repeat(30); // 240 字符

beforeEach(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE knowledge, knowledge_usage, search_event, app_user RESTART IDENTITY CASCADE');
  await pool.query(
    `INSERT INTO knowledge (title, symptom, solution, domain, scope, status, author, use_count, detail, code_ref) VALUES
     ('MySQL 分页全量', $1, '引入 pagehelper', 'java', 'demo-app', 'verified', 'alice', 5, '详情正文A', 'a.java:1'),
     ('Kingbase 方言差异', 'LIMIT OFFSET 写法不同', '改用方言 mapper', 'db', 'proj-b', 'draft', 'bob', 0, null, null),
     ('Qiankun 白屏', '子应用切换白屏', '检查 publicPath', 'frontend', 'demo-app', 'deprecated', 'alice', 1, null, null)`,
    [LONG],
  );
});

describe('listKnowledge', () => {
  it('浏览模式：分页 total 正确、按 updated_at 倒序', async () => {
    const r = await listKnowledge(pool, cfg, { page: 1, pageSize: 2 });
    expect(r.mode).toBe('browse');
    expect(r.total).toBe(3);
    expect(r.items.length).toBe(2);
    const r2 = await listKnowledge(pool, cfg, { page: 2, pageSize: 2 });
    expect(r2.items.length).toBe(1);
    expect(r.total).toBe(3);
  });

  it('浏览模式过滤：scope / status / domain / tag', async () => {
    await pool.query(`UPDATE knowledge SET tags = '{分页}' WHERE title = 'MySQL 分页全量'`);
    expect((await listKnowledge(pool, cfg, { scope: 'demo-app' })).total).toBe(2);
    expect((await listKnowledge(pool, cfg, { status: 'draft' })).total).toBe(1);
    expect((await listKnowledge(pool, cfg, { domain: 'db' })).total).toBe(1);
    expect((await listKnowledge(pool, cfg, { tag: '分页' })).total).toBe(1);
  });

  it('浏览模式不写 search_event', async () => {
    await listKnowledge(pool, cfg, { scope: 'demo-app' });
    const { rowCount } = await pool.query('SELECT 1 FROM search_event');
    expect(rowCount).toBe(0);
  });

  it('检索模式：mode=search、total=null、超长 symptom 截断 80 字符 + …', async () => {
    const r = await listKnowledge(pool, cfg, { q: '分页全量' });
    expect(r.mode).toBe('search');
    expect(r.total).toBeNull();
    const hit = r.items.find((x) => x.title === 'MySQL 分页全量');
    expect(hit).toBeTruthy();
    expect(hit!.symptom.length).toBe(81);
    expect(hit!.symptom.endsWith('…')).toBe(true);
    // 浏览模式同样截断
    const b = await listKnowledge(pool, cfg, {});
    const hit2 = b.items.find((x) => x.title === 'MySQL 分页全量');
    expect(hit2!.symptom.length).toBe(81);
  });

  it('facets：domains/scopes 带条目数', async () => {
    const r = await listKnowledge(pool, cfg, {});
    const domains = Object.fromEntries(r.facets.domains.map((d) => [d.value, d.count]));
    const scopes = Object.fromEntries(r.facets.scopes.map((s) => [s.value, s.count]));
    expect(domains).toMatchObject({ java: 1, db: 1, frontend: 1 });
    expect(scopes).toMatchObject({ 'demo-app': 2, 'proj-b': 1 });
  });
});

describe('getKnowledgeById', () => {
  it('存在返回全字段含 detail/code_ref/created_at；不存在返回 null', async () => {
    const { rows } = await pool.query<{ id: number }>(`SELECT id FROM knowledge WHERE title = 'MySQL 分页全量'`);
    const id = Number(rows[0].id);
    const k = await getKnowledgeById(pool, id);
    expect(k).not.toBeNull();
    expect(k!.detail).toBe('详情正文A');
    expect(k!.code_ref).toBe('a.java:1');
    expect(k!.created_at).toBeTruthy();
    expect(k!.symptom).toBe(LONG); // 详情不截断
    expect(await getKnowledgeById(pool, 999999)).toBeNull();
  });

  it('列表与详情负载携带 version（乐观锁 base_version 依据）', async () => {
    const browse = await listKnowledge(pool, cfg, {});
    expect(browse.items.length).toBe(3);
    expect(browse.items.every((x) => typeof x.version === 'number' && x.version >= 1)).toBe(true);
    const search = await listKnowledge(pool, cfg, { q: '分页全量' });
    expect(search.items.length).toBeGreaterThanOrEqual(1);
    expect(search.items.every((x) => typeof x.version === 'number')).toBe(true);
    const { rows } = await pool.query<{ id: number }>(`SELECT id FROM knowledge WHERE title = 'MySQL 分页全量'`);
    const k = await getKnowledgeById(pool, Number(rows[0].id));
    expect(k).not.toBeNull();
    expect(typeof k!.version).toBe('number');
    expect(k!.version).toBeGreaterThanOrEqual(1);
  });
});

describe('getStats', () => {
  it('byStatus/byDomain/byScope/topUsed/recentMisses/userCount 数字正确', async () => {
    await pool.query(`INSERT INTO app_user (username, token_hash) VALUES ('u1', 'h1'), ('u2', 'h2')`);
    await pool.query(
      `INSERT INTO search_event (queried_by, query, hit_ids) VALUES ('u1', '搜不到的词', '{}'), ('u2', '搜不到的词', '{}'), ('u1', '另一词', '{}')`);
    const s = await getStats(pool);
    expect(s.byStatus).toMatchObject({ verified: 1, draft: 1, deprecated: 1 });
    expect(s.byDomain).toMatchObject({ java: 1, db: 1, frontend: 1 });
    expect(s.byScope[0]).toMatchObject({ value: 'demo-app', count: 2 });
    expect(s.topUsed[0]).toMatchObject({ use_count: 5 });
    expect(s.recentMisses[0]).toMatchObject({ query: '搜不到的词', count: 2 });
    expect(s.userCount).toBe(2);
  });
});
