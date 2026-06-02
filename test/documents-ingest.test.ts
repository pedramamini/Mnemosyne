import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { DiscoverySpec } from "../src/agent/discovery/types.ts";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import {
  createAccount,
  createAgent,
  getDocumentById,
  listDocumentsByAgent,
} from "../src/db/index.ts";
import { ingestDocuments, type UploadFile } from "../src/documents/routes.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { type StubSandbox, stubSandboxClient } from "./stub-sandbox.ts";

// DOCS-01: the ingest pipeline end to end inside the DO + D1, with the sandbox
// MOCKED (the recording stub) and `env.AI.toMarkdown` MOCKED. We test the
// orchestrator directly (full multipart parsing is the route's job, exercised for
// the ownership case over HTTP), driving the four contract branches: live seeding,
// Build-time seeding (idempotent), ownership 404, and partial-success.

const BASE = "https://mnemosyne.test";

/** A complete Discovery spec so build() provisions a live agent. */
const VALID_SPEC: DiscoverySpec = {
  name: "Doc Watcher",
  description: "Track a vendor from uploaded docs.",
  subject: "Acme Corp",
  entityType: "vendor",
  sources: ["uploads"],
  cadence: "weekly",
  outputFormat: "brief",
  confidence: 0.95,
  facetNotes: {
    subject: "Acme.",
    entityType: "Vendor.",
    sources: "Uploads.",
    cadence: "Weekly.",
    outputFormat: "Brief.",
  },
  finalizedAt: "2026-06-02T00:00:00.000Z",
};

/** Two H1 sections → 2 chunks + 1 source-index = 3 neurons. */
const MARKDOWN = `# Section One\n\nAlpha body.\n\n# Section Two\n\nBeta body.\n`;

/** A fake `env.AI` that converts everything it's asked to into {@link MARKDOWN}. */
function fakeEnv(): Env {
  const supported = ["pdf", "docx", "png", "csv", "html", "xml"].map(
    (extension) => ({ extension, mimeType: "application/octet-stream" }),
  );
  const toMarkdown = (files?: unknown) => {
    if (files === undefined) return { supported: async () => supported };
    return Promise.resolve({
      id: "1",
      name: "x",
      mimeType: "text/markdown",
      format: "markdown" as const,
      tokens: 5,
      data: MARKDOWN,
    });
  };
  return { ...env, AI: { toMarkdown } } as unknown as Env;
}

const pdfFile = (): UploadFile => ({
  name: "report.pdf",
  bytes: new TextEncoder().encode("%PDF-1.7 fake"),
  mimeType: "application/pdf",
});
const docFile = (): UploadFile => ({
  name: "legacy.doc",
  bytes: new TextEncoder().encode("old binary"),
  mimeType: "application/msword",
});

/** Sandbox writes that landed under a document's namespaced notes dir. */
function noteWrites(sb: StubSandbox): string[] {
  return sb.writes
    .map((w) => w.path)
    .filter((p) => p.includes("/notes/sources/report/"));
}

