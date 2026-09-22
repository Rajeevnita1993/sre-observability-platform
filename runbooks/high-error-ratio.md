---
alert: HighErrorRatio
severity: critical
slo: availability
group: service_alerts
owner: platform
last_reviewed: 2026-09-22
---

# Runbook: HighErrorRatio

## Summary

The api's 5xx ratio (over a 5-minute window) has been above 5% for 5
continuous minutes. Users are experiencing failed order submissions.
This is the simpler, faster-firing sibling of the availability
burn-rate page alert — it catches acute failure before the burn-rate
math has time to accumulate.

## Likely causes (ranked by history)

1. LocalStack dependency failure. LocalStack provides SNS, SQS, and
   S3. If it is down or unhealthy, the api's SNS publish fails and it
   returns 500. Common on this cluster after Docker Desktop restarts.

2. Recent api deploy. The api restarted with a broken code path.
   Check rollout history.

3. Node-level resource pressure. The api pod is getting OOM-killed or
   CPU-throttled. Check container restarts.

4. Broken dependency config. Environment variable changed, secret
   missing, or service DNS broken after a recent apply.

5. Deliberate fault injection. Someone is spamming /debug/outbound-ping
   with an invalid URL (the debug endpoint returns 500 on DNS failure).

## First queries to run

**Current 5xx ratio:**

    job:http_error_ratio:ratio5m{job="api"}

**Breakdown by status code:**

    sum by (status) (rate(http_requests_total{job="api",status=~"5.."}[5m]))

**Breakdown by route — which endpoint is failing?:**

    sum by (route) (rate(http_requests_total{job="api",status=~"5.."}[5m]))

**Is the api even up?**

    up{job="api"}
    kubectl -n default get pods -l app=api
    kubectl -n default get deploy api -o jsonpath='{.spec.replicas}/{.status.readyReplicas}{"\n"}'
    kubectl -n default rollout history deploy/api

**Recent api errors in logs:**

    kubectl -n default logs deploy/api --tail=100 | grep -iE "error|fail|exception"

**Is LocalStack reachable?**

    up{job="localstack"}
    kubectl -n default get pods -l app=localstack
    kubectl -n default logs deploy/localstack --tail=50

**Check for recent pod restarts:**

    kube_pod_container_status_restarts_total{namespace="default", pod=~"api-.*"}

## Escalation criteria

This is a page. Acknowledge within 5 minutes.

If root cause is not identified within 15 minutes — page the api service
owner and LocalStack owner.

If error ratio exceeds 50% — treat as full outage. Consider rollback:

    kubectl -n default rollout undo deploy/api

If LocalStack is the cause and will not recover — the pipeline is
effectively down. Options:
- Restart LocalStack: `kubectl -n default rollout restart deploy/localstack`
- Free node memory by scaling down unused observability services
- Check Docker Desktop memory headroom

## Recovery verification

After the fix, confirm:
- job:http_error_ratio:ratio5m{job="api"} is below 0.05
- The alert has moved from firing to inactive in Prometheus
- 5xx rate has been at zero for a full 5-minute window

Check alert state:

    curl -s 'http://localhost:9090/api/v1/alerts' \
      | jq '.data.alerts[] | select(.labels.alertname=="HighErrorRatio") | {state, activeAt}'

## Related runbooks

- runbooks/availability-slo-burn-rate-page.md — the SLO burn-rate sibling
- runbooks/availability-slo-burn-rate-ticket.md — will fire ~15 minutes
  after this if the errors persist
- runbooks/sqs-backlog-growing.md — check if the pipeline is also
  backed up