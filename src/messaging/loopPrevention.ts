/**
 * Agent↔agent loop prevention for group threads (MNEMO-48, PRD §9.4 - "prevents
 * agent↔agent runaway").
 *
 * Pure functions, NO I/O - the rules are unit-testable without a DO. The
 * coordinator (src/messaging/ThreadCoordinator.ts) holds the per-thread state
 * (turn counter + per-agent last-spoke timestamps) and consults these to decide,
 * for each candidate member agent, whether it may take the floor for this message.
 *
 * The §9.4 rules, applied in order by {@link gateAgentTurn}:
 *   1. HARD TURN CAP - once `agentTurnsSinceHuman` reaches
 *      {@link MAX_AGENT_TURNS_PER_HUMAN_TURN}, no agent turn is cleared, NOT EVEN a
 *      mentioned one (the cap is the absolute backstop against runaway). The
 *      counter resets when a human speaks.
 *   2. POST-SPEAK COOLDOWN - an agent that spoke within
 *      {@link POST_SPEAK_COOLDOWN_MS} stays quiet (damps a single chatty agent).
 *   3. AGENT-TO-AGENT SILENCE - agents triage aggressively on HUMAN messages but
 *      do NOT reply to OTHER AGENTS unless explicitly @-mentioned. `isMentioned`
 *      overrides this silence (but still respects rules 1–2 above).
 */
import {
  MAX_AGENT_TURNS_PER_HUMAN_TURN,
  POST_SPEAK_COOLDOWN_MS,
} from "./groupTypes.ts";

/**
 * Is the inbound `from` a member AGENT rather than a human? `agentNumbers` is the
 * set of member agents' provisioned E.164s; a sender in it is an agent. `from` is
 * additionally required to be a known participant (`memberNumbers`) so an unrelated
 * number is never mistaken for an agent. Used to apply the agent-to-agent silence
 * rule (a message from another agent does not provoke replies, §9.4).
 */
export function isFromAgent(
  from: string,
  memberNumbers: string[],
  agentNumbers: string[],
): boolean {
  return memberNumbers.includes(from) && agentNumbers.includes(from);
}

/** The per-agent floor state the gate reads (held by the coordinator per thread). */
export interface AgentTurnState {
  /** Consecutive agent turns since the last human message (reset on a human turn). */
  agentTurnsSinceHuman: number;
  /** When this agent last took the floor (epoch ms), or null if it hasn't yet. */
  lastSpokeTs: number | null;
  /** Now (epoch ms) - injected so the rule stays pure/testable. */
  now: number;
}

/** Context about the current message for one candidate agent. */
export interface AgentTurnContext {
  /** Is the inbound from another agent (vs. a human)? See {@link isFromAgent}. */
  senderIsAgent: boolean;
  /** Was THIS candidate agent explicitly @-mentioned in the message? */
  isMentioned: boolean;
}

/** The gate's verdict: whether the candidate may take the floor, and why. */
export interface GateResult {
  allowed: boolean;
  reason: string;
}

/**
 * Decide whether a candidate agent may take the floor for this message (§9.4). See
 * the module comment for the rule order. The HARD TURN CAP wins over everything
 * (including an @-mention); the COOLDOWN is next; then the AGENT-TO-AGENT SILENCE,
 * which an @-mention overrides. A human message (the common case) with a fresh
 * counter and no recent utterance is allowed - agents triage aggressively on it.
 */
export function gateAgentTurn(
  state: AgentTurnState,
  ctx: AgentTurnContext,
): GateResult {
  // (1) Hard cap - the absolute backstop. Blocks even a mentioned agent so a
  // mention can't be used to keep an agent↔agent chain alive forever (§9.4).
  if (state.agentTurnsSinceHuman >= MAX_AGENT_TURNS_PER_HUMAN_TURN) {
    return { allowed: false, reason: "agent-turn cap reached" };
  }

  // (2) Post-speak cooldown - this agent spoke too recently. Independent of who
  // sent the current message, so one agent can't dominate back-to-back turns.
  if (
    state.lastSpokeTs !== null &&
    state.now - state.lastSpokeTs < POST_SPEAK_COOLDOWN_MS
  ) {
    return { allowed: false, reason: "post-speak cooldown" };
  }

  // (3) Agent-to-agent silence - do NOT reply to another agent unless mentioned.
  // The @-mention overrides the silence (a named agent always responds, §9.4).
  if (ctx.senderIsAgent && !ctx.isMentioned) {
    return { allowed: false, reason: "agent sender; not mentioned" };
  }

  return { allowed: true, reason: ctx.isMentioned ? "mentioned" : "eligible" };
}
