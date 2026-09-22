---
alert: AvailabilitySLOBurnRateTicket
severity: warning
slo: availability
group: slo_burn_rate_alerts
owner: platform
last_reviewed: 2026-09-22
---

# Runbook: AvailabilitySLOBurnRateTicket

## Summary

The api's 5xx ratio has exceeded 3.0% on both the 6h and 30m windows for
15 continuous minutes. This is a slower, sustained burn — not yet a page,
but the monthly availability budget is depleting at roughly 5× the
sustainable rate. If unresolved, the page tier will fire within a few hours.

This is the TICKET tier. File a ticket within 1 hour. Do not page anyone.

## Diagnostic reference

See runbooks/_burn-rate-pattern.md for shared context. Availability
bad ratio over any window W:

    sum(rate(http_requests_total{job="api",status=~"5.."}[W]))
      /
    sum(rate(http_requests_total{job="api"}[W]))

Page threshold: 0.072 (7.2%). Ticket threshold: 0.03 (3.0%).

## Likely causes (ranked by history)

1. A slow-burn api regression. A small percentage of requests failing
   on a specific code path or route. Not catastrophic enough for the
   page tier, but persistent. Look for a subset of traffic hitting a
   buggy branch.

2. Intermittent LocalStack issues. LocalStack occasionally slow or
   erroring — causing sporadic 5xx on the api's SNS publish. Manifests
   as a steady trickle rather than a burst.

3. A subset of traffic hitting a broken route. For example /debug/*
   endpoints hit by an external scanner, or a client library sending
   malformed requests that consistently 400 as 500.

4. Memory pressure causing sporadic OOM kills. The api pod restarts
   occasionally, and each restart window produces a burst of 5xx.

5. Slow resource leak in the api. Memory, file descriptors, or
   connections slowly growing over hours, gradually increasing error
   rate.

## First queries to run

Confirm sustained elevation across both windows (6h):

    sum(rate(http_requests_total{job="api",status=~"5.."}[6h]))
      / sum(rate(http_requests_total{job="api"}[6h]))

Confirm sustained elevation across both windows (30m):

    sum(rate(http_requests_total{job="api",status=~"5.."}[30m]))
      / sum(rate(http_requests_total{job="api"}[30m]))

Drill into which route is failing:

    sum by (route) (rate(http_requests_total{job="api",status=~"5.."}[30m]))
      /
    sum by (route) (rate(http_requests_total{job="api"}[30m]))

Which error codes dominate?

    sum by (status) (rate(http_requests_total{job="api",status=~"5.."}[30m]))

Compare against a comparable window from 24 hours ago:

    # Same query as above, just change the window to [30m] offset 24h
    # This tells you if the trend is new or chronic.

Recurring error patterns in logs:

    kubectl -n default logs deploy/api --since=1h \
      | grep -iE "error|fail" \
      | sort | uniq -c | sort -rn | head -20

api pod restart history (are restarts coincident with error bursts?):

    kubectl -n default get pods -l app=api
    kube_pod_container_status_restarts_total{namespace="default", pod=~"api-.*"}

Memory and CPU trend for the api pod over the last 6h:

    container_memory_usage_bytes{pod=~"api-.*"}
    rate(container_cpu_usage_seconds_total{pod=~"api-.*", container="api"}[5m])

## Escalation criteria

File a ticket within 1 hour if not already triaged.

If the alert promotes to AvailabilitySLOBurnRatePage — stop the ticket
workflow and follow the page runbook instead.

If the burn rate accelerates (short window climbs above 7.2%) — manually
promote to page tier and page on-call.

If the identified root cause requires api code changes — open a properly
scoped bug ticket with reproduction steps from the log grep above.

If the ticket has been open more than 4 hours without a fix — promote
to page tier manually regardless of current burn rate.

If both AvailabilitySLOBurnRatePage and AvailabilitySLOBurnRateTicket are
firing for the same SLO — focus on the page. The ticket is redundant.

## Recovery verification

After the fix, confirm:
- Both legs of the bad ratio are below 3.0%
- The alert has moved from firing to inactive in Prometheus
- The underlying 5xx rate has been below 0.03 for a full 30-minute window
  (the long leg of the ticket tier)

Check alert state:

    curl -s 'http://localhost:9090/api/v1/alerts' \
      | jq '.data.alerts[] | select(.labels.alertname=="AvailabilitySLOBurnRateTicket") | {state, activeAt}'

## Related runbooks

- runbooks/availability-slo-burn-rate-page.md — the page-tier escalation
- runbooks/high-error-ratio.md — the simpler sibling alert
- runbooks/_burn-rate-pattern.md — shared context and math