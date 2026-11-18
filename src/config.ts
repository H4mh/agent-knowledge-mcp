import { join } from 'node:path';

export interface SearchWeights {
  title: number;
  tags: number;
  symptom: number;
  solution: number;
  trigram: number;
  verifiedBoost: number;
  scopeBoost: number;
  useCountBoost: number;
  /** 向量相似度权重（启用向量检索时生效） */
  vector: number;
}

export type EmbeddingProtocol = 'openai' | 'ollama' | 'generic';

export interface EmbeddingConfig {
  protocol: EmbeddingProtocol;
  /** 完整请求地址：openai 为 .../embeddings，ollama 为 .../api/embed，generic 为自定义接口 */
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  /** generic 协议：请求体模板，{{text}} 与 {{model}} 占位 */
  bodyTemplate?: string;
  /** generic 协议：响应中向量所在路径，如 data[0].embedding */
  responsePath?: string;
}

export interface Config {
  port: number;
  databaseUrl: string;
  rateLimitPerMin: number;
  dedupThreshold: number;
  /** 兜底加入口令：配置后新身份首次注册须携带；未配置 = 完全开放接入 */
  joinSecret?: string;
  searchWeights: SearchWeights;
  /** 向量检索配置：AKM_EMBEDDING_PROTOCOL + AKM_EMBEDDING_URL 均配置时启用，否则 undefined（不启用） */
  embedding?: EmbeddingConfig;
  /** scope 自动注册是否开放：AKM_SCOPE_OPEN=false 时新 scope 须管理员预先注册（默认开放） */
  scopeOpen: boolean;
  /** 门户静态产物目录：存在时由 Fastify 托管并提供 SPA fallback；缺省 <cwd>/web/dist */
  webDistDir?: string;
}

function num(env: Record<string, string | undefined>, key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${key} 不是有效数字: ${v}`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('环境变量 DATABASE_URL 未配置');

  // 向量检索：protocol 与 url 同时配置才启用；generic 协议额外要求模板与取值路径
  const protocol = env.AKM_EMBEDDING_PROTOCOL;
  const embUrl = env.AKM_EMBEDDING_URL;
  let embedding: EmbeddingConfig | undefined;
  if (protocol && embUrl) {
    if (protocol !== 'openai' && protocol !== 'ollama' && protocol !== 'generic') {
      throw new Error(`环境变量 AKM_EMBEDDING_PROTOCOL 协议未知: ${protocol}。可用: openai | ollama | generic`);
    }
    if (protocol === 'generic' && (!env.AKM_EMBEDDING_BODY_TEMPLATE || !env.AKM_EMBEDDING_RESPONSE_PATH)) {
      throw new Error(
        'generic 协议需要 AKM_EMBEDDING_BODY_TEMPLATE（请求体模板，含 {{text}}/{{model}} 占位）与 AKM_EMBEDDING_RESPONSE_PATH（响应取值路径，如 data[0].embedding）',
      );
    }
    embedding = {
      protocol: protocol as EmbeddingProtocol,
      url: embUrl,
      model: env.AKM_EMBEDDING_MODEL || '',
      apiKey: env.AKM_EMBEDDING_API_KEY || undefined,
      timeoutMs: num(env, 'AKM_EMBEDDING_TIMEOUT_MS', 5000),
      bodyTemplate: env.AKM_EMBEDDING_BODY_TEMPLATE,
      responsePath: env.AKM_EMBEDDING_RESPONSE_PATH,
    };
  } else if (protocol || embUrl) {
    throw new Error(
      '向量检索需同时配置 AKM_EMBEDDING_PROTOCOL 与 AKM_EMBEDDING_URL（当前只配了一个，疑似漏配或拼写错误）',
    );
  }

  return {
    port: num(env, 'PORT', 3000),
    databaseUrl,
    rateLimitPerMin: num(env, 'RATE_LIMIT_PER_MIN', 60),
    dedupThreshold: num(env, 'DEDUP_THRESHOLD', 0.6),
    joinSecret: env.AKM_JOIN_SECRET || undefined,
    scopeOpen: env.AKM_SCOPE_OPEN !== 'false',
    webDistDir: env.AKM_WEB_DIST_DIR || join(process.cwd(), 'web', 'dist'),
    searchWeights: {
      title: num(env, 'W_TITLE', 1),
      tags: num(env, 'W_TAGS', 1),
      symptom: num(env, 'W_SYMPTOM', 1),
      solution: num(env, 'W_SOLUTION', 1),
      trigram: num(env, 'W_TRIGRAM', 1),
      verifiedBoost: num(env, 'W_VERIFIED_BOOST', 2),
      scopeBoost: num(env, 'W_SCOPE_BOOST', 3),
      useCountBoost: num(env, 'W_USE_COUNT_BOOST', 0.1),
      vector: num(env, 'W_VECTOR', 4),
    },
    embedding,
  };
}
