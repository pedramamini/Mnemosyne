import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { AuditLog } from "../src/audit/index.ts";
import { type AuditEmitTarget, AuditEmitter } from "../src/audit/index.ts";
import type { AuditLevel, AuditType } from "../src/audit/types.ts";

// MNEMO-21: the AuditEmitter is the ONE typed surface the loop/tools/memory layer
// narrate through. It (a) stamps the rubric-correct `level` per event type, (b)
// binds every event to a run's `sessionId`, and (c) swallows a failed emit so an
// audit write can never break the loop. We construct it over a REAL AuditLog DO
// instance via runInDurableObject (the native RPC stub can't type `emit` - that
// seam is MNEMO-22's; the instance gives genuine `AuditEvent` types for the
// query-back assertions), then assert what landed in the store.

/** The rubric the emitter encodes (PRD §6.7), keyed by the method we call. */
const RUBRIC: Record<AuditType, AuditLevel> = {
  "session.started": "milestone",
  "session.completed": "milestone",
  "source.read": "info",
  "memory.wrote": "info",
  "memory.linked": "info",
  "memory.consolidated": "milestone",
  "tool.authored": "milestone",
  "tool.ran": "info",
  "report.generated": "milestone",
  "chart.rendered": "info",
  "onboarding.phase": "milestone",
  "assessment.completed": "milestone",
  "self.revised": "milestone",
  narration: "info",
  error: "error",
};

describe("AuditEmitter", () => {
  it("forwards each method with the rubric-correct type/level and the bound sessionId", async () => {
    const stub = env.AUDIT.get(env.AUDIT.idFromName("emitter-rubric"));
    const sessionId = "run-emitter-1";

    const events = await runInDurableObject(stub, async (audit: AuditLog) => {
      // The DO instance satisfies AuditEmitTarget directly (real types).
      const emitter = new AuditEmitter(audit, sessionId);

      // One method from each event family.
      await emitter.sessionStarted("started research on Acme");
      await emitter.sessionCompleted("done", { steps: 3 });
      await emitter.sourceRead(
        "https://techcrunch.com/acme",
        "read TechCrunch",
      );
      await emitter.memoryWrote("/brain/notes/acme.md", "wrote acme.md");
      await emitter.memoryLinked("acme", "funding", "acme → funding");
      await emitter.memoryConsolidated("merged 2 notes", { merges: 2 });
      await emitter.toolAuthored("scrape", "authored scrape");
      await emitter.toolRan("runShell", "ran ls");
      await emitter.reportGenerated("Acme Report");
      await emitter.chartRendered("funding by year (funding.png)");
      await emitter.onboardingPhase("Phase 2 of 5: Mapping the landscape");
      await emitter.assessmentCompleted("Weekly self-review: on track");
      await emitter.selfRevised("Revised its operating playbook");
      await emitter.narration("Searching recent funding news for Acme");
      await emitter.error("fetch blew up", { code: 500 });

      return audit.query({ sessionId });
    });

    // Every family landed, grouped under the bound sessionId.
    const byType = new Map(events.map((e) => [e.type, e]));
    for (const [type, level] of Object.entries(RUBRIC) as [
      AuditType,
      AuditLevel,
    ][]) {
      const event = byType.get(type);
      expect(event, `missing event ${type}`).toBeDefined();
      expect(event?.level, `wrong level for ${type}`).toBe(level);
      expect(event?.sessionId).toBe(sessionId);
    }

    // Spot-check the structured payloads the typed methods build.
    expect(byType.get("source.read")?.payload.url).toBe(
      "https://techcrunch.com/acme",
    );
    expect(byType.get("memory.wrote")?.payload.path).toBe(
      "/brain/notes/acme.md",
    );
    expect(byType.get("memory.linked")?.payload.from).toBe("acme");
    expect(byType.get("memory.linked")?.payload.to).toBe("funding");
    expect(byType.get("tool.ran")?.payload.tool).toBe("runShell");
  });

  it("swallows a thrown emit instead of propagating it into the loop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const throwingTarget: AuditEmitTarget = {
      emit() {
        calls += 1;
        throw new Error("DO unavailable");
      },
    };
    const emitter = new AuditEmitter(throwingTarget, "run-x");

    // The method must resolve (not reject) even though the underlying emit threw.
    await expect(emitter.sessionStarted("x")).resolves.toBeUndefined();
    await expect(emitter.error("y")).resolves.toBeUndefined();
    await expect(
      emitter.emit({ type: "narration", text: "z" }),
    ).resolves.toBeUndefined();

    expect(calls).toBe(3); // it really did attempt the forward each time
    expect(warn).toHaveBeenCalled(); // and warned rather than throwing
    warn.mockRestore();
  });
});
