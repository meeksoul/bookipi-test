import { Redis } from 'ioredis';
import { MongoClient, MongoServerError } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoOrderRepository, type OrderRepository } from '../../src/db/orderRepository.js';
import { keys, ORDERS_GROUP } from '../../src/store/redisKeys.js';
import { createRedisClient, RedisSaleStore } from '../../src/store/redisStore.js';
import { OrderWorker } from '../../src/worker/OrderWorker.js';
import { saleConfig } from '../contract/saleStoreContract.js';
import { isMongoAvailable, isRedisAvailable, MONGO_TEST_URL, REDIS_TEST_URL } from './helpers.js';

const available = (await isRedisAvailable()) && (await isMongoAvailable());
if (!available) console.warn('Redis or MongoDB not reachable; skipping OrderWorker integration tests');

describe.skipIf(!available)('OrderWorker (Redis stream -> MongoDB)', () => {
  let redis: Redis;
  let storeRedis: Redis;
  let store: RedisSaleStore;
  let repo: MongoOrderRepository;
  let mongo: MongoClient;

  beforeAll(async () => {
    redis = new Redis(REDIS_TEST_URL, { maxRetriesPerRequest: null });
    storeRedis = createRedisClient(REDIS_TEST_URL);
    await storeRedis.connect();
    store = new RedisSaleStore(storeRedis);

    mongo = await MongoClient.connect(MONGO_TEST_URL);
    await mongo.db().dropDatabase();
    repo = await MongoOrderRepository.connect(MONGO_TEST_URL);
    await repo.ensureSchema();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await Promise.all([redis?.quit(), storeRedis?.quit(), repo?.close(), mongo?.close()]);
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

  it('tolerates redelivery without creating or overwriting orders', async () => {
    const sale = saleConfig();
    const order = { saleId: sale.id, userId: 'dup', purchasedAt: 1_000 };

    await repo.insertMany([order]);
    await repo.insertMany([order, { ...order, purchasedAt: 2_000 }]);

    expect(await repo.countBySale(sale.id)).toBe(1);
    const doc = await mongo.db().collection('orders').findOne({ saleId: sale.id });
    expect(doc?.purchasedAt).toEqual(new Date(1_000));
  });

  it('treats concurrent upserts of the same order as success', async () => {
    const sale = saleConfig();
    const order = { saleId: sale.id, userId: 'racer', purchasedAt: Date.now() };

    await Promise.all(Array.from({ length: 20 }, () => repo.insertMany([order])));

    expect(await repo.countBySale(sale.id)).toBe(1);
  });

  it('enforces one order per user at the database level', async () => {
    const sale = saleConfig();
    const orders = mongo.db().collection('orders');
    const doc = { saleId: sale.id, userId: 'u', purchasedAt: new Date(), persistedAt: new Date() };

    await orders.insertOne({ ...doc });
    await expect(orders.insertOne({ ...doc })).rejects.toMatchObject({ code: 11000 });
  });

  it('rejects malformed documents through the schema validator', async () => {
    const orders = mongo.db().collection('orders');

    const error = await orders
      .insertOne({ saleId: 's', userId: 'u', purchasedAt: '2026-01-01', persistedAt: new Date() })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MongoServerError);
    expect((error as MongoServerError).code).toBe(121);
  });

  it('can re-run schema setup on an existing collection', async () => {
    await expect(repo.ensureSchema()).resolves.toBeUndefined();
  });
});
