import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { applyMigrations, createPool } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL 未配置');

const pool = createPool(url);

async function seedUser(username: string, token: string, role: string, enabled: boolean) {
  await pool.query(
    `INSERT INTO app_user (username, token_hash, role, enabled) VALUES ($1,$2,$3,$4)
     ON CONFLICT (username) DO UPDATE SET token_hash = $2, role = $3, enabled = $4`,
    [username, createHash('sha256').update(token).digest('hex'), role, enabled],
  );
}

let baseUrl = '';

beforeAll(async () => {
  await applyMigrations(pool);
  await pool.query('TRUNCATE knowledge, knowledge_usage, search_event, app_user RESTART IDENTITY CASCADE');
  await seedUser('alice', 'alice-token', 'user', true);
  await seedUser('carol', 'carol-token', 'user', false);
  const cfg = loadConfig({ DATABASE_URL: url, PORT: '0', RATE_LIMIT_PER_MIN: '1000' });
  const app = createApp(cfg, { pool });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/mcp`;
});

afterAll(async () => {
  await pool.end();
});

function clientFor(token: string): Client {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  return new Client({ name: 'e2e-test', version: '0.0.1' }, {});
}

describe('MCP 服务 e2e', () => {
  it('列出 9 个工具', async () => {
    const client = clientFor('alice-token');
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: 'Bearer alice-token' } },
    }));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      [
        'get_context',
        'mark_used',
        'save_knowledge',
        'search_knowledge',
        'update_knowledge',
        'save_skill',
        'search_skills',
        'get_skill',
        'update_skill',
      ].sort(),
    );
    await client.close();
  });

  it('save → search 闭环；未命中带引导文案', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: 'Bearer alice-token' } },
    });
    const client = new Client({ name: 'e2e', version: '0.0.1' }, {});
    await client.connect(transport);
    const saved = await client.callTool({
      name: 'save_knowledge',
      arguments: {
        title: 'Qiankun 子应用白屏',
        symptom: '切换子应用后白屏',
        solution: '检查 publicPath 是否为 /subapp/<moduleName>/',
        domain: 'frontend',
        scope: 'demo-app',
        tags: ['qiankun'],
      },
    });
    expect(saved.isError ?? false).toBe(false);
    const hit = await client.callTool({ name: 'search_knowledge', arguments: { query: 'Qiankun 白屏' } });
    expect(JSON.stringify(hit.content)).toContain('Qiankun');
    const miss = await client.callTool({ name: 'search_knowledge', arguments: { query: '完全不存在的词条zzzz' } });
    expect(JSON.stringify(miss.content)).toContain('save_knowledge');
    await client.close();
  });

  it('update_knowledge 带 status → 工具错误提示走 CLI', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: 'Bearer alice-token' } },
    });
    const client = new Client({ name: 'e2e', version: '0.0.1' }, {});
    await client.connect(transport);
    const r = await client.callTool({
      name: 'update_knowledge',
      arguments: { id: 1, status: 'verified' } as never,
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('CLI');
    await client.close();
  });

  it('无 token / 禁用用户 → 401', async () => {
    const noToken = await fetch(baseUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    expect(noToken.status).toBe(401);
    const disabled = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer carol-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(disabled.status).toBe(401);
  });

  it('自报身份：未知 Bearer 首次请求即自动注册为 user；名字本身不再是凭证（再次调用 → 401）', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const post = (auth: string) =>
      fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Authorization: auth },
        body,
      });
    const first = await post('Bearer selfreg-zhangsan');
    expect(first.status).toBe(200);
    const { rows } = await pool.query<{ role: string; enabled: boolean }>(
      `SELECT role, enabled FROM app_user WHERE username = 'selfreg-zhangsan'`);
    expect(rows[0]).toEqual({ role: 'user', enabled: true });
    // 名字只是署名，凭证是注册时一次性发放的 identityToken（Task 3 起随响应注入）
    const again = await post('Bearer selfreg-zhangsan');
    expect(again.status).toBe(401);
  });

  it('joinSecret 兜底：新身份缺/错口令 → 401；对口令 → 接入；已注册身份不受影响', async () => {
    const cfg = loadConfig({ DATABASE_URL: url, PORT: '0', RATE_LIMIT_PER_MIN: '1000', AKM_JOIN_SECRET: 'team-secret' });
    const app = createApp(cfg, { pool });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const gated = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/mcp`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const post = (auth: string, extra: Record<string, string> = {}) =>
      fetch(gated, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Authorization: auth, ...extra },
        body,
      });

    const noSecret = await post('Bearer selfreg-newguy');
    expect(noSecret.status).toBe(401);
    const wrongSecret = await post('Bearer selfreg-newguy', { 'x-join-secret': 'wrong' });
    expect(wrongSecret.status).toBe(401);
    const { rowCount: notRegistered } = await pool.query(`SELECT 1 FROM app_user WHERE username = 'selfreg-newguy'`);
    expect(notRegistered).toBe(0);

    const withSecret = await post('Bearer selfreg-newguy', { 'x-join-secret': 'team-secret' });
    expect(withSecret.status).toBe(200);
    // 名字不再是凭证：注册后再次用名字调用被占用检查拒绝 → 401
    const again = await post('Bearer selfreg-newguy');
    expect(again.status).toBe(401);
    const oldUser = await post('Bearer alice-token');
    expect(oldUser.status).toBe(200);
    await app.close();
  });

  it('限流超限 → 429', async () => {
    const cfg = loadConfig({ DATABASE_URL: url, PORT: '0', RATE_LIMIT_PER_MIN: '2' });
    const app = createApp(cfg, { pool });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const rl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/mcp`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const s1 = await fetch(rl, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer alice-token' }, body });
    const s2 = await fetch(rl, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer alice-token' }, body });
    const s3 = await fetch(rl, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer alice-token' }, body });
    expect(s1.status).toBeLessThan(429);
    expect(s2.status).toBeLessThan(429);
    expect(s3.status).toBe(429);
    await app.close();
  });
});

describe('MCP update_knowledge 乐观锁 base_version e2e（Task 8）', () => {
  let client: Client;
  let id: number;

  beforeAll(async () => {
    client = clientFor('alice-token');
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: 'Bearer alice-token' } },
    }));
    const saved = await client.callTool({
      name: 'save_knowledge',
      arguments: {
        title: '乐观锁 e2e 条目',
        symptom: '多人同时编辑互相覆盖',
        solution: 'update 时携带 base_version 做乐观锁',
        domain: 'frontend',
        scope: 'demo-app',
        tags: ['e2e'],
      },
    });
    expect(saved.isError ?? false).toBe(false);
    const m = (saved.content as { type: string; text: string }[])[0].text.match(/已入库 #(\d+)（draft）。/);
    expect(m, `save 响应应含条目 id，实际: ${(saved.content as { text: string }[])[0].text}`).not.toBeNull();
    id = Number(m![1]);
  });

  afterAll(async () => {
    await client.close();
  });

  it('带匹配 base_version → 成功，响应文本携带新版本号', async () => {
    const r = await client.callTool({
      name: 'update_knowledge',
      arguments: { id, solution: '乐观锁更新后的结论', base_version: 1 } as never,
    });
    expect(r.isError ?? false).toBe(false);
    expect((r.content as { type: string; text: string }[])[0].text).toBe(`已更新（v2）。`);
  });

  it('带过期 base_version → CONFLICT（zod schema 放行 base_version 到 handler）', async () => {
    // 上一个用例已把条目更新到 v2：base_version=1 已过期
    const r = await client.callTool({
      name: 'update_knowledge',
      arguments: { id, solution: '过期版本的提交', base_version: 1 } as never,
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('版本冲突');
  });
});

describe('自报注册 identity_token 注入 e2e（Task 3）', () => {
  const postJson = (auth: string, body: unknown) =>
    fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Authorization: auth },
      body: JSON.stringify(body),
    });

  const callTool = (name: string, args: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  const saveArgs = (title: string, detail?: string) => ({
    title,
    symptom: `${title} 的现象`,
    solution: `${title} 的结论`,
    domain: 'frontend',
    scope: 'global',
    tags: ['e2e'],
    ...(detail ? { detail } : {}),
  });

  /** 从响应 content 文本中提取一次性 identity_token（正则锚定注入文案） */
  const tokenOf = async (resp: Response): Promise<string> => {
    const json = (await resp.json()) as { result?: { content?: { type: string; text: string }[] } };
    const texts = (json.result?.content ?? []).map((c) => c.text).join('\n');
    const m = texts.match(/identity_token）：([0-9a-f]{32})。/);
    expect(m, `响应 content 应携带 identity_token，实际: ${texts}`).not.toBeNull();
    return m![1];
  };

  it('首次 tools/call（save_knowledge）响应携带 identity_token；token 可建完整 SDK 会话；名字再调用 → 401', async () => {
    const name = 'selfreg-lisi';
    const first = await postJson(`Bearer ${name}`, callTool('save_knowledge', saveArgs('Qiankun 样式隔离失效')));
    expect(first.status).toBe(200);
    const token = await tokenOf(first);

    // token 作为凭证：完整 SDK 会话（initialize + tools/list + tools/call）
    const client = new Client({ name: 'e2e-selfreg', version: '0.0.1' }, {});
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toHaveLength(9);
    const search = await client.callTool({ name: 'search_knowledge', arguments: { query: 'Qiankun 样式隔离失效' } });
    expect(search.isError ?? false).toBe(false);
    expect(JSON.stringify(search.content)).toContain('Qiankun 样式隔离失效');
    await client.close();

    // 名字只是署名：再次用名字调用 → 401
    const again = await postJson(`Bearer ${name}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(again.status).toBe(401);
  });

  it('initialize 作为首请求：注册响应经 instructions 下发 identity_token；token 可用；已注册身份不含令牌', async () => {
    const name = 'selfreg-zhaoliu';
    const initBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0.0.1' } },
    };
    const first = await postJson(`Bearer ${name}`, initBody);
    expect(first.status).toBe(200);
    const json = (await first.json()) as { result: { instructions?: string } };
    const inst = json.result.instructions ?? '';
    const m = inst.match(/identity_token）：([0-9a-f]{32})。/);
    expect(m, `initialize 响应 instructions 应携带 identity_token，实际: ${inst}`).not.toBeNull();
    const token = m![1];

    // 下发的 token 立即可用：tools/call 成功
    const call = await postJson(`Bearer ${token}`, callTool('get_context', { scope: 'demo-app' }));
    expect(call.status).toBe(200);

    // 已注册身份的 initialize 响应不含令牌
    const again = await postJson('Bearer alice-token', initBody);
    const againJson = (await again.json()) as { result: { instructions?: string } };
    expect(againJson.result.instructions ?? '').not.toContain('identity_token');
  });

  it('错误路径：首次注册请求触发 SENSITIVE_CONTENT，错误响应同样携带 identity_token；用 token 重试可入库', async () => {
    const name = 'selfreg-wangwu';
    const first = await postJson(
      `Bearer ${name}`,
      callTool('save_knowledge', saveArgs('SSH 密钥误提交', '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----')),
    );
    expect(first.status).toBe(200);
    const json = (await first.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(json.result.isError).toBe(true);
    expect(json.result.content.map((c) => c.text).join('\n')).toContain('[SENSITIVE_CONTENT]');
    const texts = json.result.content.map((c) => c.text).join('\n');
    const m = texts.match(/identity_token）：([0-9a-f]{32})。/);
    expect(m, `错误响应也应携带 identity_token，实际: ${texts}`).not.toBeNull();
    const token = m![1];

    // 客户端拿到 token 后脱敏重试 → 成功入库
    const retry = await postJson(`Bearer ${token}`, callTool('save_knowledge', saveArgs('SSH 密钥误提交已脱敏')));
    const retryJson = (await retry.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(retryJson.result.isError ?? false).toBe(false);
    expect(retryJson.result.content.map((c) => c.text).join('\n')).toContain('已入库');
  });

  it('已注册身份的响应不携带 identity_token', async () => {
    const r = await postJson('Bearer alice-token', callTool('get_context', { scope: 'demo-app' }));
    expect(r.status).toBe(200);
    const json = (await r.json()) as { result: { content: { text: string }[] } };
    expect(json.result.content.map((c) => c.text).join('\n')).not.toContain('identity_token');
  });
});

