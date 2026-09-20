#!/usr/bin/env bash
# tests/leak-load.sh — fast, no sleep. Grows the resultsCache on every order.
set -euo pipefail

kubectl -n default port-forward svc/api 8080:8080 >/dev/null 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT
sleep 2

for i in $(seq 1 5000); do
  curl -s -o /dev/null -X POST http://localhost:8080/orders \
    -H 'content-type: application/json' \
    -d "{\"item\":\"SKU-$((i % 50))\",\"qty\":1}"
done
echo "5000 orders submitted"