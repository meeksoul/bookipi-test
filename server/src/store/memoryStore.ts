import type { OrderEvent, PurchaseResult, SaleConfig } from '../domain/sale.js';
import type { ConfigureResult, SaleStore } from './SaleStore.js';

interface SaleState {
  config: SaleConfig;
  stock: number;
  buyers: Map<string, number>;
}

/**
 * Single-process store used for unit tests and for running the demo without
 * Docker. Node runs each method body without interleaving (no awaits inside),
 * which gives the same atomicity the Redis Lua script provides.
 */
export class MemorySaleStore implements SaleStore {
  private sales = new Map<string, SaleState>();
  private activeId: string | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onOrder: (order: OrderEvent) => void = () => {},
  ) {}

  async getActiveSale(): Promise<SaleConfig | null> {
    return this.activeId ? { ...this.sales.get(this.activeId)!.config } : null;
  }

  async getStockRemaining(saleId: string): Promise<number> {
    return this.sales.get(saleId)?.stock ?? 0;
  }

  async attemptPurchase(saleId: string, userId: string): Promise<PurchaseResult> {
    const sale = this.sales.get(saleId);
    if (!sale) return { outcome: 'NO_SALE' };

    const now = this.now();
    if (now < sale.config.startsAt) return { outcome: 'NOT_STARTED' };
    if (now >= sale.config.endsAt) return { outcome: 'ENDED' };

    const previous = sale.buyers.get(userId);
    if (previous !== undefined) return { outcome: 'ALREADY_PURCHASED', purchasedAt: previous };
    if (sale.stock <= 0) return { outcome: 'SOLD_OUT' };

    sale.stock -= 1;
    sale.buyers.set(userId, now);
    this.onOrder({ saleId, userId, purchasedAt: now });
    return { outcome: 'SUCCESS', purchasedAt: now };
  }

  async getPurchase(saleId: string, userId: string): Promise<number | null> {
    return this.sales.get(saleId)?.buyers.get(userId) ?? null;
  }

  async configureSale(config: SaleConfig, opts: { ifNoActiveSale?: boolean } = {}): Promise<ConfigureResult> {
    if (opts.ifNoActiveSale && this.activeId) return 'SKIPPED_EXISTING_ACTIVE';
    if (this.sales.has(config.id)) return 'DUPLICATE_ID';

    const previous = this.activeId ? this.sales.get(this.activeId) : undefined;
    if (previous) previous.config.endsAt = Math.min(previous.config.endsAt, this.now());

    this.sales.set(config.id, { config: { ...config }, stock: config.totalStock, buyers: new Map() });
    this.activeId = config.id;
    return 'CREATED';
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
