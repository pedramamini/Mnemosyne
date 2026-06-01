/**
 * The cheap per-agent-per-message triage gate (MNEMO-48, PRD §9.4 triage gate).
 *
 * This is deliberately NOT the full agent loop - it is ONE cheap model call that
 * asks a single member agent: "given this conversation and my role, do I have
 * something valuable to add right now?" The coordinator
 * (src/messaging/ThreadCoordinator.ts) fans this out to every eligible member and
 * ranks the {@link TriageBid}s for floor control - "no pile-on, only signal"
 * (§9.4). The expensive brain/memory/tools loop runs ONLY for the 1–2 floor
 * winners, never here.
 *
 * Model choice: a dedicated {@link getTriageModel} resolving the zero-secret
 * Workers AI cheap default (the Haiku-class gate), NOT the member's per-user model
 * (which may be a costly Opus). Triage is a high-frequency, low-stakes filter, so
 * it must stay cheap and always-available regardless of an agent's BYOK profile -
 * we deliberately do NOT route it through `getModel()`'s per-user resolution.
 *
 * Silence-is-safe: any parse/validation failure yields `wantsToRespond: false`, so
 * a flaky cheap call defaults to NOT speaking (§9.4 "no pile-on, only signal").
 */
import { generateText, type LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../env.ts";
import { DEFAULT_WORKERS_AI_MODEL } from "../llm/types.ts";
import { type GroupTranscriptLine, TriageBid } from "./groupTypes.ts";

/** What {@link triageGate} needs to score one agent's interest in replying. */
export interface TriageGateInput {
  /** The member agent being asked (stamped onto its {@link TriageBid}). */
  agentId: string;
  /** A short description of this agent's role/specialty (drives "is this for me?"). */
  role: string;
  /** Recent group transcript (oldest → newest) for context. */
  transcriptTail: GroupTranscriptLine[];
  /** The new message under consideration. */
  message: string;
}

/** Injectable collaborators (test seam): a stubbed cheap model in unit tests. */
export interface TriageDeps {
  /** Override the cheap model (tests inject a `MockLanguageModelV3`). */
  model?: LanguageModel;
}

/**
 * The zero-secret Workers AI cheap default - the triage gate's model (see the
 * module comment for why this is NOT the per-user `getModel()` resolution). Always
 * available, no BYOK key, no D1 read; constructs only the client (no inference).
 */
export function getTriageModel(env: Env): LanguageModel {
  return createWorkersAI({ binding: env.AI })(DEFAULT_WORKERS_AI_MODEL);
}

/** How many transcript lines ride into the prompt (bounded so an old thread fits). */
const MAX_TRANSCRIPT_LINES = 10;

/** The fixed, low-temperature instruction for the cheap gate. */
function triageSystemPrompt(role: string): string {
  return (
    "You are one participant in a GROUP conversation, alongside other AI agents " +
    "and people. Your role/specialty:\n" +
    `${role || "a general-purpose research assistant"}\n\n` +
    "Decide whether YOU specifically have something genuinely valuable to add to " +
    "the LATEST message right now. Be conservative: stay silent unless the message " +
    "is clearly within your specialty or directly useful for you to answer - no " +
    "pile-on, only signal. Do NOT reply just to be polite or to agree.\n\n" +
    'Answer with ONLY a JSON object, no prose: {"wantsToRespond": boolean, ' +
    '"confidence": number between 0 and 1, "reason": short string}.'
  );
}

/** Build the user-side prompt: the recent transcript + the message to score. */
function triageUserPrompt(input: TriageGateInput): string {
  const lines = input.transcriptTail
    .slice(-MAX_TRANSCRIPT_LINES)
    .map((l) => `${l.from}: ${l.body}`)
    .join("\n");
  const context = lines ? `Recent conversation:\n${lines}\n\n` : "";
  return `${context}Latest message:\n${input.message}`;
}

/**
 * Run the cheap triage gate for one agent and return its {@link TriageBid}. Makes
 * exactly ONE `generateText` call (no tools, no multi-step loop - it is the gate,
 * not the agent loop) and parses the model's JSON. ANY failure (non-JSON, missing
 * fields, schema mismatch, model error) defaults to a declined bid - silence is the
 * safe default (§9.4). The agentId is always stamped from the input, never trusted
 * from the model output.
 */
export async function triageGate(
  env: Env,
  input: TriageGateInput,
  deps: TriageDeps = {},
): Promise<TriageBid> {
  const declined: TriageBid = {
    agentId: input.agentId,
    wantsToRespond: false,
    confidence: 0,
    reason: "triage declined (default)",
  };

  try {
    const model = deps.model ?? getTriageModel(env);
    const result = await generateText({
      model,
      system: triageSystemPrompt(input.role),
      prompt: triageUserPrompt(input),
    });
    return parseBid(input.agentId, result.text) ?? declined;
  } catch {
    // A failed cheap call must never block the floor - default to silence.
    return declined;
  }
}

/**
 * Parse the cheap model's text into a {@link TriageBid}, or null on any failure.
 * Extracts the first JSON object (the model may wrap it in stray prose), validates
 * it through the Zod schema, and re-stamps the trusted `agentId`. A `confidence`
 * outside 0..1 or a missing `wantsToRespond` fails validation → null → declined.
 */
function parseBid(agentId: string, text: string): TriageBid | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const parsed = TriageBid.safeParse({
    ...(typeof raw === "object" && raw !== null ? raw : {}),
    agentId, // trust the caller, not the model, for identity
  });
  return parsed.success ? parsed.data : null;
}
