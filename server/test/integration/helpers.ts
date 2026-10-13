import { Redis } from 'ioredis';
import pg from 'pg';

/** DB 15 keeps tests away from the dev data in DB 0. */
export const REDIS_TEST_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/15';
export const DATABASE_TEST_URL = process.env.DATABASE_TEST_URL ?? 'postgres://flash:flash@localhost:5432/flashsale';

export async function isRedisAvailable(): Promise<boolean> {
  const redis = new Redis(REDIS_TEST_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  try {
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

export async function isPostgresAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_TEST_URL, connectionTimeoutMillis: 1_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
