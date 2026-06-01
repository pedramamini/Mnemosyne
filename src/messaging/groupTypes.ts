/**
 * Group-orchestration contract for multi-agent group threads (MNEMO-48, PRD §9.4).
 *
 * A group thread may reach one or more agents (and humans). Every member agent
 * SEES every message, but RESPONDS only when it has something valuable to add -
 * "no pile-on, only signal" (§9.4). The {@link import("./ThreadCoordinator.ts").ThreadCoordinator}
 * DO fans each inbound to every member agent's cheap Haiku triage gate, collects
 * confidence {@link TriageBid}s within {@link TRIAGE_DEBOUNCE_MS}, and lets only the
 * top {@link MAX_FLOOR_WINNERS} run the full loop and reply. An @-mention forces a
 * response; agent↔agent runaway is bounded by {@link MAX_AGENT_TURNS_PER_HUMAN_TURN}
 * + a {@link POST_SPEAK_COOLDOWN_MS} cooldown after an agent last spoke.
 *
 * These are the shared Zod-typed shapes both sides speak. Phone numbers are E.164.
 */
import { z } from "zod";
import type { CapabilityTier } from "./tiers.ts";
import { Channel } from "./types.ts";

/**
 * A normalized inbound message addressed to a group thread (PRD §9.4/§9.5). Unlike
 * a 1:1 {@link import("./types.ts").InboundMessage}, it carries the full membership
 * - `memberAgentIds` (the agent participants the coordinator fans to) and
 * `memberNumbers` (every participant's E.164, humans + agents) - so the coordinator
 * can resolve mentions, identify an agent sender, and seed access (§9.6).
 */
export const GroupInbound = z.object({
  threadId: z.string().describe("Stable group-thread id (the THREAD DO key)."),
  from: z
    .string()
    .describe("Sender's E.164 (a human or a member agent's number)."),
  body: z.string().describe("Message text."),
  channel: Channel,
  memberAgentIds: z
    .array(z.string())
    .describe("The agent participants the coordinator fans the message to."),
  memberNumbers: z
    .array(z.string())
    .describe("Every participant E.164 (humans + agents) - the group roster."),
  ts: z.number().int().describe("Receipt timestamp (epoch ms)."),
});
/** The inferred TypeScript shape of {@link GroupInbound}. */
export type GroupInbound = z.infer<typeof GroupInbound>;

/**
 * One member agent's bid from the cheap triage gate (PRD §9.4). `wantsToRespond`
 * is the gate's yes/no; `confidence` (0..1) ranks competing bids for the limited
 * floor; `reason` is a short machine/log-friendly rationale. Silence is the safe
 * default - a parse failure in the gate yields `wantsToRespond: false` (§9.4).
 */
export const TriageBid = z.object({
  agentId: z.string(),
  wantsToRespond: z.boolean(),
  confidence: z.number().min(0).max(1).describe("0..1 ranking weight."),
  reason: z.string(),
});
/** The inferred TypeScript shape of {@link TriageBid}. */
export type TriageBid = z.infer<typeof TriageBid>;

/** One group-transcript line (who said what) - the triage gate's context unit. */
export interface GroupTranscriptLine {
  from: string;
  body: string;
}

/**
 * The coordinator → agent-DO fan-out payload (`recordGroupMessage`, §9.5): persist
 * this inbound into the member agent's group session so every agent records the
 * full multi-party history. `fromSelf` is set for the ONE member whose own number
 * sent the message, so that agent records it as its own (outbound) turn, not an
 * inbound from a stranger.
 */
export interface GroupRecordInput {
  threadId: string;
  from: string;
  body: string;
  channel: Channel;
  memberNumbers: string[];
  ts: number;
  fromSelf: boolean;
}

/** What `recordGroupMessage` returns: the member's recent transcript tail for triage. */
export interface GroupRecordResult {
  tail: GroupTranscriptLine[];
}

/**
 * The coordinator → agent-DO floor-winner payload (`replyInGroup`, §9.4): run the
 * full loop over the group transcript under `tier` (always `group_member` - do NOT
 * volunteer the owner's private memory, §9.6) and reply. `to` is the SMS reply
 * target; `fromNumber` is the winning agent's provisioned number.
 */
export interface GroupReplyInput {
  threadId: string;
  to: string;
  fromNumber: string;
  channel: Channel;
  tier: CapabilityTier;
}

/**
 * The coordinator's floor decision for one inbound message (PRD §9.4). `winners`
 * are the agentIds cleared to run the full loop and reply - capped at
 * {@link MAX_FLOOR_WINNERS} for triaged bids, but @-mentioned agents
 * (`forcedByMention`) ALWAYS win (a named agent always responds, §9.4) and so can
 * exceed the cap. `messageId` is the dedupe id the coordinator stamped.
 */
export const FloorDecision = z.object({
  threadId: z.string(),
  messageId: z.string(),
  winners: z
    .array(z.string())
    .describe(
      "agentIds cleared to reply (triaged ≤ MAX_FLOOR_WINNERS + forced).",
    ),
  forcedByMention: z
    .array(z.string())
    .describe("agentIds that won via @-mention (bypass the triage gate)."),
});
/** The inferred TypeScript shape of {@link FloorDecision}. */
export type FloorDecision = z.infer<typeof FloorDecision>;

// ─── Floor-control / loop-prevention tunables (PRD §9.4) ─────────────────────

/**
 * The maximum number of TRIAGED bids cleared to reply to one message - "only the
 * top 1–2 run the full loop and reply" (§9.4 floor control). @-mentioned agents
 * are forced winners and bypass this cap (a named agent always responds).
 */
export const MAX_FLOOR_WINNERS = 2;

/**
 * The short window the coordinator collects triage bids over before deciding the
 * floor (§9.4). Member triages run concurrently inside the DO, so this bounds how
 * long the coordinator waits for the slowest cheap gate before ranking what it has.
 */
export const TRIAGE_DEBOUNCE_MS = 1500;

/**
 * The hard cap on consecutive AGENT turns between human turns (§9.4 "prevents
 * agent↔agent runaway"). Once exceeded, no further agent turn is cleared - even an
 * @-mentioned one - until a human message resets the counter. Small on purpose: a
 * couple of agent-to-agent exchanges is useful; an unbounded chain is not.
 */
export const MAX_AGENT_TURNS_PER_HUMAN_TURN = 3;

/**
 * The cooldown after an agent last spoke before it may take the floor again (§9.4).
 * Damps a single chatty agent from monopolizing the thread across back-to-back
 * messages, independent of the per-human turn cap above.
 */
export const POST_SPEAK_COOLDOWN_MS = 30_000;
