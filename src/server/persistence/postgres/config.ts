/**
 * Shared Postgres environment configuration.
 *
 * Parses DATABASE_URL and pool-related environment variables with strict
 * parsing rules and default ranges.
 *
 * The caller passes environment values (or uses defaults from process.env),
 * and the returned config object can be used to create a pg.Pool.
 */

import pg from 'pg';

/** Default pool max and its allowed range. */
const POOL_MAX_DEFAULT = 10;
const POOL_MAX_RANGE = [1, 100];

/** Default idle timeout (ms) and its allowed range. */
const IDLE_TIMEOUT_DEFAULT = 10000;
const IDLE_TIMEOUT_RANGE = [0, 3600000];

/** Default connection timeout (ms) and its allowed range. */
const CONN_TIMEOUT_DEFAULT = 5000;
const CONN_TIMEOUT_RANGE = [1, 3600000];

/**
 * Parsed Postgres environment config shape.
 */
export type PostgresEnvConfig = {
  DATABASE_URL: string;
  poolMax: number;
  poolIdleTimeout: number;
  poolConnectionTimeout: number;
};

/**
 * Parse a strict base-10 integer environment variable value.
 */
function parseStrictInt(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed) || String(parsed) !== value) {
    throw new Error(`Invalid ${name}: must be a strict base-10 integer`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

/**
 * Parse environment values to produce a PostgresEnvConfig.
 */
export function parsePostgresEnv(
  env: {
    DATABASE_URL?: string;
    POSTGRES_POOL_MAX?: string;
    POSTGRES_IDLE_TIMEOUT_MS?: string;
    POSTGRES_CONNECTION_TIMEOUT_MS?: string;
  } = {},
): PostgresEnvConfig {
  const DATABASE_URL = env.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required for postgres driver');
  }

  const poolMax = parseStrictInt(
    'POSTGRES_POOL_MAX',
    env.POSTGRES_POOL_MAX ?? process.env.POSTGRES_POOL_MAX,
    POOL_MAX_DEFAULT,
    1,
    100,
  );
  const poolIdleTimeout = parseStrictInt(
    'POSTGRES_IDLE_TIMEOUT_MS',
    env.POSTGRES_IDLE_TIMEOUT_MS ?? process.env.POSTGRES_IDLE_TIMEOUT_MS,
    IDLE_TIMEOUT_DEFAULT,
    0,
    3600000,
  );
  const poolConnectionTimeout = parseStrictInt(
    'POSTGRES_CONNECTION_TIMEOUT_MS',
    env.POSTGRES_CONNECTION_TIMEOUT_MS ?? process.env.POSTGRES_CONNECTION_TIMEOUT_MS,
    CONN_TIMEOUT_DEFAULT,
    1,
    3600000,
  );

  return { DATABASE_URL, poolMax, poolIdleTimeout, poolConnectionTimeout };
}

/**
 * Create a pg.Pool from a parsed PostgresEnvConfig.
 */
export function createPostgresPoolFromEnv(
  config: PostgresEnvConfig,
): pg.Pool {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.poolMax,
    idleTimeoutMillis: config.poolIdleTimeout,
    connectionTimeoutMillis: config.poolConnectionTimeout,
  });
}
