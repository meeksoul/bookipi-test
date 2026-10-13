/**
 * Stress test: many unique users, each firing several concurrent purchase
 * attempts, against a fresh sale. Verifies the invariants afterwards:
 *   1. exactly min(stock, users) items are sold (no overselling / underselling)
 *   2. no user succeeds more than once
 *   3. the API's view of every user agrees with the responses they received
 *   4. (optional, --verify-db) the worker persisted exactly the winners to MongoDB
 *   5. no 5xx / transport errors (skipped with --allow-errors for fault injection)
 *
 * Usage: npm run stress -- --url http://localhost:8080 --users 10000 --stock 500
 */
import { parseArgs } from 'node:util';
import { Pool } from 'undici';
import { MongoOrderRepository } from '../src/db/orderRepository.js';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8080' },
    users: { type: 'string', default: '10000' },
    stock: { type: 'string', default: '500' },
    attempts: { type: 'string', default: '3' },
    concurrency: { type: 'string', default: '500' },
    'admin-token': { type: 'string', default: process.env.ADMIN_TOKEN ?? 'dev-admin-token' },
    'verify-db': { type: 'boolean', default: false },
    /** For fault-injection runs: tolerate 5xx / dropped requests, still enforce the invariants. */
    'allow-errors': { type: 'boolean', default: false },
    'mongo-url': { type: 'string', default: process.env.MONGO_URL ?? 'mongodb://localhost:27017/flashsale?directConnection=true' },
  },
});

const USERS = Number(args.users);
const STOCK = Number(args.stock);
const ATTEMPTS = Number(args.attempts);
const CONCURRENCY = Number(args.concurrency);

const pool = new Pool(args.url, { connections: CONCURRENCY, pipelining: 1, keepAliveTimeout: 30_000 });

async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await pool.request({
    method,
    path,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.body.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON error page (e.g. from the load balancer)
  }
  return { status: res.statusCode, json };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

async function main() {
  const saleId = `stress-${Date.now().toString(36)}`;
  const now = Date.now();
  const created = await call(
    'PUT',
    '/api/admin/sale',
    { id: saleId, startsAt: new Date(now).toISOString(), endsAt: new Date(now + 10 * 60_000).toISOString(), totalStock: STOCK },
    { 'x-admin-token': args['admin-token']! },
  );
  if (created.status !== 201) throw new Error(`could not create sale: ${created.status} ${JSON.stringify(created.json)}`);

  // Let every API replica's 1s config cache pick up the new sale.
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  const userIds = Array.from({ length: USERS }, (_, i) => `stress-user-${i}`);
  const requests = shuffle(userIds.flatMap((u) => Array.from({ length: ATTEMPTS }, () => u)));

  console.log(`Sale ${saleId}: ${STOCK} items, ${USERS} users x ${ATTEMPTS} attempts = ${requests.length} requests, concurrency ${CONCURRENCY}\n`);

  const latencies: number[] = [];
  const statusCodes = new Map<number, number>();
  const outcomes = new Map<string, number>();
  const winsPerUser = new Map<string, number>();
  const unknownOutcome = new Set<string>();
  let transportErrors = 0;

  const started = performance.now();
  await runPool(requests, CONCURRENCY, async (userId) => {
    const t0 = performance.now();
    try {
      const { status, json } = await call('POST', '/api/purchases', { userId });
      latencies.push(performance.now() - t0);
      statusCodes.set(status, (statusCodes.get(status) ?? 0) + 1);
      const outcome = json?.outcome ?? json?.error ?? `HTTP_${status}`;
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      if (outcome === 'SUCCESS') winsPerUser.set(userId, (winsPerUser.get(userId) ?? 0) + 1);
      if (status >= 500) unknownOutcome.add(userId);
    } catch {
      transportErrors++;
      unknownOutcome.add(userId);
    }
  });
  const elapsedMs = performance.now() - started;

  latencies.sort((a, b) => a - b);
  const successes = outcomes.get('SUCCESS') ?? 0;
  const expectedWinners = Math.min(STOCK, USERS);
  const serverErrors = [...statusCodes].filter(([code]) => code >= 500).reduce((n, [, c]) => n + c, 0);

  console.log('Load');
  console.log(`  duration        ${(elapsedMs / 1000).toFixed(2)} s`);
  console.log(`  throughput      ${Math.round(requests.length / (elapsedMs / 1000))} req/s`);
  console.log(`  latency (ms)    p50 ${percentile(latencies, 50).toFixed(1)} | p95 ${percentile(latencies, 95).toFixed(1)} | p99 ${percentile(latencies, 99).toFixed(1)} | max ${latencies.at(-1)?.toFixed(1)}`);
  console.log(`  status codes    ${[...statusCodes].sort().map(([c, n]) => `${c}: ${n}`).join(', ')}`);
  console.log(`  outcomes        ${[...outcomes].map(([o, n]) => `${o}: ${n}`).join(', ')}`);
  console.log(`  transport errs  ${transportErrors}\n`);

  const status = (await call('GET', '/api/sale')).json;

  // The server's record is the ground truth. A user whose request failed in
  // flight (5xx / transport error) may or may not have bought; anyone else's
  // record must match exactly what their responses said.
  const serverWinners = new Set<string>();
  let mismatches = 0;
  await runPool(userIds, CONCURRENCY, async (userId) => {
    const { json } = await call('GET', `/api/purchases/${userId}`);
    if (json?.purchased) serverWinners.add(userId);
    const consistent = json?.purchased === winsPerUser.has(userId) || (json?.purchased && unknownOutcome.has(userId));
    if (!consistent) mismatches++;
  });

  const checks: [string, boolean, string][] = [
    ['exactly min(stock, users) items sold', serverWinners.size === expectedWinners, `${serverWinners.size} sold / expected ${expectedWinners} (${successes} SUCCESS responses)`],
    ['no user won more than once', [...winsPerUser.values()].every((n) => n === 1), `${winsPerUser.size} distinct winners`],
    ['remaining stock is consistent', status?.stockRemaining === STOCK - serverWinners.size, `stockRemaining=${status?.stockRemaining}, status=${status?.status}`],
    ['purchase lookups match responses', mismatches === 0, `${mismatches} mismatches across ${USERS} users`],
  ];
  if (!args['allow-errors']) {
    checks.push(['no 5xx or transport errors', serverErrors === 0 && transportErrors === 0, `${serverErrors} 5xx, ${transportErrors} transport`]);
  }

  if (args['verify-db']) {
    const repo = await MongoOrderRepository.connect(args['mongo-url']!);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (await repo.countBySale(saleId)) < serverWinners.size) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const persisted = await repo.countBySale(saleId);
    const users = await repo.userIdsBySale(saleId);
    await repo.close();
    const sameUsers = persisted === serverWinners.size && users.length === persisted && users.every((u) => serverWinners.has(u));
    checks.push(['worker persisted exactly the winners to MongoDB', sameUsers, `${persisted} documents`]);
  }

  console.log('Correctness');
  for (const [name, ok, detail] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} (${detail})`);

  await pool.close();
  const failed = checks.some(([, ok]) => !ok);
  console.log(failed ? '\nSTRESS TEST FAILED' : '\nSTRESS TEST PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.close();
  process.exit(1);
});
