import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_TURNS_PER_HUMAN_TURN,
  POST_SPEAK_COOLDOWN_MS,
} from "../src/messaging/groupTypes.ts";
import { gateAgentTurn, isFromAgent } from "../src/messaging/loopPrevention.ts";

// MNEMO-48: agent↔agent loop prevention (PRD §9.4 - "prevents agent↔agent
// runaway"). Pure functions, no DO. Agents triage aggressively on HUMAN messages
// but do NOT reply to other agents unless @-mentioned; a hard turn cap (resets on a
// human message) and a post-speak cooldown bound any chain.

const NOW = 1_000_000;

describe("isFromAgent", () => {
  const memberNumbers = ["+15551110000", "+15551110001", "+15551110002"];
  const agentNumbers = ["+15551110001"]; // one member is an agent

  it("is true for an agent's own number, false for a human member", () => {
    expect(isFromAgent("+15551110001", memberNumbers, agentNumbers)).toBe(true);
    expect(isFromAgent("+15551110000", memberNumbers, agentNumbers)).toBe(
      false,
    );
  });

  it("is false for a number outside the roster", () => {
    expect(isFromAgent("+19999999999", memberNumbers, agentNumbers)).toBe(
      false,
    );
  });
});

describe("gateAgentTurn (PRD §9.4)", () => {
  it("blocks an agent-sender turn that is not @-mentioned", () => {
    const gate = gateAgentTurn(
      { agentTurnsSinceHuman: 0, lastSpokeTs: null, now: NOW },
      { senderIsAgent: true, isMentioned: false },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("agent sender; not mentioned");
  });

  it("allows an agent-sender turn when @-mentioned (override)", () => {
    const gate = gateAgentTurn(
      { agentTurnsSinceHuman: 0, lastSpokeTs: null, now: NOW },
      { senderIsAgent: true, isMentioned: true },
    );
    expect(gate.allowed).toBe(true);
  });

  it("enforces the hard turn cap - blocks past the cap EVEN IF mentioned", () => {
    const gate = gateAgentTurn(
      {
        agentTurnsSinceHuman: MAX_AGENT_TURNS_PER_HUMAN_TURN,
        lastSpokeTs: null,
        now: NOW,
      },
      { senderIsAgent: true, isMentioned: true },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("agent-turn cap reached");
  });

  it("allows a turn on a HUMAN message with a fresh (reset) counter", () => {
    // The coordinator resets agentTurnsSinceHuman to 0 on a human message; with no
    // recent utterance, the agent triages aggressively (allowed).
    const gate = gateAgentTurn(
      { agentTurnsSinceHuman: 0, lastSpokeTs: null, now: NOW },
      { senderIsAgent: false, isMentioned: false },
    );
    expect(gate.allowed).toBe(true);
  });

  it("blocks within POST_SPEAK_COOLDOWN_MS of the agent's last utterance", () => {
    const blocked = gateAgentTurn(
      {
        agentTurnsSinceHuman: 0,
        lastSpokeTs: NOW - (POST_SPEAK_COOLDOWN_MS - 1),
        now: NOW,
      },
      { senderIsAgent: false, isMentioned: false },
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("post-speak cooldown");

    // Past the cooldown the same agent is allowed again.
    const allowed = gateAgentTurn(
      {
        agentTurnsSinceHuman: 0,
        lastSpokeTs: NOW - (POST_SPEAK_COOLDOWN_MS + 1),
        now: NOW,
      },
      { senderIsAgent: false, isMentioned: false },
    );
    expect(allowed.allowed).toBe(true);
  });
});
