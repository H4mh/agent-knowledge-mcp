import type { Pool } from '../db.js';
import type { Config } from '../config.js';
import type { AppUser } from '../auth.js';
import { normalizeTags } from '../search/tags.js';
import { scanText, type GuardRules } from '../guard/index.js';
import type { Embedder } from '../embedding/index.js';
import { ToolError, checkScope } from './save.js';
import { insertRevision } from '../admin/revisions.js';

/** skill 名格式门槛：小写字母/数字开头，仅含小写字母、数字、连字符，总长 2-64 */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export interface SkillFile {
  path: string;
  content: string;
}

export interface SaveSkillInput {
  name: string;
  description: string;
  instructions: string;
  files?: SkillFile[];
  scope?: string;
  tags?: string[];
}

export interface SkillDeps {
  aliases: Record<string, string>;
  guardRules: GuardRules;
  /** 可选站点配置：update_skill 校验 scope 注册状态时使用（缺省按"不开放自动注册"处理） */
  cfg?: Config;
  /** 可选向量生成器：配置了向量模型时传入，保存后写入 embedding；不可用时降级不阻塞 */
  embedder?: Embedder;
}

export interface SaveSkillResult {
  id: number;
  status: 'draft';
  similar: { id: number; name: string; similarity: number }[];
  warnings: string[];
}

const MAX_FILES = 20;
const MAX_FILE_BYTES = 65536; // 64KB
const MAX_TOTAL_BYTES = 262144; // 256KB

/**
 * 附加文件校验（拒绝即 ToolError('INVALID_SKILL_FILE', 中文原因)）：
 * - path：不能以 / 或 \\ 开头、不含反斜杠、无 `..` 段（防路径穿越）、长度 ≤200、
 *   basename（大小写不敏感）≠ 'SKILL.md'（该名保留给安装入口文件）
 * - 数量 ≤20；单文件 content ≤64KB；总量 ≤256KB（按 Buffer.byteLength 字节计）
 */
export function validateSkillFiles(files: SkillFile[]): SkillFile[] {
  if (files.length > MAX_FILES) {
    throw new ToolError('INVALID_SKILL_FILE', `附加文件数量超限: ${files.length} 个（最多 ${MAX_FILES} 个）`);
  }
  let total = 0;
  for (const f of files) {
    const path = f.path ?? '';
    if (!/^[^/\\]/.test(path)) {
      throw new ToolError('INVALID_SKILL_FILE', `文件 path 非法: ${path}（不能以 / 或 \\ 开头）`);
    }
    if (path.includes('\\')) {
      throw new ToolError('INVALID_SKILL_FILE', `文件 path 非法: ${path}（不允许包含反斜杠）`);
    }
    if (path.split('/').some((seg) => seg === '..')) {
      throw new ToolError('INVALID_SKILL_FILE', `文件 path 非法: ${path}（不允许包含 .. 路径穿越段）`);
    }
    if (path.length > 200) {
      throw new ToolError('INVALID_SKILL_FILE', `文件 path 过长: ${path.length} 字符（最多 200）`);
    }
    const base = path.split('/').pop() ?? '';
    if (base.toLowerCase() === 'skill.md') {
      throw new ToolError('INVALID_SKILL_FILE', `文件名 SKILL.md 为安装入口保留，不能作为附加文件: ${path}`);
    }
    const size = Buffer.byteLength(f.content ?? '', 'utf8');
    if (size > MAX_FILE_BYTES) {
      throw new ToolError('INVALID_SKILL_FILE', `单文件超过 64KB 限制: ${path}（${size} 字节）`);
    }
    total += size;
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new ToolError('INVALID_SKILL_FILE', `附加文件总量超过 256KB 限制（共 ${total} 字节）`);
  }
  return files;
}

