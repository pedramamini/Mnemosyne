/**
 * Schedule state schemas + pure cron helpers (MNEMO-27, PRD §6.4/§7.4/§8.5).
 *
 * Two scheduling layers share these helpers (see src/schedule/fanout.ts and
 * MnemosyneAgent.scheduleNextRun): the DO's per-agent `this.schedule` timer and
 * the Worker `scheduled` cron fan-out. Both need to answer "when does this cron
 * next fire?" and "is this agent due now?" - so the cron math lives here as
 * PURE, timer-free functions, unit-testable without a DO or a real clock.
 *
 * Cron implementation choice: a MINIMAL INTERNAL evaluator, NOT a dependency.
 * The project is deliberately dependency-light (see src/reports/front-matter.ts,
 * which hand-rolls a YAML emitter rather than add a lib), and the fan-out runs in
 * the Worker where it cannot lean on the `agents` SDK's own cron support. A small
 * owned evaluator keeps ONE cron semantics across both layers and stays testable.
 * Scope: standard 5-field cron (`minute hour day-of-month month day-of-week`),
 * NUMERIC fields only, evaluated in UTC. Supports `*`, `a`, `a,b`, `a-b`, `*​/n`,
 * `a-b/n`, `a/n`; day-of-week 0 and 7 both mean Sunday. The Vixie OR rule applies:
 * when BOTH day-of-month and day-of-week are restricted, a day matches if EITHER
 * does. Named months/weekdays and seconds/year fields are intentionally not
 * supported (none of the product's cadences need them).
 */
import { z } from "zod";
// Aligns with MNEMO-04's per-agent run schedule (cron + enabled). Re-exported so
// callers reading schedule state import it from the schedule module surface.
import { AgentSchedule } from "../agent/types.ts";

export { AgentSchedule };

/** What a scheduled run does - a headless research/delta report or a brain
 * consolidation ("sleep") pass. The actual work hooks in via MNEMO-15/26. */
export const ScheduledRunKind = z.enum(["report", "consolidation"]);
export type ScheduledRunKind = z.infer<typeof ScheduledRunKind>;

/**
 * A single scheduled-run record. `scheduledFor`/`lastRunAt` are epoch ms.
 * Used as the DO callback payload (a fan-out / `this.schedule` enqueues it) and
 * as the shape the DO records when a run completes.
 */
export const ScheduledRun = z.object({
  agentId: z.string(),
  kind: ScheduledRunKind,
  /** Epoch ms this run was scheduled to fire. */
  scheduledFor: z.number().int(),
  /** Epoch ms of the previous completed run, if any. */
  lastRunAt: z.number().int().optional(),
});
export type ScheduledRun = z.infer<typeof ScheduledRun>;

/**
 * The payload carried on the DO's `this.schedule(delay, "runScheduled", payload)`
 * alarm and the dev force-run route - a subset of {@link ScheduledRun} (the DO
 * already knows its own `agentId`). `kind` defaults to `"report"`.
 */
export const ScheduledRunPayload = z.object({
  kind: ScheduledRunKind.default("report"),
  /** Epoch ms the heartbeat/timer intended this to fire (audit correlation). */
  scheduledFor: z.number().int().optional(),
});
export type ScheduledRunPayload = z.infer<typeof ScheduledRunPayload>;

/**
 * The UTC nighttime band the nightly "dream" (memory consolidation) fires in -
 * a WINDOW, not a fixed minute, so per-agent randomization within it spreads the
 * load and avoids a thundering herd of sandbox boots at one instant. 06:00–10:00
 * UTC ≈ midnight–4am US-Central. Per-user-timezone awareness is a later refinement.
 */
export const DREAM_WINDOW_START_HOUR_UTC = 6;
export const DREAM_WINDOW_HOURS = 4;

/**
 * Seconds from `now` until the next nightly dream, at a RANDOM time inside the UTC
 * night window - today's slot if it's still ahead, else tomorrow's. The caller
 * passes `rand` ∈ [0,1) (`Math.random()` in production, a fixed value in tests),
 * so each arming jitters independently. Pure + clock-injected ⇒ unit-testable.
 */
export function nextDreamDelaySec(now: number, rand: number): number {
  const d = new Date(now);
  const windowStart = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    DREAM_WINDOW_START_HOUR_UTC,
  );
  const jitterMs = Math.floor(rand * DREAM_WINDOW_HOURS * 3_600_000);
  const slot = windowStart + jitterMs;
  const next = slot > now ? slot : slot + 24 * 3_600_000;
  return Math.max(1, Math.ceil((next - now) / 1000));
}

// ─── Cron evaluator (pure) ────────────────────────────────────────────────────

