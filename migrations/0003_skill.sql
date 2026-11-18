-- skill 共享（2026-11-17）：skill 表、skill_usage 使用记录、search_event.kind 来源列
CREATE TABLE skill (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,   -- kebab-case，安装目录名
  description  TEXT NOT NULL,          -- 检索与展示用
  instructions TEXT NOT NULL,          -- SKILL.md 正文（不含 frontmatter）
  files        JSONB NOT NULL DEFAULT '[]',  -- [{path, content}] 相对目录的附加文件
  scope        TEXT,                   -- 可选关联项目 scope（scope_registry 校验）
  tags         TEXT[] NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'draft',
  author       TEXT NOT NULL,
  version      INT NOT NULL DEFAULT 1,
  use_count    INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  embedding    vector,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_skill_scope ON skill(scope);
CREATE INDEX idx_skill_tags ON skill USING gin(tags);
CREATE INDEX idx_skill_name_trgm ON skill USING gin(name gin_trgm_ops);
CREATE INDEX idx_skill_desc_trgm ON skill USING gin((name || ' ' || description) gin_trgm_ops);

CREATE TABLE skill_usage (
  id         BIGSERIAL PRIMARY KEY,
  skill_id   BIGINT NOT NULL REFERENCES skill(id),
  used_by    TEXT NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, used_by)
);

-- search_event 增加来源列（区分知识检索与 skill 检索，hit_ids 语义随之限定）
ALTER TABLE search_event ADD COLUMN kind TEXT NOT NULL DEFAULT 'knowledge';
