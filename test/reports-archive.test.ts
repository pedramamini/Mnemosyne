import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createAccount,
  createAgent,
  listReportsByAgent,
} from "../src/db/index.ts";
import {
  archiveReport,
  getReportAsset,
  getReportMarkdown,
  reportPrefix,
} from "../src/reports/archive.ts";
import type { GeneratedReport } from "../src/reports/types.ts";

// MNEMO-25: the R2 archive + D1 metadata + retrieval round-trip. The workers pool
// gives us a real (Miniflare-emulated) REPORTS_BUCKET R2 binding and DB D1 binding
// keyed by name, so this drives archiveReport against them directly (no container -
// the GeneratedReport is fabricated, asset bytes carried inline, as MNEMO-24 hands
// them over). We assert the blobs land under the per-report prefix with the right
// content types, the D1 row is inserted, and getReportMarkdown/getReportAsset
// round-trip the stored bytes.

/** Two distinct known "PNG" byte blobs (content irrelevant - identity matters). */
const PNG_ONE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const PNG_TWO = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 2, 3]);

/** Seed an account + an owned agent; return its id. */
async function ownedAgentId(): Promise<string> {
  const account = await createAccount(env, {
    email: `archive-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Archive subject",
  });
  return agent.id;
}

/** Fabricate a GeneratedReport with markdown + two PNG chart assets. */
function fakeGenerated(agentId: string): GeneratedReport {
  return {
    markdown: "---\ntitle: Acme Review\n---\n\n# Acme Review\n\nBody.\n",
    frontMatter: {
      title: "Acme Review",
      type: "report",
      agentId,
      template: "vendor",
      tags: ["security", "vendor"],
      created: "2026-05-24T12:00:00.000Z",
      source_count: 3,
    },
    brainPath: "/brain/reports/acme-review-123.md",
    assets: [
      {
        path: "/brain/reports/assets/funding-by-year.png",
        bytes: PNG_ONE,
        title: "Funding by Year",
      },
      {
        path: "/brain/reports/assets/headcount.png",
        bytes: PNG_TWO,
        title: "Headcount",
      },
    ],
  };
}

describe("archiveReport", () => {
  it("uploads report.md + PNG assets to R2 and records D1 metadata", async () => {
    const agentId = await ownedAgentId();
    const generated = fakeGenerated(agentId);

    const record = await archiveReport(env, agentId, generated);

    // D1 row: matching agent_id, title, r2_key (the prefix), JSON front_matter.
    const prefix = reportPrefix(agentId, record.id);
    expect(record.agent_id).toBe(agentId);
    expect(record.title).toBe("Acme Review");
    expect(record.r2_key).toBe(prefix);
    expect(JSON.parse(record.front_matter as string)).toEqual(
      generated.frontMatter,
    );

    // report.md exists in R2 under the prefix with text/markdown.
    const md = await env.REPORTS_BUCKET.get(`${prefix}report.md`);
    expect(md).not.toBeNull();
    expect(md?.httpMetadata?.contentType).toBe("text/markdown");
    expect(await md?.text()).toBe(generated.markdown);

    // Both PNGs exist under assets/ with image/png and the exact bytes.
    const png1 = await env.REPORTS_BUCKET.get(
      `${prefix}assets/funding-by-year.png`,
    );
    const png2 = await env.REPORTS_BUCKET.get(`${prefix}assets/headcount.png`);
    expect(png1?.httpMetadata?.contentType).toBe("image/png");
    expect(png2?.httpMetadata?.contentType).toBe("image/png");
    expect(new Uint8Array((await png1?.arrayBuffer()) as ArrayBuffer)).toEqual(
      PNG_ONE,
    );
    expect(new Uint8Array((await png2?.arrayBuffer()) as ArrayBuffer)).toEqual(
      PNG_TWO,
    );

    // listReportsByAgent surfaces the new report.
    const list = await listReportsByAgent(env, agentId);
    expect(list.map((r) => r.id)).toContain(record.id);
  });

  it("round-trips the markdown + assets through the read helpers", async () => {
    const agentId = await ownedAgentId();
    const generated = fakeGenerated(agentId);
    const record = await archiveReport(env, agentId, generated);

    const md = await getReportMarkdown(env, agentId, record.id);
    expect(md).not.toBeNull();
    expect(await md?.text()).toBe(generated.markdown);

    const asset = await getReportAsset(
      env,
      agentId,
      record.id,
      "funding-by-year.png",
    );
    expect(asset).not.toBeNull();
    expect(new Uint8Array((await asset?.arrayBuffer()) as ArrayBuffer)).toEqual(
      PNG_ONE,
    );
  });

  it("returns null for a report owned by a different agent (no leak)", async () => {
    const ownerId = await ownedAgentId();
    const intruderId = await ownedAgentId();
    const record = await archiveReport(env, ownerId, fakeGenerated(ownerId));

    // The intruder's agent id resolves the same report id to null.
    expect(await getReportMarkdown(env, intruderId, record.id)).toBeNull();
    expect(
      await getReportAsset(env, intruderId, record.id, "funding-by-year.png"),
    ).toBeNull();
  });

  it("rejects an unsafe asset name from the read side", async () => {
    const agentId = await ownedAgentId();
    const record = await archiveReport(env, agentId, fakeGenerated(agentId));

    expect(
      await getReportAsset(env, agentId, record.id, "../report.md"),
    ).toBeNull();
    expect(
      await getReportAsset(env, agentId, record.id, "x/../../y"),
    ).toBeNull();
  });
});
