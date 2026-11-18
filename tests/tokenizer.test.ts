import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/search/tokenizer.js';

describe('tokenize', () => {
  it('中文串切出 bigram，包含连接/失败', () => {
    const r = tokenize('数据库连接失败');
    expect(r).toContain('连接');
    expect(r).toContain('失败');
    expect(r).not.toContain('select');
  });

  it('中英混合切出单词与中文 bigram', () => {
    const r = tokenize('Spring Boot 超时');
    expect(r).toContain('spring');
    expect(r).toContain('boot');
    expect(r).toContain('超时');
  });

  it('两字中文段切出唯一 bigram（不产单字，避免误命中）', () => {
    const r = tokenize('卡死');
    expect(r).toEqual(['卡死']);
  });

  it('纯英文整词保留', () => {
    const r = tokenize('kingbase');
    expect(r).toEqual(['kingbase']);
  });
});
