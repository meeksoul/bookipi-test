import {
  computeSaleStatus,
  validateSaleConfig,
  type PurchaseResult,
  type SaleConfig,
  type SaleStatus,
} from '../domain/sale.js';
import type { ConfigureResult, SaleStore } from '../store/SaleStore.js';

export interface SaleStatusView {
  saleId: string | null;
  status: SaleStatus | 'no_sale';
  startsAt: string | null;
  endsAt: string | null;
  totalStock: number;
  stockRemaining: number;
  serverTime: string;
}

export interface SaleServiceOptions {
  now?: () => number;
  /** How long the active sale config may be served from memory. */
  configTtlMs?: number;
  /**
   * How long a computed status may be served from memory. The status endpoint
   * is polled by every client, so a short cache collapses thousands of reads
   * into one Redis call per instance per interval.
   */
  statusTtlMs?: number;
}

interface Cached<T> {
  value: T;
  expiresAt: number;
}

/**
 * Small read-through cache that also de-duplicates concurrent misses, so a
 * burst of requests after expiry triggers a single upstream call.
 */
class TtlCache<T> {
  private entry: Cached<T> | null = null;
  private inflight: Promise<T> | null = null;

  constructor(private readonly ttlMs: number, private readonly now: () => number) {}

  async get(load: () => Promise<T>): Promise<T> {
    if (this.entry && this.entry.expiresAt > this.now()) return this.entry.value;
    if (this.inflight) return this.inflight;
    this.inflight = load()
      .then((value) => {
        this.entry = { value, expiresAt: this.now() + this.ttlMs };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  invalidate(): void {
    this.entry = null;
  }
}

export class SaleService {
  private readonly now: () => number;
  private readonly configCache: TtlCache<SaleConfig | null>;
  private readonly statusCache: TtlCache<SaleStatusView>;

  constructor(private readonly store: SaleStore, opts: SaleServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.configCache = new TtlCache(opts.configTtlMs ?? 1_000, this.now);
    this.statusCache = new TtlCache(opts.statusTtlMs ?? 250, this.now);
  }

  getActiveSale(): Promise<SaleConfig | null> {
    return this.configCache.get(() => this.store.getActiveSale());
  }

  getStatus(): Promise<SaleStatusView> {
    return this.statusCache.get(async () => {
      const sale = await this.getActiveSale();
      const now = this.now();
      if (!sale) {
        return {
          saleId: null, status: 'no_sale', startsAt: null, endsAt: null,
          totalStock: 0, stockRemaining: 0, serverTime: new Date(now).toISOString(),
        };
      }
      const stockRemaining = await this.store.getStockRemaining(sale.id);
      return {
        saleId: sale.id,
        status: computeSaleStatus(sale, stockRemaining, now),
        startsAt: new Date(sale.startsAt).toISOString(),
        endsAt: new Date(sale.endsAt).toISOString(),
        totalStock: sale.totalStock,
        stockRemaining,
        serverTime: new Date(now).toISOString(),
      };
    });
  }

  /**
   * The cached config only decides *which* sale to target. Whether the sale is
   * open is decided atomically by the store, so a stale cache can never let a
   * purchase through outside the window.
   */
  async purchase(userId: string): Promise<PurchaseResult> {
    const sale = await this.getActiveSale();
    if (!sale) return { outcome: 'NO_SALE' };
    return this.store.attemptPurchase(sale.id, userId);
  }

  async getPurchase(userId: string): Promise<{ saleId: string | null; purchasedAt: number | null }> {
    const sale = await this.getActiveSale();
    if (!sale) return { saleId: null, purchasedAt: null };
    return { saleId: sale.id, purchasedAt: await this.store.getPurchase(sale.id, userId) };
  }

  async configureSale(config: SaleConfig, opts: { ifNoActiveSale?: boolean } = {}): Promise<ConfigureResult> {
    const result = await this.store.configureSale(validateSaleConfig(config), opts);
    this.configCache.invalidate();
    this.statusCache.invalidate();
    return result;
  }
}
