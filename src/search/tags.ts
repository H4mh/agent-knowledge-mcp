import { readFileSync } from 'node:fs';

export function loadTagAliases(path: string): Record<string, string> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

/**
 * tag 归一化：trim → 小写 → 别名映射 → 去重，保持首次出现顺序。
 */
export function normalizeTags(tags: string[], aliases: Record<string, string>): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (!t) continue;
    const mapped = aliases[t] ?? aliases[t.toLowerCase()];
    const normalized = (mapped ?? t.toLowerCase()).toLowerCase();
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}