/** 组装 SKILL.md 全文：frontmatter（name/description）+ 空行 + instructions 正文 */
export function assembleSkillMd(name: string, description: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}`;
}

/** 查重提示：name/description 三元相似度取最大，达阈值即提示；排除同名自身，LIMIT 3 */
export async function findSimilarSkills(
  pool: Pool,
  cfg: Config,
  name: string,
  description: string,
): Promise<SaveSkillResult['similar']> {
  const dup = await pool.query<{ id: number; name: string; sim: number }>(
    `SELECT id, name,
            GREATEST(similarity(name,$1), similarity(description,$2)) AS sim
     FROM skill
     WHERE name <> $3
       AND GREATEST(similarity(name,$1), similarity(description,$2)) >= $4
     ORDER BY sim DESC
     LIMIT 3`,
    [name, description, name, cfg.dedupThreshold],
  );
  return dup.rows.map((r) => ({ id: Number(r.id), name: r.name, similarity: Number(r.sim) }));
}

/**
 * scope 校验共享助手（save/update 同一套）：skill 是共享资产，scope 须为已注册 scope，不自动注册。
 * cfg 缺省按"不开放自动注册"处理（直接库调用场景）；校验不通过抛 INVALID_SCOPE。
 */
async function ensureRegisteredScope(pool: Pool, cfg: Config | undefined, scope: string): Promise<void> {
  const sc = await checkScope(pool, cfg ?? ({ scopeOpen: false } as Config), scope);
  if (sc === 'disabled') {
    throw new ToolError('INVALID_SCOPE', `scope ${scope} 已被管理员禁用`);
  } else if (sc === 'closed') {
    throw new ToolError(
      'INVALID_SCOPE',
      `scope ${scope} 未注册。skill 是共享资产，不会自动注册 scope，请联系管理员先注册该 scope 再保存。`,
    );
  } else if (sc === 'invalid-format' || sc === 'will-register') {
    const available = await pool.query<{ scope: string }>('SELECT scope FROM scope_registry WHERE enabled = true');
    throw new ToolError(
      'INVALID_SCOPE',
      `未知 scope: ${scope}。skill 的 scope 须为已注册 scope（共享资产不自动建 scope）。可用: ${available.rows
        .map((r) => r.scope)
        .join(', ')}`,
    );
  }
}

export async function handleSaveSkill(
  pool: Pool,
  cfg: Config,
  user: AppUser,
  input: SaveSkillInput,
  deps: SkillDeps,
): Promise<SaveSkillResult> {
  // name 格式校验
  if (!SKILL_NAME_RE.test(input.name)) {
    throw new ToolError(
      'INVALID_SKILL_NAME',
      `skill 名非法: ${input.name}。须为小写字母/数字开头，仅含小写字母、数字、连字符，长度 2-64`,
    );
  }

  // 附加文件校验（路径穿越防护 + 大小限制）
  const files = validateSkillFiles(input.files ?? []);

  // scope 校验（可选，传了才校验）：skill 是共享资产，不自动注册 scope，须为已注册 scope
  if (input.scope !== undefined) {
    await ensureRegisteredScope(pool, cfg, input.scope);
  }

  // 敏感信息分级扫描：instructions + 全部附加文件内容
  const scan = scanText([input.instructions, ...files.map((f) => f.content)].join('\n'), deps.guardRules);
  if (scan.blocked) {
    throw new ToolError(
      'SENSITIVE_CONTENT',
      `内容含敏感信息，禁止入库: ${scan.hits.map((h) => `${h.rule}(${h.match})`).join('; ')}。请脱敏后重试。`,
    );
  }

  // 同名冲突：skill 名即安装目录名，全局唯一；更新走 update_skill
  const dup = await pool.query('SELECT 1 FROM skill WHERE name = $1', [input.name]);
  if (dup.rowCount) {
    throw new ToolError('SKILL_EXISTS', '同名 skill 已存在，请改用 update_skill');
  }

  const similar = await findSimilarSkills(pool, cfg, input.name, input.description);
  const warnings = [...scan.warnings];

  const tags = normalizeTags(input.tags ?? [], deps.aliases);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO skill (name, description, instructions, files, scope, tags, status, author)
     VALUES ($1,$2,$3,$4,$5,$6,'draft',$7) RETURNING id`,
    [input.name, input.description, input.instructions, JSON.stringify(files), input.scope ?? null, tags, user.username],
  );
  const id = Number(rows[0].id);

  // 向量化：name+description+instructions 拼接生成 embedding；服务不可用只警告不阻塞入库
  if (deps.embedder) {
    try {
      const vec = await deps.embedder.embed([input.name, input.description, input.instructions].join('\n'));
      await pool.query('UPDATE skill SET embedding = $2::vector WHERE id = $1', [id, JSON.stringify(vec)]);
    } catch (e) {
      warnings.push(`向量服务不可用，本条未生成向量（检索将退化为关键词匹配）: ${(e as Error).message}`);
    }
  }

  return {
    id,
    status: 'draft',
    similar,
    warnings,
  };
}

export interface UpdateSkillInput {
  name: string;
  /** 乐观锁基础版本：调用方最后读到的 version；不带则跳过校验（兼容旧行为） */
  base_version?: number;
  description?: string;
  instructions?: string;
  files?: SkillFile[];
  /** undefined 保留原值；null 显式清空（置 NULL，REST 门户编辑用；MCP zod schema 仍为 string 不接受 null） */
  scope?: string | null;
  tags?: string[];
}

