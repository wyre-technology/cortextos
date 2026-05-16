# Spec: App Observability + Vendor Container Health

Tag: `observability-vendor-health`
Status: v1 — scope locked; §3 + §5 shipped, §3a + §4 to build
Owner: Conduit dev (Hank)
Paired UI scope: Pearl — tenant-facing vendor health UI (`task_1778950808450`)
Target release: Conduit June launch
Last updated: 2026-05-16

## 1. Summary

Aaron wants two things surfaced for the June launch:

1. **App-level observability** — request latency, error rates, throughput for
   the Conduit gateway itself.
2. **Per-vendor container health** — surfaced *to tenants*, so a customer can
   see whether the MCP servers they have connected are up.

This is a **delta, not a greenfield**. Conduit already records per-request
telemetry and already polls vendor containers. The work is aggregation,
tenant-scoping, and one security fix — not new infrastructure.

This doc is design-only. It defines endpoint shapes, the data model, and a
build order. No code ships from this doc.

## 2. Current state (what already exists)

### 2.1 Per-request telemetry — `request_log`

Defined in `src/org/org-service.ts` (boot DDL). Every proxied tool call writes
a row:

| Column             | Note                                          |
|--------------------|-----------------------------------------------|
| `id`               | PK                                            |
| `user_id`          | NOT NULL                                      |
| `org_id`           | tenant — nullable                             |
| `vendor_slug`      | NOT NULL (`_unified`/`_gateway` are internal) |
| `tool_name`        | nullable                                      |
| `status_code`      | NOT NULL — HTTP status of the proxied call    |
| `response_time_ms` | nullable — **latency is already captured**    |
| `created_at`       | NOT NULL, default NOW()                       |

Indexed on `(user_id, created_at)` and `(org_id, created_at)`.

**Finding:** latency, error (`status_code`), and throughput (row count over
time) raw data already lands per request, per tenant. What is missing is
*aggregation* and a *surface*.

### 2.2 Structured logs

`pino` JSON logging is configured (`src/index.ts`). No log-derived metrics
pipeline; log-shipping adapters exist (`src/log-shipping/`) for Loki / LogScale
/ Graylog but are an export path, not an in-app metrics source.

### 2.3 Admin metrics — `GET /api/admin/metrics`

WYRE-internal only (`requireAdmin`). Aggregates active orgs, top tools, credit
burn. **Not** latency / error-rate focused, **not** tenant-scoped. Reuse the
query patterns; do not reuse the surface.

### 2.4 Health endpoints

| Endpoint              | Auth        | Scope  | Returns                              |
|-----------------------|-------------|--------|--------------------------------------|
| `GET /health`         | none        | —      | static `{status:'ok', timestamp}`    |
| `GET /health/vendors` | **none**    | global | every vendor's health (all tenants)  |

`/health` is liveness only — it does not check the DB, so it returns `ok`
even when Postgres is unreachable.

### 2.5 Vendor health monitor — `VendorMonitor`

`src/monitoring/vendor-monitor.ts`. Polls every vendor container every
`MONITOR_INTERVAL_MS` (default 60s), stores current state in an in-memory
`Map`. Per-vendor `VendorStatus`:

```
{ slug, status: 'up'|'down'|'unknown', version, responseMs,
  lastChecked, lastStateChange, consecutiveFailures, lastError }
```

`down` is declared after 3 consecutive failures. **No history** — the Map
holds current state only; a restart loses it. **No tenant scoping** — it
probes the global vendor list.

## 3. Security fix — `/health/vendors` info disclosure

**Flagged as a security issue, not a feature delta.**

`GET /health/vendors` is unauthenticated and global. Anyone on the internet
can read every vendor container's `version`, `lastError`, and up/down state.
Version strings and error details are reconnaissance material and leak
internal state across tenants.

**Recommendation — ship ahead of the rest, as its own small hardening PR:**

- Keep an unauthenticated **liveness** `/health` (ops/uptime monitors need it).
- `/health/vendors` in its current form should **either** require auth (ops
  monitoring only) **or** be stripped to a bare per-vendor `status` enum with
  no `version` and no `lastError`.
- The *tenant-facing* health surface is the new authenticated, org-scoped
  endpoint in §5 — it does not depend on this fix and this fix does not
  depend on it.

This hardening is small, has no data-model design dependency, and removes a
live cross-tenant disclosure. It should not wait for the June observability
build. **Resolved:** shipped as an immediate standalone hardening fix — PR #124
admin-gates `/health/vendors`.

## 4. App-level observability

### 4.1 Metrics to surface

Derived by aggregating `request_log` over a time window:

- **Latency** — p50 / p95 / p99 of `response_time_ms`.
- **Error rate** — share of rows with `status_code >= 500` (and separately
  `>= 400`), as a percentage.
- **Throughput** — calls per minute/hour over the window.

