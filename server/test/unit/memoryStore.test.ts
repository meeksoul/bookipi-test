import { describe, expect, it } from 'vitest';
import type { OrderEvent } from '../../src/domain/sale.js';
import { MemorySaleStore } from '../../src/store/memoryStore.js';
import { describeSaleStoreContract, saleConfig } from '../contract/saleStoreContract.js';

describeSaleStoreContract('MemorySaleStore', async () => new MemorySaleStore());

describe('MemorySaleStore', () => {
  it('emits exactly one order event per successful purchase', async () => {
    const orders: OrderEvent[] = [];
    const store = new MemorySaleStore(Date.now, (order) => orders.push(order));
    const sale = saleConfig({ totalStock: 1 });
    await store.configureSale(sale);

    await store.attemptPurchase(sale.id, 'a');
    await store.attemptPurchase(sale.id, 'a');
    await store.attemptPurchase(sale.id, 'b');

    expect(orders).toEqual([{ saleId: sale.id, userId: 'a', purchasedAt: expect.any(Number) }]);
  });

  it('treats the end time as exclusive', async () => {
    let now = 1_000;
    const store = new MemorySaleStore(() => now);
    await store.configureSale({ id: 's', startsAt: 1_000, endsAt: 2_000, totalStock: 5 });

    expect((await store.attemptPurchase('s', 'a')).outcome).toBe('SUCCESS');
    now = 1_999;
    expect((await store.attemptPurchase('s', 'b')).outcome).toBe('SUCCESS');
    now = 2_000;
    expect((await store.attemptPurchase('s', 'c')).outcome).toBe('ENDED');
  });
});
