import type { Pool } from '../db.js';
import type { Config } from '../config.js';
import type { AppUser } from '../auth.js';
import { normalizeTags } from '../search/tags.js';
import { scanText, type GuardRules } from '../guard/index.js';
import type { Embedder } from '../embedding/index.js';

export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const DOMAINS = ['java', 'frontend', 'mobile', 'infra', 'db', 'workflow'] as const;

export interface SaveInput {
  title: string;
  symptom: string;
  solution: string;
  detail?: string;
  domain: string;
  scope: string;
  module?: string;
  tags: string[];
  code_ref?: string;
}

export interface SaveDeps {
  aliases: Record<string, string>;
  guardRules: GuardRules;
  /** 可选向量生成器：配置了向量模型时传入，保存后写入 embedding；不可用时降级不阻塞 */
  embedder?: Embedder;
}

export interface SaveResult {
  id: number;
  status: 'draft';
  similar: { id: number; title: string; similarity: number }[];
  warnings: string[];
  scopeRegistered: boolean;
}

/** scope 名格式门槛（与派生自 git remote 的名字形态一致）；admin service / 门户 REST 复用 */
export const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;

/**
 * scope 校验（不写库）：返回判定结果，handleSave 据此决定注册或抛错；门户预检直接消费。
 * - enabled：已注册且启用
 * - disabled：已注册但被管理员禁用
 * - invalid-format：格式不合法
 * - closed：未注册且服务已关闭自动注册
 * - will-register：未注册、格式合法、自动注册开放（调用方可注册）
 */
export async function checkScope(
  pool: Pool,
  cfg: Config,
  scope: string,
): Promise<'enabled' | 'disabled' | 'invalid-format' | 'closed' | 'will-register'> {
  const scopeRow = await pool.query<{ enabled: boolean }>('SELECT enabled FROM scope_registry WHERE scope = $1', [scope]);
  if (scopeRow.rowCount) return scopeRow.rows[0].enabled ? 'enabled' : 'disabled';
  if (!SCOPE_RE.test(scope)) return 'invalid-format';
  if (!cfg.scopeOpen) return 'closed';
  return 'will-register';
}

/** 查重提示（同 scope + global），先查后插；门户预检复用 */
export async function findSimilar(
  pool: Pool,
  cfg: Config,
  title: string,
  symptom: string,
  solution: string,
  scope: string,
): Promise<SaveResult['similar']> {
  const dup = await pool.query<{ id: number; title: string; sim: number }>(
    `SELECT id, title,
            GREATEST(similarity(title,$1), similarity(symptom,$2), similarity(solution,$3)) AS sim
     FROM knowledge
     WHERE scope IN ($4, 'global') AND status <> 'deprecated'
       AND GREATEST(similarity(title,$1), similarity(symptom,$2), similarity(solution,$3)) >= $5
     ORDER BY sim DESC
     LIMIT 3`,
    [title, symptom, solution, scope, cfg.dedupThreshold],
  );
  return dup.rows.map((r) => ({ id: Number(r.id), title: r.title, similarity: Number(r.sim) }));
}

/**
 * 门户 dry-run 预检：跑完整校验链（scope/枚举/敏感/查重）但绝不写库。
 * 抛错语义与 handleSave 一致（INVALID_SCOPE / INVALID_DOMAIN / SENSITIVE_CONTENT）。
 */
export async function precheckSave(
  pool: Pool,
  cfg: Config,
  input: SaveInput,
  deps: SaveDeps,
): Promise<{ similar: SaveResult['similar']; warnings: string[]; scopeWillRegister: boolean }> {
  const sc = await checkScope(pool, cfg, input.scope);
  if (sc === 'disabled') throw new ToolError('INVALID_SCOPE', `scope ${input.scope} 已被管理员禁用`);
  if (sc === 'invalid-format') {
    const available = await pool.query<{ scope: string }>('SELECT scope FROM scope_registry WHERE enabled = true');
    throw new ToolError('INVALID_SCOPE', `未知 scope: ${input.scope}。可用: ${available.rows.map((r) => r.scope).join(', ')}`);
  }
  if (sc === 'closed') {
    throw new ToolError(
      'INVALID_SCOPE',
      `scope ${input.scope} 未注册，且本服务已关闭自动注册（AKM_SCOPE_OPEN=false）。请联系管理员先注册该 scope 再保存。`,
    );
  }

  // domain 枚举校验
  if (!(DOMAINS as readonly string[]).includes(input.domain)) {
    throw new ToolError('INVALID_DOMAIN', `未知 domain: ${input.domain}。可用: ${DOMAINS.join(', ')}`);
  }

  // 敏感信息分级扫描
  const scan = scanText([input.title, input.symptom, input.solution, input.detail ?? ''].join('\n'), deps.guardRules);
  if (scan.blocked) {
    throw new ToolError(
      'SENSITIVE_CONTENT',
      `内容含敏感信息，禁止入库: ${scan.hits.map((h) => `${h.rule}(${h.match})`).join('; ')}。请脱敏后重试。`,
    );
  }

  return {
    similar: await findSimilar(pool, cfg, input.title, input.symptom, input.solution, input.scope),
    warnings: [...scan.warnings],
    scopeWillRegister: sc === 'will-register',
  };
}

