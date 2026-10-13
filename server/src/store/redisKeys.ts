/**
 * Every key shares the `{fs}` hash tag so they land in the same Redis Cluster
 * slot; multi-key Lua scripts are only allowed on keys within one slot.
 */
export const keys = {
  active: '{fs}:active',
  orders: '{fs}:orders',
  meta: (saleId: string) => `{fs}:sale:${saleId}:meta`,
  stock: (saleId: string) => `{fs}:sale:${saleId}:stock`,
  buyers: (saleId: string) => `{fs}:sale:${saleId}:buyers`,
};

export const ORDERS_GROUP = 'order-persisters';
