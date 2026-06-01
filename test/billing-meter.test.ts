import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  getUsageSummary,
  recordUsage,
  UNIT_COSTS,
} from "../src/billing/meter.ts";
import { createAccount } from "../src/db/index.ts";
import { currentPeriod } from "../src/llm/recordUsage.ts";

// MNEMO-49: the append-only usage_events ledger (D1). recordUsage prices an event
// into cost_cents from UNIT_COSTS + stamps the YYYY-MM period; getUsageSummary
// rolls a period up into a total + per-kind breakdown, isolated by account+period.

async function seedAccount(): Promise<string> {
  const account = await createAccount(env, {
    email: `meter-${crypto.randomUUID()}@example.com`,
  });
  return account.id;
}

describe("recordUsage", () => {
  it("prices each kind from UNIT_COSTS and stamps the YYYY-MM period", async () => {
    const accountId = await seedAccount();

    const sandbox = await recordUsage(env, {
      accountId,
      kind: "sandbox_sec",
      quantity: 100,
    });
    expect(sandbox.cost_cents).toBeCloseTo(
      100 * UNIT_COSTS.sandbox_sec.centsPerUnit,
    );
    expect(sandbox.unit).toBe(UNIT_COSTS.sandbox_sec.unit);
    expect(sandbox.period).toMatch(/^\d{4}-\d{2}$/);
    expect(sandbox.period).toBe(currentPeriod());

    const tokens = await recordUsage(env, {
      accountId,
      kind: "llm_tokens",
      quantity: 2000,
    });
    expect(tokens.cost_cents).toBeCloseTo(
      2000 * UNIT_COSTS.llm_tokens.centsPerUnit,
    );

    const sms = await recordUsage(env, {
      accountId,
      kind: "sms_segment",
      quantity: 3,
    });
    expect(sms.cost_cents).toBeCloseTo(3 * UNIT_COSTS.sms_segment.centsPerUnit);

    const report = await recordUsage(env, {
      accountId,
      kind: "report",
      quantity: 1,
    });
    expect(report.cost_cents).toBeCloseTo(1 * UNIT_COSTS.report.centsPerUnit);
  });
});

describe("getUsageSummary", () => {
  it("aggregates totalCents + byKind and isolates by account + period", async () => {
    const a = await seedAccount();
    const b = await seedAccount();

    await recordUsage(env, {
      accountId: a,
      kind: "sandbox_sec",
      quantity: 100,
    });
    await recordUsage(env, {
      accountId: a,
      kind: "llm_tokens",
      quantity: 1000,
    });
    await recordUsage(env, { accountId: a, kind: "report", quantity: 2 });
    // Another account's spend must NOT leak into a's summary.
    await recordUsage(env, {
      accountId: b,
      kind: "sandbox_sec",
      quantity: 999,
    });

    const expectSandbox = 100 * UNIT_COSTS.sandbox_sec.centsPerUnit;
    const expectTokens = 1000 * UNIT_COSTS.llm_tokens.centsPerUnit;
    const expectReport = 2 * UNIT_COSTS.report.centsPerUnit;

    const summary = await getUsageSummary(env, a);
    expect(summary.byKind.sandbox_sec).toBeCloseTo(expectSandbox);
    expect(summary.byKind.llm_tokens).toBeCloseTo(expectTokens);
    expect(summary.byKind.report).toBeCloseTo(expectReport);
    expect(summary.totalCents).toBeCloseTo(
      expectSandbox + expectTokens + expectReport,
    );

    // Period isolation: a different window sees none of these rows.
    const old = await getUsageSummary(env, a, "1999-01");
    expect(old.totalCents).toBe(0);
    expect(old.byKind).toEqual({});
  });
});