/** One parsed cron field: the allowed values + whether it was a literal `*`
 * (needed for the day-of-month / day-of-week OR rule). */
interface CronField {
  /** True only when the field was exactly `*` (a step like `*​/n` is restricted). */
  wild: boolean;
  values: Set<number>;
}

/** Inclusive bounds for each of the five cron fields, in field order. */
const FIELD_BOUNDS: ReadonlyArray<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0/7 = Sunday)
];

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

/** Parse one comma-list field (e.g. `1-5,30`, `*​/15`) into its allowed set. */
function parseField(spec: string, min: number, max: number): CronField {
  const wild = spec === "*";
  const values = new Set<number>();

  for (const part of spec.split(",")) {
    if (part === "") throw new Error(`empty cron field segment in "${spec}"`);

    const [rangePart, stepPart] = part.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`invalid cron step "/${stepPart}"`);
      }
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      // `a/n` means "from a to the field max, stepping by n".
      hi = stepPart !== undefined ? max : lo;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`invalid cron value "${part}"`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron value "${part}" out of range [${min}, ${max}]`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  return { wild, values };
}

/** Parse a 5-field cron expression (throws on a malformed expression). */
function parseCron(cron: string): ParsedCron {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `expected a 5-field cron expression, got ${fields.length}: "${cron}"`,
    );
  }
  const [minute, hour, dom, month, dowRaw] = fields.map((f, i) =>
    parseField(f, FIELD_BOUNDS[i].min, FIELD_BOUNDS[i].max),
  );
  // Normalize day-of-week 7 → 0 (both are Sunday) so matching is uniform.
  if (dowRaw.values.has(7)) {
    dowRaw.values.delete(7);
    dowRaw.values.add(0);
  }
  return { minute, hour, dom, month, dow: dowRaw };
}

/** Vixie OR rule for the day match (see the module comment). */
function dayMatches(date: Date, dom: CronField, dow: CronField): boolean {
  const domMatch = dom.values.has(date.getUTCDate());
  const dowMatch = dow.values.has(date.getUTCDay());
  if (!dom.wild && !dow.wild) return domMatch || dowMatch;
  if (!dom.wild) return domMatch;
  if (!dow.wild) return dowMatch;
  return true; // both wildcard
}

/** Hard cap on the field-advance loop - a safety net against a cron that can
 * never fire (the algorithm converges in far fewer steps for any real cron). */
const MAX_ADVANCE_STEPS = 500_000;

/**
 * The next epoch-ms strictly AFTER `fromTs` at which `cron` fires, in UTC.
 * Advances by the coarsest non-matching field (month → day → hour → minute) so
 * it converges quickly even for sparse crons. Throws on a malformed expression
 * or a cron that cannot fire within the search bound.
 */
export function nextRunAfter(cron: string, fromTs: number): number {
  const c = parseCron(cron);

  // Start at the next whole minute strictly after fromTs (seconds zeroed).
  let t = new Date(fromTs - (fromTs % 60_000) + 60_000);

  for (let i = 0; i < MAX_ADVANCE_STEPS; i++) {
    if (!c.month.values.has(t.getUTCMonth() + 1)) {
      // Jump to 00:00 on the first day of the next month.
      t = new Date(
        Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1, 0, 0, 0, 0),
      );
      continue;
    }
    if (!dayMatches(t, c.dom, c.dow)) {
      const next = new Date(t);
      next.setUTCDate(t.getUTCDate() + 1);
      next.setUTCHours(0, 0, 0, 0);
      t = next;
      continue;
    }
    if (!c.hour.values.has(t.getUTCHours())) {
      const next = new Date(t);
      next.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      t = next;
      continue;
    }
    if (!c.minute.values.has(t.getUTCMinutes())) {
      const next = new Date(t);
      next.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      t = next;
      continue;
    }
    return t.getTime();
  }

  throw new Error(`cron "${cron}" did not fire within the search window`);
}

/**
 * Is `schedule` due to run at `nowTs`, given the previous run at `lastRunAt`?
 * True only when the schedule is enabled with a valid cron AND the cron's next
 * fire after the last run has already arrived (`nowTs >= nextRunAfter(lastRunAt)`).
 * A never-run agent uses epoch 0 as the baseline, so its first eligible heartbeat
 * fires it. A disabled schedule, a null cron, or a malformed cron is never due
 * (a bad expression must not crash the heartbeat - it degrades to "not due").
 */
export function isDue(
  schedule: AgentSchedule,
  nowTs: number,
  lastRunAt: number | null | undefined,
): boolean {
  if (!schedule.enabled || !schedule.cron) return false;
  try {
    return nowTs >= nextRunAfter(schedule.cron, lastRunAt ?? 0);
  } catch {
    return false;
  }
}
