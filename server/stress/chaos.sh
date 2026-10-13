#!/usr/bin/env bash
# Fault-injection run against the docker compose stack:
#   - the order worker is down for the whole load phase (orders back up in the stream)
#   - one API replica is hard-killed mid-load (in-flight requests are lost)
# The invariants (no oversell, one per user, DB == winners) must still hold.
set -euo pipefail
cd "$(dirname "$0")/../.."

docker compose stop worker
npm run stress -- --verify-db --allow-errors --users 50000 --stock 2000 --attempts 2 --concurrency 1000 "$@" &
STRESS_PID=$!

sleep 3.5
echo ">>> killing one API replica"
docker kill "$(docker compose ps -q api | head -n 1)"
sleep 3
echo ">>> restarting the worker and the killed replica"
docker compose start worker
docker compose up -d api

wait $STRESS_PID
