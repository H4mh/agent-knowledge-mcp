import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from '../src/db.js';
import type { Embedder } from '../src/embedding/index.js';
import { ToolError } from '../src/tools/save.js';
import {
  setStatus,
  setSkillStatus,
  deleteKnowledge,
  listScopes,
  deleteScope,
  setUserEnabled,
  resetToken,
  listLegacyUsers,
  listRevisions,
  type RevisionRow,
} from '../src/admin/service.js';

/**
 * 管理员 CLI。运行: npx tsx scripts/admin.ts <command> [args]
 * 命令:
 *   adduser <name> --token <token> [--role admin]
 *   listusers | listusers --legacy（迁移检测：列出仍以用户名作令牌的存量账号）
 *   reset-token <name>   — 重发随机访问令牌（明文仅此一次显示）
 *   disable <name> | enable <name>
 *   delete-knowledge <id> | set-status <id> <draft|verified|deprecated>
 *   list-scopes | delete-scope <scope>
 *   history <id> | history --skill <name>  — 修订历史（最近 50 条，不含 snapshot）
 *   delete-skill <name> | set-skill-status <name> <draft|verified|deprecated>
 *   decay [--days 90] [--dry-run]  — 知识老化：长期无人使用的 verified 降回 draft
 *   embed                — 向量回填：为缺失 embedding 的条目生成向量（需配置向量模型）
 *   export <dir>          — 导出全部条目为 frontmatter markdown（spec §十二格式）
 */

export interface AdminDeps {
  /** 向量生成器：由入口按配置构建；embed 命令需要 */
  embedder?: Embedder;
}

function slug(title: string): string {
  return title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
}

function frontmatter(k: {
  title: string; symptom: string; solution: string; detail: string | null;
  domain: string; scope: string; module: string | null; tags: string[];
  code_ref: string | null; status: string; author: string;
}): string {
  const fm = [
    '---',
    `title: ${k.title}`,
    `symptom: ${k.symptom.replace(/\n/g, ' ')}`,
    `solution: ${k.solution.replace(/\n/g, ' ')}`,
    `domain: ${k.domain}`,
    `scope: ${k.scope}`,
    k.module ? `module: ${k.module}` : null,
    `tags: [${k.tags.join(', ')}]`,
    k.code_ref ? `code_ref: ${k.code_ref}` : null,
    `status: ${k.status}`,
    `author: ${k.author}`,
    '---',
    '',
    k.detail ?? '',
    '',
  ].filter((l) => l !== null).join('\n');
  return fm;
}

function formatRevisions(rows: RevisionRow[]): string {
  return rows.map((r) =>
    `v${r.version}\t${r.kind}\t${r.changed_by}\t${r.created_at}\t${JSON.stringify(r.changes)}`,
  ).join('\n') || '(无修订记录)';
}

