import type { EmbeddingConfig } from '../config.js';

/** 向量生成器抽象：配置了向量模型时由 createEmbedder 构建，未配置时不启用 */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/** 按 a.b[0].c 形式的路径从嵌套对象取值 */
function pickByPath(obj: unknown, path: string): unknown {
  const segs = path.replace(/\]/g, '').replace(/\[/g, '.').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const seg of segs) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

async function postJson(url: string, body: unknown, cfg: EmbeddingConfig): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`embedding 服务返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** 各协议生成请求体与从响应中取出向量 */
function buildRequest(cfg: EmbeddingConfig, text: string): unknown {
  switch (cfg.protocol) {
    case 'openai':
    case 'ollama':
      return { model: cfg.model, input: text };
    case 'generic':
      // {{text}}/{{model}} 占位替换为 JSON 字面量；写成 "{{text}}"（带引号）也兼容，
      // 避免引号叠加破坏 JSON。先替换带引号形态再替换裸形态。
      return JSON.parse(
        cfg
          .bodyTemplate!.replace(/"\{\{model\}\}"/g, JSON.stringify(cfg.model))
          .replace(/\{\{model\}\}/g, JSON.stringify(cfg.model))
          .replace(/"\{\{text\}\}"/g, JSON.stringify(text))
          .replace(/\{\{text\}\}/g, JSON.stringify(text)),
      );
  }
}

function extractVector(cfg: EmbeddingConfig, resp: unknown): number[] {
  const raw =
    cfg.protocol === 'openai'
      ? pickByPath(resp, 'data[0].embedding')
      : cfg.protocol === 'ollama'
        ? pickByPath(resp, 'embeddings[0]')
        : pickByPath(resp, cfg.responsePath!);
  if (!Array.isArray(raw) || !raw.every((n) => typeof n === 'number')) {
    throw new Error(`embedding 响应格式不符预期，无法从中取出数值向量: ${JSON.stringify(resp).slice(0, 200)}`);
  }
  return raw as number[];
}

export function createEmbedder(cfg: EmbeddingConfig): Embedder {
  return {
    async embed(text: string): Promise<number[]> {
      const resp = await postJson(cfg.url, buildRequest(cfg, text), cfg);
      return extractVector(cfg, resp);
    },
  };
}
