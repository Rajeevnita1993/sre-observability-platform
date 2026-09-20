#!/usr/bin/env bash
set -euo pipefail
kubectl -n default port-forward svc/api 8080:8080 >/dev/null 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT
sleep 2

seq 1 2000 | xargs -P 20 -I {} \
  curl -s -o /dev/null -X POST http://localhost:8080/orders \
    -H 'content-type: application/json' \
    -d '{"item":"ABC-1234","qty":1}'

echo "2000 orders submitted (20-way concurrent)"