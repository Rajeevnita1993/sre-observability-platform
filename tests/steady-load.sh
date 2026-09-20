#!/usr/bin/env bash
# scripts/steady-load.sh — same shape every run so profiles are comparable
set -euo pipefail

kubectl -n default port-forward svc/api 8080:8080 >/dev/null 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT
sleep 2

for i in $(seq 1 400); do
  curl -s -o /dev/null -X POST http://localhost:8080/orders \
    -H 'content-type: application/json' \
    -d "{\"item\":\"SKU-$((RANDOM%9))\",\"qty\":$((RANDOM%5+1))}"
  sleep 0.05
done