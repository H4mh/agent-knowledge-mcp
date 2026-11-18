import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('DATABASE_URL 缺失时抛错', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('仅配 DATABASE_URL 时返回默认值', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(cfg.port).toBe(3000);
    expect(cfg.rateLimitPerMin).toBe(60);
    expect(cfg.dedupThreshold).toBe(0.6);
    expect(cfg.searchWeights).toEqual({
      title: 1,
      tags: 1,
      symptom: 1,
      solution: 1,
      trigram: 1,
      verifiedBoost: 2,
      scopeBoost: 3,
      useCountBoost: 0.1,
      vector: 4,
    });
  });

  it('环境变量覆盖默认值', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://x',
      PORT: '4000',
      RATE_LIMIT_PER_MIN: '120',
      DEDUP_THRESHOLD: '0.7',
    });
    expect(cfg.port).toBe(4000);
    expect(cfg.rateLimitPerMin).toBe(120);
    expect(cfg.dedupThreshold).toBe(0.7);
    expect(cfg.databaseUrl).toBe('postgres://x');
  });

  it('AKM_JOIN_SECRET 未配置 → undefined（完全开放）；配置后透传', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).joinSecret).toBeUndefined();
    expect(loadConfig({ DATABASE_URL: 'postgres://x', AKM_JOIN_SECRET: 's3cret' }).joinSecret).toBe('s3cret');
    expect(loadConfig({ DATABASE_URL: 'postgres://x', AKM_JOIN_SECRET: '' }).joinSecret).toBeUndefined();
  });

  it('向量未配置 → embedding 为 undefined（默认不启用）', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).embedding).toBeUndefined();
  });

  it('向量只配 protocol 或只配 url → 配置报错（防拼错漏配）', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://x', AKM_EMBEDDING_PROTOCOL: 'openai' }),
    ).toThrow(/AKM_EMBEDDING_URL/);
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://x', AKM_EMBEDDING_URL: 'http://e' }),
    ).toThrow(/AKM_EMBEDDING_PROTOCOL/);
  });

  it('向量配置齐全 → 生成 embedding 配置（generic 协议须带模板与取值路径）', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://x',
      AKM_EMBEDDING_PROTOCOL: 'openai',
      AKM_EMBEDDING_URL: 'http://e/v1/embeddings',
      AKM_EMBEDDING_MODEL: 'bge-m3',
      AKM_EMBEDDING_API_KEY: 'sk-x',
    });
    expect(cfg.embedding).toEqual({
      protocol: 'openai',
      url: 'http://e/v1/embeddings',
      model: 'bge-m3',
      apiKey: 'sk-x',
      timeoutMs: 5000,
      bodyTemplate: undefined,
      responsePath: undefined,
    });
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://x',
        AKM_EMBEDDING_PROTOCOL: 'generic',
        AKM_EMBEDDING_URL: 'http://e/embed',
      }),
    ).toThrow(/TEMPLATE|RESPONSE_PATH/i);
  });

  it('未知向量协议 → 配置报错', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://x',
        AKM_EMBEDDING_PROTOCOL: 'baidu',
        AKM_EMBEDDING_URL: 'http://e',
      }),
    ).toThrow(/协议/);
  });

  it('scope 自动注册默认开启；AKM_SCOPE_OPEN=false 关闭', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).scopeOpen).toBe(true);
    expect(loadConfig({ DATABASE_URL: 'postgres://x', AKM_SCOPE_OPEN: 'false' }).scopeOpen).toBe(false);
  });

  it('webDistDir 默认 <cwd>/web/dist；AKM_WEB_DIST_DIR 覆盖', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).webDistDir).toMatch(/web[\\/]dist$/);
    expect(loadConfig({ DATABASE_URL: 'postgres://x', AKM_WEB_DIST_DIR: '/tmp/akm-web' }).webDistDir).toBe('/tmp/akm-web');
  });
});
