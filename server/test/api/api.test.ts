import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { SaleService } from '../../src/service/SaleService.js';
import { MemorySaleStore } from '../../src/store/memoryStore.js';
import type { SaleStore } from '../../src/store/SaleStore.js';

const ADMIN_TOKEN = 'test-token';
const HOUR = 60 * 60 * 1000;

let app: FastifyInstance;

async function setup(sale: { startsAt?: number; endsAt?: number; totalStock?: number } | null = {}, store?: SaleStore) {
  const saleStore = store ?? new MemorySaleStore();
  // TTLs of zero so each request observes the latest state.
  const service = new SaleService(saleStore, { configTtlMs: 0, statusTtlMs: 0 });
  if (sale) {
    await service.configureSale({
      id: 'launch',
      startsAt: sale.startsAt ?? Date.now() - HOUR,
      endsAt: sale.endsAt ?? Date.now() + HOUR,
      totalStock: sale.totalStock ?? 3,
    });
  }
  app = await buildApp({ service, store: saleStore, adminToken: ADMIN_TOKEN });
  return app;
}

const buy = (userId: unknown) => app.inject({ method: 'POST', url: '/api/purchases', payload: { userId } });

afterEach(async () => {
  await app?.close();
});

describe('GET /api/sale', () => {
  it('returns the status of an active sale', async () => {
    await setup({ totalStock: 3 });
    const res = await app.inject({ method: 'GET', url: '/api/sale' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ saleId: 'launch', status: 'active', totalStock: 3, stockRemaining: 3 });
  });

  it('reports upcoming and ended sales', async () => {
    await setup({ startsAt: Date.now() + HOUR, endsAt: Date.now() + 2 * HOUR });
    expect((await app.inject({ method: 'GET', url: '/api/sale' })).json().status).toBe('upcoming');
    await app.close();

    await setup({ startsAt: Date.now() - 2 * HOUR, endsAt: Date.now() - HOUR });
    expect((await app.inject({ method: 'GET', url: '/api/sale' })).json().status).toBe('ended');
  });

  it('reports no_sale when nothing is configured', async () => {
    await setup(null);
    expect((await app.inject({ method: 'GET', url: '/api/sale' })).json().status).toBe('no_sale');
  });
});

describe('POST /api/purchases', () => {
  it('returns 201 on success and 409 on a repeat attempt', async () => {
    await setup();

    const first = await buy('alice@example.com');
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ outcome: 'SUCCESS', userId: 'alice@example.com' });
    expect(first.json().purchasedAt).toEqual(expect.any(String));

    const repeat = await buy('ALICE@example.com');
    expect(repeat.statusCode).toBe(409);
    expect(repeat.json()).toMatchObject({ outcome: 'ALREADY_PURCHASED', purchasedAt: first.json().purchasedAt });
  });

  it('returns 410 when sold out', async () => {
    await setup({ totalStock: 1 });
    await buy('a');
    const res = await buy('b');
    expect(res.statusCode).toBe(410);
    expect(res.json().outcome).toBe('SOLD_OUT');
  });

  it('returns 403 outside the sale window', async () => {
    await setup({ startsAt: Date.now() + HOUR, endsAt: Date.now() + 2 * HOUR });
    const res = await buy('a');
    expect(res.statusCode).toBe(403);
    expect(res.json().outcome).toBe('NOT_STARTED');
  });

  it('returns 404 when there is no sale', async () => {
    await setup(null);
    expect((await buy('a')).statusCode).toBe(404);
  });

  it.each([undefined, '', 'has spaces', 'x'.repeat(200), 123])('rejects invalid user id %j with 400', async (userId) => {
    await setup();
    expect((await buy(userId)).statusCode).toBe(400);
  });

  it('returns 503 when the inventory store is unavailable', async () => {
    const store = new MemorySaleStore();
    await setup({}, store);
    store.attemptPurchase = async () => {
      throw new Error('connection refused');
    };
    const res = await buy('a');
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('SERVICE_UNAVAILABLE');
  });

  it('sells exactly the stock under concurrent HTTP requests', async () => {
    await setup({ totalStock: 50 });
    const responses = await Promise.all(Array.from({ length: 300 }, (_, i) => buy(`user-${i % 150}`)));

    const codes = responses.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(50);
    expect(codes.every((c) => [201, 409, 410].includes(c))).toBe(true);
  });
});

describe('GET /api/purchases/:userId', () => {
  it('tells a user whether they secured an item', async () => {
    await setup();
    await buy('alice');

    const yes = await app.inject({ method: 'GET', url: '/api/purchases/Alice' });
    expect(yes.json()).toMatchObject({ userId: 'alice', saleId: 'launch', purchased: true });

    const no = await app.inject({ method: 'GET', url: '/api/purchases/bob' });
    expect(no.json()).toMatchObject({ userId: 'bob', purchased: false, purchasedAt: null });
  });
});

describe('PUT /api/admin/sale', () => {
  const payload = {
    id: 'second',
    startsAt: new Date(Date.now() - HOUR).toISOString(),
    endsAt: new Date(Date.now() + HOUR).toISOString(),
    totalStock: 7,
  };

  it('requires the admin token', async () => {
    await setup();
    const res = await app.inject({ method: 'PUT', url: '/api/admin/sale', payload });
    expect(res.statusCode).toBe(401);
  });

  it('starts a new sale with fresh stock and buyers', async () => {
    await setup();
    await buy('alice');

    const res = await app.inject({
      method: 'PUT', url: '/api/admin/sale', payload, headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(res.statusCode).toBe(201);

    const status = (await app.inject({ method: 'GET', url: '/api/sale' })).json();
    expect(status).toMatchObject({ saleId: 'second', stockRemaining: 7, status: 'active' });
    expect((await buy('alice')).statusCode).toBe(201);
  });

  it('rejects an invalid window and duplicate ids', async () => {
    await setup();
    const headers = { 'x-admin-token': ADMIN_TOKEN };

    const invalid = await app.inject({
      method: 'PUT', url: '/api/admin/sale', headers, payload: { ...payload, endsAt: payload.startsAt },
    });
    expect(invalid.statusCode).toBe(400);

    const duplicate = await app.inject({ method: 'PUT', url: '/api/admin/sale', headers, payload: { ...payload, id: 'launch' } });
    expect(duplicate.statusCode).toBe(409);
  });
});
