import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AuditLog } from "../src/audit/index.ts";

// MNEMO-20: the workers-runtime counterpart of test/audit-store.test.ts. The
// AUDIT DO binding (class AuditLog) is configured in wrangler.toml and re-exported
// from the worker, so the vitest-pool-workers DO helpers can drive it. We use
// `runInDurableObject` for direct instance access: it both exercises the real
// store over `ctx.storage.sql` AND gives back the genuine `AuditEvent` types -
// the native RPC stub can't type these methods because the spike's untouched
// `AuditEvent.payload: Record<string, unknown>` is not RPC-type-serializable
// (`unknown` → `never`); that typed-stub seam is MNEMO-22's to solve. Each test
// uses a distinct idFromName so DO state doesn't collide. Assertions are kept
// parallel to the already-passing node:sqlite spike - proving the SAME AuditStore
// (append / filter / FTS5) runs unchanged on `ctx.storage.sql`.

describe("AuditLog Durable Object", () => {
  it("emit assigns monotonic seq and stamps the agentId from idFromName", async () => {
    const stub = env.AUDIT.get(env.AUDIT.idFromName("agent-test"));
    await runInDurableObject(stub, (audit: AuditLog) => {
      const a = audit.emit({
        type: "narration",
        text: "starting research on Acme",
      });
      const b = audit.emit({
        type: "source.read",
        level: "milestone",
        text: "read TechCrunch on Acme",
        payload: { url: "https://techcrunch.com/acme" },
      });

      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(a.agentId).toBe("agent-test"); // stamped from the DO's idFromName key
      expect(a.level).toBe("info"); // default
      expect(b.payload.url).toBe("https://techcrunch.com/acme");
    });
  });

  it("query filters by level (the milestone altitude) and by type", async () => {
    const stub = env.AUDIT.get(env.AUDIT.idFromName("audit-query"));
    await runInDurableObject(stub, (audit: AuditLog) => {
      audit.emit({ type: "narration", text: "thinking out loud" });
      audit.emit({
        type: "memory.wrote",
        level: "milestone",
        text: "wrote neuron acme.md",
      });
      audit.emit({
        type: "memory.linked",
        level: "milestone",
        text: "linked acme.md -> funding.md",
      });

      expect(audit.query({ level: "milestone" }).length).toBe(2);
      const writes = audit.query({ types: ["memory.wrote"] });
      expect(writes.length).toBe(1);
      expect(writes[0].type).toBe("memory.wrote");
    });
  });

  it("search does full-text retrieval over text via FTS5 (unchanged on ctx.storage.sql)", async () => {
    const stub = env.AUDIT.get(env.AUDIT.idFromName("audit-search"));
    await runInDurableObject(stub, (audit: AuditLog) => {
      audit.emit({
        type: "source.read",
        level: "milestone",
        text: "Acme raised a Series B led by Sequoia",
      });
      audit.emit({
        type: "source.read",
        level: "milestone",
        text: "Globex shipped a new product",
      });

      const hits = audit.search("series");
      expect(hits.length).toBe(1);
      expect(hits[0].text).toMatch(/Series B/);
      expect(audit.search("Sequoia").length).toBe(1);
      expect(audit.search("nonexistentterm").length).toBe(0);
    });
  });
});
