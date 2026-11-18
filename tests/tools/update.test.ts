import { describe, expect, it, beforeEach } from 'vitest';
import { handleUpdate } from '../../src/tools/update.js';
import { ToolError } from '../../src/tools/save.js';
import { applyMigrations, createPool } from '../../src/db.js';
import { loadTagAliases } from '../../src/search/tags.js';
import { loadGuardRules } from '../../src/guard/index.js';
import { join } from 'node:path';

const aliases = loadTagAliases(join(process.cwd(), 'config', 'tag-aliases.json'));
const guardRules = loadGuardRules(join(process.cwd(), 'config', 'guard-rules.json'));

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);
const author = { username: 'alice', role: 'user' as const };
const admin = { username: 'root', role: 'admin' as const };
const stranger = { username: 'dave', role: 'user' as const };

let entryId: number;

beforeEach(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE knowledge, entry_revision RESTART IDENTITY CASCADE');
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO knowledge (title, symptom, solution, domain, scope, status, author)
     VALUES ('原题', '原现象', '原办法', 'java', 'demo-app', 'draft', 'alice') RETURNING id`,
  );
  entryId = Number(rows[0].id);
});

describe('handleUpdate', () => {
  it('作者可改文本字段', async () => {
    const r = await handleUpdate(pool, author, { id: entryId, solution: '新办法' }, { aliases, guardRules });
    expect(r.ok).toBe(true);
    const { rows } = await pool.query<{ solution: string }>('SELECT solution FROM knowledge WHERE id=$1', [entryId]);
    expect(rows[0].solution).toBe('新办法');
  });

  it('非作者非管理员 → FORBIDDEN', async () => {
    const err = await handleUpdate(pool, stranger, { id: entryId, solution: '改' }, { aliases, guardRules }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('FORBIDDEN');
  });

  it('管理员可改任何条目', async () => {
    await handleUpdate(pool, admin, { id: entryId, symptom: 'admin 改的现象' }, { aliases, guardRules });
    const { rows } = await pool.query<{ symptom: string }>('SELECT symptom FROM knowledge WHERE id=$1', [entryId]);
    expect(rows[0].symptom).toBe('admin 改的现象');
  });

  it('status 字段对任何 MCP 调用方拒绝（仅 CLI 可改）', async () => {
    const err = await handleUpdate(pool, admin, { id: entryId, status: 'verified' } as never, { aliases, guardRules }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('FORBIDDEN');
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM knowledge WHERE id=$1', [entryId]);
    expect(rows[0].status).toBe('draft');
  });

  it('条目不存在 → NOT_FOUND', async () => {
    const err = await handleUpdate(pool, author, { id: 99999, solution: 'x' }, { aliases, guardRules }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('update 写入含私钥的 detail → SENSITIVE_CONTENT 且库中未改', async () => {
    const err = await handleUpdate(pool, author, { id: entryId, detail: '-----BEGIN RSA PRIVATE KEY-----' }, { aliases, guardRules }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('SENSITIVE_CONTENT');
    const { rows } = await pool.query<{ detail: string | null }>('SELECT detail FROM knowledge WHERE id=$1', [entryId]);
    expect(rows[0].detail).toBeNull();
  });

  it('update 的 tags 经归一化', async () => {
    await handleUpdate(pool, author, { id: entryId, tags: ['达梦', 'vue'] }, { aliases, guardRules });
    const { rows } = await pool.query<{ tags: string[] }>('SELECT tags FROM knowledge WHERE id=$1', [entryId]);
    expect(rows[0].tags).toEqual(['dameng', 'vue']);
  });

  it('配置向量模型 → 内容更新后重新生成 embedding', async () => {
    await pool.query('UPDATE knowledge SET embedding = $2::vector WHERE id = $1', [entryId, '[1,1,1]']);
    const embedder = { embed: async (t: string) => [t.length, 0] };
    await handleUpdate(pool, author, { id: entryId, solution: '全新方案内容' }, { aliases, guardRules, embedder });
    const { rows } = await pool.query<{ embedding: string }>('SELECT embedding::text FROM knowledge WHERE id=$1', [entryId]);
    // 向量基于 title+symptom+solution+detail 全文重新生成，不再是旧 [1,1,1]
    expect(rows[0].embedding).not.toBe('[1,1,1]');
    const k = (await pool.query<{ title: string; symptom: string; solution: string; detail: string | null }>(
      'SELECT title, symptom, solution, detail FROM knowledge WHERE id=$1', [entryId])).rows[0];
    expect(rows[0].embedding).toBe(`[${[k.title, k.symptom, k.solution, k.detail ?? ''].join('\n').length},0]`);
  });

  it('向量服务不可用 → 更新不受阻，旧向量保留', async () => {
    await pool.query('UPDATE knowledge SET embedding = $2::vector WHERE id = $1', [entryId, '[1,1,1]']);
    const embedder = { embed: async () => { throw new Error('服务挂了'); } };
    const r = await handleUpdate(pool, author, { id: entryId, solution: 'x' }, { aliases, guardRules, embedder });
    expect(r.ok).toBe(true);
    const { rows } = await pool.query<{ embedding: string }>('SELECT embedding::text FROM knowledge WHERE id=$1', [entryId]);
    expect(rows[0].embedding).toBe('[1,1,1]');
  });

  it('a) 带 base_version=1 更新 → 成功 version=2，修订行 changes 含旧值、snapshot 为更新前整行', async () => {
    const r = await handleUpdate(pool, author, { id: entryId, solution: '新办法', base_version: 1 }, { aliases, guardRules });
    expect(r.ok).toBe(true);
    expect(r.version).toBe(2);
    const { rows: k } = await pool.query<{ solution: string; version: number }>(
      'SELECT solution, version FROM knowledge WHERE id=$1', [entryId]);
    expect(k[0].solution).toBe('新办法');
    expect(Number(k[0].version)).toBe(2);
    const { rows: rev } = await pool.query<{
      entry_id: string; version: number; kind: string; changed_by: string;
      changes: Record<string, unknown>; snapshot: Record<string, unknown>;
    }>(
      `SELECT entry_id, version, kind, changed_by, changes, snapshot FROM entry_revision
       WHERE entry_kind = 'knowledge' AND entry_id = $1`, [entryId]);
    expect(rev).toHaveLength(1);
    expect(Number(rev[0].version)).toBe(1);
    expect(rev[0].kind).toBe('content');
    expect(rev[0].changed_by).toBe('alice');
    expect(rev[0].changes).toEqual({ solution: '原办法' });
    expect(rev[0].snapshot).toEqual(expect.objectContaining({
      id: String(entryId), version: 1, title: '原题', symptom: '原现象', solution: '原办法',
      detail: null, author: 'alice', status: 'draft', scope: 'demo-app', domain: 'java',
    }));
  });

  it('b) base_version 过期 → CONFLICT，主表未被修改', async () => {
    await handleUpdate(pool, author, { id: entryId, solution: 'v2 方案' }, { aliases, guardRules }); // v1→v2
    await handleUpdate(pool, admin, { id: entryId, solution: 'v3 方案' }, { aliases, guardRules }); // v2→v3
    const err = await handleUpdate(pool, author, { id: entryId, symptom: '新现象', base_version: 2 }, { aliases, guardRules }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toContain('search_knowledge');
    expect(err.message).toContain('v3'); // 提示当前最新版本
    const { rows } = await pool.query<{ symptom: string; version: number }>(
      'SELECT symptom, version FROM knowledge WHERE id=$1', [entryId]);
    expect(rows[0].symptom).toBe('原现象'); // symptom 未变
    expect(Number(rows[0].version)).toBe(3); // version 未被失败尝试推进
    const { rowCount } = await pool.query('SELECT 1 FROM entry_revision WHERE entry_id=$1', [entryId]);
    expect(rowCount).toBe(2); // 仅两次成功更新各写一行，失败尝试不写
  });

  it('c) 不带 base_version → 兼容旧调用，version+1 且写修订', async () => {
    const r = await handleUpdate(pool, author, { id: entryId, solution: '新办法' }, { aliases, guardRules });
    expect(r.ok).toBe(true);
    expect(r.version).toBe(2);
    const { rowCount } = await pool.query('SELECT 1 FROM entry_revision WHERE entry_id=$1', [entryId]);
    expect(rowCount).toBe(1);
  });

  it('d) 提交相同值 → 无实际变化，version 不变、无修订行', async () => {
    const r = await handleUpdate(pool, author, { id: entryId, symptom: '原现象' }, { aliases, guardRules });
    expect(r.ok).toBe(true);
    expect(r.version).toBe(1);
    const { rows } = await pool.query<{ version: number }>('SELECT version FROM knowledge WHERE id=$1', [entryId]);
    expect(Number(rows[0].version)).toBe(1);
    const { rowCount } = await pool.query('SELECT 1 FROM entry_revision WHERE entry_id=$1', [entryId]);
    expect(rowCount).toBe(0);
  });

  it('e) embedder 总是 reject → 更新成功、修订行存在、旧向量保留', async () => {
    await pool.query('UPDATE knowledge SET embedding = $2::vector WHERE id = $1', [entryId, '[1,1,1]']);
    const embedder = { embed: async () => { throw new Error('服务挂了'); } };
    const r = await handleUpdate(pool, author, { id: entryId, solution: '新方案', base_version: 1 }, { aliases, guardRules, embedder });
    expect(r.ok).toBe(true);
    expect(r.version).toBe(2);
    const { rowCount } = await pool.query('SELECT 1 FROM entry_revision WHERE entry_id=$1', [entryId]);
    expect(rowCount).toBe(1);
    const { rows } = await pool.query<{ embedding: string }>('SELECT embedding::text FROM knowledge WHERE id=$1', [entryId]);
    expect(rows[0].embedding).toBe('[1,1,1]');
  });
});
