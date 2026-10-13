import type { Redis } from 'ioredis';
import type { OrderRepository } from '../db/orderRepository.js';
import type { OrderEvent } from '../domain/sale.js';
import { keys, ORDERS_GROUP } from '../store/redisKeys.js';

type StreamEntry = [id: string, fields: string[]];

export interface OrderWorkerOptions {
  consumer: string;
  stream?: string;
  group?: string;
  batchSize?: number;
  blockMs?: number;
  /** Pending entries idle longer than this are taken over from crashed consumers. */
  claimIdleMs?: number;
  retryDelayMs?: number;
  log?: (msg: string, extra?: unknown) => void;
}

/**
 * Moves successful purchases from the Redis stream into Postgres.
 *
 * Delivery is at-least-once: an entry is ACKed only after it is committed, and
 * entries left pending by a crashed or failing consumer are reclaimed with
 * XAUTOCLAIM. Inserts are idempotent, so redelivery cannot create duplicates.
 */
export class OrderWorker {
  private running = false;
  private lastClaimAt = 0;
  private readonly stream: string;
  private readonly group: string;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly claimIdleMs: number;
  private readonly retryDelayMs: number;
  private readonly log: (msg: string, extra?: unknown) => void;

  constructor(
    private readonly redis: Redis,
    private readonly repo: OrderRepository,
    private readonly opts: OrderWorkerOptions,
  ) {
    this.stream = opts.stream ?? keys.orders;
    this.group = opts.group ?? ORDERS_GROUP;
    this.batchSize = opts.batchSize ?? 200;
    this.blockMs = opts.blockMs ?? 2_000;
    this.claimIdleMs = opts.claimIdleMs ?? 30_000;
    this.retryDelayMs = opts.retryDelayMs ?? 1_000;
    this.log = opts.log ?? (() => {});
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.stream, this.group, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
    }
  }

  /** One poll cycle: reclaim stale entries if due, then read new ones. Returns entries persisted. */
  async runOnce(): Promise<number> {
    let processed = 0;
    if (Date.now() - this.lastClaimAt >= this.claimIdleMs) {
      processed += await this.reclaimStale();
      this.lastClaimAt = Date.now();
    }

    const response = (await this.redis.xreadgroup(
      'GROUP', this.group, this.opts.consumer,
      'COUNT', this.batchSize,
      'BLOCK', this.blockMs,
      'STREAMS', this.stream, '>',
    )) as [string, StreamEntry[]][] | null;

    if (response) processed += await this.persist(response[0]![1]);
    return processed;
  }

  async run(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        const count = await this.runOnce();
        if (count > 0) this.log(`persisted ${count} orders`);
      } catch (err) {
        // Unacked entries stay pending and will be reclaimed; just back off.
        this.log('batch failed, will retry', err);
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async reclaimStale(): Promise<number> {
    let processed = 0;
    let cursor = '0-0';
    do {
      const [next, entries] = (await this.redis.xautoclaim(
        this.stream, this.group, this.opts.consumer, this.claimIdleMs, cursor, 'COUNT', this.batchSize,
      )) as [string, StreamEntry[]];
      processed += await this.persist(entries.filter((entry) => entry !== null));
      cursor = next;
    } while (cursor !== '0-0');
    return processed;
  }

  private async persist(entries: StreamEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    await this.repo.insertMany(entries.map(([, fields]) => parseOrder(fields)));
    await this.redis.xack(this.stream, this.group, ...entries.map(([id]) => id));
    return entries.length;
  }
}

function parseOrder(fields: string[]): OrderEvent {
  const map = new Map<string, string>();
  for (let i = 0; i < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!);
  return {
    saleId: map.get('saleId')!,
    userId: map.get('userId')!,
    purchasedAt: Number(map.get('purchasedAt')),
  };
}