async function freshAccountAgent(): Promise<{
  agentId: string;
  accountId: string;
}> {
  const account = await createAccount(env, {
    email: `docs-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Doc host",
  });
  return { agentId: agent.id, accountId: account.id };
}

function programGit(sb: StubSandbox): void {
  // git/ls plumbing the write pipeline shells out to (mirrors brain-routes test).
  sb.onRun("rev-parse", { stdout: "main\n" });
  sb.setDefaultRead("");
}

describe("document ingestion", () => {
  it("(a) seeds a built agent's upload immediately", async () => {
    const { agentId, accountId } = await freshAccountAgent();
    const { stub: sb, client } = stubSandboxClient();
    programGit(sb);
    await runInDurableObject(
      env.AGENT.get(env.AGENT.idFromName(agentId)),
      async (instance: MnemosyneAgent) => {
        (
          instance as unknown as { testSandboxOverride: unknown }
        ).testSandboxOverride = client;
        instance.completeDiscovery(VALID_SPEC);
        await instance.build();
      },
    );

    const testEnv = fakeEnv();
    const results = await ingestDocuments(testEnv, { agentId, accountId }, [
      pdfFile(),
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("seeded");
    expect(results[0].neuronCount).toBe(3);
    expect(results[0].sourceSlug).toBe("sources/report/index");

    // D1 row reflects the seed.
    const row = await getDocumentById(env, results[0].docId);
    expect(row?.status).toBe("seeded");
    expect(row?.neuron_count).toBe(3);
    expect(row?.source_slug).toBe("sources/report/index");
    expect(row?.convert_method).toBe("tomarkdown");

    // The original blob landed in R2.
    const blob = await env.DOCUMENTS_BUCKET.get(row?.r2_key ?? "");
    expect(blob).not.toBeNull();

    // The write pipeline received the source index + one neuron per chunk.
    const writes = noteWrites(sb);
    expect(writes).toHaveLength(3);
    expect(writes.some((p) => p.endsWith("/sources/report/index.md"))).toBe(
      true,
    );
  });

  it("(b) stores converted for a not-built agent, then Build seeds it (idempotent)", async () => {
    const { agentId, accountId } = await freshAccountAgent();
    const { stub: sb, client } = stubSandboxClient();
    programGit(sb);
    await runInDurableObject(
      env.AGENT.get(env.AGENT.idFromName(agentId)),
      (instance: MnemosyneAgent) => {
        (
          instance as unknown as { testSandboxOverride: unknown }
        ).testSandboxOverride = client;
        instance.completeDiscovery(VALID_SPEC);
      },
    );

    // Upload BEFORE build: stored as `converted`, nothing seeded.
    const testEnv = fakeEnv();
    const [res] = await ingestDocuments(testEnv, { agentId, accountId }, [
      pdfFile(),
    ]);
    expect(res.status).toBe("converted");
    expect(res.neuronCount).toBe(0);
    expect(noteWrites(sb)).toHaveLength(0);

    const converted = await getDocumentById(env, res.docId);
    expect(converted?.status).toBe("converted");
    expect(converted?.discovery_id).toBe(agentId);

    // Build seeds the attached doc and flips it to seeded (discovery_id cleared).
    await runInDurableObject(
      env.AGENT.get(env.AGENT.idFromName(agentId)),
      async (instance: MnemosyneAgent) => {
        (
          instance as unknown as { testSandboxOverride: unknown }
        ).testSandboxOverride = client;
        await instance.build();
      },
    );
    const seeded = await getDocumentById(env, res.docId);
    expect(seeded?.status).toBe("seeded");
    expect(seeded?.neuron_count).toBe(3);
    expect(seeded?.discovery_id).toBeNull();
    const writesAfterBuild = noteWrites(sb).length;
    expect(writesAfterBuild).toBe(3);

    // A second build must NOT double-seed.
    await runInDurableObject(
      env.AGENT.get(env.AGENT.idFromName(agentId)),
      async (instance: MnemosyneAgent) => {
        (
          instance as unknown as { testSandboxOverride: unknown }
        ).testSandboxOverride = client;
        await instance.build();
      },
    );
    expect(noteWrites(sb).length).toBe(writesAfterBuild);
    expect((await getDocumentById(env, res.docId))?.status).toBe("seeded");
  });

  it("(c) a request for another account's agent returns 404 and touches nothing", async () => {
    const { agentId } = await freshAccountAgent();
    const intruder = await createAccount(env, {
      email: `intruder-${crypto.randomUUID()}@example.com`,
    });
    const cookie = `${SESSION_COOKIE}=${await createSession(env, intruder.id)}`;

    // GET the victim's document list as a different account.
    const getCtx = createExecutionContext();
    const getRes = await worker.fetch(
      new Request(`${BASE}/agents/${agentId}/documents`, {
        method: "GET",
        headers: { Cookie: cookie },
      }),
      env,
      getCtx,
    );
    await waitOnExecutionContext(getCtx);
    expect(getRes.status).toBe(404);

    // POST an upload as the intruder: still 404, and the victim has no documents.
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array([1, 2, 3])], "x.pdf", {
        type: "application/pdf",
      }),
    );
    const postCtx = createExecutionContext();
    const postRes = await worker.fetch(
      new Request(`${BASE}/agents/${agentId}/documents`, {
        method: "POST",
        headers: { Cookie: cookie },
        body: form,
      }),
      env,
      postCtx,
    );
    await waitOnExecutionContext(postCtx);
    expect(postRes.status).toBe(404);
    expect(await listDocumentsByAgent(env, agentId)).toHaveLength(0);
  });

  it("(d) an unsupported file fails per-file without aborting a sibling's ingest", async () => {
    const { agentId, accountId } = await freshAccountAgent();
    const { stub: sb, client } = stubSandboxClient();
    programGit(sb);
    await runInDurableObject(
      env.AGENT.get(env.AGENT.idFromName(agentId)),
      async (instance: MnemosyneAgent) => {
        (
          instance as unknown as { testSandboxOverride: unknown }
        ).testSandboxOverride = client;
        instance.completeDiscovery(VALID_SPEC);
        await instance.build();
      },
    );

    const testEnv = fakeEnv();
    const results = await ingestDocuments(testEnv, { agentId, accountId }, [
      docFile(),
      pdfFile(),
    ]);

    expect(results).toHaveLength(2);
    // The legacy .doc is rejected at the accept-list (no row persisted).
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toContain("Unsupported");
    expect(results[0].neuronCount).toBe(0);
    // The sibling .pdf still ingested + seeded.
    expect(results[1].status).toBe("seeded");
    expect(results[1].neuronCount).toBe(3);

    // Only the supported file has a persisted row.
    const rows = await listDocumentsByAgent(env, agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe("report.pdf");
  });
});
