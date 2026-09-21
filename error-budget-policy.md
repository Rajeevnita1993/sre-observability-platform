# Error Budget Policy — Order Pipeline

**Owner:** SRE / Platform team
**Review cadence:** Quarterly
**Last updated:** Day 62
**Applies to:** `default/api`, `default/worker`, and the SNS→SQS→S3 async pipeline

---

## 1. Service Level Objectives

### SLO 1 — /orders latency

**Service Level Indicator (SLI):**
Proportion of `POST /orders` requests that complete in **under 500 ms**,
measured at the api process via `http_request_duration_seconds_bucket`,
over a rolling 5-minute window.

**Service Level Objective (SLO):**
**95%** of requests under 500 ms, evaluated over a rolling **30-day** window.

**Error budget:** 5% of requests may exceed 500 ms.

**Recording rule:** `job:http_request_duration_seconds:fast_ratio5m`

**Rationale for 500 ms (not 300 ms):** the api's existing histogram bucket
list is `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]`. The next
bucket above the nominal 300 ms target is 500 ms. Using an existing bucket
preserves the ratio-SLI shape (proportion under threshold) rather than an
interpolated quantile. Backlog item: add `0.3` to `api/tracing.js` buckets
to support the tighter SLO.

### SLO 2 — Order fulfillment freshness

**Service Level Indicator (SLI):**
Proportion of orders whose **api-receipt → S3-write-confirmed** latency is
**under 10 seconds**, measured via `order_fulfillment_duration_seconds_bucket`,
over a rolling 5-minute window.

**Service Level Objective (SLO):**
**95%** of orders fulfilled within 10 seconds, evaluated over a rolling
**30-day** window.

**Error budget:** 5% of orders may exceed 10 seconds.

**Recording rule:** `job:order_fulfillment_duration_seconds:fast_ratio5m`

**Measurement point:** end-to-end. `receivedAtMs` is stamped in `api/app.js`
at SNS publish time, carried as an SNS message attribute through SQS to the
worker, and recorded at S3 PutObject confirmation. This captures SNS publish
latency + SQS queue wait + worker processing.

---

## 2. Budget Consumption and Escalation

Both SLOs use the same escalation tiers. Budget consumption is evaluated on
a rolling 30-day window.

### Tier 0 — Under 25% consumed (normal)

**State:** healthy. No action required.

**What's allowed:**
- Normal feature velocity. Standard deploy cadence.
- Risky changes to the api or worker are permitted without extra review.

**What's not:**
- Nothing is forbidden; this is the design operating state.

### Tier 1 — 25% consumed (note it)

**State:** elevated burn. Not alarming, but worth a written note.

**Required actions:**
- Post a message in `#reliability` noting the burn and the trailing-30d value.
- No process change. No freeze. This tier exists to surface trends early.

**Exit:** budget consumption falls back under 25%.

### Tier 2 — 50% consumed (reliability work enters the sprint)

**State:** the system is burning faster than the SLO can sustain for the
remaining window. Corrective work is now mandatory.

**Required actions:**
- Add **one reliability item** to the top-3 of the next sprint planning.
- The reliability item must be chosen from the "Known failure modes" section
  below, or a new item justified by the burn's root cause.
- Any risky deploy to the affected service requires **a second reviewer** who
  explicitly acknowledges the current burn rate in the PR description.

**What counts as "risky":**
- Changes to `serializeResult`, `s3writer.js`, or the SQS polling loop
- Changes to api SNS publish code path
- Changes to `api/tracing.js` or `worker/metrics.js` (instrumentation drift)
- Any change to the PrometheusRule CRD

**Exit:** budget consumption falls back under 25% for 7 consecutive days.

### Tier 3 — 100% consumed (freeze)

**State:** the SLO is violated for the current window. Feature work stops.

**Required actions:**
- **Feature deploy freeze** to the affected service (`api` and/or `worker`).
  Security patches and pure observability improvements are exempt.
- **Incident review within 48 hours.** Blameless postmortem, published to
  `#reliability`. Root cause, contributing factors, and at least one
  preventative action item.
- **The freeze lifts only when** the trailing-30d ratio recovers above the
  SLO target (0.95) AND the postmortem's action items are merged.

**Who can lift the freeze:**
- The on-call engineer, after both conditions above are verified.
- The service owner, with a written justification if the conditions aren't met.

---

## 3. Burn-Rate Alerts

Recorded in `monitoring/order-pipeline-rules` , the burn-rate alerts
fire on **rate of budget consumption**, not absolute consumption. This makes
them forward-looking — they catch a fast burn before the monthly budget is
gone.

### Fast burn → page

`HighBurnRateFast` fires when the 1-hour error ratio exceeds 14.4× the SLO
error rate AND the 5-minute ratio confirms. At this rate, the full 30-day
budget exhausts in ~2 days.