describe('MCP skill 工具 e2e', () => {
  let client: Client;

  beforeAll(async () => {
    // 仅清本组用例数据；scope 复用前面用例已注册的 demo-app
    await pool.query('TRUNCATE skill, skill_usage RESTART IDENTITY CASCADE');
    client = clientFor('alice-token');
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: 'Bearer alice-token' } },
    }));
  });

  afterAll(async () => {
    await client.close();
  });

  it('save → search → get → update 全链路', async () => {
    const saved = await client.callTool({
      name: 'save_skill',
      arguments: {
        name: 'e2e-demo-skill',
        description: 'e2e 全链路验证用 skill',
        instructions: '按步骤执行 e2e 验证流程',
        files: [{ path: 'scripts/check.sh', content: '#!/bin/bash\necho ok\n' }],
        scope: 'demo-app',
        tags: ['e2e'],
      },
    });
    expect(saved.isError ?? false).toBe(false);
    expect((saved.content as { type: string; text: string }[])[0].text).toBe('已上传 skill "e2e-demo-skill"（draft）。');

    const hit = await client.callTool({ name: 'search_skills', arguments: { query: 'e2e-demo-skill' } });
    expect(hit.isError ?? false).toBe(false);
    expect(JSON.stringify(hit.content)).toContain('e2e-demo-skill');

    const got = await client.callTool({ name: 'get_skill', arguments: { name: 'e2e-demo-skill' } });
    expect(got.isError ?? false).toBe(false);
    const gotObj = JSON.parse((got.content as { type: string; text: string }[])[0].text) as {
      install: string;
      name: string;
      description: string;
      version: number;
      status: string;
      files: { path: string; content: string }[];
    };
    expect(gotObj.name).toBe('e2e-demo-skill');
    expect(gotObj.version).toBe(1);
    expect(gotObj.status).toBe('draft');
    expect(gotObj.install).toContain('~/.claude/skills/e2e-demo-skill/');
    expect(gotObj.files).toHaveLength(2);
    const skillMd = gotObj.files.find((f) => f.path === 'SKILL.md');
    expect(skillMd).toBeDefined();
    expect(skillMd!.content).toMatch(/^---\nname: e2e-demo-skill\ndescription: e2e 全链路验证用 skill\n---/);

    const updated = await client.callTool({
      name: 'update_skill',
      arguments: { name: 'e2e-demo-skill', instructions: '更新后的执行步骤' },
    });
    expect(updated.isError ?? false).toBe(false);
    expect((updated.content as { type: string; text: string }[])[0].text).toBe('已更新 skill "e2e-demo-skill"（v2）。');
  });

  it('update_skill 带过期 base_version → CONFLICT（zod schema 放行 base_version 到 handler）', async () => {
    // 上一个用例已把 e2e-demo-skill 更新到 v2：base_version=1 已过期
    const r = await client.callTool({
      name: 'update_skill',
      arguments: { name: 'e2e-demo-skill', instructions: '再改一次', base_version: 1 } as never,
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('版本冲突');
  });

  it('search_skills 未命中 → 引导文案', async () => {
    const miss = await client.callTool({ name: 'search_skills', arguments: { query: '完全不存在的词条zzzz' } });
    expect(miss.isError ?? false).toBe(false);
    expect(JSON.stringify(miss.content)).toContain('未命中可用 skill。');
  });
});
