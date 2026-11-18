-- scope 自动注册（2026-11-16）：记录由哪个身份首次注册，便于审查
ALTER TABLE scope_registry ADD COLUMN IF NOT EXISTS created_by TEXT;
