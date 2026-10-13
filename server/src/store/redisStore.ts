import { Redis } from 'ioredis';
import type { PurchaseOutcome, PurchaseResult, SaleConfig } from '../domain/sale.js';
import type { ConfigureResult, SaleStore } from './SaleStore.js';
import { keys } from './redisKeys.js';

/**
 * Atomic purchase. Redis executes scripts serially, so no other command can
 * observe or modify stock/buyers between the checks and the writes.
 * Time comes from the Redis server clock so all API instances agree on the
 * sale window regardless of their own clock skew.
 *
 * KEYS: meta, stock, buyers, orders stream   ARGV: userId, saleId
 */
const PURCHASE_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local window = redis.call('HMGET', KEYS[1], 'startMs', 'endMs')
if not window[1] then return {'NO_SALE'} end
if now < tonumber(window[1]) then return {'NOT_STARTED'} end
if now >= tonumber(window[2]) then return {'ENDED'} end

local previous = redis.call('HGET', KEYS[3], ARGV[1])
if previous then return {'ALREADY_PURCHASED', previous} end

local stock = tonumber(redis.call('GET', KEYS[2]) or '0')
if stock <= 0 then return {'SOLD_OUT'} end

redis.call('DECR', KEYS[2])
redis.call('HSET', KEYS[3], ARGV[1], now)
redis.call('XADD', KEYS[4], '*', 'saleId', ARGV[2], 'userId', ARGV[1], 'purchasedAt', now)
return {'SUCCESS', tostring(now)}
`;

/**
 * KEYS: active, new meta, new stock, previous meta (or new meta if none)
 * ARGV: id, startMs, endMs, totalStock, previousId, ifNoActiveSale ('1'|'0')
 */
const CONFIGURE_LUA = `
if ARGV[6] == '1' and redis.call('EXISTS', KEYS[1]) == 1 then return 'SKIPPED_EXISTING_ACTIVE' end
if redis.call('EXISTS', KEYS[2]) == 1 then return 'DUPLICATE_ID' end

if ARGV[5] ~= '' then
  local t = redis.call('TIME')
  local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  local prevEnd = tonumber(redis.call('HGET', KEYS[4], 'endMs') or '0')
  if prevEnd > now then redis.call('HSET', KEYS[4], 'endMs', now) end
end

redis.call('HSET', KEYS[2], 'startMs', ARGV[2], 'endMs', ARGV[3], 'totalStock', ARGV[4])
redis.call('SET', KEYS[3], ARGV[4])
redis.call('SET', KEYS[1], ARGV[1])
return 'CREATED'
`;

interface FlashSaleCommands {
  flashPurchase(meta: string, stock: string, buyers: string, orders: string, userId: string, saleId: string): Promise<string[]>;
  flashConfigure(
    active: string, meta: string, stock: string, prevMeta: string,
    id: string, startMs: number, endMs: number, totalStock: number, prevId: string, ifNoActive: string,
  ): Promise<ConfigureResult>;
}

type FlashRedis = Redis & FlashSaleCommands;

export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    // Fail fast instead of queueing requests while Redis is unreachable: the API
    // answers 503 and clients retry, rather than piling up latency and memory.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2_000,
    lazyConnect: true,
  });
}

export class RedisSaleStore implements SaleStore {
  private readonly redis: FlashRedis;

  constructor(redis: Redis) {
    redis.defineCommand('flashPurchase', { numberOfKeys: 4, lua: PURCHASE_LUA });
    redis.defineCommand('flashConfigure', { numberOfKeys: 4, lua: CONFIGURE_LUA });
    this.redis = redis as FlashRedis;
  }

  async getActiveSale(): Promise<SaleConfig | null> {
    const id = await this.redis.get(keys.active);
    if (!id) return null;
    const meta = await this.redis.hgetall(keys.meta(id));
    if (!meta.startMs) return null;
    return {
      id,
      startsAt: Number(meta.startMs),
      endsAt: Number(meta.endMs),
      totalStock: Number(meta.totalStock),
    };
  }

  async getStockRemaining(saleId: string): Promise<number> {
    return Math.max(0, Number((await this.redis.get(keys.stock(saleId))) ?? 0));
  }

  async attemptPurchase(saleId: string, userId: string): Promise<PurchaseResult> {
    const [outcome, purchasedAt] = await this.redis.flashPurchase(
      keys.meta(saleId), keys.stock(saleId), keys.buyers(saleId), keys.orders, userId, saleId,
    );
    return purchasedAt === undefined
      ? { outcome: outcome as PurchaseOutcome }
      : { outcome: outcome as PurchaseOutcome, purchasedAt: Number(purchasedAt) };
  }

  async getPurchase(saleId: string, userId: string): Promise<number | null> {
    const value = await this.redis.hget(keys.buyers(saleId), userId);
    return value === null ? null : Number(value);
  }

  async configureSale(config: SaleConfig, opts: { ifNoActiveSale?: boolean } = {}): Promise<ConfigureResult> {
    const previousId = (await this.redis.get(keys.active)) ?? '';
    return this.redis.flashConfigure(
      keys.active, keys.meta(config.id), keys.stock(config.id),
      keys.meta(previousId || config.id),
      config.id, config.startsAt, config.endsAt, config.totalStock,
      previousId === config.id ? '' : previousId,
      opts.ifNoActiveSale ? '1' : '0',
    );
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
