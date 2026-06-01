import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuditEmitTarget, AuditEmitter } from "../src/audit/index.ts";
import type { AuditInput } from "../src/audit/types.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import {
  notifyReportReady,
  type ReadyReport,
} from "../src/email/report-notify.ts";
import { archiveReport } from "../src/reports/archive.ts";
import type { FindingsDelta } from "../src/reports/delta.ts";
import { generateDeltaReport } from "../src/reports/delta-report.ts";
import type { Fact, Findings } from "../src/reports/findings.ts";
import type { GeneratedReport } from "../src/reports/types.ts";

// MNEMO-28: notifyReportReady glue. The workers pool gives real D1 + REPORTS_BUCKET
// bindings; the Resend POST is stubbed at globalThis.fetch so no real email is sent
// (mirroring test/auth.test.ts's sendMagicLink stub). We seed an account + agent +
// an archived report, then assert: (1) one Resend POST with the owner email as `to`,
// the agent name + delta headline in the subject, the deep link in the body, and an
// inline `cid:` PNG attachment; (2) a non-2xx response does not throw and emits an
// `error` audit event; (3) the MNEMO-26 skip path produces ZERO Resend calls.

/** A known "PNG" byte blob (content irrelevant - identity matters). */
const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7]);

afterEach(() => {
  vi.restoreAllMocks();
});

/** A spy AuditEmitter capturing every emitted event. */
function spyEmitter(): { emitter: AuditEmitter; events: AuditInput[] } {
  const events: AuditInput[] = [];
  const target: AuditEmitTarget = {
    emit: (input) => {
      events.push(input);
    },
  };
  return { emitter: AuditEmitter.withSession(target, null), events };
}

/** Seed an account (known email) + an owned agent (known name); return both ids. */
async function seedOwnedAgent(): Promise<{
  agentId: string;
  email: string;
  agentName: string;
}> {
  const email = `owner-${crypto.randomUUID()}@example.com`;
  const account = await createAccount(env, { email });
  const agentName = "Acme Watcher";
  const agent = await createAgent(env, {
    account_id: account.id,
    name: agentName,
  });
  return { agentId: agent.id, email, agentName };
}

/** Fabricate a GeneratedReport with markdown + one PNG hero chart asset. */
function fakeGenerated(agentId: string): GeneratedReport {
  return {
    markdown: "---\ntitle: Acme Review\n---\n\n# Acme Review\n\nBody.\n",
    frontMatter: {
      title: "Acme Review",
      type: "report",
      agentId,
      template: "vendor",
      tags: ["vendor"],
      created: "2026-05-24T12:00:00.000Z",
      source_count: 1,
    },
    brainPath: "/brain/reports/acme-review-123.md",
    assets: [
      {
        path: "/brain/reports/assets/funding-by-year.png",
        bytes: PNG_BYTES,
        title: "Funding by Year",
      },
    ],
  };
}

/** A delta with one added fact (yields a non-baseline headline via summarizeDelta). */
function oneAddedDelta(): FindingsDelta {
  return {
    added: [{ key: "funding.last_round", label: "Last round", value: "$10M" }],
    removed: [],
    changed: [],
    unchangedCount: 0,
  };
}

/** Build the archived ReadyReport for an agent (archive to R2/D1, then assemble). */
async function readyReport(
  agentId: string,
  delta?: FindingsDelta,
): Promise<ReadyReport> {
  const generated = fakeGenerated(agentId);
  const record = await archiveReport(env, agentId, generated);
  return { ...generated, record, delta };
}

describe("notifyReportReady", () => {
  it("emails the owner with the subject, deep link, and an inline PNG attachment", async () => {
    const { agentId, email, agentName } = await seedOwnedAgent();
    const delta = oneAddedDelta();
    const report = await readyReport(agentId, delta);
    const { emitter, events } = spyEmitter();

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "re_1" })));

    await notifyReportReady(env, agentId, report, { emitter });

    // Exactly one Resend POST to the emails endpoint.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.resend.com/emails");

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      to: string[];
      subject: string;
      html: string;
      attachments?: Array<{
        filename: string;
        content: string;
        content_id: string;
        content_type: string;
      }>;
    };

    // `to` is the owner's account email.
    expect(body.to).toEqual([email]);

    // Subject carries the agent name + the delta headline.
    const headline = "1 new fact, 0 changed, 0 removed since last report";
    expect(body.subject).toContain(agentName);
    expect(body.subject).toContain(headline);

    // Body links to the full web report at the MNEMO-25 route.
    const reportUrl = `${env.APP_BASE_URL}/agents/${agentId}/reports/${report.record.id}`;
    expect(body.html).toContain(reportUrl);

    // The hero PNG rides as an inline (cid:) attachment with the exact bytes.
    expect(body.attachments).toHaveLength(1);
    const attachment = body.attachments?.[0];
    expect(attachment?.filename).toBe("funding-by-year.png");
    expect(attachment?.content_type).toBe("image/png");
    expect(attachment?.content).toBe(btoa(String.fromCharCode(...PNG_BYTES)));
    // The body references the attachment inline by its content_id.
    expect(body.html).toContain(`cid:${attachment?.content_id}`);

    // Success emits a milestone narration (the calm cockpit stream).
    const ok = events.find((e) => e.text === "Emailed report to owner");
    expect(ok).toBeDefined();
    expect(ok?.level).toBe("milestone");
  });

  it("falls back to the 'New report' headline when there is no delta", async () => {
    const { agentId } = await seedOwnedAgent();
    const report = await readyReport(agentId); // no delta → baseline
    const { emitter } = spyEmitter();

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "re_1" })));

    await notifyReportReady(env, agentId, report, { emitter });

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    ) as { subject: string };
    expect(body.subject).toContain("New report");
  });

  it("does not throw on a non-2xx Resend response and emits an error audit event", async () => {
    const { agentId } = await seedOwnedAgent();
    const report = await readyReport(agentId, oneAddedDelta());
    const { emitter, events } = spyEmitter();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad", { status: 422 }),
    );

    // Best-effort: resolves (never rejects) even though the send failed.
    await expect(
      notifyReportReady(env, agentId, report, { emitter }),
    ).resolves.toBeUndefined();

    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err?.level).toBe("error");
    expect(err?.text).toBe("Failed to email report to owner");
    expect(String((err?.payload as { error?: string }).error)).toContain("422");
  });

  it("emits an error (no send) when the owner cannot be resolved", async () => {
    // A resolver that returns null (e.g. a deleted account) → no send, audited.
    const { agentId } = await seedOwnedAgent();
    const report = await readyReport(agentId);
    const { emitter, events } = spyEmitter();

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      notifyReportReady(env, agentId, report, {
        emitter,
        resolveOwner: async () => null,
      }),
    ).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

describe("delta skip path → no notification", () => {
  it("sends ZERO Resend emails when nothing material changed (skipWhenUnchanged)", async () => {
    const agentId = crypto.randomUUID();
    const { emitter } = spyEmitter();

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const fact = (key: string, value: string): Fact => ({
      key,
      label: key,
      value,
    });
    const same: Findings = { facts: [fact("a", "1"), fact("b", "2")] };

    // Identical prior + current ⇒ empty delta ⇒ skip (returns before the generator,
    // so MNEMO-28's notify never fires - the post-archive path is never reached).
    const result = await generateDeltaReport(
      env,
      agentId,
      {},
      { skipWhenUnchanged: true },
      {
        loadPriorFindings: async () => same,
        computeCurrentFindings: async () => same,
        emitter,
      },
    );

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
