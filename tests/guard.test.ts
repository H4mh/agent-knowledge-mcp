import { describe, expect, it } from 'vitest';
import { loadGuardRules, scanText } from '../src/guard/index.js';
import { join } from 'node:path';

const rules = loadGuardRules(join(process.cwd(), 'config', 'guard-rules.json'));

describe('scanText', () => {
  it('私钥块 → 硬拒绝', () => {
    const r = scanText('配置如下 -----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----', rules);
    expect(r.blocked).toBe(true);
    expect(r.hits.some((h) => h.rule === '私钥块')).toBe(true);
  });

  it('AWS 密钥 → 硬拒绝', () => {
    const r = scanText('key is AKIAIOSFODNN7EXAMPLE', rules);
    expect(r.blocked).toBe(true);
  });

  it('身份证号 → 硬拒绝', () => {
    const r = scanText('测试身份证 11010519491231002X', rules);
    expect(r.blocked).toBe(true);
  });

  it('银行卡号 → 硬拒绝', () => {
    const r = scanText('卡号 6222600260001072444', rules);
    expect(r.blocked).toBe(true);
  });

  it('内网 IP → 仅警告，不拦截', () => {
    const r = scanText('连接 Nexus：10.2.3.4:8081', rules);
    expect(r.blocked).toBe(false);
    expect(r.warnings.join('')).toContain('内网');
    expect(r.hits.length).toBe(0);
  });

  it('192.168 地址 → 仅警告', () => {
    const r = scanText('数据库在 192.168.1.10', rules);
    expect(r.blocked).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('正常文本 → 无命中', () => {
    const r = scanText('升级 Spring Boot 后需要显式引入 pagehelper 2.x', rules);
    expect(r.blocked).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(r.hits).toEqual([]);
  });
});
