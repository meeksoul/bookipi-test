import { MongoBulkWriteError, MongoClient, MongoServerError, type Collection, type Db } from 'mongodb';
import type { OrderEvent } from '../domain/sale.js';

export interface OrderRepository {
  /** Idempotent: re-inserting an existing (saleId, userId) is a no-op. */
  insertMany(orders: OrderEvent[]): Promise<void>;
}

export interface OrderDocument {
  saleId: string;
  userId: string;
  purchasedAt: Date;
  persistedAt: Date;
}

const COLLECTION = 'orders';
const DUPLICATE_KEY = 11000;
const NAMESPACE_EXISTS = 48;

/**
 * MongoDB gives none of these guarantees by default the way a SQL table with a
 * primary key does, so each one is set up explicitly:
 *  - unique index on (saleId, userId): the database-level "one item per user" backstop
 *  - $jsonSchema validator: rejects malformed documents instead of storing them
 *  - write concern majority + journal: a confirmed write survives primary failover;
 *    the worker drops the Redis stream entry right after, so a rolled-back write
 *    would be an order lost for good
 *  - read concern majority: counts never include writes that could be rolled back
 */
const VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['saleId', 'userId', 'purchasedAt', 'persistedAt'],
    properties: {
      saleId: { bsonType: 'string', minLength: 1 },
      userId: { bsonType: 'string', minLength: 1 },
      purchasedAt: { bsonType: 'date' },
      persistedAt: { bsonType: 'date' },
    },
  },
};

export class MongoOrderRepository implements OrderRepository {
  private readonly orders: Collection<OrderDocument>;

  private constructor(private readonly client: MongoClient, private readonly db: Db) {
    this.orders = db.collection<OrderDocument>(COLLECTION);
  }

  static async connect(url: string): Promise<MongoOrderRepository> {
    const client = new MongoClient(url, {
      writeConcern: { w: 'majority', journal: true, wtimeoutMS: 5_000 },
      readConcern: { level: 'majority' },
      readPreference: 'primary',
      retryWrites: true,
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5_000,
    });
    await client.connect();
    return new MongoOrderRepository(client, client.db());
  }

  /** Creates the collection, validator and indexes. Safe to run on every start. */
  async ensureSchema(): Promise<void> {
    try {
      await this.db.createCollection(COLLECTION, { validator: VALIDATOR, validationAction: 'error' });
    } catch (err) {
      if (!(err instanceof MongoServerError) || err.code !== NAMESPACE_EXISTS) throw err;
      await this.db.command({ collMod: COLLECTION, validator: VALIDATOR, validationAction: 'error' });
    }
    await this.orders.createIndexes([
      { key: { saleId: 1, userId: 1 }, name: 'sale_user_unique', unique: true },
      { key: { saleId: 1, purchasedAt: 1 }, name: 'sale_purchased_at' },
    ]);
  }

  async insertMany(orders: OrderEvent[]): Promise<void> {
    if (orders.length === 0) return;
    const persistedAt = new Date();
    try {
      await this.orders.bulkWrite(
        orders.map((order) => ({
          updateOne: {
            filter: { saleId: order.saleId, userId: order.userId },
            // $setOnInsert: a redelivered order never overwrites the original record.
            update: { $setOnInsert: { purchasedAt: new Date(order.purchasedAt), persistedAt } },
            upsert: true,
          },
        })),
        // Unordered: one failing document does not stop the rest of the batch.
        { ordered: false },
      );
    } catch (err) {
      if (isOnlyDuplicateKeyErrors(err)) return;
      throw err;
    }
  }

  async countBySale(saleId: string): Promise<number> {
    return this.orders.countDocuments({ saleId });
  }

  async userIdsBySale(saleId: string): Promise<string[]> {
    return this.orders.distinct('userId', { saleId });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * Two concurrent upserts of the same order can race on the unique index and one
 * gets E11000. The order exists either way, so that is success. A write concern
 * error is never swallowed: it means durability was not confirmed.
 */
function isOnlyDuplicateKeyErrors(err: unknown): boolean {
  if (!(err instanceof MongoBulkWriteError)) return false;
  if (err.result?.getWriteConcernError()) return false;
  const writeErrors = [err.writeErrors].flat();
  return writeErrors.length > 0 && writeErrors.every((e) => e.code === DUPLICATE_KEY);
}
