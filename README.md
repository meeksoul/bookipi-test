# Flash Sale System

This app is built with Claude opus 5.5 medium(structure) + grok 4.7 fast(micro tuning). Every code, documentation and test has passed the developer's(me) review. 
External library or testing tools is excluded on purpose of the easier tester reviews. 
To establish the concurrency and scalability, the single truth data and the atomic logic stays on the redis memory and multiple workers grab the job in the order, asyncronously.
If it were only this flash sale, SQL is more appropriate choice because the schema is stable, as a single silent worker error could be disastrous to the customers. But it doesn't mean that nosql is not an option for this case. We just need to control the db schema more and check harder on every step to prevent duplications, db replica logics and failed transactions. I created a flow diagram images on /docs for the easier tester review.  
This app folows the common practice of flash sales but has a trade-off. When Redis crashes before user order is saved on the Redis disk, user would get the 201 message(order success) but order is failed. To weigh the fairness more, we need to move the stock count(only stock avaiable on the Redis)to the order DB(mongo) but it could seriously damage the first-click win user experience, especially on the high traffic case. 

Purpose: A high-throughput backend and React frontend for a flash sale of a single product with limited stock: a configurable sale window, strict one-item-per-user, and no overselling under heavy concurrency.

- **API**: Node.js 24, TypeScript, Fastify (stateless, horizontally scaled)
- **Inventory / concurrency control**: Redis 7, one atomic Lua script per purchase
- **Order hand-off**: Redis Streams (consumer group, at-least-once)
- **System of record**: MongoDB replica set (orders collection, unique index, majority writes, idempotent upserts)
- **Frontend**: React 19 + Vite, served by nginx, which also load-balances the API replicas
- **Tests**: Vitest (unit, API, Redis/MongoDB integration) and a custom stress / fault-injection harness

---

## Quick start

Docker Compose v2 is enough to run the app and try a purchase. Node.js is not required for that path.

```bash
docker compose up -d --build --wait     # redis, mongo, 3x api, worker, nginx+frontend
```

Open http://localhost:8080 in a browser.

By default a sale called `launch` with 100 items opens immediately and runs for 2 hours. A sale is purchasable only while the current time is inside its window. Configure it with environment variables before `docker compose up`:

```bash
SALE_ID=drop-1 SALE_STOCK=500 \
SALE_STARTS_AT=2026-01-01T00:00:00Z SALE_ENDS_AT=2027-01-01T00:00:00Z \
docker compose up -d --build --wait
```

The env config only seeds a sale if none exists yet, so restarting a container never resets stock. To start a new sale at runtime (this is what the stress test does), set `endsAt` in the future:

```bash
curl -X PUT localhost:8080/api/admin/sale \
  -H 'content-type: application/json' -H 'x-admin-token: dev-admin-token' \
  -d '{"id":"drop-2","startsAt":"2026-01-01T00:00:00Z","endsAt":"2027-01-01T00:00:00Z","totalStock":50}'
```

Stop everything with `docker compose down` (add `-v` to wipe Redis and MongoDB data).

### Running locally without Docker

The API can run with an in-memory store (single process, no persistence). It is meant for trying the UI only. This path needs Node.js 20+ (24 recommended).

```bash
npm install
STORE=memory npm run dev:server   # API on :3000
npm run dev:web                   # Vite on :5173, proxies /api to :3000
```

With Redis and MongoDB available (for example `docker compose up -d redis mongo --wait`), run `npm run dev:server`, `npm run dev:worker` and `npm run dev:web`.

---

## Architecture

![Architecture](docs/architecture.png)

### When a user purchases

The API answers as soon as one Redis script decides the outcome. Only a successful purchase appends an order, and that write is part of the same atomic step as the stock decrement. MongoDB is updated afterwards, off the request.

![When a user purchases](docs/purchase-flow.png)

The duplicate check runs before the stock check, so a buyer who already won still sees "already purchased" after a sellout. The client retries a `503` with jittered backoff; a repeat of a purchase that already committed returns `409`, not a second item.

### Purchase path

![Purchase path](docs/purchase-path.png)

### Components and why

| Component | Role |
| --- | --- |
| nginx | Serves the built React app and round-robins `/api` across API replicas |
| API (Fastify) | Stateless: validation, HTTP mapping, small read caches. Scales horizontally |
| Redis | Source of truth for stock and buyers during the sale; runs the atomic purchase |
| Redis Stream | Durable buffer that decouples the hot path from the database |
| Order worker | Drains the stream into MongoDB in batches, with crash recovery |
| MongoDB | Long-term system of record, with a unique index as a second uniqueness guard |

