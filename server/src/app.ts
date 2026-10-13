import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { InvalidSaleConfigError, normalizeUserId, type PurchaseOutcome } from './domain/sale.js';
import type { SaleService } from './service/SaleService.js';
import type { SaleStore } from './store/SaleStore.js';

export interface AppDeps {
  service: SaleService;
  store: SaleStore;
  adminToken: string;
  corsOrigin?: string | boolean;
  logger?: FastifyServerOptions['logger'];
}

const PURCHASE_RESPONSES: Record<PurchaseOutcome, { status: number; message: string }> = {
  SUCCESS: { status: 201, message: 'Congratulations! You secured an item.' },
  ALREADY_PURCHASED: { status: 409, message: 'You have already purchased this item.' },
  SOLD_OUT: { status: 410, message: 'Sorry, the item is sold out.' },
  NOT_STARTED: { status: 403, message: 'The sale has not started yet.' },
  ENDED: { status: 403, message: 'The sale has ended.' },
  NO_SALE: { status: 404, message: 'There is no active sale.' },
};

const userIdBody = {
  type: 'object',
  required: ['userId'],
  properties: { userId: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

const saleConfigBody = {
  type: 'object',
  required: ['startsAt', 'endsAt', 'totalStock'],
  properties: {
    id: { type: 'string' },
    startsAt: { type: 'string' },
    endsAt: { type: 'string' },
    totalStock: { type: 'integer', minimum: 0 },
  },
} as const;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Per-request logs are a measurable cost at tens of thousands of req/s.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024,
    ajv: { customOptions: { coerceTypes: false } },
  });

  await app.register(cors, { origin: deps.corsOrigin ?? true });

  app.setErrorHandler((error: Error & { validation?: unknown; statusCode?: number }, request, reply) => {
    if (error.validation) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: error.message });
    }
    if (error instanceof InvalidSaleConfigError) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: error.message });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: 'BAD_REQUEST', message: error.message });
    }
    // Inventory store unreachable or timed out. A purchase may or may not have
    // been applied; retrying is safe because purchases are idempotent per user.
    request.log.error({ err: error }, 'request failed');
    return reply.status(503).send({ error: 'SERVICE_UNAVAILABLE', message: 'Please try again shortly.' });
  });

  app.get('/api/health', async (_request, reply) => {
    try {
      await deps.store.ping();
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  app.get('/api/sale', async () => deps.service.getStatus());

  app.post<{ Body: { userId: string } }>('/api/purchases', { schema: { body: userIdBody } }, async (request, reply) => {
    const userId = normalizeUserId(request.body.userId);
    if (!userId) return reply.status(400).send({ error: 'BAD_REQUEST', message: 'Invalid user id.' });

    const result = await deps.service.purchase(userId);
    const { status, message } = PURCHASE_RESPONSES[result.outcome];
    return reply.status(status).send({
      outcome: result.outcome,
      message,
      userId,
      purchasedAt: result.purchasedAt ? new Date(result.purchasedAt).toISOString() : null,
    });
  });

  app.get<{ Params: { userId: string } }>('/api/purchases/:userId', async (request, reply) => {
    const userId = normalizeUserId(request.params.userId);
    if (!userId) return reply.status(400).send({ error: 'BAD_REQUEST', message: 'Invalid user id.' });

    const { saleId, purchasedAt } = await deps.service.getPurchase(userId);
    return {
      userId,
      saleId,
      purchased: purchasedAt !== null,
      purchasedAt: purchasedAt === null ? null : new Date(purchasedAt).toISOString(),
    };
  });

  app.put<{ Body: { id?: string; startsAt: string; endsAt: string; totalStock: number } }>(
    '/api/admin/sale',
    { schema: { body: saleConfigBody } },
    async (request, reply) => {
      if (request.headers['x-admin-token'] !== deps.adminToken) {
        return reply.status(401).send({ error: 'UNAUTHORIZED' });
      }
      const { body } = request;
      const id = body.id ?? `sale-${Date.now().toString(36)}`;
      const result = await deps.service.configureSale({
        id,
        startsAt: Date.parse(body.startsAt),
        endsAt: Date.parse(body.endsAt),
        totalStock: body.totalStock,
      });
      if (result === 'DUPLICATE_ID') {
        return reply.status(409).send({ error: 'DUPLICATE_ID', message: `Sale "${id}" already exists.` });
      }
      return reply.status(201).send({ saleId: id });
    },
  );

  return app;
}
