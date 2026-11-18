const CJK_RE = /[一-鿿㐀-䶿]+/g;

/**
 * 查询分词：CJK 连续段切 bigram（单字段保留），拉丁/数字按非字母数字切分并小写。
 */
export function tokenize(query: string): string[] {
  const tokens: string[] = [];

  for (const run of query.match(CJK_RE) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }

  for (const run of query.split(/[^a-zA-Z0-9]+/)) {
    if (run) tokens.push(run.toLowerCase());
  }

  return tokens;
}
