---
alert: HighLatency
severity: warning
slo: freshness
group: service_alerts
owner: platform
last_reviewed: 2026-09-22
---

# Runbook: HighLatency

## Summary

The worker's p95 S3-write latency (`s3_write_duration_bucket`) has been
above 2 seconds for 5 continuous minutes. Normal S3 writes to LocalStack
take ~150ms — 2s means the worker is struggling. This alert is
worker-side; it does not page, but it is a leading indicator for
FreshnessSLOBurnRatePage.

## Likely causes (ranked by history)

1. LocalStack S3 slow. LocalStack accumulates memory over days; S3 write
   latency grows from 150ms to seconds. Restart fixes temporarily.

2. Node-level disk pressure. Kind node's disk filling up (Prometheus TSDB
   growth, Loki chunks, image layers). Check node filesystem metrics.

3. Worker pod CPU-throttled. Even with the Day 63 concurrency fix, if
   the node is squeezed, worker messages queue up.

4. SerializeResult regression. If the CPU cost of serialization crept
   back up (Day 51's 20-iteration deepClone pattern), it would delay the
   S3 write step.

5. Network path issue between worker pod and LocalStack pod. Rare on a
   single-node Kind cluster, but possible if a CNI plugin misbehaves.

## First queries to run

**Current p95 S3-write latency:**

    histogram_quantile(0.95,
      sum by (le) (rate(s3_write_duration_bucket{job="worker"}[5m])))

**p99 for the tail:**

    histogram_quantile(0.99,
      sum by (le) (rate(s3_write_duration_bucket{job="worker"}[5m])))

**Is the worker up and processing?**

    up{job="worker"}
    kubectl -n default get pods -l app=worker
    kubectl -n default logs deploy/worker --tail=50

**Worker resource usage:**

    rate(container_cpu_usage_seconds_total{pod=~"worker-.*", container="worker"}[5m])
    container_memory_usage_bytes{pod=~"worker-.*"}

**LocalStack S3 health:**

    up{job="localstack"}
    kubectl -n default logs deploy/localstack --tail=50 | grep -iE "s3|error|slow"

**Node disk pressure — is the Kind node running out of space?**

    node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}

**Recent worker deploys (did serializeResult change?):**

    kubectl -n default rollout history deploy/worker
    kubectl -n default exec deploy/worker -- sh -c 'grep -c "deepClone" /app/serialize.js'

## Escalation criteria

File a ticket within 1 hour if not already triaged.

If p95 exceeds 5 seconds — the worker is effectively broken. Investigate
immediately; the freshness SLO will degrade within ~15 minutes.

If LocalStack is the cause and won't recover — the pipeline is
effectively down. Restart LocalStack (accepting brief SNS/SQS/S3 outage).

If node disk is above 80% — free space. Check Prometheus retention
(`kubectl -n monitoring get prometheus -o jsonpath='{.items[0].spec.retention}'`)
and scale down unused observability services.

If worker memory shows a leak trend — restart the pod as a stopgap and
open a leak investigation ticket.

## Recovery verification

After the fix, confirm:
- histogram_quantile(0.95, rate(s3_write_duration_bucket[5m])) is below 0.5s
- The alert has moved from firing to inactive in Prometheus
- p95 has been below the 2s threshold for a full 5-minute window

Check alert state:

    curl -s 'http://localhost:9090/api/v1/alerts' \
      | jq '.data.alerts[] | select(.labels.alertname=="HighLatency") | {state, activeAt}'

## Related runbooks

- runbooks/freshness-slo-burn-rate-page.md — downstream SLO alert
- runbooks/freshness-slo-burn-rate-ticket.md — ticket-tier sibling
- runbooks/sqs-backlog-growing.md — check if queue is backing up as a
  consequence