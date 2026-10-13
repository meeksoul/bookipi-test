import type { SaleConfig } from './domain/sale.js';

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function parseDate(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Date.parse(raw);
  if (Number.isNaN(value)) throw new Error(`${name} must be an ISO-8601 date, got "${raw}"`);
  return value;
}

export function loadConfig() {
  const now = Date.now();
  const startsAt = parseDate('SALE_STARTS_AT', now);
  const initialSale: SaleConfig = {
    id: env('SALE_ID', 'launch'),
    startsAt,
    endsAt: parseDate('SALE_ENDS_AT', startsAt + 2 * 60 * 60 * 1000),
    totalStock: Number(env('SALE_STOCK', '100')),
  };

  return {
    port: Number(env('PORT', '3000')),
    host: env('HOST', '0.0.0.0'),
    store: env('STORE', 'redis') as 'redis' | 'memory',
    redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
    mongoUrl: env('MONGO_URL', 'mongodb://localhost:27017/flashsale?directConnection=true'),
    adminToken: env('ADMIN_TOKEN', 'dev-admin-token'),
    logLevel: env('LOG_LEVEL', 'info'),
    initialSale,
  };
}
