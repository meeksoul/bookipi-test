import os from 'node:os';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { PgOrderRepository } from './db/orderRepository.js';
import { OrderWorker } from './worker/OrderWorker.js';

const config = loadConfig();

// Blocking reads need a dedicated connection without the API's short timeouts.
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const repo = PgOrderRepository.connect(config.databaseUrl);
await repo.migrate();

const worker = new OrderWorker(redis, repo, {
  consumer: `${os.hostname()}-${process.pid}`,
  log: (msg, extra) => console.log(new Date().toISOString(), msg, extra ?? ''),
});
await worker.ensureGroup();
console.log('order worker started');

const shutdown = () => worker.stop();
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await worker.run();
await Promise.all([redis.quit(), repo.close()]);
console.log('order worker stopped');