---

## Design choices and trade-offs

### 1. Concurrency control: one atomic Lua script in Redis

The whole decision runs as one Lua script ([`server/src/store/redisStore.ts`](server/src/store/redisStore.ts)): is the window open, has this user bought, is there stock, then decrement, record the buyer and enqueue the order. Redis executes scripts one at a time, so no two purchases can interleave. Overselling and double-buying are impossible by construction, with no locks, retries or transactions to tune.

Alternatives considered:

- **Decrementing stock in the database** (SQL `UPDATE stock SET n = n - 1 WHERE n > 0`, or Mongo `findOneAndUpdate({ stock: { $gt: 0 } }, { $inc: { stock: -1 } })`). Correct, but every buyer contends on one hot row or document. Throughput is bounded by lock and commit time, and the database most needed for durable records becomes the bottleneck.
- **Distributed locks (Redlock).** Extra round trips and lock-expiry edge cases, for a guarantee a single script already gives.
- **Plain `DECR` then compensate with `INCR` when negative.** Atomic for stock, but checking "already bought" separately opens a race where the same user wins twice from two tabs. The script checks both together.

Details that matter:

- **The Redis server clock decides the sale window** (`TIME` inside the script), so API replicas with skewed clocks cannot disagree about whether the sale is open.
- **The duplicate check comes before the stock check.** A buyer who clicks again after the sale sells out sees "already purchased", not "sold out".
- **User ids are normalised** (trimmed, lower-cased, restricted charset) before they reach Redis, so `Alice@x.com` and `alice@x.com` count as the same buyer.
- **All keys share the `{fs}` hash tag**, so the multi-key script also works on Redis Cluster.

### 2. Keep the hot path in memory; persist asynchronously

A purchase costs the API one Redis round trip. The durable write to MongoDB happens off the request path: the script appends the order to a Redis Stream in the same atomic step, and a worker batches those orders into MongoDB. Consequences:

- A traffic spike never reaches the database. MongoDB sees one bulk write per 200 orders, and total writes are bounded by the stock size, not the traffic.
- The stream entry is written atomically with the stock decrement, so there is no "decremented but never enqueued" gap (the usual dual-write problem).
- Delivery is **at-least-once**. The worker ACKs a stream entry only after MongoDB has confirmed the write on a majority of replica-set members, and `XAUTOCLAIM` takes over entries left pending by a crashed consumer. Writes are idempotent upserts on a unique `(saleId, userId)` index, so redelivery cannot duplicate an order. The unique index is also a second, independent guard for one-item-per-user.
- **Trade-off:** the order database is eventually consistent, typically within milliseconds. While the sale is running, Redis is the read model for "did I buy?".

### 3. Order database: MongoDB, and what it needs compared with SQL

#### Why MongoDB

The company already runs the MERN stack, and that decides it:

- **Operational fit.** The team already deploys, monitors, backs up and is on call for MongoDB. A second database engine just for orders would add infrastructure, runbooks and expertise for no functional gain.
- **Same tooling and data model as other services.** Orders can be read by existing Node services with the same driver and conventions, and the order document can later embed payment or shipping details without a schema migration.
- **No performance downside here.** The order database is off the hot path: it receives batched writes from one worker, and the total number of orders is bounded by the stock. Raw write speed, where SQL and MongoDB differ, does not affect users.

With no team constraint, a SQL database would have been an equally valid choice. Its guarantees below are defaults, and orders are relational data. The point is that both can be made correct; with MongoDB that takes explicit configuration, listed below.

#### What SQL gives by default, and how this project gets it from MongoDB

| Guarantee | SQL (e.g. Postgres) | MongoDB, as implemented in [`orderRepository.ts`](server/src/db/orderRepository.ts) |
| --- | --- | --- |
| One order per user per sale | `PRIMARY KEY (sale_id, user_id)` | Unique compound index `{ saleId: 1, userId: 1 }`, created on startup **before** the worker writes |
| Idempotent redelivery | `INSERT ... ON CONFLICT DO NOTHING` | `bulkWrite` of `updateOne` + `upsert: true` + `$setOnInsert`; duplicate-key error `11000` counts as success |
| A confirmed write survives a crash or failover | `COMMIT` is durable on that server | Write concern `w: "majority", journal: true` on a **replica set** |
| Reads never see data that can be rolled back | Committed data cannot be undone | Read concern `"majority"`, read preference `primary` |
| Data has the right shape and types | Table schema | `$jsonSchema` validator: required fields, `purchasedAt` must be a BSON `Date` |

