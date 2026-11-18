import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from '../src/db.js';
import { normalizeTags } from '../src/search/tags.js';

/**
 * 种子数据导入：把带 frontmatter 的 markdown 目录导入知识库（status=verified, author=import）。
 * 运行: npx tsx scripts/import-markdown.ts <dir>
 * frontmatter 必填字段: title, symptom, solution, domain, scope, tags
 */
export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error('缺少 frontmatter');
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: m[2].trim() };
}

function parseTags(v: string): string[] {
  const inner = v.replace(/^\[|\]$/g, '');
  return inner.split(',').map((s) => s.trim()).filter(Boolean);
}

export async function importMarkdown(pool: Pool, dir: string, aliases?: Record<string, string>): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] };
  const aliasMap = aliases ?? {};
  const REQUIRED = ['title', 'symptom', 'solution', 'domain', 'scope', 'tags'] as const;

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    try {
      const raw = readFileSync(join(dir, file), 'utf8');
      const { fm, body } = parseFrontmatter(raw);
      const missing = REQUIRED.filter((k) => !fm[k]);
      if (missing.length) throw new Error(`缺少字段: ${missing.join(', ')}`);

      const tags = normalizeTags(parseTags(fm.tags), aliasMap);
      const dup = await pool.query('SELECT 1 FROM knowledge WHERE title = $1 AND scope = $2', [fm.title, fm.scope]);
      if (dup.rowCount) {
        result.skipped++;
        continue;
      }
      await pool.query(
        `INSERT INTO knowledge (title, symptom, solution, detail, domain, scope, module, tags, code_ref, status, author)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'verified','import')`,
        [fm.title, fm.symptom, fm.solution, body || null, fm.domain, fm.scope,
         fm.module ?? null, tags, fm.code_ref ?? null],
      );
      result.imported++;
    } catch (e) {
      result.errors.push(`${file}: ${(e as Error).message}`);
    }
  }
  return result;
}

async function main() {
  const { loadConfig } = await import('../src/config.js');
  const { createPool } = await import('../src/db.js');
  const { loadTagAliases } = await import('../src/search/tags.js');
  const dir = process.argv[2];
  if (!dir) {
    console.error('用法: npx tsx scripts/import-markdown.ts <markdown 目录>');
    process.exit(1);
  }
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  try {
    const aliases = loadTagAliases(join(process.cwd(), 'config', 'tag-aliases.json'));
    const r = await importMarkdown(pool, dir, aliases);
    console.log(`导入 ${r.imported} 条，跳过 ${r.skipped} 条，错误 ${r.errors.length} 条`);
    for (const e of r.errors) console.error(e);
    if (r.errors.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && /import-markdown\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error('失败:', e.message);
    process.exit(1);
  });
}
