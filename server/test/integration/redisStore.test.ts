import type { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { keys } from '../../src/store/redisKeys.js';
import { createRedisClient, RedisSaleStore } from '../../src/store/redisStore.js';
import { describeSaleStoreContract, saleConfig } from '../contract/saleStoreContract.js';
import { isRedisAvailable, REDIS_TEST_URL } from './helpers.js';

const redisAvailable = await isRedisAvailable();
if (!redisAvailable) console.warn(`Redis not reachable at ${REDIS_TEST_URL}; skipping Redis integration tests`);

describe.skipIf(!redisAvailable)('RedisSaleStore', () => {
  const clients: Redis[] = [];

  async function createStore() {
    const redis = createRedisClient(REDIS_TEST_URL);
    await redis.connect();
    clients.push(redis);
    return new RedisSaleStore(redis);
  }

  beforeEach(async () => {
    const admin = createRedisClient(REDIS_TEST_URL);
    await admin.connect();
    await admin.flushdb();
    admin.disconnect();
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit()));
  });

  describeSaleStoreContract('RedisSaleStore', createStore);

  it('appends exactly one order to the stream per successful purchase', async () => {
    const store = await createStore();
    const sale = saleConfig({ totalStock: 3 });
    await store.configureSale(sale);

    await Promise.all(['a', 'a', 'b', 'c', 'd', 'e'].map((u) => store.attemptPurchase(sale.id, u)));

    const entries = await clients[0]!.xrange(keys.orders, '-', '+');
    const users = entries.map(([, fields]) => fields[fields.indexOf('userId') + 1]);
    expect(users).toHaveLength(3);
    expect(new Set(users).size).toBe(3);
  });

  it('stays correct when many independent connections (like API replicas) race', async () => {
    const stores = await Promise.all(Array.from({ length: 8 }, () => createStore()));
    const sale = saleConfig({ totalStock: 250 });
    await stores[0]!.configureSale(sale);

    const results = await Promise.all(
      Array.from({ length: 4_000 }, (_, i) => stores[i % stores.length]!.attemptPurchase(sale.id, `u${i % 1_000}`)),
    );

    expect(results.filter((r) => r.outcome === 'SUCCESS')).toHaveLength(250);
    expect(await stores[0]!.getStockRemaining(sale.id)).toBe(0);
    expect(await clients[0]!.hlen(keys.buyers(sale.id))).toBe(250);
  });
});