#### Points that need care with MongoDB

1. **Write concern, the most important one.** The worker removes an order from the Redis stream (`XACK`) as soon as MongoDB confirms the write. If the confirmation came from the primary alone (`w: 1`) and the primary failed before replicating, the new primary would not have the order, and MongoDB would roll it back when the old primary rejoins. The order would be lost silently: Redis has already forgotten it. With `w: "majority"`, a confirmed write is on most members, and any newly elected primary must have it. MongoDB 5.0+ already defaults to majority, but the client sets it explicitly because the default drops to `w: 1` in some topologies with an arbiter, and a single "fast path" override would quietly reintroduce the risk.
2. **A replica set, never a standalone server.** Majority writes, retryable writes and transactions need one. Compose runs a single-node replica set (`--replSet rs0`, initialised by the healthcheck) so the code path is real. Production needs 3 data-bearing members and no arbiters.
3. **Write-concern timeouts are "unknown", not "failed".** With `wtimeoutMS: 5000`, a timeout means the write may still replicate later. The worker treats any error as "not saved": it skips `XACK`, so the entry is retried, and the idempotent upsert makes a retry harmless. Duplicate-key errors are swallowed only when there is **no** write-concern error.
4. **`$setOnInsert`, not `$set`.** A redelivered order must never overwrite the original `purchasedAt`. A test checks this.
5. **Unordered bulk writes.** With `ordered: false`, one duplicate does not stop the rest of the batch. Two concurrent upserts of the same order can race on the unique index; one gets `11000`, which is success because the order exists.
6. **Schema discipline.** MongoDB accepts any document by default, so bugs show up as bad data rather than errors. The validator rejects malformed orders (error `121`), and timestamps are stored as `Date`, not strings, so range queries and sorting stay correct.
7. **Sharding, later.** A unique index on a sharded collection must include the shard key as a prefix, so the shard key should be `{ saleId, userId }` (or hashed `userId` within a sale), never `purchasedAt`. A monotonically increasing key would send every write to one shard.
8. **Reporting and relations.** There are no foreign keys or joins as SQL has them. Reports use aggregation pipelines, and an index `{ saleId: 1, purchasedAt: 1 }` supports "first N buyers" style queries. Data that changes together (order + payment) should live in one document, not rely on multi-document transactions, which are slower and have time and size limits.
9. **Reconciliation.** Because a misconfiguration fails silently, a post-sale job should compare the Redis buyers hash with the order count per `saleId`. The stress test does exactly this check with `--verify-db`.

### 4. Stateless, horizontally scalable API

The API holds no state that affects correctness, so you can add replicas behind the load balancer (Compose runs 3). Two small in-process caches reduce Redis load:

- **Active-sale config, 1s TTL.** This only selects *which* sale to target. Whether it is open is still decided atomically in Redis, so a stale cache cannot let a purchase through outside the window.
- **Status response, 250ms TTL, with in-flight de-duplication.** The status endpoint is polled by every client. Thousands of concurrent polls become one Redis call per replica every 250ms.

Request logging is off on the hot path (it costs measurable throughput at 20k req/s), and the request body is capped at 1 KB.

### 5. Failure handling

| Failure | Behaviour |
| --- | --- |
| Redis unreachable or slow | The client fails fast (offline queue off, 2s command timeout), and the API answers `503` instead of piling up requests. The frontend retries with jittered exponential backoff |
| Response lost after a purchase committed (timeout, dropped connection) | Retrying is safe: the repeat returns `ALREADY_PURCHASED` with the original timestamp. Purchases are idempotent per user |
| API replica crashes | nginx marks it failed and stops routing to it. In-flight requests on that replica get `502`, and nginx does not resend them to another replica (`proxy_next_upstream error`). Docker restarts the replica |
| Worker crashes or MongoDB is down | Orders wait in the stream and nothing is lost. On recovery the worker (or another consumer) reclaims pending entries |
| MongoDB primary fails over mid-batch | Majority-confirmed writes survive. An unconfirmed batch errors or times out, so it is not `XACK`ed and is retried idempotently against the new primary |
| Process restart during a sale | Seeding uses "create only if no active sale", so stock and buyers are never reset |
| Redis crash | AOF with `appendfsync everysec`. Each purchase script is replayed atomically, so a restore can never oversell, but the last ~1s of acknowledged purchases could be lost (see below) |

**Known limits, and what I'd do in production:**

