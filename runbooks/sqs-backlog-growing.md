---
alert: SqsBacklogGrowing
severity: critical
slo: -
group: service_alerts
owner: platform
last_reviewed: 2026-09-22
---

# Runbook: SqsBacklogGrowing

## Summary
Fires when `sqs_queue_depth{queue="orders-queue"} > 100` for 5 continuous
minutes — the worker is consuming slower than the api publishes. Users
are unaffected *for now* (api still returns 202), but the async pipeline
is falling behind. If left unchecked, freshness SLO degrades and the
queue grows unbounded.

## Likely causes (ranked by history)

1. **Worker is down, crash-looping, or scaled to 0.** Most common on this
   cluster — a bad rollout, an OOM kill under memory pressure, or an
   accidental `kubectl scale --replicas=0`.

2. **Worker is up but throughput-starved.** The worker processes messages
   but too slowly. Known triggers on this system:
   - `serializeResult` regression (Day 51/63 pattern — heavy CPU per message)
   - `WORKER_CONCURRENCY` env var misconfigured back to 1
   - S3 write latency degraded (LocalStack slow, disk pressure)
   - Worker pod CPU-throttled or memory-squeezed by the node

3. **Publish spike.** The api is receiving far more traffic than normal
   — k6 load test, retry storm, or a runaway client. Worker is healthy
   but can't keep pace with the increased rate.

4. **Poison-message loop.** A subset of messages consistently fails S3
   write, gets redelivered forever (no DLQ configured). Each redelivery
   burns worker CPU. Known gap — see Day 62 B1 notes.

## First queries to run

**Is the worker running at all?**

    up{job="worker"}

`1` = worker is up and scraped. `0` = down.

**Pod-level state (Kubernetes):**

    kubectl -n default get pods -l app=worker
    kubectl -n default get deploy worker -o jsonpath='{.spec.replicas}/{.status.readyReplicas}{"\n"}'
    kubectl -n default logs deploy/worker --tail=50

**Backlog trend over the last 15 minutes — is it still climbing or draining?**

    max_over_time(sqs_queue_depth{queue="orders-queue"}[15m])

**Consume rate vs publish rate — who's ahead?**

    sum(rate(sqs_messages_consumed_total{job="worker"}[5m]))

    sum(rate(http_requests_total{job="api",route="/orders",status="202"}[5m]))

- Consume ≥ publish → worker is keeping up, backlog is transient.
- Consume < publish → worker is falling behind, backlog will grow.

**Is the worker slow, not stopped?**

    histogram_quantile(0.95,
      sum by (le) (rate(s3_write_duration_bucket{job="worker"}[5m])))

- p95 < 0.5s → worker S3 writes healthy.
- p95 > 2s → S3 write degraded. Check LocalStack and the node.

**Confirm concurrency setting is correct:**

    kubectl -n default exec deploy/worker -- sh -c 'echo CONCURRENCY=$WORKER_CONCURRENCY'

- Expected: `CONCURRENCY=10`. `1` = the Day 63 throughput fix was lost.

**Check for poison messages (redelivery loop):**

    sum(rate(sqs_messages_consumed_total{job="worker"}[5m]))
      - on() group_left
    sum(rate(worker_jobs_processed{job="worker"}[5m]))

Or by order-ID repetition in logs:

    kubectl -n default logs deploy/worker --tail=500 \
      | grep -oE 'order_id[":]+ ?[a-f0-9-]+' | sort | uniq -c | sort -rn | head

**Dashboard:** Grafana → *Day 61 — k6 vs api p95* (for the api side).
Queue depth is visible on the SLO dashboard. If neither has the panel,
query Prometheus directly with the expressions above.

## Escalation criteria

- **Backlog > 500 (5× threshold)** — page the on-call immediately. The
  queue is growing fast enough that the freshness SLO will degrade within
  ~15 minutes.
- **Backlog > 5,000** — treat as an incident. Day 63 saw 38,466 during a
  50-VU load test with the pre-fix worker. At this depth, the pipeline is
  effectively down.
- **Worker restart (or `kubectl rollout restart`) does not reduce backlog
  within 10 minutes** — escalate to the platform/worker service owner.
- **`up{job="worker"} == 0` for > 5 minutes** — no diagnostics needed,
  the answer is "worker is down, bring it back."

## Recovery verification

After the fix:
- `sqs_queue_depth{queue="orders-queue"}` returns to < 50
- `sum(rate(sqs_messages_consumed_total{job="worker"}[5m]))` ≥ publish rate
- `job:order_fulfillment_duration_seconds:fast_ratio5m` returns to ≥ 0.95
  within ~5 minutes (5m rate window drain time)

## Related runbooks

- `freshness-slo-burn-rate-page.md` — the downstream SLO alert that fires
  if this alert's condition persists.
- `high-latency.md` — fires if the S3 write specifically is slow (created
  in Day 64 Step 4).