---
alert: LatencySLOBurnRatePage
severity: critical
slo: latency
group: slo_burn_rate_alerts
owner: platform
last_reviewed: 2026-09-22
---

# Runbook: LatencySLOBurnRatePage

## Summary

The proportion of POST /orders requests exceeding 500ms has crossed 14.4%
on both the 1h and 5m windows for 2 continuous minutes. Users are
experiencing slow order submissions right now. At this rate the monthly
latency budget (1%) exhausts in roughly 2 days.

This is the PAGE tier. Acknowledge within 5 minutes or the alert
auto-escalates in Alertmanager.

## Diagnostic reference

See runbooks/_burn-rate-pattern.md for shared context. Latency bad
ratio over any window W:

    1 - (
      sum(rate(http_request_duration_seconds_bucket{job="api",route="/orders",le="0.5"}[W]))
        /
      sum(rate(http_request_duration_seconds_count{job="api",route="/orders"}[W]))
    )

Page threshold: 0.144 (14.4%). Ticket threshold: 0.06 (6.0%).

Note: the bucket label is le="0.5" not le="0.3". Our histogram bucket
list is [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]. The
0.3 bucket does not exist, so we use the next available boundary.

## Likely causes (ranked by history)

1. LocalStack SNS saturation. The api awaits sns.send() before returning
   202. Under concurrent load, LocalStack SNS serializes publishes. This
   was the direct cause of the Day 62 latency SLI dip at 50 VUs. Check
   the sns.publish orders span duration in Tempo.

2. api pod CPU-throttled or memory-squeezed. Node-level pressure causes
   the Node event loop to stall, delaying every request. Check
   container_cpu_cfs_throttled_seconds_total.

3. Genuine traffic spike. The api is receiving more concurrent requests
   than it can serve in 500ms. Check if publish rate is unusually high.

4. Debug/deliberate slow path. Someone is sending requests with
   ?slow=true (the Day 27 fault injector adds 700ms per request). Check
   for that query param in access logs.

5. SerializeResult regression on the api side (if the api ever calls
   serializeResult — currently this lives only in the worker, but worth
   checking if the code has changed).

6. Node-level disk or network saturation. Rare on a lab cluster, but
   possible if the host is under heavy I/O.

## First queries to run

Confirm both legs (1h):

    1 - (
      sum(rate(http_request_duration_seconds_bucket{job="api",route="/orders",le="0.5"}[1h]))
        / sum(rate(http_request_duration_seconds_count{job="api",route="/orders"}[1h]))
    )

Confirm both legs (5m):

    1 - (
      sum(rate(http_request_duration_seconds_bucket{job="api",route="/orders",le="0.5"}[5m]))
        / sum(rate(http_request_duration_seconds_count{job="api",route="/orders"}[5m]))
    )

Actual p95, not just the ratio:

    histogram_quantile(0.95,
      sum by (le) (rate(http_request_duration_seconds_bucket{job="api",route="/orders"}[5m])))

Actual p99 (worst-case tail):

    histogram_quantile(0.99,
      sum by (le) (rate(http_request_duration_seconds_bucket{job="api",route="/orders"}[5m])))

api pod health:

    up{job="api"}
    kubectl -n default get pods -l app=api
    kubectl -n default logs deploy/api --tail=100 | grep -iE "slow|error|delay"

CPU throttling check:

    rate(container_cpu_cfs_throttled_seconds_total{pod=~"api-.*", container="api"}[5m])

Check for ?slow=true traffic in recent logs:

    kubectl -n default logs deploy/api --tail=500 | grep -c "slow=true"

Tempo — slow sns.publish spans in the last 15 minutes:

    # In Grafana Explore, Tempo datasource:
    { name = "sns.publish orders" && duration > 500ms }

Recent api deploys:

    kubectl -n default rollout history deploy/api

Compare against worker-side latency (is the whole node slow?):

    histogram_quantile(0.95,
      sum by (le) (rate(s3_write_duration_bucket{job="worker"}[5m])))

## Escalation criteria

This is a page. Acknowledge within 5 minutes.

If p95 is greater than 2 seconds — the api is effectively unusable.
Consider rolling back the last deploy:

    kubectl -n default rollout undo deploy/api

If LocalStack is the cause — the fix is infrastructure-side. LocalStack
is single-replica on this cluster, so scaling isn't an option. Options:
- Scale down unused observability services to free node memory
- Bump LocalStack pod resource limits
- Restart LocalStack (accepting a brief SNS outage) to clear state

If root cause is not identified within 15 minutes — page the api service
owner.

If error ratio is ALSO climbing (cross-reference with
AvailabilitySLOBurnRatePage) — you likely have an api-wide incident
and should treat this as a partial outage.

If this alert fires twice within 24 hours for the same SLO — escalate
to a written postmortem regardless of root cause.

## Recovery verification

After the fix, confirm:
- Both legs of the bad ratio are below 14.4%
- The alert has moved from firing to inactive in Prometheus
- job:http_request_duration_seconds:fast_ratio5m has recovered above
  0.95 for a full 5-minute window
- p95 has returned below 200ms

Check alert state:

    curl -s 'http://localhost:9090/api/v1/alerts' \
      | jq '.data.alerts[] | select(.labels.alertname=="LatencySLOBurnRatePage") | {state, activeAt}'

Check the SLO metric:

    curl -s 'http://localhost:9090/api/v1/query' \
      --data-urlencode 'query=job:http_request_duration_seconds:fast_ratio5m' \
      | jq '.data.result[0].value[1]'

## Related runbooks

- runbooks/latency-slo-burn-rate-ticket.md — the 6h/30m sibling
- runbooks/high-latency.md — the S3-write alert on the worker
- runbooks/freshness-slo-burn-rate-page.md — check if the async
  pipeline is also slow (likely if LocalStack is degraded)
- runbooks/_burn-rate-pattern.md — shared context and math