import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  archiveHtmlArtifact,
  artifactPrefix,
  getHtmlArtifact,
} from "../src/artifacts/store.ts";
import {
  createAccount,
  createAgent,
  listArtifactsByAgent,
} from "../src/db/index.ts";

// HTML artifact archive (renderHtml tool): the R2 blob + D1 metadata + retrieval
// round-trip. The workers pool gives a real (Miniflare-emulated) REPORTS_BUCKET +
// DB binding, so this drives archiveHtmlArtifact against them directly. Mirrors
// reports-archive.test.ts - the artifact store reuses REPORTS_BUCKET under a
// distinct `agents/<id>/artifacts/<id>/` prefix.

const HTML = "<!doctype html><html><body><h1>Hello</h1></body></html>";

/** Seed an account + an owned agent; return its id. */
async function ownedAgentId(): Promise<string> {
  const account = await createAccount(env, {
    email: `artifact-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Artifact subject",
  });
  return agent.id;
}

describe("archiveHtmlArtifact", () => {
  it("uploads index.html to R2 and records D1 metadata", async () => {
    const agentId = await ownedAgentId();
    const record = await archiveHtmlArtifact(env, {
      agentId,
      conversationId: "conv-1",
      title: "Acme Dashboard",
      html: HTML,
    });

    const prefix = artifactPrefix(agentId, record.id);
    expect(record.agent_id).toBe(agentId);
    expect(record.conversation_id).toBe("conv-1");
    expect(record.title).toBe("Acme Dashboard");
    expect(record.r2_key).toBe(prefix);
    expect(record.content_type).toBe("text/html; charset=utf-8");
    expect(record.byte_size).toBe(new TextEncoder().encode(HTML).length);

    // index.html exists under the prefix with text/html.
    const obj = await env.REPORTS_BUCKET.get(`${prefix}index.html`);
    expect(obj).not.toBeNull();
    expect(obj?.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
    expect(await obj?.text()).toBe(HTML);

    // listArtifactsByAgent surfaces the new artifact.
    const list = await listArtifactsByAgent(env, agentId);
    expect(list.map((a) => a.id)).toContain(record.id);
  });

  it("round-trips the HTML through the ownership-checked read helper", async () => {
    const agentId = await ownedAgentId();
    const record = await archiveHtmlArtifact(env, {
      agentId,
      title: "No conversation",
      html: HTML,
    });
    // conversation_id is nullable (produced outside a thread).
    expect(record.conversation_id).toBeNull();

    const obj = await getHtmlArtifact(env, agentId, record.id);
    expect(obj).not.toBeNull();
    expect(await obj?.text()).toBe(HTML);
  });

  it("returns null for an artifact owned by a different agent (no leak)", async () => {
    const ownerId = await ownedAgentId();
    const intruderId = await ownedAgentId();
    const record = await archiveHtmlArtifact(env, {
      agentId: ownerId,
      title: "Owner only",
      html: HTML,
    });

    expect(await getHtmlArtifact(env, intruderId, record.id)).toBeNull();
  });

  it("returns null for a missing artifact id", async () => {
    const agentId = await ownedAgentId();
    expect(await getHtmlArtifact(env, agentId, crypto.randomUUID())).toBeNull();
  });
});
