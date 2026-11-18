import { describe, expect, it, beforeEach } from 'vitest';
import { searchSkills } from '../src/search/skill.js';
import { loadConfig } from '../src/config.js';
import { applyMigrations, createPool } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);
const cfg = loadConfig({ DATABASE_URL: 'postgres://unused' });

interface Seed {
  name: string; description: string; instructions?: string; tags?: string[]; scope?: string | null; status?: string;
}

async function seed(s: Seed, embedding?: string) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO skill (name, description, instructions, tags, scope, status, author, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,'seed',$7::vector) RETURNING id`,
    [s.name, s.description, s.instructions ?? '见正文', s.tags ?? [], s.scope ?? null, s.status ?? 'draft', embedding ?? null],
  );
  return Number(rows[0].id);
}

beforeEach(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE skill, skill_usage, search_event RESTART IDENTITY CASCADE');
  await seed({ name: 'pdf-export', description: '导出 PDF 报表的通用流程', tags: ['pdf'], scope: 'demo-app', status: 'verified' });
  await seed({ name: 'pdf-export-guide', description: '导出 PDF 报表的流程手册', tags: ['pdf'], scope: 'demo-app' });
  await seed({ name: 'k8s-debug', description: 'K8s 环境导出报表的流程', tags: ['k8s'], scope: 'proj-b' });
});

describe('searchSkills', () => {
  it('关键词命中返回结果，verified 条目 score 含 verifiedBoost（高于同主题 draft）', async () => {
    const r = await searchSkills(pool, cfg, { query: '导出 PDF 报表' }, 'alice');
    expect(r.results.length).toBeGreaterThanOrEqual(2);
    const ids = r.results.map((x) => x.id);
    expect(ids.indexOf(1)).toBeGreaterThan(-1);
    // verified 排在 draft 前，分差 ≥ verifiedBoost(默认 2)
    expect(ids.indexOf(1)).toBeLessThan(ids.indexOf(2));
    const draft = r.results.find((x) => x.id === 2)!;
    const verified = r.results.find((x) => x.id === 1)!;
    expect(verified.status).toBe('verified');
    expect(verified.score - draft.score).toBeGreaterThanOrEqual(cfg.searchWeights.verifiedBoost);
  });

  it('tags 命中可召回', async () => {
    const r = await searchSkills(pool, cfg, { query: 'k8s' }, 'alice');
    expect(r.results.some((x) => x.id === 3)).toBe(true);
  });

  it('关键词仅出现在 instructions 也可召回（无 embedder，纯关键词路径）', async () => {
    const id = await seed({
      name: 'redis-flush',
      description: '清理缓存的流程',
      instructions: '先执行 crashloopcheck 校验节点状态，再重启 pod',
    });
    const r = await searchSkills(pool, cfg, { query: 'crashloopcheck' }, 'alice');
    expect(r.results.some((x) => x.id === id)).toBe(true);
  });

  it('关键词仅出现在 instructions 也可召回（配置 embedder 时）', async () => {
    const id = await seed({
      name: 'redis-flush2',
      description: '清理缓存的流程',
      instructions: '先执行 probecheck 校验节点状态，再重启 pod',
    });
    const embedder = { embed: async () => [0.1, 0.2, 0.9] };
    const r = await searchSkills(pool, cfg, { query: 'probecheck' }, 'alice', embedder);
    expect(r.results.some((x) => x.id === id)).toBe(true);
  });

  it('带 scope 时同 scope 条目加成排前，其他 scope 条目仍可见（软隔离）', async () => {
    const r = await searchSkills(pool, cfg, { query: '导出 PDF 报表', scope: 'demo-app' }, 'alice');
    expect(r.results.some((x) => x.id === 3)).toBe(true);
    expect(r.results[0].scope).toBe('demo-app');
  });

  it('纯语义查询（零词重叠、trigram 低于 0.2）+ mock embedder → 仍召回，分数含向量项', async () => {
    const vecId = await seed(
      { name: 'k8s-pod-crash', description: '容器一直 CrashLoopBackOff 检查资源限额与探针配置', status: 'verified' },
      '[0.9,0.1,0.0]',
    );
    // 「数据库连接池超时」与该条目 name/description 零关键词重叠，但向量语义相近
    const embedder = { embed: async () => [0.85, 0.2, 0.05] };
    const r = await searchSkills(pool, cfg, { query: '数据库连接池超时' }, 'alice', embedder);
    const hit = r.results.find((x) => x.id === vecId);
    expect(hit).toBeTruthy();
    expect(hit!.score).toBeGreaterThan(0);
  });

  it('向量服务不可用 → 静默退化为关键词检索，不报错', async () => {
    const embedder = { embed: async () => { throw new Error('服务挂了'); } };
    const r = await searchSkills(pool, cfg, { query: '导出 PDF 报表' }, 'alice', embedder);
    expect(r.results.some((x) => x.id === 1)).toBe(true);
  });

  it('无命中时返回空数组', async () => {
    const r = await searchSkills(pool, cfg, { query: '完全不存在的词条xyzq' }, 'alice');
    expect(r.results).toEqual([]);
  });

  it('检索记录 search_event（kind=skill，hit_ids 为 skill ids）', async () => {
    await searchSkills(pool, cfg, { query: '导出 PDF 报表' }, 'alice');
    const { rows } = await pool.query<{ queried_by: string; kind: string; hit_ids: number[] }>(
      'SELECT queried_by, kind, hit_ids FROM search_event');
    expect(rows.length).toBe(1);
    expect(rows[0].queried_by).toBe('alice');
    expect(rows[0].kind).toBe('skill');
    expect(rows[0].hit_ids.map(Number)).toContain(1);
  });

  it('未命中也记录 search_event（hit_ids 空数组，kind=skill）', async () => {
    await searchSkills(pool, cfg, { query: '完全不存在的词条xyzq' }, 'alice');
    const { rows } = await pool.query<{ kind: string; hit_ids: number[] }>('SELECT kind, hit_ids FROM search_event');
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('skill');
    expect(rows[0].hit_ids).toEqual([]);
  });

  it('limit 生效（Math.min 上限 50）', async () => {
    const r = await searchSkills(pool, cfg, { query: 'pdf', limit: 1 }, 'alice');
    expect(r.results.length).toBe(1);
  });

  it('SkillHit 字段完整（name/description/status/scope/tags/author/version/use_count/updated_at）', async () => {
    const r = await searchSkills(pool, cfg, { query: '导出 PDF 报表' }, 'alice');
    expect(r.results.length).toBeGreaterThan(0);
    const h = r.results[0];
    expect(h).toMatchObject({
      name: 'pdf-export',
      description: '导出 PDF 报表的通用流程',
      status: 'verified',
      scope: 'demo-app',
      tags: ['pdf'],
      author: 'seed',
    });
    expect(typeof h.version).toBe('number');
    expect(typeof h.use_count).toBe('number');
    expect(typeof h.score).toBe('number');
    expect(h.updated_at).toBeTruthy();
  });
});
