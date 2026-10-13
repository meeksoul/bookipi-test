import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';

/** DB 15 / a separate Mongo database keep tests away from the dev data. */
export const REDIS_TEST_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/15';
export const MONGO_TEST_URL = process.env.MONGO_TEST_URL ?? 'mongodb://localhost:27017/flashsale_test?directConnection=true';

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

export async function isMongoAvailable(): Promise<boolean> {
  const client = new MongoClient(MONGO_TEST_URL, { serverSelectionTimeoutMS: 1_000 });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}