- **Redis is a single point of failure here.** In production, use a managed primary/replica setup (ElastiCache, Memorystore) with automatic failover. Replication is asynchronous, so failover can lose acknowledged writes. If that is unacceptable, call `WAIT 1 <timeout>` after a successful purchase (costs one replica round trip), or use `appendfsync always`.
- **Every replica polls Redis for sale status.** At much larger scale, serve `GET /api/sale` from a CDN with a 1s TTL, or push updates over SSE/WebSocket.
- **There is no bot protection or rate limiting.** That belongs at the edge (WAF, CDN rate limits, CAPTCHA, or a virtual waiting room), not in the API. Doing it per IP inside the API would also throttle the stress test, which runs from one IP.
- **The admin endpoint is protected only by a shared token.** That is fine for a demo; production needs real auth.

### 6. Scaling further

- **More API throughput:** add replicas. Each one is a thin layer over Redis.
- **Beyond one Redis primary:** stock for one product is inherently a single hot key, but one Redis core handles roughly 100k script calls per second. Past that, split stock into N buckets on different shards (`{fs:0}`, `{fs:1}`, ...) and route each user to a bucket by hashing their id. A user then always hits the same bucket, which keeps the duplicate check local, and you can rebalance leftovers at the end of the sale.
- **Cheaper rejections after a sellout:** replicas could cache "sold out" briefly and reject at the edge. I left this out so repeat buyers still get an accurate "already purchased".

---

## API

| Method | Path | Responses |
| --- | --- | --- |
| `GET` | `/api/sale` | `200` `{ saleId, status: upcoming \| active \| sold_out \| ended \| no_sale, startsAt, endsAt, totalStock, stockRemaining, serverTime }` |
| `POST` | `/api/purchases` with body `{ "userId": "alice@example.com" }` | `201 SUCCESS`, `409 ALREADY_PURCHASED`, `410 SOLD_OUT`, `403 NOT_STARTED / ENDED`, `404 NO_SALE`, `400` invalid id, `503` store unavailable (safe to retry) |
| `GET` | `/api/purchases/:userId` | `200` `{ userId, saleId, purchased, purchasedAt }` |
| `PUT` | `/api/admin/sale` (header `x-admin-token`) | `201` `{ saleId }`. Starts a new sale and closes the previous one |
| `GET` | `/api/health` | `200` / `503` depending on Redis reachability |

Purchase responses always include `outcome`, `message`, `userId` and `purchasedAt`.

---

## Tests

Node.js 20 or newer (24 recommended).

```bash
npm install
docker compose up -d redis mongo --wait   # needed for the integration suites
npm test                                  # server + web
```

Integration suites skip themselves (with a warning) if Redis or MongoDB is not reachable, so `npm test` also works without Docker, with reduced coverage. Use `REDIS_TEST_URL` / `MONGO_TEST_URL` to point them elsewhere. They use Redis DB 15 and the `flashsale_test` Mongo database, and never touch dev data.

