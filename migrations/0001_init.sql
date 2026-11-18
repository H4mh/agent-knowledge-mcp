-- 0001_init: 初始 schema（spec §六）
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE knowledge (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  symptom       TEXT NOT NULL,
  solution      TEXT NOT NULL,
  detail        TEXT,
  domain        TEXT NOT NULL,
  scope         TEXT NOT NULL,
  module        TEXT,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  code_ref      TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  author        TEXT NOT NULL,
  use_count     INT NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  embedding     vector,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_usage (
  id            BIGSERIAL PRIMARY KEY,
  knowledge_id  BIGINT NOT NULL REFERENCES knowledge(id),
  used_by       TEXT NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (knowledge_id, used_by)
);

CREATE TABLE scope_registry (
  scope         TEXT PRIMARY KEY,
  description   TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE search_event (
  id            BIGSERIAL PRIMARY KEY,
  queried_by    TEXT NOT NULL,
  query         TEXT NOT NULL,
  scope         TEXT,
  hit_ids       BIGINT[],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  username      TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_scope ON knowledge(scope);
CREATE INDEX idx_knowledge_domain ON knowledge(domain);
CREATE INDEX idx_knowledge_status ON knowledge(status);
CREATE INDEX idx_knowledge_tags ON knowledge USING gin(tags);
CREATE INDEX idx_knowledge_trgm ON knowledge USING gin (title gin_trgm_ops, symptom gin_trgm_ops, solution gin_trgm_ops);
CREATE INDEX idx_search_event_query ON search_event USING gin (query gin_trgm_ops);
CREATE INDEX idx_search_event_created ON search_event(created_at);

INSERT INTO scope_registry (scope, description) VALUES
  ('global',   '跨项目通用知识'),
  ('demo-app',   'demo-app 产品线（人力资源系统）'),
  ('proj-a',  '客户示例A（数字人事系统）'),
  ('proj-b',  'proj-b 项目'),
  ('proj-c',   'proj-c 项目');
