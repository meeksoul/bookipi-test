export interface SaleConfig {
  id: string;
  /** Epoch milliseconds, inclusive. */
  startsAt: number;
  /** Epoch milliseconds, exclusive. */
  endsAt: number;
  totalStock: number;
}

export type SaleStatus = 'upcoming' | 'active' | 'sold_out' | 'ended';

export type PurchaseOutcome =
  | 'SUCCESS'
  | 'ALREADY_PURCHASED'
  | 'SOLD_OUT'
  | 'NOT_STARTED'
  | 'ENDED'
  | 'NO_SALE';

export interface PurchaseResult {
  outcome: PurchaseOutcome;
  /** Set for SUCCESS and ALREADY_PURCHASED. */
  purchasedAt?: number;
}

export interface OrderEvent {
  saleId: string;
  userId: string;
  purchasedAt: number;
}

export function computeSaleStatus(sale: SaleConfig, stockRemaining: number, now: number): SaleStatus {
  if (now < sale.startsAt) return 'upcoming';
  if (now >= sale.endsAt) return 'ended';
  if (stockRemaining <= 0) return 'sold_out';
  return 'active';
}

const USER_ID_PATTERN = /^[a-z0-9._@+-]{1,128}$/;

/**
 * User ids are treated case-insensitively (emails), so "Alice@x.com" and
 * "alice@x.com" are the same buyer for the one-item-per-user rule.
 */
export function normalizeUserId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return USER_ID_PATTERN.test(value) ? value : null;
}

export class InvalidSaleConfigError extends Error {}

export function validateSaleConfig(config: SaleConfig): SaleConfig {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.id)) {
    throw new InvalidSaleConfigError('id must be 1-64 chars of [A-Za-z0-9_-]');
  }
  if (!Number.isFinite(config.startsAt) || !Number.isFinite(config.endsAt)) {
    throw new InvalidSaleConfigError('startsAt and endsAt must be valid dates');
  }
  if (config.endsAt <= config.startsAt) {
    throw new InvalidSaleConfigError('endsAt must be after startsAt');
  }
  if (!Number.isSafeInteger(config.totalStock) || config.totalStock < 0) {
    throw new InvalidSaleConfigError('totalStock must be a non-negative integer');
  }
  return config;
}