| Suite | What it covers |
| --- | --- |
| `server/test/unit/sale.test.ts` | Status transitions at window boundaries, user-id normalisation, config validation |
| `server/test/unit/saleService.test.ts` | Status lifecycle, cache TTLs, collapsing concurrent reads into one store call |
| `server/test/contract/saleStoreContract.ts` | **One behaviour suite run against both the in-memory store and real Redis**: window enforcement, one-per-user, sold-out, zero stock, reconfiguration, and 2,000 concurrent attempts from 500 users for 100 items |
| `server/test/api/api.test.ts` | Every endpoint and status code via `fastify.inject`, validation, 503 mapping, concurrent HTTP purchases, admin auth |
| `server/test/integration/redisStore.test.ts` | Exactly one stream entry per sale; 8 independent connections (like replicas) racing 4,000 attempts for 250 items |
| `server/test/integration/orderWorker.test.ts` | Stream to MongoDB persistence and ACKs; **crash recovery** (a failing consumer's entries are reclaimed by another); redelivery neither duplicates nor overwrites; 20 concurrent upserts of one order; unique index rejects a direct duplicate; schema validator rejects a malformed order |
| `web/src/App.test.tsx` | Status display, button enablement, feedback for each outcome, retry after 503, order lookup |

---

## Stress tests

The harness ([`server/stress/stress.ts`](server/stress/stress.ts)) creates a fresh sale through the admin API. It then sends `users × attempts` purchase requests in shuffled order (so one user's duplicate attempts race each other) at a fixed concurrency through nginx, and finally checks the invariants against the server:

1. exactly `min(stock, users)` items were sold: no oversell, no undersell
2. no user received `SUCCESS` more than once
3. remaining stock equals `stock - sold`
4. `GET /api/purchases/:id` for **every** user matches the responses that user received
5. with `--verify-db`: MongoDB contains exactly the winners, no more and no fewer
6. no 5xx or transport errors (relaxed by `--allow-errors` for fault-injection runs)

The process exits non-zero if any check fails.

```bash
docker compose up -d --build --wait
npm install
npm run stress -- --verify-db                                    # 10k users x 3 attempts, 500 items
npm run stress -- --verify-db --users 50000 --stock 2000 --attempts 2 --concurrency 1000
npm run stress -- --verify-db --users 300 --stock 1000 --attempts 5   # more stock than buyers
npm run stress:chaos                                             # fault injection (below)
```

Options: `--url` (default `http://localhost:8080`), `--users`, `--stock`, `--attempts`, `--concurrency`, `--admin-token`, `--verify-db`, `--mongo-url`, `--allow-errors`.

### Results

Measured on an Apple Silicon laptop with everything (3 API replicas, nginx, Redis, MongoDB, worker and the load generator) running on the same machine under Docker Desktop. Absolute numbers are limited by that setup; the correctness results are what matter.

**10,000 users × 3 attempts, 500 items, 500 concurrent connections**

```
throughput      15447 req/s
latency (ms)    p50 22.0 | p95 83.9 | p99 225.4 | max 461.8
status codes    201: 500, 409: 1000, 410: 28500
PASS  exactly min(stock, users) items sold (500)
PASS  no user won more than once (500 distinct winners)
PASS  remaining stock is consistent (stockRemaining=0, status=sold_out)
PASS  purchase lookups match responses (0 mismatches across 10000 users)
PASS  no 5xx or transport errors
PASS  worker persisted exactly the winners to MongoDB (500 documents)
```

**50,000 users × 2 attempts, 2,000 items, 1,000 concurrent connections**

```
throughput      18173 req/s
latency (ms)    p50 41.9 | p95 123.7 | p99 236.2 | max 1327.8
status codes    201: 2000, 409: 2000, 410: 96000
PASS  ... all invariants
PASS  worker persisted exactly the winners to MongoDB (2000 documents)
```

**More stock than buyers: 300 users × 5 attempts, 1,000 items.** 300 `SUCCESS` and 1,200 `ALREADY_PURCHASED`; `stockRemaining=700`; MongoDB has 300 documents. No user can buy a second item even though stock remains.

How to read these numbers:

- The status-code mix is exactly what the rules predict. Each of the `stock` winners gets one `201`. Their other attempts get `409` only if they arrived after the winning one. Everyone else gets `410`. No request returns `201` beyond the stock.
- Most requests are rejections (`410`) that go through the same atomic script, so throughput is about the same before and after the sellout.
- The tail latency (p99, max) is most likely CPU contention: one laptop runs the load generator, nginx and every service at once. The Redis script itself runs in microseconds.

### Fault injection: `npm run stress:chaos`

This runs the 50k-user load with the order worker stopped, hard-kills (`docker kill`) one API replica about 3.5s into the run, then restarts both:

```
status codes    201: 2000, 409: 1991, 410: 95678, 502: 331
PASS  exactly min(stock, users) items sold (2000 sold / expected 2000)
PASS  no user won more than once (2000 distinct winners)
PASS  remaining stock is consistent (stockRemaining=0, status=sold_out)
PASS  purchase lookups match responses (0 mismatches across 50000 users)
PASS  worker persisted exactly the winners to MongoDB (2000 documents)
```

The requests in flight on the killed replica (a few dozen to a few hundred, depending on timing) got `502` from nginx (their outcome is unknown to the client, which would retry safely). The other replicas absorbed the traffic. Orders piled up in the stream while the worker was down, and were all persisted, exactly once, after it came back.

---

## Project layout

```
docker-compose.yml          redis, mongo (replica set), api (x3), worker, web
server/
  src/
    domain/sale.ts          types, status computation, validation (pure)
    store/redisStore.ts     Lua scripts: atomic purchase + sale configuration
    store/memoryStore.ts    same contract, in-process (tests / no-Docker demo)
    service/SaleService.ts  caching and orchestration
    app.ts                  Fastify routes and HTTP mapping
    worker/OrderWorker.ts   Redis Stream -> MongoDB, with crash recovery
    db/orderRepository.ts   MongoDB: schema validator, unique index, majority writes, idempotent upserts
    server.ts, worker.ts    process entry points
  test/                     unit, api, contract, integration
  stress/                   stress.ts, chaos.sh
web/
  src/App.tsx               UI
  src/api.ts                API client (with safe retries)
  nginx.conf                static hosting + API load balancing
```
