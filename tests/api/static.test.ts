import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { applyMigrations, createPool } from '../../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);
const webDist = mkdtempSync(join(tmpdir(), 'akm-web-'));
writeFileSync(join(webDist, 'index.html'), '<html>portal-fixture</html>', 'utf8');

const app = createApp(loadConfig({ DATABASE_URL: url, AKM_WEB_DIST_DIR: webDist }), { pool });
const noWebApp = createApp(loadConfig({ DATABASE_URL: url, AKM_WEB_DIST_DIR: join(tmpdir(), 'akm-no-such-dir') }), { pool });

beforeAll(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE app_user RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
  rmSync(webDist, { recursive: true, force: true });
});

describe('静态托管 + SPA fallback', () => {
  it('GET / 返回 index.html；GET /admin/scopes 同样返回 index.html（history fallback）', async () => {
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('portal-fixture');
    const deep = await app.inject({ method: 'GET', url: '/admin/scopes' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('portal-fixture');
  });

  it('未知 /api/xxx 返回 404 JSON（不落 SPA fallback）', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/nonexistent' });
    expect(r.statusCode).toBe(404);
    expect(() => JSON.parse(r.body)).not.toThrow();
  });

  it('GET /mcp 仍 405；webDistDir 不存在时不托管静态（404 JSON）', async () => {
    expect((await app.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(405);
    const r = await noWebApp.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(404);
    expect(() => JSON.parse(r.body)).not.toThrow();
  });
});
