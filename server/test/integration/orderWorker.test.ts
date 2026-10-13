import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgOrderRepository, type OrderRepository } from '../../src/db/orderRepository.js';
import { keys, ORDERS_GROUP } from '../../src/store/redisKeys.js';
import { createRedisClient, RedisSaleStore } from '../../src/store/redisStore.js';
import { OrderWorker } from '../../src/worker/OrderWorker.js';
import { saleConfig } from '../contract/saleStoreContract.js';
import { DATABASE_TEST_URL, isPostgresAvailable, isRedisAvailable, REDIS_TEST_URL } from './helpers.js';

const available = (await isRedisAvailable()) && (await isPostgresAvailable());
if (!available) console.warn('Redis or Postgres not reachable; skipping OrderWorker integration tests');

describe.skipIf(!available)('OrderWorker (Redis stream -> Postgres)', () => {
  let redis: Redis;
  let storeRedis: Redis;
  let store: RedisSaleStore;
  let repo: PgOrderRepository;

  beforeAll(async () => {
    redis = new Redis(REDIS_TEST_URL, { maxRetriesPerRequest: null });
    storeRedis = createRedisClient(REDIS_TEST_URL);
    await storeRedis.connect();
    store = new RedisSaleStore(storeRedis);
    repo = PgOrderRepository.connect(DATABASE_TEST_URL);
    await repo.migrate();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await Promise.all([redis?.quit(), storeRedis?.quit(), repo?.close()]);
  });

  async function sellTo(users: string[], totalStock = users.length) {
    const sale = saleConfig({ totalStock });
    await store.configureSale(sale);
    await Promise.all(users.map((u) => store.attemptPurchase(sale.id, u)));
    return sale;
  }

  const worker = (repository: OrderRepository, opts: { consumer: string; claimIdleMs?: number }) =>
    new OrderWorker(redis, repository, { blockMs: 50, ...opts });

  it('persists every sold item exactly once and acknowledges the stream', async () => {
    const sale = await sellTo(Array.from({ length: 120 }, (_, i) => `user-${i}`), 100);
    const w = worker(repo, { consumer: 'c1' });
    await w.ensureGroup();

    while ((await w.runOnce()) > 0);

    expect(await repo.countBySale(sale.id)).toBe(100);
    const [pending] = (await redis.xpending(keys.orders, ORDERS_GROUP)) as [number];
    expect(pending).toBe(0);
  });

  it('recovers entries left pending by a crashed consumer', async () => {
    const sale = await sellTo(['a', 'b', 'c']);
    const failingRepo: OrderRepository = {
      insertMany: async () => {
        throw new Error('database down');
      },
    };

    const crashed = worker(failingRepo, { consumer: 'crashed', claimIdleMs: 60_000 });
    await crashed.ensureGroup();
    await expect(crashed.runOnce()).rejects.toThrow('database down');
    expect(await repo.countBySale(sale.id)).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const rescuer = worker(repo, { consumer: 'rescuer', claimIdleMs: 50 });
    await rescuer.runOnce();

    expect(await repo.countBySale(sale.id)).toBe(3);
    const [pending] = (await redis.xpending(keys.orders, ORDERS_GROUP)) as [number];
    expect(pending).toBe(0);
  });

  it('tolerates redelivery without creating duplicate orders', async () => {
    const sale = saleConfig();
    const order = { saleId: sale.id, userId: 'dup', purchasedAt: Date.now() };

    await repo.insertMany([order]);
    await repo.insertMany([order, order]);

    expect(await repo.countBySale(sale.id)).toBe(1);
  });
});