All bucketable by `vendor_slug` and filterable by `org_id`.

### 4.2 Surface — WYRE-internal admin metrics (resolved)

**Resolved by Aaron:** app observability is **WYRE-internal-only** for June,
not tenant-facing. It therefore folds into the existing `GET /api/admin/metrics`
(admin-gated) — **no new tenant-facing endpoint**.

The latency p50/p95/p99, error-rate, and throughput aggregations are added to
the existing `fetchMetrics()` payload (`src/admin/routes.ts`). Internal
`vendor_slug`s (`_unified`, `_gateway`) excluded, matching the current
admin-metrics convention.

Postgres percentile aggregation (`percentile_cont`) over the existing
`(org_id, created_at)` index is sufficient at current volume. No new table;
no Prometheus `/metrics` endpoint in v1 (note it as a fast-follow if WYRE
wants external scraping).

## 5. Vendor container health — tenant-scoped

### 5.1 Endpoint

`GET /api/orgs/:orgId/vendor-health` — authenticated, org-scoped (member+).
Returns only the vendors **that org has connected** (has credentials /
server-access for) — not the global vendor list.

Per-vendor object (shape shared with Pearl for the UI scope):

```
{
  vendorSlug:  string,
  displayName: string,
  status:      'healthy' | 'degraded' | 'down' | 'unknown',
  lastChecked: string,   // ISO 8601 — UI shows staleness from this
  latencyMs:   number,
  version:     string | null,
  errorDetail: string | null   // populated only when degraded/down
}
```

### 5.2 `degraded` — a new state (confirmed)

The monitor today is 3-state (`up`/`down`/`unknown`). This spec adds a 4th,
`degraded`: container responds but latency exceeds a threshold, or it has
1–2 consecutive failures (below the hard `down` threshold of 3). It gives the
tenant UI a real amber state instead of a binary. **Confirmed by Pearl** — the
4-state model (`healthy`/`degraded`/`down`/`unknown`) stands. The status dot is
a status indicator and supports >2 states. Amber/red/grey design-token values
are a Ruby detail and do not affect the endpoint.

Status mapping (monitor `VendorStatus` → endpoint `status`):

| Endpoint `status` | Condition                                              |
|-------------------|--------------------------------------------------------|
| `healthy`         | `up`, latency under threshold                          |
| `degraded`        | `up` but latency over threshold, OR 1–2 consec failures|
| `down`            | `down` (≥3 consecutive failures)                       |
| `unknown`         | not yet probed / no state                              |

### 5.3 Polling model

Read from the `VendorMonitor` cache — **never** live-check on page load. A
page load must not fan out to N vendor containers. `lastChecked` communicates
staleness. Default 60s poll interval is adequate.

### 5.4 History / uptime-over-time — OUT OF v1 SCOPE

**Resolved with Pearl.** Figma Surface 2 cards show status-dot + users +
last-call + Configure — no per-vendor sparkline, uptime %, or incident list.
The only trend element is a page-top aggregate "ERROR RATE (7d)" card, which is
app-observability (§4), not per-vendor health history.

**v1 = current-state only, zero new write path.** The endpoint reads the
in-memory `VendorMonitor` cache and nothing more.

**v2 (not built):** if Aaron later wants per-vendor uptime, add a
`vendor_health_history (id, vendor_slug, status, latency_ms, checked_at)`
table and have the monitor append one row per probe. Noted here so the v2 path
is known; it is explicitly not in this scope.

## 6. Build order

1. **Security fix** — admin-gate `/health/vendors` (§3). ✅ shipped — PR #124.
2. **Vendor-health tenant endpoint** (§5) — filter monitor cache to the org's
   connected vendors; 4-state `degraded`. ✅ shipped — PR #125.
3. **Readiness probe** — `GET /health/ready` that checks DB reachability,
   distinct from liveness `/health`. Not yet built.
4. **App-observability admin metrics** (§4) — `request_log` aggregation added
   to `GET /api/admin/metrics` (WYRE-internal). Not yet built.

`vendor_health_history` is **not** in this build order — it is v2 (§5.4).

## 7. Open questions — all resolved

| # | Question | Resolution |
|---|----------|------------|
| 1 | `/health/vendors` hardening — immediate fix or part of this work? | Immediate standalone fix — shipped as PR #124. |
| 2 | App observability — tenant-facing or WYRE-internal for June? | WYRE-internal-only (Aaron) — folds into `/api/admin/metrics`. |
| 3 | Vendor-health UI — current-state only, or uptime trends? | Current-state only (Pearl) — history is v2. |
| 4 | Figma cards — is there a `degraded` visual state? | Yes (Pearl) — 4-state model stands. |

Scope is locked. §3 and §5 are shipped; §3a (readiness probe) and §4 (admin
metrics) remain to build.
