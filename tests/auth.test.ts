import { describe, expect, it, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { authenticate, RateLimiter } from '../src/auth.js';
import { applyMigrations, createPool } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);

async function seedUser(username: string, token: string, role: string, enabled: boolean) {
  await pool.query(
    `INSERT INTO app_user (username, token_hash, role, enabled) VALUES ($1,$2,$3,$4)
     ON CONFLICT (username) DO UPDATE SET token_hash = $2, role = $3, enabled = $4`,
    [username, createHash('sha256').update(token).digest('hex'), role, enabled],
  );
}

beforeEach(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE app_user RESTART IDENTITY CASCADE');
  await seedUser('alice', 'alice-token', 'user', true);
  await seedUser('bob', 'bob-token', 'admin', true);
  await seedUser('carol', 'carol-token', 'user', false);
});

describe('authenticate', () => {
  it('有效 token → 返回用户与角色', async () => {
    const u = await authenticate(pool, 'alice-token');
    expect(u).toEqual({ username: 'alice', role: 'user' });
  });

  it('admin 角色', async () => {
    const u = await authenticate(pool, 'bob-token');
    expect(u).toEqual({ username: 'bob', role: 'admin' });
  });

  it('非法身份格式的 token → null（开放模式下未知 token 视为自报身份，见下方用例）', async () => {
    expect(await authenticate(pool, 'wrong token')).toBeNull();
    expect(await authenticate(pool, undefined)).toBeNull();
  });

  it('禁用用户 → null', async () => {
    expect(await authenticate(pool, 'carol-token')).toBeNull();
  });

  it('未知名 + 合法格式 + 无 joinSecret → 自动注册为 user，返回随机 identityToken，库里存的是其哈希', async () => {
    const u = await authenticate(pool, 'zhangsan');
    expect(u?.username).toBe('zhangsan');
    expect(u?.role).toBe('user');
    expect(u?.identityToken).toMatch(/^[0-9a-f]{32}$/);
    const { rows } = await pool.query(`SELECT role, enabled, token_hash FROM app_user WHERE username = 'zhangsan'`);
    expect(rows[0].role).toBe('user');
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].token_hash).toBe(createHash('sha256').update(u!.identityToken!).digest('hex'));
    expect(rows[0].token_hash).not.toBe(createHash('sha256').update('zhangsan').digest('hex'));
  });

  it('用返回的 identityToken 再次调用 → 命中同一用户，不重复建号，且不再返回 identityToken', async () => {
    const first = await authenticate(pool, 'lisi');
    const token = first!.identityToken!;
    const u = await authenticate(pool, token);
    expect(u).toEqual({ username: 'lisi', role: 'user' });
    const { rowCount } = await pool.query(`SELECT 1 FROM app_user WHERE username = 'lisi'`);
    expect(rowCount).toBe(1);
  });

  it('注册后再次用名字本身调用 → null（用户名占用检查拒绝）', async () => {
    await authenticate(pool, 'lisi');
    expect(await authenticate(pool, 'lisi')).toBeNull();
  });

  it('joinSecret 缺失时注册被拒（回归确认）', async () => {
    expect(await authenticate(pool, 'qianba', { joinSecret: 'team-secret' })).toBeNull();
    const { rowCount } = await pool.query(`SELECT 1 FROM app_user WHERE username = 'qianba'`);
    expect(rowCount).toBe(0);
  });

  it('身份名含非法字符 → null 且不建号', async () => {
    expect(await authenticate(pool, '张三!')).toBeNull();
    expect(await authenticate(pool, '-badstart')).toBeNull();
    expect(await authenticate(pool, 'a'.repeat(41))).toBeNull();
    const { rowCount } = await pool.query(`SELECT 1 FROM app_user WHERE username IN ('张三!', '-badstart')`);
    expect(rowCount).toBe(0);
  });

  it('joinSecret 已配置且口令不符/缺失 → null 且不建号', async () => {
    const opts = { joinSecret: 'team-secret' };
    expect(await authenticate(pool, 'wangwu', opts)).toBeNull();
    expect(await authenticate(pool, 'wangwu', { joinSecret: 'team-secret', joinHeader: 'wrong' })).toBeNull();
    const { rowCount } = await pool.query(`SELECT 1 FROM app_user WHERE username = 'wangwu'`);
    expect(rowCount).toBe(0);
  });

  it('joinSecret 已配置且口令正确 → 注册成功并返回 identityToken', async () => {
    const u = await authenticate(pool, 'zhaoliu', { joinSecret: 'team-secret', joinHeader: 'team-secret' });
    expect(u?.username).toBe('zhaoliu');
    expect(u?.role).toBe('user');
    expect(u?.identityToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('已注册 token 命中路径不要求 joinSecret（identityToken 即凭证）', async () => {
    const first = await authenticate(pool, 'sunqi', { joinSecret: 'team-secret', joinHeader: 'team-secret' });
    const token = first!.identityToken!;
    const u = await authenticate(pool, token, { joinSecret: 'team-secret' });
    expect(u).toEqual({ username: 'sunqi', role: 'user' });
  });

  it('已有用户名被他人冒用（同名字不同 token）→ null 且不覆盖原 token', async () => {
    expect(await authenticate(pool, 'alice')).toBeNull();
    expect(await authenticate(pool, 'alice-token')).toEqual({ username: 'alice', role: 'user' });
  });

  it('被禁用账号的 token 永久封禁（不可借自报身份重新进入）', async () => {
    expect(await authenticate(pool, 'carol-token')).toBeNull();
    const { rowCount } = await pool.query(`SELECT 1 FROM app_user WHERE username = 'carol-token'`);
    expect(rowCount).toBe(0);
  });
});

describe('RateLimiter', () => {
  it('每分钟超限后拒绝，不同 key 互不影响', () => {
    const rl = new RateLimiter(3);
    expect(rl.allow('t1')).toBe(true);
    expect(rl.allow('t1')).toBe(true);
    expect(rl.allow('t1')).toBe(true);
    expect(rl.allow('t1')).toBe(false);
    expect(rl.allow('t2')).toBe(true);
  });
});

describe('authenticate verifyOnly（门户 /api 仅校验不注册）', () => {
  it('verifyOnly: 未知 token 返回 null 且不注册新用户', async () => {
    const u = await authenticate(pool, 'stranger-abc', { verifyOnly: true });
    expect(u).toBeNull();
    const { rowCount } = await pool.query(`SELECT 1 FROM app_user WHERE username = 'stranger-abc'`);
    expect(rowCount).toBe(0);
  });

  it('verifyOnly: 已注册 token 正常返回；禁用 token 仍为 null', async () => {
    expect(await authenticate(pool, 'alice-token', { verifyOnly: true })).toEqual({ username: 'alice', role: 'user' });
    expect(await authenticate(pool, 'carol-token', { verifyOnly: true })).toBeNull();
  });

  it('不带 verifyOnly 时未知 token 仍自报注册（MCP 行为不变）', async () => {
    const u = await authenticate(pool, 'wangwu');
    expect(u?.username).toBe('wangwu');
    expect(u?.role).toBe('user');
  });
});
