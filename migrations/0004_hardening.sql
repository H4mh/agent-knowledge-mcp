-- 修订历史（2026-11-17）：knowledge.version 版本列、entry_revision 修订记录表
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

CREATE TABLE entry_revision (
  id         BIGSERIAL PRIMARY KEY,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('knowledge','skill')),
  entry_id   BIGINT NOT NULL,
  version    INT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('content','status')),
  changed_by TEXT NOT NULL,
  changes    JSONB NOT NULL,
  snapshot   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_entry_revision_entry ON entry_revision(entry_kind, entry_id, created_at DESC);
