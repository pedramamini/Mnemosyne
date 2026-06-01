import { describe, expect, it } from "vitest";
import type { AgentSchedule } from "../src/schedule/types.ts";
import {
  DREAM_WINDOW_HOURS,
  DREAM_WINDOW_START_HOUR_UTC,
  isDue,
  nextDreamDelaySec,
  nextRunAfter,
} from "../src/schedule/types.ts";

// MNEMO-27: the cron helpers are PURE (no DO, no timers), so this exercises them
// directly against a fixed `fromTs` in UTC. 2026-05-24 10:30:00 UTC is a Sunday.
const FROM = Date.UTC(2026, 4, 24, 10, 30, 0);

describe("nextRunAfter", () => {
  it("computes the next top-of-hour for an hourly cron", () => {
    expect(nextRunAfter("0 * * * *", FROM)).toBe(
      Date.UTC(2026, 4, 24, 11, 0, 0),
    );
  });

  it("rolls to the next day for a daily cron already past today's time", () => {
    // 10:30 is past 09:00, so the next 09:00 is tomorrow.
    expect(nextRunAfter("0 9 * * *", FROM)).toBe(
      Date.UTC(2026, 4, 25, 9, 0, 0),
    );
  });

  it("finds the next matching weekday for a weekly cron", () => {
    // Sunday 10:30 → next Monday 09:00.
    const next = nextRunAfter("0 9 * * 1", FROM);
    expect(next).toBe(Date.UTC(2026, 4, 25, 9, 0, 0));
    expect(new Date(next).getUTCDay()).toBe(1);
  });

  it("honors step fields (every 15 minutes)", () => {
    expect(nextRunAfter("*/15 * * * *", FROM)).toBe(
      Date.UTC(2026, 4, 24, 10, 45, 0),
    );
  });

  it("is strictly after fromTs even on a minute boundary", () => {
    const onBoundary = Date.UTC(2026, 4, 24, 11, 0, 0);
    expect(nextRunAfter("0 * * * *", onBoundary)).toBe(
      Date.UTC(2026, 4, 24, 12, 0, 0),
    );
  });

  it("converges on a sparse cron (Feb 29, leap years only)", () => {
    expect(nextRunAfter("0 0 29 2 *", FROM)).toBe(
      Date.UTC(2028, 1, 29, 0, 0, 0),
    );
  });

  it("throws on a malformed expression", () => {
    expect(() => nextRunAfter("nonsense", FROM)).toThrow();
    expect(() => nextRunAfter("0 9 * *", FROM)).toThrow(); // 4 fields
    expect(() => nextRunAfter("0 99 * * *", FROM)).toThrow(); // out of range
  });
});

describe("isDue", () => {
  const hourly: AgentSchedule = { cron: "0 * * * *", enabled: true };

  it("is due once now has reached the next fire after the last run", () => {
    const lastRun = Date.UTC(2026, 4, 24, 10, 0, 0); // 10:00
    // next after 10:00 is 11:00; now is 11:05 → due.
    expect(isDue(hourly, Date.UTC(2026, 4, 24, 11, 5, 0), lastRun)).toBe(true);
  });

  it("is NOT due before the next fire arrives", () => {
    const lastRun = Date.UTC(2026, 4, 24, 10, 0, 0); // 10:00
    // next after 10:00 is 11:00; now is 10:30 → not yet.
    expect(isDue(hourly, FROM, lastRun)).toBe(false);
  });

  it("treats a never-run agent (null lastRunAt) as due when enabled", () => {
    expect(isDue(hourly, FROM, null)).toBe(true);
    expect(isDue(hourly, FROM, undefined)).toBe(true);
  });

  it("is never due when disabled", () => {
    const disabled: AgentSchedule = { cron: "0 * * * *", enabled: false };
    expect(isDue(disabled, Date.UTC(2026, 4, 24, 11, 5, 0), 0)).toBe(false);
  });

  it("is never due with a null cron", () => {
    const noCron: AgentSchedule = { cron: null, enabled: true };
    expect(isDue(noCron, Date.UTC(2026, 4, 24, 11, 5, 0), 0)).toBe(false);
  });

  it("degrades a malformed cron to 'not due' rather than throwing", () => {
    const bad: AgentSchedule = { cron: "nonsense", enabled: true };
    expect(isDue(bad, Date.UTC(2030, 0, 1, 0, 0, 0), 0)).toBe(false);
  });
});

describe("nextDreamDelaySec - randomized nightly dream time", () => {
  const WIN_START = DREAM_WINDOW_START_HOUR_UTC; // 6
  const WIN_END = DREAM_WINDOW_START_HOUR_UTC + DREAM_WINDOW_HOURS; // 10

  it("schedules into TODAY's window when it's still ahead (rand=0 ⇒ window start)", () => {
    const now = Date.UTC(2026, 4, 24, 3, 0, 0); // 03:00 UTC, before the window
    const delay = nextDreamDelaySec(now, 0);
    const fire = new Date(now + delay * 1000);
    expect(fire.getUTCHours()).toBe(WIN_START);
    expect(fire.getUTCDate()).toBe(24); // same day
    expect(delay).toBe(3 * 3600); // 03:00 → 06:00
  });

  it("rolls to TOMORROW's window when today's slot is already past", () => {
    const now = Date.UTC(2026, 4, 24, 10, 30, 0); // 10:30 UTC, after the window
    const fire = new Date(now + nextDreamDelaySec(now, 0) * 1000);
    expect(fire.getUTCDate()).toBe(25); // next day
    expect(fire.getUTCHours()).toBe(WIN_START);
  });

  it("keeps every random pick inside the night window [start, end)", () => {
    const now = Date.UTC(2026, 4, 24, 1, 0, 0);
    for (const rand of [0, 0.25, 0.5, 0.75, 0.999]) {
      const fire = new Date(now + nextDreamDelaySec(now, rand) * 1000);
      expect(fire.getUTCHours()).toBeGreaterThanOrEqual(WIN_START);
      expect(fire.getUTCHours()).toBeLessThan(WIN_END);
    }
  });

  it("is deterministic for a fixed (now, rand) and always ≥ 1s", () => {
    const now = Date.UTC(2026, 4, 24, 12, 0, 0);
    expect(nextDreamDelaySec(now, 0.42)).toBe(nextDreamDelaySec(now, 0.42));
    expect(nextDreamDelaySec(now, 0.42)).toBeGreaterThanOrEqual(1);
  });
});
