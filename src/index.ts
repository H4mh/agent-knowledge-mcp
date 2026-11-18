import { loadConfig } from './config.js';
import { applyMigrations, createPool } from './db.js';
import { createApp } from './app.js';

async function main() {
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  await applyMigrations(pool);
  const app = createApp(cfg, { pool });

  const shutdown = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  console.log(`agent-knowledge-mcp listening on :${cfg.port}`);
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
