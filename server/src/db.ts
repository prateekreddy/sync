import pg from 'pg';

// int8 comes back as a string by default so values beyond 2^53 survive. Lease
// epochs are bounded by claim count on one work item and will never approach
// that, so parsing to Number keeps comparisons honest instead of stringly-typed.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(url = process.env.GATEWAY_DATABASE_URL): Pool {
  if (!url) throw new Error('GATEWAY_DATABASE_URL is not set');
  return new pg.Pool({
    connectionString: url,
    max: Number(process.env.GATEWAY_DB_POOL ?? 10),
    // Claim is a single statement; anything slower than this is a stuck backend,
    // and an agent waiting on it is worse than an agent told to retry.
    statement_timeout: 5_000,
  });
}

export async function tx<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
