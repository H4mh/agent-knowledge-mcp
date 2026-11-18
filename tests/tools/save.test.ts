import { describe, expect, it, beforeEach } from 'vitest';
import { handleSave, ToolError } from '../../src/tools/save.js';
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

const baseInput = {
  title: 'MyBatis 分页失效',
  symptom: '分页查询返回全量数据',
  solution: '显式引入 pagehelper-spring-boot-starter 2.x',
  domain: 'java',
  scope: 'demo-app',
  tags: ['mybatis'],
};

beforeEach(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE knowledge RESTART IDENTITY CASCADE');
  await pool.query("DELETE FROM scope_registry WHERE scope LIKE 'autoscope-%' OR created_by IS NOT NULL");
});

describe('handleSave', () => {
  it('合法保存 → draft + 作者 + tag 归一化', async () => {
    const r = await handleSave(pool, cfg, user, { ...baseInput, tags: ['达梦', 'vue'] }, { aliases, guardRules });
    expect(r.status).toBe('draft');
    expect(r.similar).toEqual([]);
    const db = await pool.query<{ author: string; tags: string[] }>(
      'SELECT author, tags FROM knowledge WHERE id = $1', [r.id]);
    expect(db.rows[0].author).toBe('alice');
    expect(db.rows[0].tags).toEqual(['dameng', 'vue']);
  });

  it('未知 scope → INVALID_SCOPE，message 列出可用 scope', async () => {
    const err = await handleSave(pool, cfg, user, { ...baseInput, scope: '非法 scope！' }, { aliases, guardRules }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('INVALID_SCOPE');
    expect(err.message).toContain('demo-app');
    const { rowCount } = await pool.query("SELECT 1 FROM scope_registry WHERE scope = '非法 scope！'");
    expect(rowCount).toBe(0);
  });

  it('未注册合法 scope → 自动注册（记录 created_by）并保存成功', async () => {
    const scope = `autoscope-${Date.now()}`;
    const r = await handleSave(pool, cfg, user, { ...baseInput, scope }, { aliases, guardRules });
    expect(r.status).toBe('draft');
    expect(r.scopeRegistered).toBe(true);
    const { rows } = await pool.query<{ created_by: string; enabled: boolean }>(
      'SELECT created_by, enabled FROM scope_registry WHERE scope = $1', [scope]);
    expect(rows[0]).toEqual({ created_by: 'alice', enabled: true });
  });

  it('已禁用 scope → INVALID_SCOPE（提示禁用），不重新启用', async () => {
    const scope = `autoscope-dis-${Date.now()}`;
    await pool.query('INSERT INTO scope_registry (scope, enabled) VALUES ($1, false)', [scope]);
    const err = await handleSave(pool, cfg, user, { ...baseInput, scope }, { aliases, guardRules }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('INVALID_SCOPE');
    expect(err.message).toContain('禁用');
    const { rows } = await pool.query<{ enabled: boolean }>('SELECT enabled FROM scope_registry WHERE scope = $1', [scope]);
    expect(rows[0].enabled).toBe(false);
  });

  it('未知 domain → INVALID_DOMAIN', async () => {
    const err = await handleSave(pool, cfg, user, { ...baseInput, domain: 'rust' }, { aliases, guardRules }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('INVALID_DOMAIN');
  });

  it('私钥内容 → SENSITIVE_CONTENT，不入库', async () => {
    const err = await handleSave(pool, cfg, user, { ...baseInput, detail: '-----BEGIN RSA PRIVATE KEY-----' }, { aliases, guardRules }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('SENSITIVE_CONTENT');
    const { rows } = await pool.query('SELECT 1 FROM knowledge');
    expect(rows.length).toBe(0);
  });

  it('含内网 IP 的 solution → 正常入库，且警告送达', async () => {
    const r = await handleSave(pool, cfg, user, { ...baseInput, solution: 'Nexus 地址 10.0.0.5:8081，改 settings.xml' }, { aliases, guardRules });
    expect(r.status).toBe('draft');
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join('')).toContain('内网');
  });

  it('相似条目（同 scope）→ similar 提示', async () => {
    await handleSave(pool, cfg, user, baseInput, { aliases, guardRules });
    const r = await handleSave(pool, cfg, user, { ...baseInput, title: 'MyBatis 分页失效问题' }, { aliases, guardRules });
    expect(r.similar.length).toBeGreaterThan(0);
    expect(r.similar[0].title).toContain('MyBatis');
  });

  it('global 范围相似条目也命中提示', async () => {
    await handleSave(pool, cfg, user, { ...baseInput, scope: 'global' }, { aliases, guardRules });
    const r = await handleSave(pool, cfg, user, baseInput, { aliases, guardRules });
    expect(r.similar.length).toBeGreaterThan(0);
  });

  it('配置向量模型 → 保存后写入 embedding', async () => {
    const embedder = { embed: async (t: string) => t.includes('MyBatis') ? [0.5, 0.6] : [0, 0] };
    const r = await handleSave(pool, cfg, user, baseInput, { aliases, guardRules, embedder });
    const { rows } = await pool.query<{ embedding: string | null }>('SELECT embedding::text FROM knowledge WHERE id = $1', [r.id]);
    expect(rows[0].embedding).toBe('[0.5,0.6]');
  });

  it('向量服务不可用 → 入库不受阻，警告送达，embedding 为空', async () => {
    const embedder = { embed: async () => { throw new Error('服务挂了'); } };
    const r = await handleSave(pool, cfg, user, baseInput, { aliases, guardRules, embedder });
    expect(r.status).toBe('draft');
    expect(r.warnings.join('')).toContain('向量');
    const { rows } = await pool.query<{ embedding: string | null }>('SELECT embedding::text FROM knowledge WHERE id = $1', [r.id]);
    expect(rows[0].embedding).toBeNull();
  });

  it('AKM_SCOPE_OPEN=false → 未注册 scope 拒绝并提示联系管理员，不自动注册', async () => {
    const closed = loadConfig({ DATABASE_URL: 'postgres://unused', AKM_SCOPE_OPEN: 'false' });
    const scope = `closedscope-${Date.now()}`;
    const err = await handleSave(pool, closed, user, { ...baseInput, scope }, { aliases, guardRules }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('INVALID_SCOPE');
    expect(err.message).toContain('管理员');
    const { rowCount } = await pool.query('SELECT 1 FROM scope_registry WHERE scope = $1', [scope]);
    expect(rowCount).toBe(0);
  });

  it('AKM_SCOPE_OPEN=false → 已注册 scope 保存不受影响', async () => {
    const closed = loadConfig({ DATABASE_URL: 'postgres://unused', AKM_SCOPE_OPEN: 'false' });
    const r = await handleSave(pool, closed, user, baseInput, { aliases, guardRules });
    expect(r.status).toBe('draft');
    expect(r.scopeRegistered).toBe(false);
  });
});

describe('precheckSave（门户 dry-run 预检）', () => {
  it('不入库：返回 similar/warnings/scopeWillRegister，行数不变', async () => {
    const { precheckSave } = await import('../../src/tools/save.js');
    // 查重只看同 scope + global：种子条目直接种在待预检的 scope 下
    await pool.query(
      `INSERT INTO knowledge (title, symptom, solution, domain, scope, author)
       VALUES ('已存在的分页问题', '分页查询返回全量数据', '显式引入 pagehelper 2.x', 'java', 'autoscope-new1', 'seed')`);
    const countBefore = (await pool.query('SELECT count(*)::int AS c FROM knowledge')).rows[0].c;
    const r = await precheckSave(pool, cfg, {
      title: '分页问题再次出现', symptom: '分页查询返回全量数据', solution: '调整 pagehelper 配置',
      domain: 'java', scope: 'autoscope-new1', tags: [],
    }, { aliases, guardRules });
    expect(r.similar.length).toBeGreaterThanOrEqual(1);
    expect(r.scopeWillRegister).toBe(true);
    const countAfter = (await pool.query('SELECT count(*)::int AS c FROM knowledge')).rows[0].c;
    expect(countAfter).toBe(countBefore);
  });

  it('敏感内容抛 SENSITIVE_CONTENT；非法 domain 抛 INVALID_DOMAIN', async () => {
    const { precheckSave } = await import('../../src/tools/save.js');
    await expect(precheckSave(pool, cfg, {
      ...baseInput, solution: '私钥如下 -----BEGIN RSA PRIVATE KEY----- xxx', scope: 'demo-app',
    }, { aliases, guardRules })).rejects.toMatchObject({ code: 'SENSITIVE_CONTENT' });
    await expect(precheckSave(pool, cfg, {
      ...baseInput, domain: 'frontend3d', scope: 'demo-app',
    }, { aliases, guardRules })).rejects.toMatchObject({ code: 'INVALID_DOMAIN' });
  });

  it('已注册但禁用的 scope 抛 INVALID_SCOPE；scopeOpen=false 时未注册 scope 抛 INVALID_SCOPE', async () => {
    const { precheckSave } = await import('../../src/tools/save.js');
    await pool.query(`INSERT INTO scope_registry (scope, enabled) VALUES ('autoscope-off1', false) ON CONFLICT (scope) DO UPDATE SET enabled = false`);
    await expect(precheckSave(pool, cfg, { ...baseInput, scope: 'autoscope-off1' }, { aliases, guardRules }))
      .rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    const closedCfg = loadConfig({ DATABASE_URL: 'postgres://unused', AKM_SCOPE_OPEN: 'false' });
    await expect(precheckSave(pool, closedCfg, { ...baseInput, scope: 'autoscope-closed1' }, { aliases, guardRules }))
      .rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    // 清理：scope_registry 跨测试文件共享，残留会让 db.test 的"预置 5 个 scope"断言按调度时序偶发失败
    await pool.query(`DELETE FROM scope_registry WHERE scope IN ('autoscope-off1', 'autoscope-closed1')`);
  });
});
