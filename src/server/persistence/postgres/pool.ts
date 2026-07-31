import pg from 'pg';

/**
 * API shape for the pg.Pool used here and in the codec/repository types.
 * Re-exported for convenience.
 */
export type Pool = pg.Pool;

/** Default pool options matching typical self-hosted deployment bounds. */
export const DEFAULT_POOL_MAX = 10;
export const DEFAULT_POOL_IDLE_TIMEOUT = 30000;   // 30 seconds
export const DEFAULT_POOL_CONNECTION_TIMEOUT = 5000; // 5 seconds

/**
 * Creates a configured pg.Pool with credential-safe error logging.
 *
 * The caller is responsible for passing DATABASE_URL.
 */
export function createPostgresPool(
  config: {
    DATABASE_URL: string;
    poolMax?: number;
    poolIdleTimeout?: number;
    poolConnectionTimeout?: number;
  },
): Pool {
  const poolMax = config.poolMax ?? DEFAULT_POOL_MAX;
  const poolIdleTimeout = config.poolIdleTimeout ?? DEFAULT_POOL_IDLE_TIMEOUT;
  const poolConnectionTimeout =
    config.poolConnectionTimeout ?? DEFAULT_POOL_CONNECTION_TIMEOUT;

  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: poolMax,
    idleTimeoutMillis: poolIdleTimeout,
    connectionTimeoutMillis: poolConnectionTimeout,
  });

  // Attach a credential-safe error listener: log generic messages,
  // never expose the connection string.
  pool.on('error', (err: Error) => {
    // Only log a sanitized message; do not include the full err.message
    // which may contain the password or other secrets.
    console.error(
      `[pg-pool] database connection error: ${err.name ?? 'PoolError'}`,
    );
  });

  return pool;
}
