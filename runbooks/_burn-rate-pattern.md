---
kind: reference
scope: burn-rate-alerts
owner: platform
last_reviewed: 2026-09-22
---

# Burn-Rate Alert Pattern — shared diagnostic reference

All six burn-rate alerts on the order pipeline follow the same pattern.
This document holds the shared diagnostic flow; the per-alert runbooks
link to it and only state the alert-specific bits.

## What burn-rate alerts detect

Two windows must both be above a derived threshold. The long window
(diluted over hours) prevents blip paging. The short window (concentrated)
ensures the burn is still happening *now*.

| Tier | Multiplier | Windows | `for:` | Severity | Budget-per-hour |
|---|---|---|---|---|---|
| Page | 14.4× | 1h + 5m | 2m | critical | 2% of month per 1h |
| Ticket | 6× | 6h + 30m | 15m | warning | 5% of month per 6h |

Multipliers derived from `B = fraction × W / w` — see Day 63 Step 1.

## Thresholds per SLO

| SLO | Budget | Page threshold | Ticket threshold |
|---|---|---|---|
| availability | 0.005 | 7.2% | 3.0% |
| latency | 0.01 | 14.4% | 6.0% |
| freshness | 0.01 | 14.4% | 6.0% |

## The bad-ratio expression per SLO

| SLO | Bad ratio |
|---|---|
| availability | `sum(rate(http_requests_total{job="api",status=~"5.."}[W])) / sum(rate(http_requests_total{job="api"}[W]))` |
| latency | `1 - (sum(rate(http_request_duration_seconds_bucket{job="api",route="/orders",le="0.5"}[W])) / sum(rate(http_request_duration_seconds_count{job="api",route="/orders"}[W])))` |
| freshness | `1 - (sum(rate(order_fulfillment_duration_seconds_bucket{job="worker",le="10.0"}[W])) / sum(rate(order_fulfillment_duration_seconds_count{job="worker"}[W])))` |

Substitute `W` with the window you're checking: `5m`, `1h`, `30m`, or `6h`.

## Universal first steps (do these before anything else)

1. **Is the alert still firing right now?** Both legs must be true for
   the alert to persist. If one leg cleared, it was a transient — note
   and close.

   ```bash
   curl -s 'http://localhost:9090/api/v1/alerts' \
     | jq '.data.alerts[] | select(.labels.alertname | contains("SLOBurnRate")) | {name: .labels.alertname, state, activeAt}'
   ```

2. **Recent deploy?** Check what changed in the last 30 minutes. Most
   burn-rate incidents start with a deploy.

   ```bash
   kubectl -n default rollout history deploy/api
   kubectl -n default rollout history deploy/worker
   ```

3. **Is this a single-service issue or cluster-wide?** Look at
   `up{job=~"api|worker"}` and the node's health before drilling into
   the SLO metric.

4. **Check the short window first — it tells you whether the burn is
   still happening.** If the short leg has cooled but the long leg is
   still hot, the incident is over and the alert will clear within
   `for:` minutes.

## Universal recovery verification

After the fix, confirm:
- The bad ratio for both legs has fallen below the threshold
- The alert has moved from `firing` → `inactive` in Prometheus
- The SLO metric (`job:*:fast_ratio5m`) has recovered above 0.95 for a
  full 5-minute window

## Universal escalation rules

- **Page tier fires → acknowledge within 5 minutes** or it auto-escalates
  in Alertmanager.
- **If the same page-tier alert fires twice within 24 hours** for the same
  SLO — escalate to a written postmortem regardless of root cause.
- **If the ticket-tier alert has been open > 4 hours** without a fix —
  promote to page tier manually.
- **If both page and ticket tiers are firing for the same SLO** — the
  ticket is redundant; focus on the page and suppress the ticket.

## Related

- `error-budget-policy.md` — the SLO definitions and escalation tiers
- `runbooks/_template.md` — the template all runbooks start from