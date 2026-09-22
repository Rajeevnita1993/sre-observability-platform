---
alert: LatencySLOBurnRateTicket
severity: warning
slo: latency
group: slo_burn_rate_alerts
owner: platform
last_reviewed: 2026-09-22
---

# Runbook: LatencySLOBurnRateTicket

## Summary

The proportion of POST /orders requests exceeding 500ms has crossed 6.0%
on both the 6h and 30m windows for 15 continuous minutes. The latency
budget is depleting at roughly 6× the sustainable rate — slower than a
page, but this is a real, persistent issue. If unresolved it will
eventually promote to the page tier.

This is the TICKET tier. File a ticket within 1 hour. Do not page anyone.

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
list is [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5].

## Likely causes (ranked by history)

1. Gradual LocalStack degradation. SNS or SQS slowing down over hours
   due to memory growth or disk pressure in the LocalStack pod. Not
   severe enough for the page tier, but steady.

2. Node-level resource pressure building over time. Accumulated memory
   pressure on the Kind node is affecting multiple pods, and the api
   is suffering as a consequence. This is a very common pattern on a
   16 GB laptop running the full LGTM stack.

3. A slow api code path affecting a small fraction of requests. For
   example, /orders with large payloads or specific item patterns
   taking longer due to validation or serialization overhead.

4. Worker backpressure spilling into the api. If the worker is falling
   behind and the api's SNS publish begins to block (unlikely — SNS
   publish is fire-and-forget from the api's perspective — but worth
   checking if the api awaits any downstream signal).

5. A slow external dependency. The api's outbound calls (SNS, and any
   debug/outbound-ping calls from external clients) are trending slower.

6. Slow resource leak in the api. Connections or memory accumulating
   over hours.

## First queries to run

Confirm both legs (6h):

    1 - (
      sum(rate(http_request_duration_seconds_bucket{job="api",route="/orders",le="0.5"}[6h]))
        / sum(rate(http_request_duration_seconds_count{job="api",route="/orders"}[6h]))
    )

Confirm both legs (30m):

    1 - (
      sum(rate(http_request_duration_seconds_bucket{job="api",route="/orders",le="0.5"}[30m]))
        / sum(rate(http_request_duration_seconds_count{job="api",route="/orders"}[30m]))
    )

Full p95 trend over the last 6 hours — is it trending worse, stable, or improving?:

    histogram_quantile(0.95,
      sum by (le) (rate(http_request_duration_seconds_bucket{job="api",route="/orders"}[5m])))

(Open this in Grafana over a 6-hour window. Slope matters more than the
current value.)

Has any pod restarted recently?:

    kube_pod_container_status_restarts_total{namespace="default"}

Node memory and CPU trend over the last 6h:

    node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes
    node_load1

LocalStack pod resource usage:

    container_memory_usage_bytes{pod=~"localstack-.*"}
    rate(container_cpu_usage_seconds_total{pod=~"localstack-.*"}[5m])

api pod resource usage:

    container_memory_usage_bytes{pod=~"api-.*"}
    rate(container_cpu_usage_seconds_total{pod=~"api-.*", container="api"}[5m])

api CPU throttling:

    rate(container_cpu_cfs_throttled_seconds_total{pod=~"api-.*", container="api"}[5m])

Slow request logs — extract recent slow responses:

    kubectl -n default logs deploy/api --since=6h \
      | jq -r 'select(.duration_seconds > 0.5) | .duration_seconds' \
      | sort -n | tail -20

Tempo — slow sns.publish spans over 6h:

    # In Grafana Explore, Tempo datasource:
    { name = "sns.publish orders" && duration > 500ms }

Check for ?slow=true traffic in the last 6h:

    kubectl -n default logs deploy/api --since=6h | grep -c "slow=true"

## Escalation criteria

File a ticket within 1 hour if not already triaged.

If p95 over the last 30 minutes exceeds 1 second — the slow burn is
accelerating. Manually promote to page tier and follow
runbooks/latency-slo-burn-rate-page.md.

If the root cause requires a code change — open a bug with sample
payloads from the slow-request logs.

If LocalStack resource usage is trending upward — the cluster needs
more memory (or fewer running services) before it degrades into a page.
Consider scaling down unused observability services temporarily.

If the ticket has been open more than 4 hours without a fix — promote
to page tier manually regardless of current burn rate.

If both LatencySLOBurnRatePage and LatencySLOBurnRateTicket are firing
for the same SLO — focus on the page. The ticket is redundant.

## Recovery verification

After the fix, confirm:
- Both legs of the bad ratio are below 6.0%
- The alert has moved from firing to inactive in Prometheus
- job:http_request_duration_seconds:fast_ratio5m has recovered above
  0.95 for a full 30-minute window (the long leg of the ticket tier)
- p95 has returned below 200ms

Check alert state:

    curl -s 'http://localhost:9090/api/v1/alerts' \
      | jq '.data.alerts[] | select(.labels.alertname=="LatencySLOBurnRateTicket") | {state, activeAt}'

Check the SLO metric:

    curl -s 'http://localhost:9090/api/v1/query' \
      --data-urlencode 'query=job:http_request_duration_seconds:fast_ratio5m' \
      | jq '.data.result[0].value[1]'

## Related runbooks

- runbooks/latency-slo-burn-rate-page.md — the page-tier escalation
- runbooks/freshness-slo-burn-rate-ticket.md — likely firing alongside
  if the bottleneck is shared infrastructure
- runbooks/_burn-rate-pattern.md — shared context and math