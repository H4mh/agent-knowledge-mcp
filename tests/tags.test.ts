import { describe, expect, it } from 'vitest';
import { loadTagAliases, normalizeTags } from '../src/search/tags.js';
import { join } from 'node:path';

const aliases = loadTagAliases(join(process.cwd(), 'config', 'tag-aliases.json'));

describe('normalizeTags', () => {
  it('别名映射 + trim + 小写 + 去重，保持顺序', () => {
    expect(normalizeTags(['达梦', ' DM8 ', 'vue', 'vue'], aliases)).toEqual(['dameng', 'vue']);
  });

  it('小写后再查别名', () => {
    expect(normalizeTags(['DM8'], aliases)).toEqual(['dameng']);
    expect(normalizeTags(['人大金仓'], aliases)).toEqual(['kingbase']);
  });

  it('未知 tag 保留小写原文', () => {
    expect(normalizeTags(['MyBatis'], aliases)).toEqual(['mybatis']);
  });
});
