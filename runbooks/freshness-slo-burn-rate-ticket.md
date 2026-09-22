---
alert: FreshnessSLOBurnRateTicket
severity: warning
slo: freshness
group: slo_burn_rate_alerts
owner: platform
last_reviewed: 2026-09-22
---

# Runbook: FreshnessSLOBurnRateTicket

## Summary

More than 6.0% of orders are taking longer than 10 seconds from
api-receipt to S3-write, on both the 6h and 30m windows, for 15
continuous minutes. A sustained slow burn — the pipeline is degrading
over hours, not minutes. Not yet paged, but trending toward the page
tier if the trend continues.

This is the TICKET tier. File a ticket within 1 hour. Do not page anyone.

## Diagnostic reference

See runbooks/_burn-rate-pattern.md for shared context. Freshness bad
ratio over any window W:

    1 - (
      sum(rate(order_fulfillment_duration_seconds_bucket{job="worker",le="10.0"}[W]))
        /
      sum(rate(order_fulfillment_duration_seconds_count{job="worker"}[W]))
    )

Page threshold: 0.144 (14.4%). Ticket threshold: 0.06 (6.0%).

CRITICAL: the bucket label is le="10.0" with the decimal, not le="10".
The worker uses the OTel SDK metrics API, which formats bucket labels
as floats. This exact mismatch cost time on Day 62 — see journal.

## Likely causes (ranked by history)

1. Worker throughput running slightly below publish rate. The queue is
   slowly growing — every hour it gets a bit deeper, every hour
   freshness p95 gets a bit higher. Not an acute failure, but a slow
   structural mismatch between supply and demand.

2. LocalStack SQS receive latency slowly degrading. LocalStack
   accumulates memory over days. Receive latency grows from 10ms to
   100ms, reducing effective worker batch throughput. Restart fixes it
   temporarily.

3. Worker pod under memory pressure — leaking memory over hours. Node.js
   GC pause growing, or a slow leak in a dependency. Restart usually
   fixes it, but the underlying leak should be investigated.

4. A growing subset of large orders. Orders with bigger payloads take
   longer in serializeResult and S3 write. If the traffic mix shifted
   toward larger orders, freshness averages drift up.

5. Node-level memory pressure affecting all pods. The 16 GB laptop
   running the full LGTM stack + Kind + LocalStack is close to its
   ceiling. Memory pressure causes GC pauses and scheduling delays for
   the worker.

6. Poison-message loop starting to accumulate. No DLQ configured. A
   small fraction of messages failing S3 write redeliver forever,
   slowly consuming more worker throughput over time.

## First queries to run

Confirm both legs (6h):

    1 - (
      sum(rate(order_fulfillment_duration_seconds_bucket{job="worker",le="10.0"}[6h]))
        / sum(rate(order_fulfillment_duration_seconds_count{job="worker"}[6h]))
    )

Confirm both legs (30m):

    1 - (
      sum(rate(order_fulfillment_duration_seconds_bucket{job="worker",le="10.0"}[30m]))
        / sum(rate(order_fulfillment_duration_seconds_count{job="worker"}[30m]))
    )

Is SQS depth trending up over hours? Look at the last 6 hours in
Grafana. The slope matters more than the current value:

    sqs_queue_depth{queue="orders-queue"}

Worker memory usage over the last 6h — is it growing?:

    container_memory_usage_bytes{pod=~"worker-.*"}

Worker S3-write p95 trend:

    histogram_quantile(0.95,
      sum by (le) (rate(s3_write_duration_bucket{job="worker"}[5m])))

Worker consume rate vs api publish rate:

    sum(rate(sqs_messages_consumed_total{job="worker"}[5m]))

    sum(rate(http_requests_total{job="api",route="/orders",status="202"}[5m]))

Worker freshness p95 (raw):

    histogram_quantile(0.95,
      sum by (le) (rate(order_fulfillment_duration_seconds_bucket{job="worker"}[5m])))

LocalStack memory growth:

    container_memory_usage_bytes{pod=~"localstack-.*"}

Node memory available trend over the last 6h:

    node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes

Any correlation with recent deploys or config changes? Check what
changed in the last 24h:

    kubectl -n default rollout history deploy/worker
    kubectl -n default rollout history deploy/api
    kubectl -n observability get pods --sort-by=.metadata.creationTimestamp | tail -20

Concurrency still configured correctly?:

    kubectl -n default exec deploy/worker -- sh -c 'echo CONCURRENCY=$WORKER_CONCURRENCY'

Check for poison messages (repeated order IDs):

    kubectl -n default logs deploy/worker --tail=500 \
      | grep -oE 'order_id[":]+ ?[a-f0-9-]+' | sort | uniq -c | sort -rn | head

## Escalation criteria

File a ticket within 1 hour if not already triaged.

If the 30m leg climbs above 14.4% — promote to page tier immediately
and follow runbooks/freshness-slo-burn-rate-page.md.

If SQS depth has grown monotonically for more than 4 hours — the
worker is genuinely undersupplied. Consider these interventions:

    # 1. Restart the worker pod (may clear a memory leak)
    kubectl -n default rollout restart deploy/worker

    # 2. Bump concurrency (edit ConfigMap, then restart)
    kubectl -n default set env deploy/worker WORKER_CONCURRENCY=20
    kubectl -n default rollout restart deploy/worker

    # 3. Free node memory by scaling down unused observability services
    kubectl -n observability scale statefulset tempo loki --replicas=0

If worker memory trend shows growth above 500 MB per day — open a leak
investigation ticket. This is not urgent by itself but will cause
repeated incidents if ignored.

If the ticket has been open more than 4 hours without a fix — promote
to page tier manually regardless of current burn rate.

If both FreshnessSLOBurnRatePage and FreshnessSLOBurnRateTicket are
firing for the same SLO — focus on the page. The ticket is redundant.

## Recovery verification

After the fix, confirm:
- Both legs of the bad ratio are below 6.0%
- The alert has moved from firing to inactive in Prometheus
- job:order_fulfillment_duration_seconds:fast_ratio5m has recovered
  above 0.95 for a full 30-minute window (the long leg of the ticket
  tier)
- Worker freshness p95 has returned below 5s
- SQS depth has stabilized below 50

Note: freshness recovery is slower than latency because the 5m and
30m rate windows must drain slow observations. Even after the queue is
empty, expect the ratio to remain depressed for the length of the
window.

Check alert state:

    curl -s 'http://localhost:9090/api/v1/alerts' \
      | jq '.data.alerts[] | select(.labels.alertname=="FreshnessSLOBurnRateTicket") | {state, activeAt}'

Check the SLO metric:

    curl -s 'http://localhost:9090/api/v1/query' \
      --data-urlencode 'query=job:order_fulfillment_duration_seconds:fast_ratio5m' \
      | jq '.data.result[0].value[1]'

## Related runbooks

- runbooks/freshness-slo-burn-rate-page.md — the page-tier escalation
- runbooks/sqs-backlog-growing.md — if SQS depth is the driver
- runbooks/latency-slo-burn-rate-ticket.md — check for correlated
  slowness (shared LocalStack or node pressure)
- runbooks/_burn-rate-pattern.md — shared context and math