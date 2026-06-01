/**
 * Light counters + timings (MNEMO-50, PRD §3).
 *
 * No metrics backend, no APM - a metric is just a structured log line
 * (`event:"metric"`) the edge captures into Logpush. Aggregation/alerting is a
 * downstream query concern; this module only EMITS. `counter` and `timing` share
 * the same `{ metric, value, kind, tags }` shape so one Logpush filter
 * (`event="metric" metric="..."`) sweeps both.
 *
 * Seed metric names live in {@link METRICS} so emitters reference a constant, not a
 * string literal - the names are part of the observability contract and must stay
 * stable for dashboards/alerts to keep matching.
 */
import { log } from "./logger.ts";

/** Tag map attached to a metric (e.g. `{ reason: "cost_cap" }`). Keep values primitive. */
export type MetricTags = Record<string, string | number | boolean>;

/** Increment a counter `metric` by `value` (default 1), optionally tagged. Pure emit. */
export function counter(name: string, value = 1, tags?: MetricTags): void {
  log("info", "metric", {
    metric: name,
    value,
    kind: "counter",
    tags: tags ?? {},
  });
}

/** Record a `ms` duration for `metric`, optionally tagged. Pure emit. */
export function timing(name: string, ms: number, tags?: MetricTags): void {
  log("info", "metric", {
    metric: name,
    value: ms,
    kind: "timing",
    tags: tags ?? {},
  });
}

/**
 * Seed metric-name constants - the stable observability contract. Reference these
 * from emit sites so a rename is one edit here, not a grep across the codebase.
 *
 * - `RESEARCH_RUN_*`  - agent research-run lifecycle (started/completed/failed).
 * - `SANDBOX_BOOT_MS` - container cold-start time (the §8.4 cost lever).
 * - `LLM_CALL_MS`     - model round-trip latency.
 * - `REPORT_GENERATED`- a report artifact produced (MNEMO-24).
 * - `ADMISSION_DENIED`- an admission-gate denial, **tagged by reason** (ties to the
 *                       MNEMO-49 `AdmissionReason`: cost_cap / concurrency / tier_feature).
 * - `HTTP_5XX`        - a 5xx response left the Worker (incremented in the error handler).
 */
export const METRICS = {
  RESEARCH_RUN_STARTED: "research_run_started",
  RESEARCH_RUN_COMPLETED: "research_run_completed",
  RESEARCH_RUN_FAILED: "research_run_failed",
  SANDBOX_BOOT_MS: "sandbox_boot_ms",
  LLM_CALL_MS: "llm_call_ms",
  REPORT_GENERATED: "report_generated",
  ADMISSION_DENIED: "admission_denied",
  HTTP_5XX: "http_5xx",
} as const;
