import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { SaleService } from './service/SaleService.js';
import { MemorySaleStore } from './store/memoryStore.js';
import { createRedisClient, RedisSaleStore } from './store/redisStore.js';
import type { SaleStore } from './store/SaleStore.js';

const config = loadConfig();

async function createStore(): Promise<SaleStore> {
  if (config.store === 'memory') return new MemorySaleStore();
  const redis = createRedisClient(config.redisUrl);
  await redis.connect();
  return new RedisSaleStore(redis);
}

const store = await createStore();
const service = new SaleService(store);
const app = await buildApp({ service, store, adminToken: config.adminToken, logger: { level: config.logLevel } });

// Every instance tries this on boot; only the first one wins, and restarts never
// reset an in-progress sale's stock.
const seeded = await service.configureSale(config.initialSale, { ifNoActiveSale: true });
app.log.info({ seeded, store: config.store, sale: config.initialSale }, 'sale initialised');

await app.listen({ port: config.port, host: config.host });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
