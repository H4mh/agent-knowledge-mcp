import { describe, expect, it, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createEmbedder } from '../src/embedding/index.js';
import type { EmbeddingConfig } from '../src/config.js';

interface Recorded {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

/** 起一个一次性 stub embedding 服务，返回录制的请求与给定响应 */
async function stub(opts: {
  status?: number;
  respond: (body: unknown) => unknown;
  sleepMs?: number;
}): Promise<{ url: string; recorded: Recorded[] }> {
  const recorded: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      recorded.push({
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'),
        headers: req.headers,
      });
      const send = () => {
        res.writeHead(opts.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(opts.respond(recorded)));
      };
      if (opts.sleepMs) setTimeout(send, opts.sleepMs);
      else send();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/embed`, recorded };
}

const base: EmbeddingConfig = {
  protocol: 'openai',
  url: '',
  model: 'bge-m3',
  timeoutMs: 2000,
};

describe('createEmbedder', () => {
  it('openai 协议：POST {model,input}，带 Bearer 头，解析 data[0].embedding', async () => {
    const { url, recorded } = await stub({ respond: () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) });
    const e = createEmbedder({ ...base, url, apiKey: 'sk-test' });
    expect(await e.embed('数据库超时')).toEqual([0.1, 0.2, 0.3]);
    expect(recorded[0].body).toEqual({ model: 'bge-m3', input: '数据库超时' });
    expect(recorded[0].headers.authorization).toBe('Bearer sk-test');
  });

  it('ollama 协议：POST {model,input}，解析 embeddings[0]', async () => {
    const { url, recorded } = await stub({ respond: () => ({ embeddings: [[0.3, 0.4]] }) });
    const e = createEmbedder({ ...base, protocol: 'ollama', url });
    expect(await e.embed('分页失效')).toEqual([0.3, 0.4]);
    expect(recorded[0].body).toEqual({ model: 'bge-m3', input: '分页失效' });
    expect(recorded[0].headers.authorization).toBeUndefined();
  });

  it('generic 协议：按模板组装请求体，按路径取响应向量', async () => {
    const { url, recorded } = await stub({ respond: () => ({ result: { vector: [9, 8, 7] } }) });
    const e = createEmbedder({
      ...base,
      protocol: 'generic',
      url,
      bodyTemplate: '{"q":{{text}},"model":"{{model}}"}',
      responsePath: 'result.vector',
    });
    expect(await e.embed('中文"引号"文本')).toEqual([9, 8, 7]);
    expect(recorded[0].body).toEqual({ q: '中文"引号"文本', model: 'bge-m3' });
  });

  it('generic 协议支持数组下标路径 data[0].embedding', async () => {
    const { url } = await stub({ respond: () => ({ data: [{ embedding: [1, 2] }] }) });
    const e = createEmbedder({
      ...base,
      protocol: 'generic',
      url,
      bodyTemplate: '{"input":{{text}}}',
      responsePath: 'data[0].embedding',
    });
    expect(await e.embed('x')).toEqual([1, 2]);
  });

  it('服务返回 500 → embed 拒绝（调用方负责降级）', async () => {
    const { url } = await stub({ status: 500, respond: () => ({ error: 'boom' }) });
    const e = createEmbedder({ ...base, url });
    await expect(e.embed('x')).rejects.toThrow(/500/);
  });

  it('超时 → embed 拒绝', async () => {
    const { url } = await stub({ respond: () => ({}), sleepMs: 300 });
    const e = createEmbedder({ ...base, url, timeoutMs: 80 });
    await expect(e.embed('x')).rejects.toThrow();
  });
});
