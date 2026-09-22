---
alert: <AlertName>
severity: <critical|warning|info|none>
slo: <availability|latency|freshness|-> 
group: <service_alerts|slo_burn_rate_alerts>
owner: platform
last_reviewed: 2026-09-22
---

# Runbook: <AlertName>

## Summary
<One or two sentences: what the expr checks, what it means for users.>

## Likely causes (ranked by history)
1. <Most probable cause for THIS system, from real incidents>
2. <Second most probable>
3. <Third>

## First queries to run
- PromQL — <what to check first>: `<literal query>`
- LogQL / TraceQL — <if relevant>: `<literal query>`
- Dashboard: <exact Grafana dashboard + panel name>

## Escalation criteria
- <Concrete time bound, e.g. "no cause found within 15 minutes">
- <Concrete severity bound, e.g. "backlog exceeds 5x threshold">
- <Who to page/ticket next>
