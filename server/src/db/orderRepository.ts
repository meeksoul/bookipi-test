import pg from 'pg';
import type { OrderEvent } from '../domain/sale.js';

export interface OrderRepository {
  /** Idempotent: re-inserting an existing (saleId, userId) is a no-op. */
  insertMany(orders: OrderEvent[]): Promise<void>;
}

export class PgOrderRepository implements OrderRepository {
  constructor(private readonly pool: pg.Pool) {}

  static connect(databaseUrl: string): PgOrderRepository {
    return new PgOrderRepository(new pg.Pool({ connectionString: databaseUrl, max: 5 }));
  }

  async migrate(): Promise<void> {
    // The primary key is the database-level backstop for "one item per user".
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        sale_id      TEXT        NOT NULL,
        user_id      TEXT        NOT NULL,
        purchased_at TIMESTAMPTZ NOT NULL,
        persisted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (sale_id, user_id)
      )
    `);
  }

  async insertMany(orders: OrderEvent[]): Promise<void> {
    if (orders.length === 0) return;
    await this.pool.query(
      `INSERT INTO orders (sale_id, user_id, purchased_at)
       SELECT s, u, to_timestamp(t / 1000.0)
       FROM unnest($1::text[], $2::text[], $3::bigint[]) AS x(s, u, t)
       ON CONFLICT (sale_id, user_id) DO NOTHING`,
      [orders.map((o) => o.saleId), orders.map((o) => o.userId), orders.map((o) => o.purchasedAt)],
    );
  }

  async countBySale(saleId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      'SELECT count(*) FROM orders WHERE sale_id = $1',
      [saleId],
    );
    return Number(rows[0]!.count);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
