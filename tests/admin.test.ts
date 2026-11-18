import { describe, expect, it, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdmin } from '../scripts/admin.js';
import { authenticate } from '../src/auth.js';
import { listLegacyUsers, listRevisions, resetToken } from '../src/admin/service.js';
import { applyMigrations, createPool } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);

beforeEach(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE knowledge, knowledge_usage, search_event, app_user, entry_revision RESTART IDENTITY CASCADE');
  // skill 不整体 TRUNCATE（并行文件共用），只清掉 embed 用例的固定名 skill，保证重跑幂等
  await pool.query("DELETE FROM skill WHERE name IN ('backfill-skill', 'only-skill-missing')");
});

describe('runAdmin', () => {
  it('adduser → listusers 可见，token 可鉴权', async () => {
    const out1 = await runAdmin(pool, ['adduser', 'alice', '--token', 'secret-token', '--role', 'admin']);
    expect(out1).toContain('alice');
    const out2 = await runAdmin(pool, ['listusers']);
    expect(out2).toContain('alice');
    expect(out2).toContain('admin');
    const u = await authenticate(pool, 'secret-token');
    expect(u).toEqual({ username: 'alice', role: 'admin' });
  });

  it('disable 后鉴权失败，enable 恢复', async () => {
    await runAdmin(pool, ['adduser', 'bob', '--token', 'bob-token']);
    await runAdmin(pool, ['disable', 'bob']);
    expect(await authenticate(pool, 'bob-token')).toBeNull();
    await runAdmin(pool, ['enable', 'bob']);
    expect(await authenticate(pool, 'bob-token')).not.toBeNull();
  });

  it('delete-knowledge 删除条目及 usage', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO knowledge (title, symptom, solution, domain, scope, author)
       VALUES ('待删', 'x', 'y', 'java', 'demo-app', 'a') RETURNING id`);
    const id = Number(rows[0].id);
    await pool.query('INSERT INTO knowledge_usage (knowledge_id, used_by) VALUES ($1,$2)', [id, 'u1']);
    await runAdmin(pool, ['delete-knowledge', String(id)]);
    const k = await pool.query('SELECT 1 FROM knowledge WHERE id=$1', [id]);
    const u = await pool.query('SELECT 1 FROM knowledge_usage WHERE knowledge_id=$1', [id]);
    expect(k.rowCount).toBe(0);
    expect(u.rowCount).toBe(0);
  });

  it('set-status 变更状态', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO knowledge (title, symptom, solution, domain, scope, author)
       VALUES ('条目', 'x', 'y', 'java', 'demo-app', 'a') RETURNING id`);
    await runAdmin(pool, ['set-status', String(Number(rows[0].id)), 'verified']);
    const { rows: r2 } = await pool.query<{ status: string }>('SELECT status FROM knowledge WHERE id=$1', [rows[0].id]);
    expect(r2[0].status).toBe('verified');
  });

  it('export 导出 frontmatter markdown', async () => {
    await pool.query(
      `INSERT INTO knowledge (title, symptom, solution, detail, domain, scope, tags, status, author)
       VALUES ('导出条目', '现象', '办法', '正文', 'java', 'demo-app', ARRAY['mysql'], 'verified', 'a')`);
    const dir = mkdtempSync(join(tmpdir(), 'akm-export-'));
    await runAdmin(pool, ['export', dir]);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const content = readFileSync(join(dir, files[0]), 'utf8');
    expect(content).toContain('title: 导出条目');
    expect(content).toContain('domain: java');
    expect(content).toContain('scope: demo-app');
    expect(content).toContain('办法');
  });

  it('list-scopes 列出 scope 与启用状态', async () => {
    const out = await runAdmin(pool, ['list-scopes']);
    expect(out).toContain('global');
    expect(out).toContain('demo-app');
    expect(out).toMatch(/enabled|disabled/);
  });

  it('delete-scope 删除 scope；不存在 → 报错', async () => {
    const scope = `autoscopedel-${Date.now()}`;
    await pool.query('INSERT INTO scope_registry (scope) VALUES ($1)', [scope]);
    const out = await runAdmin(pool, ['delete-scope', scope]);
    expect(out).toContain(scope);
    const { rowCount } = await pool.query('SELECT 1 FROM scope_registry WHERE scope=$1', [scope]);
    expect(rowCount).toBe(0);
    const err = await runAdmin(pool, ['delete-scope', scope]).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('不存在');
  });

  it('delete-scope 有条目时拒绝（CLI 与 REST 共用语义）', async () => {
    const scope = `autoscopecnt-${Date.now()}`;
    await pool.query('INSERT INTO scope_registry (scope) VALUES ($1)', [scope]);
    await pool.query(
      `INSERT INTO knowledge (title, symptom, solution, domain, scope, author)
       VALUES ('t', 'x', 'y', 'java', $1, 'a')`, [scope]);
    const err = await runAdmin(pool, ['delete-scope', scope]).catch((e) => e);
    expect(err.message).toMatch(/\[SCOPE_HAS_ENTRIES\]|仍有知识条目/);
    const { rowCount } = await pool.query('SELECT 1 FROM scope_registry WHERE scope=$1', [scope]);
    expect(rowCount).toBe(1); // 未被删除
  });

  async function insertAt(title: string, status: string, daysAgo: number, usedDaysAgo: number | null) {
    const values = [title, status, String(daysAgo)];
    const usedExpr = usedDaysAgo === null
      ? 'NULL'
      : (() => { values.push(String(usedDaysAgo)); return `now() - ($${values.length} || ' days')::interval`; })();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO knowledge (title, symptom, solution, domain, scope, status, author, updated_at, last_used_at)
       VALUES ($1, '现象', '办法', 'java', 'demo-app', $2, 'a', now() - ($3 || ' days')::interval, ${usedExpr})
       RETURNING id`,
      values,
    );
    return Number(rows[0].id);
  }

  describe('decay 知识老化', () => {
    it('长期无人使用的 verified → 降回 draft', async () => {
      const id = await insertAt('陈年verified', 'verified', 200, 180);
      const out = await runAdmin(pool, ['decay', '--days', '90']);
      expect(out).toContain('draft');
      const { rows } = await pool.query<{ status: string }>('SELECT status FROM knowledge WHERE id=$1', [id]);
      expect(rows[0].status).toBe('draft');
    });

    it('从未使用过的 verified 按 updated_at 起算', async () => {
      const id = await insertAt('导入即verified', 'verified', 200, null);
      await runAdmin(pool, ['decay', '--days', '90']);
      const { rows } = await pool.query<{ status: string }>('SELECT status FROM knowledge WHERE id=$1', [id]);
      expect(rows[0].status).toBe('draft');
    });

    it('近期用过的 verified 不降级；draft 不动', async () => {
      const freshId = await insertAt('新鲜verified', 'verified', 200, 10);
      const draftId = await insertAt('陈年draft', 'draft', 300, null);
      const out = await runAdmin(pool, ['decay', '--days', '90']);
      expect(out).not.toContain('新鲜verified');
      const { rows: fresh } = await pool.query<{ status: string }>('SELECT status FROM knowledge WHERE id=$1', [freshId]);
      const { rows: draft } = await pool.query<{ status: string }>('SELECT status FROM knowledge WHERE id=$1', [draftId]);
      expect(fresh[0].status).toBe('verified');
      expect(draft[0].status).toBe('draft');
    });

    it('--dry-run 只报告不修改', async () => {
      const id = await insertAt('待衰减条目', 'verified', 200, 180);
      const out = await runAdmin(pool, ['decay', '--days', '90', '--dry-run']);
      expect(out).toContain('待衰减条目');
      const { rows } = await pool.query<{ status: string }>('SELECT status FROM knowledge WHERE id=$1', [id]);
      expect(rows[0].status).toBe('verified');
    });
  });

  describe('embed 向量回填', () => {
    it('为缺失 embedding 的条目生成向量；已有向量的不动', async () => {
      const a = await insertAt('缺向量条目', 'draft', 1, null);
      const b = await insertAt('有向量条目', 'draft', 1, null);
      await pool.query('UPDATE knowledge SET embedding = $2::vector WHERE id = $1', [b, '[9,9,9]']);
      const out = await runAdmin(pool, ['embed'], {
        embedder: { embed: async (t: string) => [t.length, 0] },
      });
      expect(out).toContain('1 条');
      const va = await pool.query<{ embedding: string }>('SELECT embedding::text FROM knowledge WHERE id=$1', [a]);
      const vb = await pool.query<{ embedding: string }>('SELECT embedding::text FROM knowledge WHERE id=$1', [b]);
      expect(va.rows[0].embedding).not.toBeNull();
      expect(vb.rows[0].embedding).toBe('[9,9,9]');
    });

    it('单条失败不中断，其余照常回填', async () => {
      const a = await insertAt('会失败条目', 'draft', 1, null);
      const b = await insertAt('会成功条目', 'draft', 1, null);
      const out = await runAdmin(pool, ['embed'], {
        embedder: { embed: async (t: string) => { if (t.includes('失败')) throw new Error('服务挂了'); return [1, 2]; } },
      });
      expect(out).toContain('失败');
      const va = await pool.query<{ embedding: string | null }>('SELECT embedding::text FROM knowledge WHERE id=$1', [a]);
      const vb = await pool.query<{ embedding: string | null }>('SELECT embedding::text FROM knowledge WHERE id=$1', [b]);
      expect(va.rows[0].embedding).toBeNull();
      expect(vb.rows[0].embedding).toBe('[1,2]');
    });

    it('未传 embedder（未配置向量模型）→ 明确提示', async () => {
      const out = await runAdmin(pool, ['embed']);
      expect(out).toContain('未配置');
    });

    it('skill 缺向量的条目一并回填（检索文本 = name + description + instructions）', async () => {
      const { rows: sk } = await pool.query<{ id: number }>(
        `INSERT INTO skill (name, description, instructions, status, author)
         VALUES ('backfill-skill', '技能描述', '步骤正文', 'draft', 'seed') RETURNING id`);
      await pool.query('UPDATE skill SET embedding = NULL WHERE id = $1', [sk[0].id]);
      let captured = '';
      const out = await runAdmin(pool, ['embed'], {
        embedder: { embed: async (t: string) => { captured = t; return [3, 4]; } },
      });
      expect(out).toContain('skill');
      const v = await pool.query<{ embedding: string | null }>('SELECT embedding::text FROM skill WHERE id=$1', [sk[0].id]);
      expect(v.rows[0].embedding).toBe('[3,4]');
      expect(captured).toContain('backfill-skill');
      expect(captured).toContain('技能描述');
      expect(captured).toContain('步骤正文');
    });

    it('知识全有向量但 skill 缺向量时仍回填 skill', async () => {
      const { rows: sk } = await pool.query<{ id: number }>(
        `INSERT INTO skill (name, description, instructions, status, author)
         VALUES ('only-skill-missing', '描述', '正文', 'draft', 'seed') RETURNING id`);
      const out = await runAdmin(pool, ['embed'], {
        embedder: { embed: async () => [7, 7] },
      });
      expect(out).toContain('skill');
      const v = await pool.query<{ embedding: string | null }>('SELECT embedding::text FROM skill WHERE id=$1', [sk[0].id]);
      expect(v.rows[0].embedding).toBe('[7,7]');
    });
  });

  describe('迁移工具：reset-token / listusers --legacy / history', () => {
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');

    it('resetToken 换发令牌：旧 token 失效、新 token 命中、返回值 ≠ 用户名', async () => {
      await pool.query(`INSERT INTO app_user (username, token_hash, role) VALUES ('carol', $1, 'user')`, [sha('carol-old')]);
      const token = await resetToken(pool, 'carol');
      expect(token).not.toBe('carol');
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      // verifyOnly 模式仅校验：旧 token 401，新 token 命中
      expect(await authenticate(pool, 'carol-old', { verifyOnly: true })).toBeNull();
      expect(await authenticate(pool, token, { verifyOnly: true })).toMatchObject({ username: 'carol' });
      await expect(resetToken(pool, 'no-such-user')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('listLegacyUsers 识别名字即令牌的存量用户；resetToken 后消失', async () => {
      await pool.query(
        `INSERT INTO app_user (username, token_hash) VALUES ('legacy-bob', $1), ('modern-amy', $2)`,
        [sha('legacy-bob'), sha('some-random-plain-token')],
      );
      expect(await listLegacyUsers(pool)).toEqual(['legacy-bob']);
      await resetToken(pool, 'legacy-bob');
      expect(await listLegacyUsers(pool)).toEqual([]);
    });

    it('listRevisions 返回修订行（不含 snapshot），created_at DESC，skill 名解析正确', async () => {
      const { rows: k } = await pool.query<{ id: number }>(
        `INSERT INTO knowledge (title, symptom, solution, domain, scope, author)
         VALUES ('修订条目', 'x', 'y', 'java', 'demo-app', 'a') RETURNING id`);
      const id = Number(k[0].id);
      await pool.query('DELETE FROM entry_revision WHERE entry_kind = $1 AND entry_id = $2', ['knowledge', id]);
      await pool.query(
        `INSERT INTO entry_revision (entry_kind, entry_id, version, kind, changed_by, changes, snapshot, created_at)
         VALUES ('knowledge', $1, 2, 'content', 'alice', '{"symptom":"新现象"}', '{}', now() - interval '1 hour'),
                ('knowledge', $1, 3, 'status', 'bob', '{"status":"verified"}', '{}', now())`,
        [id],
      );
      const revs = await listRevisions(pool, 'knowledge', id);
      expect(revs).toHaveLength(2);
      expect(revs[0]).toMatchObject({ version: 3, kind: 'status', changed_by: 'bob' });
      expect(revs[1]).toMatchObject({ version: 2, kind: 'content', changed_by: 'alice', changes: { symptom: '新现象' } });
      expect(revs[0]).not.toHaveProperty('snapshot');

      const name = `hist-skill-${Date.now()}`;
      const { rows: s } = await pool.query<{ id: number }>(
        `INSERT INTO skill (name, description, instructions, status, author)
         VALUES ($1, 'd', 'i', 'draft', 'seed') RETURNING id`, [name]);
      await pool.query(
        `INSERT INTO entry_revision (entry_kind, entry_id, version, kind, changed_by, changes, snapshot)
         VALUES ('skill', $1, 2, 'content', 'carl', '{"instructions":"新步骤"}', '{}')`,
        [s[0].id],
      );
      const srevs = await listRevisions(pool, 'skill', name);
      expect(srevs).toHaveLength(1);
      expect(srevs[0]).toMatchObject({ version: 2, kind: 'content', changed_by: 'carl' });
    });

    it('listRevisions 不存在的 skill 名 → NOT_FOUND；knowledge id 允许查历史（条目已删仍返回修订行）', async () => {
      // knowledge id 不存在（含条目已删除）→ 修订行按 spec「供追溯」保留，history 仍返回
      expect(await listRevisions(pool, 'knowledge', 999999)).toEqual([]);
      await expect(listRevisions(pool, 'skill', 'no-such-skill-hist')).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const { rows: k } = await pool.query<{ id: number }>(
        `INSERT INTO knowledge (title, symptom, solution, domain, scope, author)
         VALUES ('待删条目', 'x', 'y', 'java', 'demo-app', 'a') RETURNING id`);
      const id = Number(k[0].id);
      await pool.query(
        `INSERT INTO entry_revision (entry_kind, entry_id, version, kind, changed_by, changes, snapshot)
         VALUES ('knowledge', $1, 2, 'content', 'alice', '{"symptom":"旧现象"}', '{}')`,
        [id],
      );
      await pool.query('DELETE FROM knowledge WHERE id = $1', [id]);
      const revs = await listRevisions(pool, 'knowledge', id);
      expect(revs).toHaveLength(1);
      expect(revs[0]).toMatchObject({ version: 2, kind: 'content', changed_by: 'alice' });
    });

    it('listRevisions 同 created_at 时按 id DESC 兜底排序', async () => {
      const { rows: k } = await pool.query<{ id: number }>(
        `INSERT INTO knowledge (title, symptom, solution, domain, scope, author)
         VALUES ('同时间修订', 'x', 'y', 'java', 'demo-app', 'a') RETURNING id`);
      const id = Number(k[0].id);
      await pool.query('DELETE FROM entry_revision WHERE entry_kind = $1 AND entry_id = $2', ['knowledge', id]);
      await pool.query(
        `INSERT INTO entry_revision (entry_kind, entry_id, version, kind, changed_by, changes, snapshot, created_at)
         VALUES ('knowledge', $1, 1, 'content', 'alice', '{}', '{}', now()),
                ('knowledge', $1, 2, 'content', 'bob', '{}', '{}', now())`,
        [id],
      );
      const revs = await listRevisions(pool, 'knowledge', id);
      expect(revs.map((r) => r.version)).toEqual([2, 1]);
    });

    it('CLI: reset-token / listusers --legacy / history <id> / history --skill <name>', async () => {
      await pool.query(`INSERT INTO app_user (username, token_hash) VALUES ('cli-dave', $1)`, [sha('cli-dave')]);
      const out = await runAdmin(pool, ['reset-token', 'cli-dave']);
      expect(out).toContain('cli-dave');
      const token = out.trim().split('\n').pop()!.trim();
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(await authenticate(pool, token, { verifyOnly: true })).toMatchObject({ username: 'cli-dave' });

      // listusers --legacy：dave 已重置不在列；再造一个 legacy 用户可见
      await pool.query(`INSERT INTO app_user (username, token_hash) VALUES ('cli-erin', $1)`, [sha('cli-erin')]);
      expect(await runAdmin(pool, ['listusers', '--legacy'])).toContain('cli-erin');
      expect(await runAdmin(pool, ['listusers', '--legacy'])).not.toContain('cli-dave');
      // 不带 --legacy 行为不变
      expect(await runAdmin(pool, ['listusers'])).toContain('cli-erin');

      const { rows: k } = await pool.query<{ id: number }>(
        `INSERT INTO knowledge (title, symptom, solution, domain, scope, author)
         VALUES ('CLI修订条目', 'x', 'y', 'java', 'demo-app', 'a') RETURNING id`);
      const id = Number(k[0].id);
      await pool.query('DELETE FROM entry_revision WHERE entry_kind = $1 AND entry_id = $2', ['knowledge', id]);
      await pool.query(
        `INSERT INTO entry_revision (entry_kind, entry_id, version, kind, changed_by, changes, snapshot)
         VALUES ('knowledge', $1, 2, 'content', 'alice', '{"symptom":"新现象"}', '{}')`,
        [id],
      );
      const histOut = await runAdmin(pool, ['history', String(id)]);
      expect(histOut).toContain('v2');
      expect(histOut).toContain('alice');
      expect(histOut).toContain('新现象');

      const sname = `hist-cli-skill-${Date.now()}`;
      const { rows: s } = await pool.query<{ id: number }>(
        `INSERT INTO skill (name, description, instructions, status, author)
         VALUES ($1, 'd', 'i', 'draft', 'seed') RETURNING id`, [sname]);
      await pool.query(
        `INSERT INTO entry_revision (entry_kind, entry_id, version, kind, changed_by, changes, snapshot)
         VALUES ('skill', $1, 4, 'status', 'admin', '{"status":"verified"}', '{}')`,
        [s[0].id],
      );
      const skillHist = await runAdmin(pool, ['history', '--skill', sname]);
      expect(skillHist).toContain('v4');
      expect(skillHist).toContain('admin');
      expect(skillHist).toContain('verified');
    });
  });
});
