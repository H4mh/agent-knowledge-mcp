import { describe, expect, it, beforeEach } from 'vitest';
import {
  handleSaveSkill,
  handleUpdateSkill,
  handleGetSkill,
  validateSkillFiles,
  assembleSkillMd,
  SKILL_NAME_RE,
  type SaveSkillInput,
} from '../../src/tools/skill.js';
import { ToolError } from '../../src/tools/save.js';
import { loadConfig } from '../../src/config.js';
import { applyMigrations, createPool } from '../../src/db.js';
import { loadTagAliases } from '../../src/search/tags.js';
import { loadGuardRules } from '../../src/guard/index.js';
import { join } from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);
const cfg = loadConfig({ DATABASE_URL: 'postgres://unused' });
const user = { username: 'alice', role: 'user' as const };
const aliases = loadTagAliases(join(process.cwd(), 'config', 'tag-aliases.json'));
const guardRules = loadGuardRules(join(process.cwd(), 'config', 'guard-rules.json'));
const deps = { aliases, guardRules };

const baseInput: SaveSkillInput = {
  name: 'pdf-export',
  description: '导出 PDF 报表的通用流程',
  instructions: '使用 puppeteer 将 HTML 渲染为 PDF 并上传附件目录',
  tags: ['pdf'],
};

beforeEach(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE skill, skill_usage, entry_revision RESTART IDENTITY CASCADE');
});

describe('SKILL_NAME_RE', () => {
  it('合法名通过：小写字母数字与连字符，2-64 位', () => {
    expect(SKILL_NAME_RE.test('pdf-export')).toBe(true);
    expect(SKILL_NAME_RE.test('a1')).toBe(true);
  });
  it('大写、下划线、单字符不通过', () => {
    expect(SKILL_NAME_RE.test('Pdf-Export')).toBe(false);
    expect(SKILL_NAME_RE.test('pdf_export')).toBe(false);
    expect(SKILL_NAME_RE.test('a')).toBe(false);
  });
});

describe('assembleSkillMd', () => {
  it('生成 frontmatter + 正文的 SKILL.md 文本', () => {
    expect(assembleSkillMd('pdf-export', '导出 PDF', '第一步…')).toBe(
      '---\nname: pdf-export\ndescription: 导出 PDF\n---\n\n第一步…',
    );
  });
});

