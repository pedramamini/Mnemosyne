import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TriageGateInput } from "../src/messaging/triage.ts";
import { triageGate } from "../src/messaging/triage.ts";
import { capturingGenerateModel, generateModel } from "./mock-model.ts";

// MNEMO-48: the cheap per-agent triage gate (PRD §9.4 triage gate). Runs in the
// workers pool so `env` is real, but the cheap model is STUBBED via `deps.model`
// (a `MockLanguageModelV3`) - no inference. The gate is deliberately NOT the full
// agent loop: ONE model call, no tools. Silence is the safe default on any parse
// failure ("no pile-on, only signal").

const BASE: TriageGateInput = {
  agentId: "agent-1",
  role: "vendor research agent",
  transcriptTail: [],
  message: "Any news on Acme's funding round?",
};

describe("triageGate (PRD §9.4 triage gate)", () => {
  it("parses a valid bid JSON into a TriageBid", async () => {
    const json = JSON.stringify({
      wantsToRespond: true,
      confidence: 0.8,
      reason: "Acme is my beat",
    });
    const bid = await triageGate(env, BASE, {
      model: generateModel(json).model,
    });
    expect(bid).toEqual({
      agentId: "agent-1",
      wantsToRespond: true,
      confidence: 0.8,
      reason: "Acme is my beat",
    });
  });

  it("extracts the JSON object even when the model wraps it in prose", async () => {
    const text =
      'Sure thing: {"wantsToRespond": false, "confidence": 0.2, "reason": "not my area"} - hope that helps';
    const bid = await triageGate(env, BASE, {
      model: generateModel(text).model,
    });
    expect(bid.wantsToRespond).toBe(false);
    expect(bid.confidence).toBe(0.2);
  });

  it("defaults to silence (wantsToRespond:false) on non-JSON output", async () => {
    const bid = await triageGate(env, BASE, {
      model: generateModel("Hmm, I'm not really sure - maybe?").model,
    });
    expect(bid).toMatchObject({
      agentId: "agent-1",
      wantsToRespond: false,
      confidence: 0,
    });
  });

  it("defaults to silence on malformed / wrong-typed JSON", async () => {
    const bad = JSON.stringify({ wantsToRespond: "yes", confidence: "high" });
    const bid = await triageGate(env, BASE, {
      model: generateModel(bad).model,
    });
    expect(bid.wantsToRespond).toBe(false);
  });

  it("always stamps the caller's agentId, never the model's", async () => {
    const json = JSON.stringify({
      agentId: "IMPOSTER",
      wantsToRespond: true,
      confidence: 0.5,
      reason: "x",
    });
    const bid = await triageGate(env, BASE, {
      model: generateModel(json).model,
    });
    expect(bid.agentId).toBe("agent-1");
  });

  it("makes exactly ONE model call - it is the cheap gate, not the agent loop", async () => {
    const cm = capturingGenerateModel(
      JSON.stringify({ wantsToRespond: true, confidence: 0.6, reason: "ok" }),
    );
    await triageGate(env, BASE, { model: cm.model.model });
    expect(cm.calls).toHaveLength(1);
  });
});
