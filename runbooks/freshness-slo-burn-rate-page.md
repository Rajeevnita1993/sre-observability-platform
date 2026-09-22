---
alert: FreshnessSLOBurnRatePage
severity: critical
slo: freshness
group: slo_burn_rate_alerts
owner: platform
last_reviewed: 2026-09-22
---

# Runbook: FreshnessSLOBurnRatePage

## Summary

More than 14.4% of orders are taking longer than 10 seconds from
api-receipt to S3-write, on both the 1h and 5m windows, for 2 continuous
minutes. The async pipeline is severely backlogged. Users are not yet
affected (the api still returns 202 immediately), but orders are not
being fulfilled in a reasonable time.

This is the PAGE tier. Acknowledge within 5 minutes or the alert
auto-escalates in Alertmanager.

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
This is because the worker uses the OTel SDK metrics API, which formats
bucket labels as floats. The api uses prom-client, which trims them.
This exact mismatch cost time on Day 62 — see the journal.

## Likely causes (ranked by history)

1. Worker throughput starved. The worker cannot consume messages faster
   than the api publishes. This was the Day 63 incident — pre-fix worker
   at ~5 msg/s, post-fix at ~47 msg/s sustained, ~87 msg/s peak. Check
   the WORKER_CONCURRENCY env var first.

2. SQS backlog is the symptom, not the cause. Check sqs_queue_depth.
   If it is climbing, the pipeline is losing ground. Follow
   runbooks/sqs-backlog-growing.md if so.

3. Worker pod down, crash-looping, or scaled to 0. Freshness will
   collapse within minutes of the worker becoming unavailable.

4. Poison-message loop. No DLQ configured on orders-queue. Failed S3
   writes get redelivered forever, consuming worker throughput on each
   retry. Known gap — see Day 62 B1 notes.

5. SNS publish latency regression. If the api's sns.publish spans are
   slow, receivedAtMs was stamped but the message sat in SNS for
   seconds before hitting SQS. Check Tempo for slow sns.publish spans.

6. LocalStack SQS receive latency degraded. LocalStack accumulates
   memory over days. Receive latency grows from 10ms to 100ms, reducing
   effective worker batch throughput.

## First queries to run

Confirm both legs (1h):

    1 - (
      sum(rate(order_fulfillment_duration_seconds_bucket{job="worker",le="10.0"}[1h]))
        / sum(rate(order_fulfillment_duration_seconds_count{job="worker"}[1h]))
    )

Confirm both legs (5m):

    1 - (
      sum(rate(order_fulfillment_duration_seconds_bucket{job="worker",le="10.0"}[5m]))
        / sum(rate(order_fulfillment_duration_seconds_count{job="worker"}[5m]))
    )

Is the queue backing up? This is the leading indicator:

    sqs_queue_depth{queue="orders-queue"}

Worker consume rate vs api publish rate — who is ahead?:

    sum(rate(sqs_messages_consumed_total{job="worker"}[5m]))

    sum(rate(http_requests_total{job="api",route="/orders",status="202"}[5m]))

Is the worker running?:

    up{job="worker"}
    kubectl -n default get pods -l app=worker
    kubectl -n default logs deploy/worker --tail=50

Is concurrency still configured correctly?:

    kubectl -n default exec deploy/worker -- sh -c 'echo CONCURRENCY=$WORKER_CONCURRENCY'

Expected output: CONCURRENCY=10. If it shows 1, the Day 63 throughput
fix has been lost from the deployment. Fix:

    kubectl -n default rollout restart deploy/worker

Or, if the ConfigMap was edited:

    kubectl -n default apply -f k8s/worker.yaml
    kubectl -n default rollout restart deploy/worker

Worker freshness p95 (raw, not the ratio):

    histogram_quantile(0.95,
      sum by (le) (rate(order_fulfillment_duration_seconds_bucket{job="worker"}[5m])))

Worker S3-write p95 (is the S3 write itself slow?):

    histogram_quantile(0.95,
      sum by (le) (rate(s3_write_duration_bucket{job="worker"}[5m])))

Check for slow SNS publishes via Tempo:

    # In Grafana Explore, Tempo datasource:
    { name = "sns.publish orders" && duration > 1s }

Recent worker deploys:

    kubectl -n default rollout history deploy/worker

Check for poison messages (repeated order IDs in worker logs):

    kubectl -n default logs deploy/worker --tail=500 \
      | grep -oE 'order_id[":]+ ?[a-f0-9-]+' | sort | uniq -c | sort -rn | head

## Escalation criteria

This is a page. Acknowledge within 5 minutes.

If SQS depth exceeds 5,000 — this is a full pipeline incident. The
worker cannot catch up. Day 63 saw 38,466 during a 50-VU load test
with the pre-fix worker. Escalate immediately to the platform owner.

If the worker is down and will not stay up — roll back the worker
deployment:

    kubectl -n default rollout undo deploy/worker

If the root cause is not identified within 15 minutes — page the
worker service owner.

If LocalStack is the underlying bottleneck — the fix is infrastructure
side. Options: restart LocalStack (accepting brief SNS/SQS outage),
free node memory by scaling down unused observability services, or
scale the worker concurrency up further.

If this alert fires twice within 24 hours for the same SLO — escalate
to a written postmortem regardless of root cause.

## Recovery verification

After the fix, confirm:
- sqs_queue_depth returns to below 50
- sum(rate(sqs_messages_consumed_total{job="worker"}[5m])) meets or
  exceeds the api publish rate
- job:order_fulfillment_duration_seconds:fast_ratio5m returns to 0.95
  or above within roughly 5 minutes (5m rate window drain time)
- Worker freshness p95 has fallen below 5s

Note: freshness takes longer to recover than latency because the 5m
rate window must drain the slow observations. It is normal for the
freshness ratio to stay depressed for up to 5 minutes after the fix,
even if the queue is already empty.

Check alert state:

    curl -s 'http://localhost:9090/api/v1/alerts' \
      | jq '.data.alerts[] | select(.labels.alertname=="FreshnessSLOBurnRatePage") | {state, activeAt}'

Check the SLO metric:

    curl -s 'http://localhost:9090/api/v1/query' \
      --data-urlencode 'query=job:order_fulfillment_duration_seconds:fast_ratio5m' \
      | jq '.data.result[0].value[1]'

## Related runbooks

- runbooks/sqs-backlog-growing.md — direct diagnosis of the queue
- runbooks/freshness-slo-burn-rate-ticket.md — the 6h/30m sibling
- runbooks/latency-slo-burn-rate-page.md — cross-check if the api is
  also slow (shared infrastructure)
- runbooks/_burn-rate-pattern.md — shared context and math