describe('validateSkillFiles', () => {
  it('合法文件列表原样返回', () => {
    const files = [
      { path: 'scripts/render.js', content: 'console.log(1)' },
      { path: 'README.txt', content: '说明' },
    ];
    expect(validateSkillFiles(files)).toEqual(files);
  });

  it.each(['../evil.txt', '/etc/passwd', 'a\\b.txt', 'SKILL.md', 'docs/SKILL.md'])(
    'path 非法(%s) → INVALID_SKILL_FILE',
    (path) => {
      const err = (() => {
        try {
          validateSkillFiles([{ path, content: 'x' }]);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('INVALID_SKILL_FILE');
    },
  );

  it('超过 20 个文件拒绝，20 个通过', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f${i}.txt`, content: 'x' }));
    expect(validateSkillFiles(mk(20)).length).toBe(20);
    expect(() => validateSkillFiles(mk(21))).toThrowError(expect.objectContaining({ code: 'INVALID_SKILL_FILE' }));
  });

  it('单文件 65536 字节通过，65537 拒绝（按字节算，非字符数）', () => {
    expect(validateSkillFiles([{ path: 'big.txt', content: 'a'.repeat(65536) }]).length).toBe(1);
    expect(() => validateSkillFiles([{ path: 'big.txt', content: 'a'.repeat(65537) }])).toThrowError(
      expect.objectContaining({ code: 'INVALID_SKILL_FILE' }),
    );
  });

  it('总量超过 262144 字节拒绝', () => {
    const half = 'a'.repeat(131073);
    expect(() => validateSkillFiles([{ path: 'a.txt', content: half }, { path: 'b.txt', content: half }])).toThrowError(
      expect.objectContaining({ code: 'INVALID_SKILL_FILE' }),
    );
  });
});

describe('handleSaveSkill', () => {
  it('合法保存 → draft + similar 为空 + 无警告，落库字段正确', async () => {
    const r = await handleSaveSkill(pool, cfg, user, { ...baseInput, tags: ['达梦', 'vue'] }, deps);
    expect(r.status).toBe('draft');
    expect(r.similar).toEqual([]);
    expect(r.warnings).toEqual([]);
    const db = await pool.query<{ author: string; tags: string[]; scope: string | null; files: unknown }>(
      'SELECT author, tags, scope, files FROM skill WHERE id = $1',
      [r.id],
    );
    expect(db.rows[0].author).toBe('alice');
    expect(db.rows[0].tags).toEqual(['dameng', 'vue']);
    expect(db.rows[0].scope).toBeNull();
    expect(db.rows[0].files).toEqual([]);
  });

  it('name 大写 / 含下划线 → INVALID_SKILL_NAME，不入库', async () => {
    for (const name of ['Pdf-Export', 'pdf_export']) {
      const err = await handleSaveSkill(pool, cfg, user, { ...baseInput, name }, deps).catch((e) => e);
      expect(err).toBeInstanceOf(ToolError);
      expect(err.code).toBe('INVALID_SKILL_NAME');
    }
    const { rowCount } = await pool.query('SELECT 1 FROM skill');
    expect(rowCount).toBe(0);
  });

  it.each(['../evil.txt', '/etc/passwd', 'a\\b.txt', 'SKILL.md'])(
    'handleSaveSkill 内 files path 非法(%s) → INVALID_SKILL_FILE',
    async (path) => {
      const err = await handleSaveSkill(pool, cfg, user, { ...baseInput, files: [{ path, content: 'x' }] }, deps).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(ToolError);
      expect(err.code).toBe('INVALID_SKILL_FILE');
    },
  );

  it('同名 skill 已存在 → SKILL_EXISTS', async () => {
    await handleSaveSkill(pool, cfg, user, baseInput, deps);
    const err = await handleSaveSkill(pool, cfg, user, baseInput, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('SKILL_EXISTS');
    expect(err.message).toContain('update_skill');
  });

  it('敏感内容（instructions 或文件）→ SENSITIVE_CONTENT，不入库', async () => {
    const err = await handleSaveSkill(
      pool,
      cfg,
      user,
      { ...baseInput, instructions: '先读取 -----BEGIN RSA PRIVATE KEY----- 中的密钥' },
      deps,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('SENSITIVE_CONTENT');
    const err2 = await handleSaveSkill(
      pool,
      cfg,
      user,
      { ...baseInput, files: [{ path: 'key.txt', content: '-----BEGIN RSA PRIVATE KEY-----' }] },
      deps,
    ).catch((e) => e);
    expect(err2).toBeInstanceOf(ToolError);
    expect(err2.code).toBe('SENSITIVE_CONTENT');
    const { rowCount } = await pool.query('SELECT 1 FROM skill');
    expect(rowCount).toBe(0);
  });

  it('未注册 scope（无论格式是否合法）→ INVALID_SCOPE，提示须为已注册 scope，不自动注册', async () => {
    const willRegister = `autoscope-skill-${Date.now()}`;
    const err = await handleSaveSkill(pool, cfg, user, { ...baseInput, scope: willRegister }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('INVALID_SCOPE');
    expect(err.message).toContain('已注册');
    const { rowCount } = await pool.query('SELECT 1 FROM scope_registry WHERE scope = $1', [willRegister]);
    expect(rowCount).toBe(0);
    const err2 = await handleSaveSkill(pool, cfg, user, { ...baseInput, scope: '非法 scope！' }, deps).catch((e) => e);
    expect(err2).toBeInstanceOf(ToolError);
    expect(err2.code).toBe('INVALID_SCOPE');
    expect(err2.message).toContain('demo-app');
  });

  it('已禁用 scope → INVALID_SCOPE（提示禁用）', async () => {
    await pool.query(
      'INSERT INTO scope_registry (scope, enabled) VALUES ($1, false) ON CONFLICT (scope) DO UPDATE SET enabled = false',
      ['autoscope-skill-dis'],
    );
    const err = await handleSaveSkill(pool, cfg, user, { ...baseInput, scope: 'autoscope-skill-dis' }, deps).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('INVALID_SCOPE');
    expect(err.message).toContain('禁用');
  });

  it('已注册 scope → 正常保存并关联 scope', async () => {
    const r = await handleSaveSkill(pool, cfg, user, { ...baseInput, scope: 'demo-app' }, deps);
    expect(r.status).toBe('draft');
    const db = await pool.query<{ scope: string | null }>('SELECT scope FROM skill WHERE id = $1', [r.id]);
    expect(db.rows[0].scope).toBe('demo-app');
  });

  it('相似 skill（低阈值）→ similar 提示，最多 3 条，排除同名', async () => {
    const lowCfg = loadConfig({ DATABASE_URL: 'postgres://unused', DEDUP_THRESHOLD: '0.1' });
    await pool.query(
      `INSERT INTO skill (name, description, instructions, author) VALUES
       ('pdf-export-guide', '导出 PDF 报表的通用流程手册', '见正文', 'seed'),
       ('pdf-export-faq', '导出 PDF 报表常见问题', '见正文', 'seed'),
       ('pdf-export-tips', '导出 PDF 报表的小技巧', '见正文', 'seed'),
       ('pdf-export-notes', '导出 PDF 报表的注意事项', '见正文', 'seed'),
       ('unrelated-skill', '完全无关的技能', '见正文', 'seed')`,
    );
    const r = await handleSaveSkill(pool, lowCfg, user, baseInput, deps);
    expect(r.similar.length).toBe(3);
    expect(r.similar.every((s) => s.name !== 'pdf-export')).toBe(true);
    expect(r.similar[0].similarity).toBeGreaterThanOrEqual(r.similar[2].similarity);
  });

  it('配置向量模型 → 以 name+description+instructions 生成 embedding 并写入', async () => {
    const embedder = { embed: async (t: string) => (t.startsWith('pdf-export') ? [0.5, 0.6] : [0, 0]) };
    const r = await handleSaveSkill(pool, cfg, user, baseInput, { ...deps, embedder });
    const { rows } = await pool.query<{ embedding: string | null }>(
      'SELECT embedding::text FROM skill WHERE id = $1',
      [r.id],
    );
    expect(rows[0].embedding).toBe('[0.5,0.6]');
  });

  it('向量服务不可用 → 入库不受阻，警告送达，embedding 为空', async () => {
    const embedder = { embed: async () => { throw new Error('服务挂了'); } };
    const r = await handleSaveSkill(pool, cfg, user, baseInput, { ...deps, embedder });
    expect(r.status).toBe('draft');
    expect(r.warnings.join('')).toContain('向量');
    const { rows } = await pool.query<{ embedding: string | null }>(
      'SELECT embedding::text FROM skill WHERE id = $1',
      [r.id],
    );
    expect(rows[0].embedding).toBeNull();
  });
});

describe('handleUpdateSkill / handleGetSkill', () => {
  const bob = { username: 'bob', role: 'user' as const };
  const carol = { username: 'carol', role: 'user' as const };
  const admin = { username: 'root', role: 'admin' as const };

  async function savePdf() {
    return handleSaveSkill(pool, cfg, user, baseInput, deps);
  }

  it('作者 update：files 整体替换（旧文件消失、新文件在）+ version+1', async () => {
    await savePdf();
    const r = await handleUpdateSkill(pool, user, {
      name: 'pdf-export',
      files: [{ path: 'scripts/render.js', content: 'console.log(1)' }],
    }, deps);
    expect(r).toEqual({ ok: true, version: 2 });
    const db = await pool.query<{ files: { path: string; content: string }[]; version: number }>(
      'SELECT files, version FROM skill WHERE name = $1',
      ['pdf-export'],
    );
    expect(db.rows[0].files).toEqual([{ path: 'scripts/render.js', content: 'console.log(1)' }]);
    expect(db.rows[0].version).toBe(2);
  });

  it('非作者 update → FORBIDDEN；不存在的 skill → NOT_FOUND', async () => {
    await savePdf();
    const err = await handleUpdateSkill(pool, bob, { name: 'pdf-export', description: '改描述' }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toContain('仅作者或管理员可修改');
    const err2 = await handleUpdateSkill(pool, user, { name: 'no-such-skill', description: 'x' }, deps).catch((e) => e);
    expect(err2).toBeInstanceOf(ToolError);
    expect(err2.code).toBe('NOT_FOUND');
  });

  it('admin（role admin）可修改他人 skill', async () => {
    await savePdf();
    const r = await handleUpdateSkill(pool, admin, { name: 'pdf-export', instructions: '新正文' }, deps);
    expect(r.ok).toBe(true);
    expect(r.version).toBe(2);
    const db = await pool.query<{ instructions: string }>('SELECT instructions FROM skill WHERE name = $1', [
      'pdf-export',
    ]);
    expect(db.rows[0].instructions).toBe('新正文');
  });

  it('未提供字段保留原值，内容无实际变化时 version 不变', async () => {
    const saved = await savePdf();
    const r = await handleUpdateSkill(pool, user, { name: 'pdf-export', tags: ['PDF'] }, deps);
    expect(r).toEqual({ ok: true, version: 1 });
    const db = await pool.query<{ description: string; instructions: string; tags: string[]; version: number }>(
      'SELECT description, instructions, tags, version FROM skill WHERE id = $1',
      [saved.id],
    );
    expect(db.rows[0].description).toBe(baseInput.description);
    expect(db.rows[0].instructions).toBe(baseInput.instructions);
    expect(db.rows[0].tags).toEqual(['pdf']);
    expect(db.rows[0].version).toBe(1);
  });

  it('内容实际变化 → 重算 embedding；向量失败 → 保留旧向量且不阻塞', async () => {
    const saved = await savePdf();
    const embedder = { embed: async (t: string) => (t.includes('新描述') ? [0.9, 0.1] : [0.5, 0.6]) };
    await handleUpdateSkill(pool, user, { name: 'pdf-export', description: '新描述' }, { ...deps, embedder });
    const db = await pool.query<{ embedding: string | null }>('SELECT embedding::text embedding FROM skill WHERE id = $1', [
      saved.id,
    ]);
    expect(db.rows[0].embedding).toBe('[0.9,0.1]');

    const badEmbedder = { embed: async () => { throw new Error('服务挂了'); } };
    const r = await handleUpdateSkill(pool, user, { name: 'pdf-export', description: '再改一次' }, {
      ...deps,
      embedder: badEmbedder,
    });
    expect(r.ok).toBe(true);
    const db2 = await pool.query<{ embedding: string | null }>('SELECT embedding::text embedding FROM skill WHERE id = $1', [
      saved.id,
    ]);
    expect(db2.rows[0].embedding).toBe('[0.9,0.1]');
  });

  it('get 返回 SKILL.md 组装 frontmatter（含 name/description 行）+ 附加文件', async () => {
    await handleSaveSkill(pool, cfg, user, { ...baseInput, files: [{ path: 'scripts/render.js', content: 'console.log(1)' }] }, deps);
    const r = await handleGetSkill(pool, bob, 'pdf-export');
    expect(r.name).toBe('pdf-export');
    expect(r.description).toBe(baseInput.description);
    expect(r.version).toBe(1);
    expect(r.status).toBe('draft');
    expect(r.files[0].path).toBe('SKILL.md');
    expect(r.files[0].content).toContain('name: pdf-export');
    expect(r.files[0].content).toContain(`description: ${baseInput.description}`);
    expect(r.files[0].content).toContain(baseInput.instructions);
    expect(r.files[1]).toEqual({ path: 'scripts/render.js', content: 'console.log(1)' });
    expect(r.files).toHaveLength(2);
  });

  it('同一 user 两次 get → use_count=1（幂等）', async () => {
    const saved = await savePdf();
    await handleGetSkill(pool, bob, 'pdf-export');
    await handleGetSkill(pool, bob, 'pdf-export');
    const db = await pool.query<{ use_count: number }>('SELECT use_count FROM skill WHERE id = $1', [saved.id]);
    expect(db.rows[0].use_count).toBe(1);
  });

  it('两个不同非作者 user get → status=verified，且写 kind=status 修订行（version 不变）', async () => {
    const saved = await savePdf();
    const first = await handleGetSkill(pool, bob, 'pdf-export');
    expect(first.status).toBe('draft');
    const second = await handleGetSkill(pool, carol, 'pdf-export');
    expect(second.status).toBe('verified');
    const db = await pool.query<{ status: string; use_count: number; version: number }>(
      'SELECT status, use_count, version FROM skill WHERE id = $1',
      [saved.id],
    );
    expect(db.rows[0].status).toBe('verified');
    expect(db.rows[0].use_count).toBe(2);
    // 自动晋升写修订：changed_by=触发晋升的拉取者，changes=旧状态，version 不变
    const rev = await pool.query<{
      version: number; kind: string; changed_by: string;
      changes: Record<string, unknown>; snapshot: Record<string, unknown>;
    }>(
      `SELECT version, kind, changed_by, changes, snapshot
       FROM entry_revision WHERE entry_kind = 'skill' AND entry_id = $1`,
      [saved.id],
    );
    expect(rev.rowCount).toBe(1);
    expect(rev.rows[0]).toMatchObject({
      kind: 'status',
      changed_by: 'carol',
      version: 1,
      changes: { status: 'draft' },
    });
    expect(rev.rows[0].snapshot).toMatchObject({ id: String(saved.id), status: 'draft' });
    expect(db.rows[0].version).toBe(1);
  });

  it('get 不存在的 skill → NOT_FOUND', async () => {
    const err = await handleGetSkill(pool, user, 'no-such-skill').catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('update 传敏感内容（instructions/description/文件）→ SENSITIVE_CONTENT，不入库', async () => {
    await savePdf();
    for (const patch of [
      { instructions: '先读取 -----BEGIN RSA PRIVATE KEY----- 中的密钥' },
      { description: '密钥见 -----BEGIN RSA PRIVATE KEY-----' },
      { files: [{ path: 'key.txt', content: '-----BEGIN RSA PRIVATE KEY-----' }] },
    ]) {
      const err = await handleUpdateSkill(pool, user, { name: 'pdf-export', ...patch }, deps).catch((e) => e);
      expect(err).toBeInstanceOf(ToolError);
      expect(err.code).toBe('SENSITIVE_CONTENT');
      expect(err.message).toContain('内容含敏感信息');
    }
    const db = await pool.query<{ version: number }>('SELECT version FROM skill WHERE name = $1', ['pdf-export']);
    expect(db.rows[0].version).toBe(1);
  });

  it('update scope 未注册 → INVALID_SCOPE（不自动注册）；禁用 scope → INVALID_SCOPE', async () => {
    await savePdf();
    const depsWithCfg = { ...deps, cfg };
    const unregistered = `autoscope-upd-${Date.now()}`;
    const err = await handleUpdateSkill(pool, user, { name: 'pdf-export', scope: unregistered }, depsWithCfg).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('INVALID_SCOPE');
    expect(err.message).toContain('已注册');
    const { rowCount } = await pool.query('SELECT 1 FROM scope_registry WHERE scope = $1', [unregistered]);
    expect(rowCount).toBe(0);
    await pool.query(
      'INSERT INTO scope_registry (scope, enabled) VALUES ($1, false) ON CONFLICT (scope) DO UPDATE SET enabled = false',
      ['autoscope-upd-dis'],
    );
    const err2 = await handleUpdateSkill(pool, user, { name: 'pdf-export', scope: 'autoscope-upd-dis' }, depsWithCfg).catch(
      (e) => e,
    );
    expect(err2).toBeInstanceOf(ToolError);
    expect(err2.code).toBe('INVALID_SCOPE');
    expect(err2.message).toContain('禁用');
  });

  it('合法 update（含已注册 scope + 正常内容）不受影响', async () => {
    await savePdf();
    const r = await handleUpdateSkill(pool, user, { name: 'pdf-export', scope: 'demo-app', description: '更新后的描述' }, {
      ...deps,
      cfg,
    });
    expect(r).toEqual({ ok: true, version: 2 });
    const db = await pool.query<{ scope: string | null; description: string }>(
      'SELECT scope, description FROM skill WHERE name = $1',
      ['pdf-export'],
    );
    expect(db.rows[0].scope).toBe('demo-app');
    expect(db.rows[0].description).toBe('更新后的描述');
  });

  it('update files: [] → 清空全部附加文件（整体替换）+ version+1', async () => {
    await handleSaveSkill(pool, cfg, user, { ...baseInput, files: [{ path: 'a.txt', content: 'x' }] }, deps);
    const r = await handleUpdateSkill(pool, user, { name: 'pdf-export', files: [] }, deps);
    expect(r).toEqual({ ok: true, version: 2 });
    const db = await pool.query<{ files: { path: string }[] }>('SELECT files FROM skill WHERE name = $1', ['pdf-export']);
    expect(db.rows[0].files).toEqual([]);
  });

  it('update tags: [] → 清空全部 tags + version+1', async () => {
    await savePdf();
    const r = await handleUpdateSkill(pool, user, { name: 'pdf-export', tags: [] }, deps);
    expect(r).toEqual({ ok: true, version: 2 });
    const db = await pool.query<{ tags: string[] }>('SELECT tags FROM skill WHERE name = $1', ['pdf-export']);
    expect(db.rows[0].tags).toEqual([]);
  });

  it('update scope: null → 清空 scope（置 NULL）+ version+1；不触发已注册 scope 校验', async () => {
    await handleSaveSkill(pool, cfg, user, { ...baseInput, scope: 'demo-app' }, deps);
    const r = await handleUpdateSkill(pool, user, { name: 'pdf-export', scope: null }, { ...deps, cfg });
    expect(r).toEqual({ ok: true, version: 2 });
    const db = await pool.query<{ scope: string | null }>('SELECT scope FROM skill WHERE name = $1', ['pdf-export']);
    expect(db.rows[0].scope).toBeNull();
  });

  it('a) base_version 过期 → CONFLICT，主表未被修改且无新修订行', async () => {
    await savePdf();
    await handleUpdateSkill(pool, user, { name: 'pdf-export', description: 'v2 描述' }, deps); // v1→v2
    const err = await handleUpdateSkill(pool, user, {
      name: 'pdf-export',
      description: 'v3 描述',
      base_version: 1,
    }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toContain('版本冲突');
    expect(err.message).toContain('search_skills');
    expect(err.message).toContain('v2'); // 提示当前最新版本
    const db = await pool.query<{ description: string; version: number }>(
      'SELECT description, version FROM skill WHERE name = $1',
      ['pdf-export'],
    );
    expect(db.rows[0].description).toBe('v2 描述'); // 内容未变
    expect(db.rows[0].version).toBe(2); // version 未被失败尝试推进
    const { rowCount } = await pool.query("SELECT 1 FROM entry_revision WHERE entry_kind = 'skill'");
    expect(rowCount).toBe(1); // 仅首次成功更新写了修订行
  });

  it('a2) base_version 过期但提交内容为 no-op → 仍 CONFLICT（校验先于变更检测）', async () => {
    await savePdf();
    await handleUpdateSkill(pool, user, { name: 'pdf-export', description: 'v2 描述' }, deps); // v1→v2
    const err = await handleUpdateSkill(pool, user, {
      name: 'pdf-export',
      description: 'v2 描述', // 与当前值相同，本会是 no-op
      base_version: 1,
    }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('CONFLICT');
    const db = await pool.query<{ version: number }>('SELECT version FROM skill WHERE name = $1', ['pdf-export']);
    expect(db.rows[0].version).toBe(2);
    const { rowCount } = await pool.query("SELECT 1 FROM entry_revision WHERE entry_kind = 'skill'");
    expect(rowCount).toBe(1);
  });

  it('b) base_version 正确 → version+1，修订行 snapshot 为更新前整行（含 files JSON）', async () => {
    const saved = await handleSaveSkill(pool, cfg, user, { ...baseInput, files: [{ path: 'a.txt', content: 'x' }] }, deps);
    const r = await handleUpdateSkill(pool, user, {
      name: 'pdf-export',
      instructions: '新正文',
      base_version: 1,
    }, deps);
    expect(r).toEqual({ ok: true, version: 2 });
    const db = await pool.query<{ instructions: string; version: number }>(
      'SELECT instructions, version FROM skill WHERE id = $1',
      [saved.id],
    );
    expect(db.rows[0].instructions).toBe('新正文');
    expect(db.rows[0].version).toBe(2);
    const { rows: rev } = await pool.query<{
      entry_id: string; version: number; kind: string; changed_by: string;
      changes: Record<string, unknown>; snapshot: Record<string, unknown>;
    }>(
      `SELECT entry_id, version, kind, changed_by, changes, snapshot FROM entry_revision
       WHERE entry_kind = 'skill' AND entry_id = $1`,
      [saved.id],
    );
    expect(rev).toHaveLength(1);
    expect(Number(rev[0].version)).toBe(1); // 记录的是变更前版本
    expect(rev[0].kind).toBe('content');
    expect(rev[0].changed_by).toBe('alice');
    expect(rev[0].changes).toEqual({ instructions: baseInput.instructions });
    expect(rev[0].snapshot).toEqual(expect.objectContaining({
      id: String(saved.id), // pg BIGINT → string，JSONB 审计保持
      version: 1,
      author: 'alice',
      description: baseInput.description,
      instructions: baseInput.instructions,
      files: [{ path: 'a.txt', content: 'x' }],
      scope: null,
      tags: ['pdf'],
    }));
  });

  it('c) 提交相同值 → 无实际变化早返回，version 不变、不写修订行', async () => {
    await savePdf();
    const r = await handleUpdateSkill(pool, user, {
      name: 'pdf-export',
      description: baseInput.description,
      base_version: 1,
    }, deps);
    expect(r).toEqual({ ok: true, version: 1 });
    const db = await pool.query<{ version: number }>('SELECT version FROM skill WHERE name = $1', ['pdf-export']);
    expect(db.rows[0].version).toBe(1);
    const { rowCount } = await pool.query("SELECT 1 FROM entry_revision WHERE entry_kind = 'skill'");
    expect(rowCount).toBe(0);
  });

  it('d) scope: null 清空路径 → 照常写修订行（changes 含旧 scope）', async () => {
    await handleSaveSkill(pool, cfg, user, { ...baseInput, scope: 'demo-app' }, deps);
    const r = await handleUpdateSkill(pool, user, { name: 'pdf-export', scope: null }, { ...deps, cfg });
    expect(r).toEqual({ ok: true, version: 2 });
    const { rows: rev } = await pool.query<{ changes: Record<string, unknown>; kind: string }>(
      "SELECT changes, kind FROM entry_revision WHERE entry_kind = 'skill'",
    );
    expect(rev).toHaveLength(1);
    expect(rev[0].kind).toBe('content');
    expect(rev[0].changes).toEqual({ scope: 'demo-app' });
  });

  it('不带 base_version → 兼容旧调用，version+1 且写修订行', async () => {
    await savePdf();
    const r = await handleUpdateSkill(pool, user, { name: 'pdf-export', description: '新描述' }, deps);
    expect(r).toEqual({ ok: true, version: 2 });
    const { rowCount } = await pool.query("SELECT 1 FROM entry_revision WHERE entry_kind = 'skill'");
    expect(rowCount).toBe(1);
  });
});
