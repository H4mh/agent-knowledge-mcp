import { describe, expect, it, beforeEach } from 'vitest';
import { importMarkdown } from '../scripts/import-markdown.js';
import { applyMigrations, createPool } from '../src/db.js';
import { join } from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);
const seedDir = join(process.cwd(), 'scripts', 'seed-example');

beforeEach(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE knowledge RESTART IDENTITY CASCADE');
});

describe('importMarkdown', () => {
  it('导入示例目录 → 2 条 verified', async () => {
    const r = await importMarkdown(pool, seedDir);
    expect(r.imported).toBe(2);
    expect(r.errors).toEqual([]);
    const { rows } = await pool.query<{ status: string; author: string; tags: string[] }>(
      'SELECT status, author, tags FROM knowledge ORDER BY id');
    expect(rows.length).toBe(2);
    expect(rows.every((x) => x.status === 'verified' && x.author === 'import')).toBe(true);
    expect(rows.some((x) => x.tags.includes('mysql'))).toBe(true);
  });

  it('坏文件报错但不中断其他文件', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'akm-import-'));
    writeFileSync(join(dir, 'bad.md'), '---\ntitle: 缺字段\n---\n正文');
    const r = await importMarkdown(pool, dir);
    expect(r.imported).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain('bad.md');
  });

  it('重复导入幂等（title+scope 重复跳过）', async () => {
    await importMarkdown(pool, seedDir);
    const r2 = await importMarkdown(pool, seedDir);
    expect(r2.imported).toBe(0);
    const { rows } = await pool.query('SELECT 1 FROM knowledge');
    expect(rows.length).toBe(2);
  });
});