export async function handleSave(
  pool: Pool,
  cfg: Config,
  user: AppUser,
  input: SaveInput,
  deps: SaveDeps,
): Promise<SaveResult> {
  // scope 校验：未注册且格式合法 → 首次保存即注册（记录创建者），零人工开通
  const sc = await checkScope(pool, cfg, input.scope);
  let scopeRegistered = false;
  if (sc === 'disabled') {
    throw new ToolError('INVALID_SCOPE', `scope ${input.scope} 已被管理员禁用`);
  } else if (sc === 'invalid-format') {
    const available = await pool.query<{ scope: string }>('SELECT scope FROM scope_registry WHERE enabled = true');
    throw new ToolError(
      'INVALID_SCOPE',
      `未知 scope: ${input.scope}。可用: ${available.rows.map((r) => r.scope).join(', ')}`,
    );
  } else if (sc === 'closed') {
    // 收紧模式：新 scope 须管理员预先注册，杜绝拼写错误随手造出的碎片 scope
    throw new ToolError(
      'INVALID_SCOPE',
      `scope ${input.scope} 未注册，且本服务已关闭自动注册（AKM_SCOPE_OPEN=false）。请联系管理员先注册该 scope 再保存。`,
    );
  } else if (sc === 'will-register') {
    await pool.query(
      `INSERT INTO scope_registry (scope, description, enabled, created_by) VALUES ($1, $2, true, $3)`,
      [input.scope, '自动注册（首次保存）', user.username],
    );
    scopeRegistered = true;
  }

  // domain 枚举校验
  if (!(DOMAINS as readonly string[]).includes(input.domain)) {
    throw new ToolError('INVALID_DOMAIN', `未知 domain: ${input.domain}。可用: ${DOMAINS.join(', ')}`);
  }

  // 敏感信息分级扫描
  const scan = scanText([input.title, input.symptom, input.solution, input.detail ?? ''].join('\n'), deps.guardRules);
  if (scan.blocked) {
    throw new ToolError(
      'SENSITIVE_CONTENT',
      `内容含敏感信息，禁止入库: ${scan.hits.map((h) => `${h.rule}(${h.match})`).join('; ')}。请脱敏后重试。`,
    );
  }

  const similar = await findSimilar(pool, cfg, input.title, input.symptom, input.solution, input.scope);

  const tags = normalizeTags(input.tags, deps.aliases);
  const warnings = [...scan.warnings];
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO knowledge (title, symptom, solution, detail, domain, scope, module, tags, code_ref, status, author)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10) RETURNING id`,
    [input.title, input.symptom, input.solution, input.detail ?? null, input.domain, input.scope,
     input.module ?? null, tags, input.code_ref ?? null, user.username],
  );
  const id = Number(rows[0].id);

  // 向量化：标题+现象+方案+详情拼接生成 embedding；服务不可用只警告不阻塞入库
  if (deps.embedder) {
    try {
      const vec = await deps.embedder.embed([input.title, input.symptom, input.solution, input.detail ?? ''].join('\n'));
      await pool.query('UPDATE knowledge SET embedding = $2::vector WHERE id = $1', [id, JSON.stringify(vec)]);
    } catch (e) {
      warnings.push(`向量服务不可用，本条未生成向量（检索将退化为关键词匹配）: ${(e as Error).message}`);
    }
  }

  return {
    id,
    status: 'draft',
    similar,
    warnings,
    scopeRegistered,
  };
}