const PROMOTION_DISTINCT_USERS = 2;

/** 稳定字符串化：对象键排序后序列化，用于与 JSONB 回读值做等值比较 */
function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return val;
  });
}

function eqTags(a: string[], b: string[]): boolean {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

/** FOR UPDATE 锁定行：含修订 snapshot 所需的全部列（pg BIGINT id 为 string，snapshot JSONB 保持） */
interface SkillRow {
  id: string;
  author: string;
  description: string;
  instructions: string;
  files: SkillFile[];
  scope: string | null;
  tags: string[];
  version: number;
}

/**
 * update_skill 补丁语义：description/instructions/files/scope/tags 全部可选；
 * files 提供时整体替换（JSONB 覆盖，删除附加文件的唯一途径），未提供时保留原值；
 * 内容字段实际变化才 version+1 并重算 embedding（向量失败保留旧向量，不阻塞）。
 * 权限：仅作者或 admin 可改，否则 FORBIDDEN；skill 不存在 → NOT_FOUND。
 * 乐观锁：base_version 与当前 version 不符 → CONFLICT（在变更检测之前校验，
 * 即使提交内容为 no-op 也冲突）；无实际变化早返回，version 不动、不写修订。
 * 变更路径：事务内 FOR UPDATE 行锁 → 修订行（entry_revision，changes=旧值/snapshot=更新前整行）
 * → UPDATE version+1 → 提交；embedding 重生成是慢外呼，位于 COMMIT 之后。
 * 内容更新路径重跑敏感扫描（同 save/update 标准）；scope 提供时须为已注册 scope（不自动注册），null 显式清空。
 */
export async function handleUpdateSkill(
  pool: Pool,
  user: AppUser,
  input: UpdateSkillInput,
  deps: SkillDeps,
): Promise<{ ok: true; version: number }> {
  const client = await pool.connect();
  let row: SkillRow;
  try {
    await client.query('BEGIN');
    const cur = await client.query<SkillRow>(
      'SELECT id, author, description, instructions, files, scope, tags, version FROM skill WHERE name = $1 FOR UPDATE',
      [input.name],
    );
    if (!cur.rowCount) throw new ToolError('NOT_FOUND', `skill 不存在: ${input.name}`);
    row = cur.rows[0];

    // 权限校验（保持 author/admin 规则）
    if (user.role !== 'admin' && user.username !== row.author) {
      throw new ToolError('FORBIDDEN', '仅作者或管理员可修改');
    }

    // 乐观锁校验：权限之后、变更检测之前——过期 base_version 即使是 no-op 提交也必须 CONFLICT
    if (input.base_version !== undefined && input.base_version !== row.version) {
      throw new ToolError(
        'CONFLICT',
        `版本冲突：skill 已被他人更新（当前 v${row.version}）。请重新 search_skills 获取最新内容后再修改。`,
      );
    }

    // 附加文件校验（路径穿越防护 + 大小限制）
    const files = input.files !== undefined ? validateSkillFiles(input.files) : null;

    // scope 校验（同 save：skill 是共享资产，scope 须为已注册 scope，不自动注册）；null 表示清空，跳过校验
    if (input.scope !== undefined && input.scope !== null) {
      await ensureRegisteredScope(pool, deps.cfg, input.scope);
    }

    // 敏感信息分级扫描：本次提交的 description/instructions/附加文件内容（同 save/update 标准）
    const scanInputs: string[] = [];
    if (input.description !== undefined) scanInputs.push(input.description);
    if (input.instructions !== undefined) scanInputs.push(input.instructions);
    if (files) for (const f of files) scanInputs.push(f.content);
    if (scanInputs.length) {
      const scan = scanText(scanInputs.join('\n'), deps.guardRules);
      if (scan.blocked) {
        throw new ToolError(
          'SENSITIVE_CONTENT',
          `内容含敏感信息，禁止入库: ${scan.hits.map((h) => `${h.rule}(${h.match})`).join('; ')}。请脱敏后重试。`,
        );
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const changes: Record<string, unknown> = {};
    let changed = false;
    const add = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (input.description !== undefined) {
      if (input.description !== row.description) {
        changed = true;
        changes.description = row.description;
      }
      add('description', input.description);
    }
    if (input.instructions !== undefined) {
      if (input.instructions !== row.instructions) {
        changed = true;
        changes.instructions = row.instructions;
      }
      add('instructions', input.instructions);
    }
    if (input.files !== undefined) {
      if (stableStringify(files) !== stableStringify(row.files)) {
        changed = true;
        changes.files = row.files;
      }
      add('files', JSON.stringify(files));
    }
    if (input.scope !== undefined) {
      // null 清空：直接置 NULL（!== row.scope 比较覆盖 null 与原值的差异）
      if (input.scope !== row.scope) {
        changed = true;
        changes.scope = row.scope;
      }
      add('scope', input.scope);
    }
    if (input.tags !== undefined) {
      const tags = normalizeTags(input.tags, deps.aliases);
      if (!eqTags(tags, row.tags)) {
        changed = true;
        changes.tags = row.tags;
      }
      add('tags', tags);
    }

    // 无实际变化：早返回，version 不动、不写修订
    if (!changed) {
      await client.query('COMMIT');
      return { ok: true, version: row.version };
    }

    // 修订记录：changes=变更字段旧值，snapshot=更新前整行；与 UPDATE 同事务
    await insertRevision(client, 'skill', Number(row.id), row.version, 'content', user.username, changes, { ...row });

    sets.push('version = version + 1', 'updated_at = now()');
    params.push(row.id);
    await client.query(`UPDATE skill SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const newVersion = row.version + 1;
    await client.query('COMMIT');

    // 内容变化 → 重算 embedding；向量服务不可用保留旧向量，不阻塞。
    // 位于事务之外：慢外呼绝不占用连接/行锁
    if (deps.embedder) {
      try {
        const vec = await deps.embedder.embed(
          [input.name, input.description ?? row.description, input.instructions ?? row.instructions].join('\n'),
        );
        await pool.query('UPDATE skill SET embedding = $2::vector WHERE id = $1', [row.id, JSON.stringify(vec)]);
      } catch {
        // 保留旧向量
      }
    }

    return { ok: true, version: newVersion };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * get_skill 拉取：返回 SKILL.md 组装（frontmatter + 正文）+ 附加文件。
 * 每次成功调用记 skill_usage（同一用户幂等）并累加 use_count；
 * draft 被 ≥2 个不同（非作者）用户拉取 → 晋升 verified（同 mark_used），晋升写 kind='status' 修订行。
 */
export async function handleGetSkill(
  pool: Pool,
  user: AppUser,
  name: string,
): Promise<{ name: string; description: string; version: number; status: string; files: SkillFile[] }> {
  const { rows } = await pool.query<{
    id: number;
    name: string;
    description: string;
    instructions: string;
    files: SkillFile[];
    version: number;
    status: string;
  }>('SELECT id, name, description, instructions, files, version, status FROM skill WHERE name = $1', [name]);
  if (!rows.length) throw new ToolError('NOT_FOUND', `skill 不存在: ${name}`);
  const s = rows[0];

  const ins = await pool.query(
    'INSERT INTO skill_usage (skill_id, used_by) VALUES ($1,$2) ON CONFLICT (skill_id, used_by) DO NOTHING',
    [s.id, user.username],
  );
  if (ins.rowCount) {
    await pool.query('UPDATE skill SET use_count = use_count + 1, last_used_at = now() WHERE id = $1', [s.id]);
  }

  const { rows: pr } = await pool.query<{ n: string }>(
    `SELECT count(DISTINCT used_by)::text n
     FROM skill_usage su
     JOIN skill sk ON sk.id = su.skill_id
     WHERE su.skill_id = $1 AND su.used_by <> sk.author`,
    [s.id],
  );
  let status = s.status;
  if (status === 'draft' && Number(pr[0].n) >= PROMOTION_DISTINCT_USERS) {
    // 自动晋升也写修订历史：小事务 FOR UPDATE 锁行 → kind='status' 修订行（changed_by=触发晋升
    // 的拉取者，changes=旧状态，snapshot=晋升前整行）→ UPDATE status → 提交；version 不变
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query<{ id: string; status: string; version: number }>(
        'SELECT id, status, version FROM skill WHERE id = $1 FOR UPDATE',
        [s.id],
      );
      if (cur.rowCount && cur.rows[0].status === 'draft') {
        const row = cur.rows[0];
        await insertRevision(
          client, 'skill', Number(row.id), row.version, 'status', user.username,
          { status: row.status }, { ...s, ...row },
        );
        await client.query("UPDATE skill SET status = 'verified' WHERE id = $1", [s.id]);
      }
      await client.query('COMMIT');
      status = 'verified';
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  const files: SkillFile[] = [
    { path: 'SKILL.md', content: assembleSkillMd(s.name, s.description, s.instructions) },
    ...(Array.isArray(s.files) ? s.files : []),
  ];
  return { name: s.name, description: s.description, version: Number(s.version), status, files };
}