export async function runAdmin(pool: Pool, args: string[], deps: AdminDeps = {}): Promise<string> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'adduser': {
      const name = rest[0];
      const tokenIdx = rest.indexOf('--token');
      const token = tokenIdx >= 0 ? rest[tokenIdx + 1] : undefined;
      if (!name || !token) throw new Error('用法: adduser <name> --token <token> [--role admin]');
      const roleIdx = rest.indexOf('--role');
      const role = roleIdx >= 0 ? rest[roleIdx + 1] : 'user';
      const hash = createHash('sha256').update(token).digest('hex');
      await pool.query(
        `INSERT INTO app_user (username, token_hash, role) VALUES ($1,$2,$3)
         ON CONFLICT (username) DO UPDATE SET token_hash = $2, role = $3, enabled = true`,
        [name, hash, role],
      );
      return `用户 ${name}（${role}）已写入`;
    }
    case 'listusers': {
      if (rest.includes('--legacy')) {
        const names = await listLegacyUsers(pool);
        return names.length
          ? `仍以用户名作为令牌的存量账号（建议 reset-token 换发）:\n${names.join('\n')}`
          : '(无 legacy 用户)';
      }
      const { rows } = await pool.query<{ username: string; role: string; enabled: boolean }>(
        'SELECT username, role, enabled FROM app_user ORDER BY username');
      return rows.map((r) => `${r.username}\t${r.role}\t${r.enabled ? 'enabled' : 'disabled'}`).join('\n') || '(无用户)';
    }
    case 'reset-token': {
      const name = rest[0];
      if (!name) throw new Error('用法: reset-token <name>');
      const token = await resetToken(pool, name);
      return `用户 ${name} 令牌已重置，新令牌（仅此一次显示，请妥善保存）:\n${token}`;
    }
    case 'history': {
      if (rest[0] === '--skill') {
        const name = rest[1];
        if (!name) throw new Error('用法: history --skill <name>');
        return formatRevisions(await listRevisions(pool, 'skill', name));
      }
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) throw new Error('用法: history <id> | history --skill <name>');
      return formatRevisions(await listRevisions(pool, 'knowledge', id));
    }
    case 'disable':
    case 'enable': {
      const name = rest[0];
      if (!name) throw new Error(`用法: ${cmd} <name>`);
      await setUserEnabled(pool, name, cmd === 'enable');
      return `用户 ${name} 已${cmd === 'enable' ? '启用' : '禁用'}`;
    }
    case 'delete-knowledge': {
      const id = Number(rest[0]);
      await deleteKnowledge(pool, id);
      return `条目 #${id} 已删除`;
    }
    case 'set-status': {
      const id = Number(rest[0]);
      const status = rest[1];
      await setStatus(pool, id, status, 'admin-cli');
      return `条目 #${id} 状态 → ${status}`;
    }
    case 'list-scopes': {
      const rows = await listScopes(pool);
      return rows.map((r) => `${r.scope}\t${r.enabled ? 'enabled' : 'disabled'}${r.createdBy ? `\t${r.createdBy}` : ''}`).join('\n') || '(无 scope)';
    }
    case 'delete-scope': {
      const scope = rest[0];
      if (!scope) throw new Error('用法: delete-scope <scope>');
      await deleteScope(pool, scope);
      return `scope ${scope} 已删除`;
    }
    case 'decay': {
      // 借鉴 Mem0/Zep 的记忆衰减：新鲜度 = 最近一次使用，从未使用则按 updated_at 起算
      const daysIdx = rest.indexOf('--days');
      const days = daysIdx >= 0 ? Number(rest[daysIdx + 1]) : 90;
      const dryRun = rest.includes('--dry-run');
      if (!Number.isFinite(days) || days <= 0) throw new Error('用法: decay [--days 90] [--dry-run]');
      const stale = await pool.query<{ id: string; title: string; status: string }>(
        `SELECT id, title, status FROM knowledge
         WHERE status = 'verified' AND COALESCE(last_used_at, updated_at) < now() - ($1 || ' days')::interval
         ORDER BY id`,
        [String(days)],
      );
      if (dryRun) {
        return stale.rows.length
          ? `[dry-run] 将降级 ${stale.rows.length} 条:\n${stale.rows.map((r) => `#${r.id} ${r.title}`).join('\n')}`
          : `[dry-run] 无超过 ${days} 天未使用的 verified 条目`;
      }
      if (!stale.rowCount) return `无超过 ${days} 天未使用的 verified 条目`;
      await pool.query(
        `UPDATE knowledge SET status = 'draft', updated_at = now()
         WHERE status = 'verified' AND COALESCE(last_used_at, updated_at) < now() - ($1 || ' days')::interval`,
        [String(days)],
      );
      return `已降级 ${stale.rowCount} 条 verified → draft:\n${stale.rows.map((r) => `#${r.id} ${r.title}`).join('\n')}`;
    }
    case 'embed': {
      // 向量回填：为缺失 embedding 的条目（新入库时服务不可用、或启用向量前的存量）补生成向量；knowledge 与 skill 一并处理
      if (!deps.embedder) {
        return '未配置向量模型（AKM_EMBEDDING_PROTOCOL + AKM_EMBEDDING_URL），无法回填向量';
      }
      const { rows } = await pool.query<{ id: string; title: string; symptom: string; solution: string; detail: string | null }>(
        'SELECT id, title, symptom, solution, detail FROM knowledge WHERE embedding IS NULL ORDER BY id');
      const { rows: skillRows } = await pool.query<{ id: string; name: string; description: string; instructions: string }>(
        'SELECT id, name, description, instructions FROM skill WHERE embedding IS NULL ORDER BY id');
      if (!rows.length && !skillRows.length) return '所有条目均已有向量，无需回填';
      let ok = 0;
      const failed: string[] = [];
      for (const k of rows) {
        try {
          const vec = await deps.embedder.embed([k.title, k.symptom, k.solution, k.detail ?? ''].join('\n'));
          await pool.query('UPDATE knowledge SET embedding = $2::vector WHERE id = $1', [k.id, JSON.stringify(vec)]);
          ok++;
        } catch (e) {
          failed.push(`知识 #${k.id} ${k.title}: ${(e as Error).message}`);
        }
      }
      // skill 检索文本与保存路径一致（name + description + instructions）
      let skillOk = 0;
      for (const s of skillRows) {
        try {
          const vec = await deps.embedder.embed([s.name, s.description, s.instructions].join('\n'));
          await pool.query('UPDATE skill SET embedding = $2::vector WHERE id = $1', [s.id, JSON.stringify(vec)]);
          skillOk++;
        } catch (e) {
          failed.push(`skill ${s.name}: ${(e as Error).message}`);
        }
      }
      const lines = [`已回填 ${ok} 条知识向量、${skillOk} 条 skill 向量`];
      if (failed.length) lines.push(`${failed.length} 条失败:\n${failed.join('\n')}`);
      return lines.join('\n');
    }
    case 'export': {
      const dir = rest[0];
      if (!dir) throw new Error('用法: export <dir>');
      const { rows } = await pool.query<{
        id: string; title: string; symptom: string; solution: string; detail: string | null;
        domain: string; scope: string; module: string | null; tags: string[];
        code_ref: string | null; status: string; author: string;
      }>('SELECT id, title, symptom, solution, detail, domain, scope, module, tags, code_ref, status, author FROM knowledge ORDER BY id');
      mkdirSync(dir, { recursive: true });
      for (const k of rows) {
        const file = join(dir, `${k.id}-${slug(k.title)}.md`);
        writeFileSync(file, frontmatter(k), 'utf8');
      }
      return `已导出 ${rows.length} 条到 ${dir}`;
    }
    case 'delete-skill': {
      // 硬删除 skill；skill_usage 有外键引用，先清 usage（与门户 REST DELETE 语义一致）
      const name = rest[0];
      if (!name) throw new Error('用法: delete-skill <name>');
      const { rows } = await pool.query<{ id: string }>('SELECT id FROM skill WHERE name = $1', [name]);
      if (!rows.length) throw new ToolError('NOT_FOUND', `skill 不存在: ${name}`);
      await pool.query('DELETE FROM skill_usage WHERE skill_id = $1', [rows[0].id]);
      await pool.query('DELETE FROM skill WHERE id = $1', [rows[0].id]);
      return `skill ${name} 已删除`;
    }
    case 'set-skill-status': {
      const name = rest[0];
      const status = rest[1];
      if (!name || !status) throw new Error('用法: set-skill-status <name> <draft|verified|deprecated>');
      await setSkillStatus(pool, name, status, 'admin-cli');
      return `skill ${name} 状态 → ${status}`;
    }
    default:
      throw new Error(`未知命令: ${cmd}。可用: adduser listusers reset-token disable enable delete-knowledge set-status list-scopes delete-scope history decay embed export delete-skill set-skill-status`);
  }
}

async function main() {
  const { loadConfig } = await import('../src/config.js');
  const { createPool } = await import('../src/db.js');
  const { createEmbedder } = await import('../src/embedding/index.js');
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  const embedder = cfg.embedding ? createEmbedder(cfg.embedding) : undefined;
  try {
    console.log(await runAdmin(pool, process.argv.slice(2), { embedder }));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && /admin\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error('失败:', e instanceof ToolError ? `[${e.code}] ${e.message}` : e.message);
    process.exit(1);
  });
}
