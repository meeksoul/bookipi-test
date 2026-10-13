import type { PurchaseResult, SaleConfig } from '../domain/sale.js';

export type ConfigureResult = 'CREATED' | 'SKIPPED_EXISTING_ACTIVE' | 'DUPLICATE_ID';

/**
 * The inventory store is the single source of truth for stock and buyers.
 * `attemptPurchase` MUST be atomic: the sale-window check, the one-per-user
 * check, the stock decrement and the order hand-off happen as one unit.
 */
export interface SaleStore {
  getActiveSale(): Promise<SaleConfig | null>;
  getStockRemaining(saleId: string): Promise<number>;
  attemptPurchase(saleId: string, userId: string): Promise<PurchaseResult>;
  /** Returns the purchase timestamp, or null if the user has not purchased. */
  getPurchase(saleId: string, userId: string): Promise<number | null>;
  /**
   * Creates a new sale and makes it the active one. Any previously active sale
   * is closed immediately. With `ifNoActiveSale`, does nothing if a sale already
   * exists (used on boot so restarts never reset stock).
   */
  configureSale(config: SaleConfig, opts?: { ifNoActiveSale?: boolean }): Promise<ConfigureResult>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
