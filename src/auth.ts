import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from './db.js';

export interface AppUser {
  username: string;
  role: 'user' | 'admin';
}

/** authenticate 结果；自报注册分支一次性携带明文 identityToken（命中/禁用路径不携带） */
export interface AuthResult extends AppUser {
  identityToken?: string;
}

/** sha256 十六进制摘要：token 存库统一走此哈希（admin 工具比对存量用户也复用） */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 自报身份名格式：字母/数字开头，可含 . _ -，总长 ≤40 */
const IDENTITY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;

export interface AuthOptions {
  /** 兜底：配置后，新身份首次注册必须携带对口令（joinHeader）；已注册身份不受影响 */
  joinSecret?: string;
  joinHeader?: string;
  /** 仅校验模式（门户 /api）：跳过自报注册分支，未知/格式不合法/被禁用 token 一律 null 且不写库 */
  verifyOnly?: boolean;
}

export async function authenticate(pool: Pool, bearer: string | undefined, opts: AuthOptions = {}): Promise<AuthResult | null> {
  if (!bearer) return null;
  const hash = tokenHash(bearer);
  const { rows } = await pool.query<{ username: string; role: string; enabled: boolean }>(
    `SELECT username, role, enabled FROM app_user
     WHERE token_hash = $1`,
    [hash],
  );
  if (rows.length) {
    // 禁用账号的 token 永久封禁：不允许借"自报身份"绕过 disable
    if (!rows[0].enabled) return null;
    return { username: rows[0].username, role: rows[0].role === 'admin' ? 'admin' : 'user' };
  }

  // 未知 token → 尝试自报身份注册（开放接入模式，spec 修订 2026-11-15；verifyOnly 跳过，门户不注册）
  if (opts.verifyOnly) return null;
  if (!IDENTITY_RE.test(bearer)) return null;
  if (opts.joinSecret !== undefined && opts.joinHeader !== opts.joinSecret) return null;

  // 用户名已被占用（含被禁用账号）且 token 不同 → 拒绝，不覆盖管理员建号
  const taken = await pool.query<{ enabled: boolean }>('SELECT enabled FROM app_user WHERE username = $1', [bearer]);
  if (taken.rowCount) return null;

  // 随机访问令牌：Bearer 名降级为署名，凭证是注册时一次性返回的 identityToken
  const identityToken = randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO app_user (username, token_hash, role, enabled) VALUES ($1, $2, 'user', true)`,
    [bearer, tokenHash(identityToken)],
  );
  return { username: bearer, role: 'user', identityToken };
}

/** 内存滑动窗口限流（按 key，默认按 token），多实例部署下为近似限流（spec §八）。 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private maxPerMin: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (arr.length >= this.maxPerMin) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}
