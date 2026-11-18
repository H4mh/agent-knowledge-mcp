import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export function migrationsDir(): string {
  // 运行时在 dist/，源码在 src/；迁移文件随仓库 migrations/ 目录定位
  const candidates = [
    join(__dirname, '..', 'migrations'),
    join(process.cwd(), 'migrations'),
  ];
  for (const dir of candidates) {
    try {
      readdirSync(dir);
      return dir;
    } catch {
      /* 尝试下一个 */
    }
  }
  throw new Error(`找不到 migrations 目录: ${candidates.join(', ')}`);
}

export async function applyMigrations(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (rowCount) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`迁移 ${file} 失败: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
}
