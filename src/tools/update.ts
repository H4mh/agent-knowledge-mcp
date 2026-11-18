import type { Pool } from '../db.js';
import type { AppUser } from '../auth.js';
import { ToolError } from './save.js';
import { normalizeTags } from '../search/tags.js';
import { scanText, type GuardRules } from '../guard/index.js';
import type { Embedder } from '../embedding/index.js';
import { insertRevision } from '../admin/revisions.js';

export interface UpdateInput {
  id: number;
  /** 乐观锁基础版本：调用方最后读到的 version；不带则跳过校验（兼容旧行为） */
  base_version?: number;
  symptom?: string;
  solution?: string;
  detail?: string;
  tags?: string[];
  code_ref?: string;
  module?: string;
  status?: string; // 仅用于拒绝：收到即报 FORBIDDEN，status 变更只走 admin CLI
}

export interface UpdateDeps {
  aliases: Record<string, string>;
  guardRules: GuardRules;
  /** 可选向量生成器：配置了向量模型时传入，内容更新后重新生成 embedding；不可用时保留旧向量 */
  embedder?: Embedder;
}

export interface UpdateResult {
  ok: true;
  /** 更新后的条目版本号（version 列值） */
  version: number;
}

/** FOR UPDATE 锁定行：含修订 snapshot 所需的全部列 */
interface KnowledgeRow {
  id: string;
  version: number;
  title: string;
  symptom: string;
  solution: string;
  detail: string | null;
  tags: string[];
  code_ref: string | null;
  module: string | null;
  author: string;
  status: string;
  scope: string;
  domain: string;
}

export async function handleUpdate(pool: Pool, user: AppUser, input: UpdateInput, deps: UpdateDeps): Promise<UpdateResult> {
  // status 变更对任何 MCP 调用方拒绝（ledger Task 10 裁定），仅 admin CLI 可改
  if ('status' in (input as unknown as Record<string, unknown>)) {
    throw new ToolError('FORBIDDEN', 'status 变更不受 MCP 支持，请联系管理员使用 CLI');
  }

  // 敏感信息分级扫描：与 save 相同标准（final review Important #1）
  const scan = scanText([input.symptom, input.solution, input.detail].filter((t) => t !== undefined).join('\n'), deps.guardRules);
  if (scan.blocked) {
    throw new ToolError(
      'SENSITIVE_CONTENT',
      `内容含敏感信息，禁止入库: ${scan.hits.map((h) => `${h.rule}(${h.match})`).join('; ')}。请脱敏后重试。`,
    );
  }

  // 事务内 FOR UPDATE 行锁 → base_version 校验 → 修订行 → UPDATE version+1 → 提交；
  // embedding 重生成是慢外呼，必须在 COMMIT 之后（不得持锁等待向量服务）
  const client = await pool.connect();
  let row: KnowledgeRow;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<KnowledgeRow>(
      `SELECT id, version, title, symptom, solution, detail, tags, code_ref, module, author, status, scope, domain
       FROM knowledge WHERE id = $1 FOR UPDATE`,
      [input.id],
    );
    if (!rows.length) throw new ToolError('NOT_FOUND', `条目不存在: ${input.id}`);
    row = rows[0];

    // 权限校验（保持 author/admin 规则）
    if (row.author !== user.username && user.role !== 'admin') {
      throw new ToolError('FORBIDDEN', '仅作者本人或管理员可修改条目');
    }

    // 乐观锁校验：不符即 ROLLBACK 后报 CONFLICT，提示重新 search 获取最新版本
    if (input.base_version !== undefined && input.base_version !== row.version) {
      throw new ToolError(
        'CONFLICT',
        `版本冲突：条目已被他人更新（当前 v${row.version}）。请重新 search_knowledge 获取最新内容后再修改。`,
      );
    }

    // changed 检测：仅实际提交且值发生变化的字段进 sets
    const proposed: Array<{ col: string; val: unknown; old: unknown }> = [];
    if (input.symptom !== undefined && input.symptom !== row.symptom) {
      proposed.push({ col: 'symptom', val: input.symptom, old: row.symptom });
    }
    if (input.solution !== undefined && input.solution !== row.solution) {
      proposed.push({ col: 'solution', val: input.solution, old: row.solution });
    }
    if (input.detail !== undefined && (input.detail ?? null) !== row.detail) {
      proposed.push({ col: 'detail', val: input.detail ?? null, old: row.detail });
    }
    if (input.tags !== undefined) {
      const tags = normalizeTags(input.tags, deps.aliases);
      if (JSON.stringify(tags) !== JSON.stringify(row.tags)) {
        proposed.push({ col: 'tags', val: tags, old: row.tags });
      }
    }
    if (input.code_ref !== undefined && (input.code_ref ?? null) !== row.code_ref) {
      proposed.push({ col: 'code_ref', val: input.code_ref ?? null, old: row.code_ref });
    }
    if (input.module !== undefined && (input.module ?? null) !== row.module) {
      proposed.push({ col: 'module', val: input.module ?? null, old: row.module });
    }

    // 无实际变化：早返回，version 不动、不写修订
    if (!proposed.length) {
      await client.query('COMMIT');
      return { ok: true, version: row.version };
    }

    // 修订记录：changes=变更字段旧值，snapshot=更新前整行；与 UPDATE 同事务
    const changes: Record<string, unknown> = {};
    for (const f of proposed) changes[f.col] = f.old;
    await insertRevision(client, 'knowledge', Number(row.id), row.version, 'content', user.username, changes, { ...row });

    const params: unknown[] = proposed.map((f) => f.val);
    const sets = proposed.map((f, i) => `${f.col} = $${i + 1}`);
    await client.query(
      `UPDATE knowledge SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $${params.push(input.id)}`,
      params,
    );
    const newVersion = row.version + 1;
    await client.query('COMMIT');

    // 向量重生成：内容可能已变，基于更新后的全文重新 embedding；失败保留旧向量不阻塞。
    // 位于事务之外：慢外呼绝不占用连接/行锁
    if (deps.embedder) {
      const { rows: cur } = await pool.query<{ title: string; symptom: string; solution: string; detail: string | null }>(
        'SELECT title, symptom, solution, detail FROM knowledge WHERE id = $1', [input.id]);
      const k = cur[0];
      try {
        const vec = await deps.embedder.embed([k.title, k.symptom, k.solution, k.detail ?? ''].join('\n'));
        await pool.query('UPDATE knowledge SET embedding = $2::vector WHERE id = $1', [input.id, JSON.stringify(vec)]);
      } catch {
        // 向量服务不可用：保留旧向量，检索退化为关键词匹配
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
