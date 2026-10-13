import { describe, expect, it, vi } from 'vitest';
import { SaleService } from '../../src/service/SaleService.js';
import { MemorySaleStore } from '../../src/store/memoryStore.js';

function setup() {
  let now = 10_000;
  const clock = () => now;
  const store = new MemorySaleStore(clock);
  const service = new SaleService(store, { now: clock, configTtlMs: 1_000, statusTtlMs: 250 });
  return { store, service, advance: (ms: number) => (now += ms) };
}

describe('SaleService', () => {
  it('reports no_sale before any sale is configured', async () => {
    const { service } = setup();
    expect((await service.getStatus()).status).toBe('no_sale');
    expect(await service.purchase('a')).toEqual({ outcome: 'NO_SALE' });
  });

  it('moves through upcoming -> active -> sold_out', async () => {
    const { service, advance } = setup();
    await service.configureSale({ id: 's', startsAt: 11_000, endsAt: 20_000, totalStock: 1 });

    expect((await service.getStatus()).status).toBe('upcoming');
    advance(1_000);
    expect((await service.getStatus()).status).toBe('active');
    expect((await service.purchase('a')).outcome).toBe('SUCCESS');
    advance(250);
    expect(await service.getStatus()).toMatchObject({ status: 'sold_out', stockRemaining: 0, totalStock: 1 });
  });

  it('collapses concurrent status reads into a single store call', async () => {
    const { store, service } = setup();
    await service.configureSale({ id: 's', startsAt: 0, endsAt: 20_000, totalStock: 5 });
    const spy = vi.spyOn(store, 'getStockRemaining');

    await Promise.all(Array.from({ length: 100 }, () => service.getStatus()));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refreshes the cached status after its TTL', async () => {
    const { store, service, advance } = setup();
    await service.configureSale({ id: 's', startsAt: 0, endsAt: 20_000, totalStock: 5 });
    const spy = vi.spyOn(store, 'getStockRemaining');

    await service.getStatus();
    advance(100);
    await service.getStatus();
    advance(200);
    await service.getStatus();

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('looks up a user purchase in the active sale', async () => {
    const { service } = setup();
    await service.configureSale({ id: 's', startsAt: 0, endsAt: 20_000, totalStock: 5 });
    await service.purchase('a');

    expect(await service.getPurchase('a')).toEqual({ saleId: 's', purchasedAt: 10_000 });
    expect(await service.getPurchase('b')).toEqual({ saleId: 's', purchasedAt: null });
  });
});
