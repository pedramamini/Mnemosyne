/**
 * Usage metering (MNEMO-49) - the writer + aggregator over the append-only
 * `usage_events` ledger. `recordUsage` prices one metered event into `cost_cents`
 * and appends a row; `getUsageSummary` rolls a period up into a total + per-kind
 * breakdown. This module is PURE accounting - D1 + arithmetic, NO enforcement
 * (that's limits.ts). It is the cost signal the cost-cap gate sums.
 *
 * NB: distinct from `src/llm/recordUsage.ts` (MNEMO-14), which accumulates BYOK
 * milli-USD into `llm_spend` for the per-account LLM spend cap. THIS ledger
 * normalizes ALL consumption (sandbox-seconds, LLM tokens, SMS segments, reports)
 * to one estimated-cents column so the subscription cost cap sums a single number.
 */
import { z } from "zod";
import type { Env } from "../env.ts";
import { currentPeriod } from "../llm/recordUsage.ts";

/** The kinds of consumption the ledger meters (mirrors the CHECK in 0011). */
export const UsageKind = z.enum([
  "sandbox_sec",
  "llm_tokens",
  "sms_segment",
  "report",
]);
export type UsageKind = z.infer<typeof UsageKind>;

/** A row of `usage_events`, parsed on read so column drift fails loudly. */
export const UsageEventRow = z.object({
  id: z.string(),
  account_id: z.string(),
  agent_id: z.string().nullable(),
  kind: z.string(),
  quantity: z.number(),
  unit: z.string(),
  cost_cents: z.number(),
  period: z.string(),
  session_id: z.string().nullable(),
  created_at: z.string(),
});
export type UsageEventRow = z.infer<typeof UsageEventRow>;

/**
 * Unit cost table - estimated PLATFORM cost in CENTS per ONE unit of `quantity`,
 * so `cost_cents = quantity * centsPerUnit`. Estimates, seeded from the PRD and
 * meant to be tuned against real invoices (they only need to be directionally
 * right for the cap to bound runaway cost). Each entry cites its source.
 */
export const UNIT_COSTS: Record<
  UsageKind,
  { unit: string; centsPerUnit: number }
> = {
  // §8.4: the per-agent container is the top cost lever (billed active-time only).
  // ~0.003¢/sec ≈ $0.0018/min of a small "basic" instance - the dominant cost,
  // so the cap + concurrency limits exist mainly to bound THIS.
  sandbox_sec: { unit: "second", centsPerUnit: 0.003 },
  // §8.5: blended LLM token cost. 0.00015¢/token = $0.0015 per 1k tokens - a
  // conservative blend across the free Qwen3 default + cheaper BYOK models.
  llm_tokens: { unit: "token", centsPerUnit: 0.00015 },
  // §9.2: the messaging add-on. ~1¢/SMS segment (Twilio outbound list price).
  sms_segment: { unit: "segment", centsPerUnit: 1.0 },
  // §8.5: a generated report (Code-Interpreter compute + chart render). ~0.5¢ each.
  report: { unit: "report", centsPerUnit: 0.5 },
};

/** Compute the normalized cents cost of `quantity` units of `kind`. */
export function costCentsFor(kind: UsageKind, quantity: number): number {
  return quantity * UNIT_COSTS[kind].centsPerUnit;
}

/** What to meter: one consumption event. `unit` defaults to the kind's natural unit. */
export interface UsageInput {
  accountId: string;
  agentId?: string | null;
  kind: UsageKind;
  quantity: number;
  unit?: string;
  sessionId?: string | null;
}

/**
 * Price `input` into `cost_cents`, stamp the current `YYYY-MM` period, and APPEND
 * a `usage_events` row (never updates - the ledger is append-only). Returns the
 * persisted row. Pure write - no cap check (that's the gate's job, post-write).
 */
export async function recordUsage(
  env: Env,
  input: UsageInput,
): Promise<UsageEventRow> {
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const period = currentPeriod();
  const unit = input.unit ?? UNIT_COSTS[input.kind].unit;
  const cost_cents = costCentsFor(input.kind, input.quantity);
  const row = await env.DB.prepare(
    `INSERT INTO usage_events
       (id, account_id, agent_id, kind, quantity, unit, cost_cents, period, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(
      id,
      input.accountId,
      input.agentId ?? null,
      input.kind,
      input.quantity,
      unit,
      cost_cents,
      period,
      input.sessionId ?? null,
      created_at,
    )
    .first();
  return UsageEventRow.parse(row);
}

/** Aggregated consumption for a period: total + per-kind breakdown (cents). */
export interface UsageSummary {
  period: string;
  totalCents: number;
  byKind: Record<string, number>;
}

/**
 * Sum an account's `usage_events` for `period` (defaults to the current window):
 * `totalCents` over all rows + a `byKind` map. Isolated by `account_id` + `period`
 * (the indexed columns), so one account's spend never leaks into another's.
 */
export async function getUsageSummary(
  env: Env,
  accountId: string,
  period: string = currentPeriod(),
): Promise<UsageSummary> {
  const { results } = await env.DB.prepare(
    `SELECT kind, SUM(cost_cents) AS cents
       FROM usage_events
      WHERE account_id = ? AND period = ?
      GROUP BY kind`,
  )
    .bind(accountId, period)
    .all<{ kind: string; cents: number | null }>();

  const byKind: Record<string, number> = {};
  let totalCents = 0;
  for (const r of results) {
    const cents = r.cents ?? 0;
    byKind[r.kind] = cents;
    totalCents += cents;
  }
  return { period, totalCents, byKind };
}
