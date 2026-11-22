const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
const lockId = 74201931;

async function migrate() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be configured before running database migrations.');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10000
  });
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name TEXT PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = fs.readdirSync(migrationsDir)
      .filter((file) => /^\\d+_.*\\.sql$/.test(file))
      .sort();

    if (files.length === 0) {
      throw new Error(`No SQL migration files found in ${migrationsDir}`);
    }

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      await client.query('BEGIN');
      try {
        const existing = await client.query(
          'SELECT checksum FROM schema_migrations WHERE migration_name = $1',
          [file]
        );

        if (existing.rowCount > 0) {
          if (existing.rows[0].checksum.trim() !== checksum) {
            throw new Error(`Applied migration ${file} has changed. Create a new migration instead of editing an applied file.`);
          }
          await client.query('COMMIT');
          console.log(`Migration already applied: ${file}`);
          continue;
        }

        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (migration_name, checksum) VALUES ($1, $2)',
          [file, checksum]
        );
        await client.query('COMMIT');
        console.log(`Applied migration: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    console.log('Database migrations are up to date.');
  } finally {
    if (lockAcquired) {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {});
    }
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
});