**Response:** page on-call. Investigate immediately.

### Slow burn → ticket

`HighBurnRateSlow` fires when the 6-hour error ratio exceeds 6× the SLO
error rate AND the 30-minute ratio confirms. At this rate, the budget
exhausts in ~5 days.

**Response:** file a ticket. Investigate within one business day.

---

## 4. Known Failure Modes

Real failure modes observed and characterized in this system:

### F1 — LocalStack SNS saturation (upstream bottleneck)

**Symptom:** SLO 1 (latency) degrades first. SLO 2 (freshness) stays green.
SQS depth begins climbing but worker p95 freshness is still under threshold.

**Cause:** api awaits `sns.send()` before returning 202. Under concurrent
load, LocalStack serializes publishes.

**Response:** the latency SLO is the canary. Check api's server-side p95,
SNS publish span duration in Tempo. LocalStack scaling is a lab constraint;
in production this would be a real-SNS throughput investigation.

### F2 — Worker throughput starvation (downstream bottleneck)

**Symptom:** SLO 2 (freshness) degrades first. SLO 1 (latency) stays green
or recovers. SQS depth climbs unbounded. Worker p95 freshness rises to
minutes.

**Cause:** worker can't keep pace with the api's publish rate. Classic
causes: expensive per-message CPU work, slow S3 writes, worker replica count
too low.

**Response:** the freshness SLO is the canary. Check worker CPU utilization,
`serializeResult` span duration in Pyroscope, SQS `ApproximateNumberOfMessagesVisible`.

**Observed instance :** `serializeResult` ran 20 deep-clone iterations
plus a 3000-item batch/dedupe per message. At 38 msg/s inbound and ~4-8 msg/s
worker throughput, SQS climbed to 5,518 in under 5 minutes. Reduced to 1
iteration and 1 batch item; throughput restored.

### F3 — Poison message loop (no DLQ)

**Symptom:** SQS depth plateaus at a nonzero floor even after load stops.
Worker log shows repeated order IDs.

**Cause:** failed messages are not deleted from SQS, and there is no
Dead Letter Queue with a `maxReceiveCount`. Failed messages redeliver
indefinitely, consuming worker CPU.

**Response:** inspect SQS `RedrivePolicy`. If absent, add a DLQ with
`maxReceiveCount: 3`. Redrive stuck messages from the primary queue after
the root cause is fixed.

**Status:** known gap. Not yet implemented.

---

## 5. Measurement Integrity

An SLO is only as trustworthy as its instrumentation. Two known biases:

### B1 — Freshness histogram only observes successes

The worker's `.observe()` call runs after S3 PutObject confirms. Failed
messages that are redelivered are not observed until they succeed. A message
that never succeeds is never observed at all.

**Consequence:** SLO 2 reads "100% under 10s" while a subset of orders are
stuck in retry loops. The SLO is blind to in-flight failures.

**Mitigation (backlog):** record freshness on failure too, tagged with
`status="error"`. Add a second SLI ("order failure ratio") to catch this.

### B2 — Bucket label format differs across instrumentation libraries

prom-client (api) emits trimmed labels: `le="0.5"`, `le="1"`.
OTel SDK (worker) emits float-formatted labels: `le="5.0"`, `le="10.0"`.

**Consequence:** a recording rule written against `le="10"` matches nothing
when the metric is produced by OTel. Rule silently returns empty, health
still reads `ok`.

**Mitigation:** any new recording rule must verify the actual label format
against the live metric before being merged.

---

## 6. What This Policy Is Not

- **Not a promise to customers.** These SLOs govern internal engineering
  behavior. External SLAs (if any) are separate documents.
- **Not static.** Re-evaluate quarterly. If an SLO is trivially met for two
  consecutive quarters, tighten it. If it's consistently missed by a small
  margin, the SLO may be miscalibrated rather than the system broken.
- **Not a substitute for alerting.** SLO burn-rate alerts catch trend-based
  failures. Infrastructure alerts (pod down, queue size exploding) still run
  independently and page on-call for hard failures.

---

## Appendix — Recording Rules Reference

Both rules are defined in `monitoring/order-pipeline-rules`, group
`journey_slis`, `interval: 30s`:

```yaml
- record: job:http_request_duration_seconds:fast_ratio5m
  expr: |
    sum(rate(http_request_duration_seconds_bucket{job="api",route="/orders",le="0.5"}[5m]))
      /
    sum(rate(http_request_duration_seconds_count{job="api",route="/orders"}[5m]))

- record: job:order_fulfillment_duration_seconds:fast_ratio5m
  expr: |
    sum(rate(order_fulfillment_duration_seconds_bucket{job="worker",le="10.0"}[5m]))
      /
    sum(rate(order_fulfillment_duration_seconds_count{job="worker"}[5m]))