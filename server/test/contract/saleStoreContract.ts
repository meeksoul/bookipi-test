import { describe, expect, it } from 'vitest';
import type { PurchaseResult, SaleConfig } from '../../src/domain/sale.js';
import type { SaleStore } from '../../src/store/SaleStore.js';

const HOUR = 60 * 60 * 1000;

let counter = 0;
export function saleConfig(overrides: Partial<SaleConfig> = {}): SaleConfig {
  const now = Date.now();
  return {
    id: `test-${process.pid}-${Date.now()}-${counter++}`,
    startsAt: now - HOUR,
    endsAt: now + HOUR,
    totalStock: 10,
    ...overrides,
  };
}

/**
 * Behaviour every SaleStore implementation must satisfy. Run against both the
 * in-memory store (unit) and Redis (integration) so they cannot drift apart.
 */
export function describeSaleStoreContract(name: string, createStore: () => Promise<SaleStore>) {
  describe(`${name} (SaleStore contract)`, () => {
    async function storeWithSale(overrides: Partial<SaleConfig> = {}) {
      const store = await createStore();
      const sale = saleConfig(overrides);
      expect(await store.configureSale(sale)).toBe('CREATED');
      return { store, sale };
    }

    it('sells to a user once and reports ALREADY_PURCHASED afterwards', async () => {
      const { store, sale } = await storeWithSale();

      const first = await store.attemptPurchase(sale.id, 'alice');
      const second = await store.attemptPurchase(sale.id, 'alice');

      expect(first.outcome).toBe('SUCCESS');
      expect(second).toEqual({ outcome: 'ALREADY_PURCHASED', purchasedAt: first.purchasedAt });
      expect(await store.getStockRemaining(sale.id)).toBe(sale.totalStock - 1);
      expect(await store.getPurchase(sale.id, 'alice')).toBe(first.purchasedAt);
      expect(await store.getPurchase(sale.id, 'bob')).toBeNull();
    });

    it('rejects purchases before the window opens and after it closes', async () => {
      const upcoming = await storeWithSale({ startsAt: Date.now() + HOUR, endsAt: Date.now() + 2 * HOUR });
      expect((await upcoming.store.attemptPurchase(upcoming.sale.id, 'alice')).outcome).toBe('NOT_STARTED');

      const ended = await storeWithSale({ startsAt: Date.now() - 2 * HOUR, endsAt: Date.now() - HOUR });
      expect((await ended.store.attemptPurchase(ended.sale.id, 'alice')).outcome).toBe('ENDED');
      expect(await ended.store.getStockRemaining(ended.sale.id)).toBe(ended.sale.totalStock);
    });

    it('returns NO_SALE for an unknown sale', async () => {
      const store = await createStore();
      expect((await store.attemptPurchase('does-not-exist', 'alice')).outcome).toBe('NO_SALE');
    });

    it('reports SOLD_OUT once stock is exhausted, but buyers still see their purchase', async () => {
      const { store, sale } = await storeWithSale({ totalStock: 2 });

      expect((await store.attemptPurchase(sale.id, 'a')).outcome).toBe('SUCCESS');
      expect((await store.attemptPurchase(sale.id, 'b')).outcome).toBe('SUCCESS');
      expect((await store.attemptPurchase(sale.id, 'c')).outcome).toBe('SOLD_OUT');
      expect((await store.attemptPurchase(sale.id, 'a')).outcome).toBe('ALREADY_PURCHASED');
      expect(await store.getStockRemaining(sale.id)).toBe(0);
    });

    it('handles a sale with zero stock', async () => {
      const { store, sale } = await storeWithSale({ totalStock: 0 });
      expect((await store.attemptPurchase(sale.id, 'a')).outcome).toBe('SOLD_OUT');
    });

    it('never oversells or double-sells under concurrent attempts', async () => {
      const stock = 100;
      const users = 500;
      const attemptsPerUser = 4;
      const { store, sale } = await storeWithSale({ totalStock: stock });

      const attempts: Promise<PurchaseResult & { userId: string }>[] = [];
      for (let round = 0; round < attemptsPerUser; round++) {
        for (let u = 0; u < users; u++) {
          const userId = `user-${u}`;
          attempts.push(store.attemptPurchase(sale.id, userId).then((r) => ({ ...r, userId })));
        }
      }
      const results = await Promise.all(attempts);

      const winners = results.filter((r) => r.outcome === 'SUCCESS').map((r) => r.userId);
      expect(winners).toHaveLength(stock);
      expect(new Set(winners).size).toBe(stock);
      expect(await store.getStockRemaining(sale.id)).toBe(0);

      const outcomes = new Set(results.map((r) => r.outcome));
      expect([...outcomes].sort()).toEqual(['ALREADY_PURCHASED', 'SOLD_OUT', 'SUCCESS']);
    });

    it('does not overwrite an active sale when ifNoActiveSale is set', async () => {
      const { store, sale } = await storeWithSale();
      const other = saleConfig();

      expect(await store.configureSale(other, { ifNoActiveSale: true })).toBe('SKIPPED_EXISTING_ACTIVE');
      expect((await store.getActiveSale())?.id).toBe(sale.id);
    });

    it('rejects a duplicate sale id', async () => {
      const { store, sale } = await storeWithSale();
      expect(await store.configureSale({ ...sale })).toBe('DUPLICATE_ID');
    });

    it('closes the previous sale when a new one is configured', async () => {
      const { store, sale } = await storeWithSale();
      const next = saleConfig();

      expect(await store.configureSale(next)).toBe('CREATED');

      expect(await store.getActiveSale()).toEqual(next);
      expect((await store.attemptPurchase(sale.id, 'late')).outcome).toBe('ENDED');
      expect((await store.attemptPurchase(next.id, 'late')).outcome).toBe('SUCCESS');
    });
  });
}
