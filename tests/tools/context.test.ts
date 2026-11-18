import { describe, expect, it, beforeEach } from 'vitest';
import { getContext } from '../../src/tools/context.js';
import { applyMigrations, createPool } from '../../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);

async function seed(title: string, status: string, module?: string, useCount = 0) {
  await pool.query(
    `INSERT INTO knowledge (title, symptom, solution, domain, scope, module, status, author, use_count)
     VALUES ($1,'现象','办法','java','demo-app',$2,$3,'seed',$4)`,
    [title, module, status, useCount],
  );
}

beforeEach(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE knowledge RESTART IDENTITY CASCADE');
});

describe('getContext', () => {
  it('verified 优先于 draft，不含 deprecated', async () => {
    await seed('草稿条目', 'draft', undefined, 99);
    await seed('验证条目', 'verified', undefined, 1);
    await seed('废弃条目', 'deprecated', undefined, 999);
    const r = await getContext(pool, { scope: 'demo-app' });
    expect(r.items.map((i) => i.title)).toEqual(['验证条目', '草稿条目']);
  });

  it('同状态内按 use_count 降序', async () => {
    await seed('低使用', 'verified', undefined, 1);
    await seed('高使用', 'verified', undefined, 10);
    const r = await getContext(pool, { scope: 'demo-app' });
    expect(r.items.map((i) => i.title)).toEqual(['高使用', '低使用']);
  });

  it('最多 20 条', async () => {
    for (let i = 0; i < 21; i++) await seed(`条目${i}`, 'verified');
    const r = await getContext(pool, { scope: 'demo-app' });
    expect(r.items.length).toBe(20);
  });

  it('module 前缀过滤', async () => {
    await seed('微前端条目', 'verified', 'core/MicroFront');
    await seed('后端条目', 'verified', 'core/Service');
    const r = await getContext(pool, { scope: 'demo-app', module: 'core/MicroFront' });
    expect(r.items.map((i) => i.title)).toEqual(['微前端条目']);
  });

  it('条目携带 version（乐观锁 base_version 依据）', async () => {
    await seed('验证条目', 'verified');
    const r = await getContext(pool, { scope: 'demo-app' });
    expect(r.items.length).toBe(1);
    expect(typeof r.items[0].version).toBe('number');
    expect(r.items[0].version).toBe(1);
  });
});
