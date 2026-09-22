---
alert: AvailabilitySLOBurnRatePage
severity: critical
slo: availability
group: slo_burn_rate_alerts
owner: platform
last_reviewed: 2026-09-22
---

# Runbook: AvailabilitySLOBurnRatePage

## Summary

The api's 5xx ratio has exceeded 7.2% on both the 1h and 5m windows for
2 continuous minutes. At this rate, the monthly availability budget
(0.5%) exhausts in roughly 2 days. Users are experiencing failed
requests right now.

This is the PAGE tier. Acknowledge within 5 minutes or the alert
auto-escalates in Alertmanager.

## Diagnostic reference

See runbooks/_burn-rate-pattern.md for shared context. Availability
bad ratio over any window W:

    sum(rate(http_requests_total{job="api",status=~"5.."}[W]))
      /
    sum(rate(http_requests_total{job="api"}[W]))

Page threshold: 0.072 (7.2%). Ticket threshold: 0.03 (3.0%).

## Likely causes (ranked by history)

1. Recent api deploy. The api restarted with a broken code path.
   Most common — check rollout history first.

2. LocalStack dependency failure. LocalStack provides SNS, SQS, and
   S3. If it is down or unhealthy, the api's SNS publish fails and
   it returns 500. This was the Day 62 pattern when under load.

3. Retry storm. A downstream failure causes clients to retry,
   multiplying load and error rate. Look for a spike in request rate
   coincident with the error ratio rise.

4. Node-level resource pressure. The api pod is getting OOM-killed
   or CPU-throttled. Check container restarts.

5. Broken dependency config. Environment variable changed, secret
   missing, or service DNS broken after a recent apply.

## First queries to run

Confirm both legs are still hot (1h):

    sum(rate(http_requests_total{job="api",status=~"5.."}[1h]))
      / sum(rate(http_requests_total{job="api"}[1h]))

Confirm both legs are still hot (5m):

    sum(rate(http_requests_total{job="api",status=~"5.."}[5m]))
      / sum(rate(http_requests_total{job="api"}[5m]))

Which error codes? Break down by status:

    sum by (status) (rate(http_requests_total{job="api",status=~"5.."}[5m]))

Which routes?

    sum by (route) (rate(http_requests_total{job="api",status=~"5.."}[5m]))

Is the api even up?

    up{job="api"}

Kubernetes pod state:

    kubectl -n default get pods -l app=api
    kubectl -n default get deploy api -o jsonpath='{.spec.replicas}/{.status.readyReplicas}{"\n"}'
    kubectl -n default rollout history deploy/api

Recent api errors in logs:

    kubectl -n default logs deploy/api --tail=100 | grep -iE "error|fail|exception"

Is LocalStack reachable?

    up{job="localstack"}
    kubectl -n default logs deploy/localstack --tail=50

Check for recent pod restarts:

    kube_pod_container_status_restarts_total{namespace="default", pod=~"api-.*"}

## Escalation criteria

This is a page. Acknowledge within 5 minutes.

If root cause is not identified within 15 minutes — page the service
owner for api and LocalStack.

If error ratio exceeds 50% — treat as full outage. Consider rollback
to the last known-good api image:

    kubectl -n default rollout undo deploy/api

If LocalStack is the cause and will not recover — the pipeline is
effectively down. Escalate to infrastructure owner.

If this alert fires twice within 24 hours for the same SLO — escalate
to a written postmortem regardless of root cause.

## Recovery verification

After the fix, confirm:
- Both legs of the bad ratio are below 7.2%
- The alert has moved from firing to inactive in Prometheus
- job:http_error_ratio:ratio5m{job="api"} has returned below 0.005 for
  a full 5-minute window

Check alert state:

    curl -s 'http://localhost:9090/api/v1/alerts' \
      | jq '.data.alerts[] | select(.labels.alertname=="AvailabilitySLOBurnRatePage") | {state, activeAt}'

## Related runbooks

- runbooks/availability-slo-burn-rate-ticket.md — will fire ~15 minutes
  later if this persists
- runbooks/high-error-ratio.md — the simpler 5-minute alert that fires
  alongside or before this one
- runbooks/freshness-slo-burn-rate-page.md — check if the async
  pipeline is also impacted
