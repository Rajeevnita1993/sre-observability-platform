---
alert: SqsOldestMessageAgeHigh
severity: critical
slo: -
group: queue_health
owner: platform
last_reviewed: 2026-09-23
---

# Runbook: SqsOldestMessageAgeHigh

## Summary
p95 of `sqs_message_age_seconds` (publish → consume) on `orders-queue`
has exceeded 60s for 5 minutes. The worker is consuming, but messages
are stale by the time they're processed — arrival rate is outpacing
effective throughput, or per-message processing has slowed.

Customer impact: order confirmation and inventory sync run off S3
results written by the worker. A 60s+ queue dwell pushes those past
the downstream SLA window.

**What this alert does NOT catch:** a fully stopped worker. If no
messages are consumed, no observations are recorded, the `rate(...)`
has no samples, and the alert silently stays inactive. That failure
mode belongs to `SqsBacklogGrowing` (queue depth). Both alerts exist
because they cover different failure shapes.

## Likely causes (ranked by history)
1. **Load spike beyond single-replica throughput.** Day 62 and Day 63
   were both triggered by 50-VU k6 runs. Queue climbed to 5,518 and
   38,466 respectively before any consumer-side symptom was noticed.
   Check whether a load test is running.
2. **Worker CPU-bound on serialization.** Day 62 root cause: 20
   `deepClone` iterations plus a 3,000-item batch per message in
   `serializeResult`. Fix reduced to 1 iteration, `batch(1)`. If
   `serialize.js` was recently modified, suspect regression.
3. **Worker I/O serialization regression.** Day 63 root cause: sequential
   `await` between S3 write (~150ms) and SQS delete (~50ms) capped
   throughput at ~4 msg/s. Fix: `mapConcurrent` + `WORKER_CONCURRENCY=10`
   + `MaxNumberOfMessages: 10`. Confirm the env var and `MaxNumberOfMessages`
   are still in place — a config drift here silently reverts to ~4 msg/s.
4. **S3/LocalStack write latency.** If `s3_write_duration` p95 rises,
   messages take longer per-consumer, consumption rate drops, age climbs.
   LocalStack under memory pressure is a plausible culprit on this
   host (7.3 GB Docker Desktop budget, ~5 GB observed in use).
5. **Expensive message types.** If Step 7 of Day 65 is loaded, some
   order payloads are intentionally CPU-heavy. This is the manufactured-
   incident case, not an organic failure — verify intent before paging.

## First queries to run

PromQL — **is depth also climbing, or only age?**
```
sqs_queue_depth{queue="orders-queue"}
```
If depth is flat but age is climbing, the worker is keeping up with
arrivals but each message sits in the queue longer than expected —
look at S3 latency, not worker count. If depth is also climbing,
arrival rate exceeds consumption rate.

PromQL — **raw age distribution (spot outliers, not just p95):**
```
histogram_quantile(0.50, sum by (le) (rate(sqs_message_age_seconds_bucket{queue="orders-queue"}[5m])))
histogram_quantile(0.99, sum by (le) (rate(sqs_message_age_seconds_bucket{queue="orders-queue"}[5m])))
```
A p50 near the p95 means the whole queue is slow (throughput problem).
A p50 low but p99 high means a few messages are stuck (poison or
expensive message type).

PromQL — **is the worker actually consuming?**
```
rate(sqs_messages_consumed_total[5m])
rate(worker_jobs_processed_total[5m])
```
If consumption rate is ~0, this alert shouldn't be firing — it means
you're seeing a stale window, check `SqsBacklogGrowing` instead.

PromQL — **is S3 the bottleneck?**
```
histogram_quantile(0.95, sum by (le) (rate(s3_write_duration_bucket[5m])))
histogram_quantile(0.95, sum by (le) (rate(order_fulfillment_duration_seconds_bucket[5m])))
```
If `order_fulfillment_duration_seconds` and `sqs_message_age_seconds`
are both elevated by roughly the same amount, the queue is the problem.
If fulfillment is much higher than age, the worker is doing extra work
per message (serialize, S3, delete).

Kubectl — **replica and CPU state:**
```
kubectl -n default get deploy worker
kubectl -n default top pod -l app=worker          # if metrics-server is up
kubectl -n default logs deploy/worker --tail=100 | grep -E 'duration_seconds|error'
```
Look at per-message `duration_seconds` in the logs. If it's crept up
from the ~0.01–0.05s baseline, processing itself is slow. If it's still
in that range, the queue is the bottleneck, not the worker.

Dashboard: `Queue Health` (Day 65) — panels **"Age at consumption"**,
**"Queue depth"**, **"Consumption rate"**. If the dashboard isn't loaded
yet, use the ad-hoc PromQL above.

## Escalation criteria
- **No cause identified within 15 minutes** → page platform on-call.
- **p95 age exceeds 300s** (5 minutes, top bucket threshold) → treat as
  outage; downstream order confirmation SLA is definitively breached.
- **Queue depth exceeds 5× normal (500+)** while age is still climbing
  → declare capacity incident, escalate to infrastructure.
- **Worker replicas cannot be scaled** (HPA blocked, node resource
  exhausted) → escalate to infrastructure; do not attempt manual
  vertical scaling on the current 16 GB host.
- **If the day's load test is confirmed as the cause** → no page. Log
  the incident, close with `expected-load` label, and move on.