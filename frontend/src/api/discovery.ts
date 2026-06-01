/**
 * Discovery API adapter (MNEMO-34) - the SINGLE point of contact with the
 * MNEMO-29 Discovery backend. The rest of the UI consumes the stable, idealized
 * shapes declared here; this file absorbs the fact that the real backend differs.
 *
 * ── How the real MNEMO-29 contract differs (and how we adapt) ────────────────
 * MNEMO-29 mounts Discovery *under an existing agent* - there is no standalone
 * "discovery session" resource. So an agent must be created FIRST:
 *
 *   our startDiscovery(seed)         →  POST /agents { name, description }      (MNEMO-05, create the draft)
 *                                       then POST /agents/:id/discovery/start { name, description }
 *                                       ⇒ the new agent id IS the `discoveryId`.
 *   our sendDiscoveryMessage(id, m)  →  POST /agents/:id/discovery/message { message }
 *                                       backend returns { reply, state }; we map it.
 *   our finalizeDiscovery(id)        →  POST /agents/:id/build                  (MNEMO-30, provision + go live)
 *                                       ⇒ the agent already exists, so we just return its id.
 *
 * The backend `DiscoveryState` is `{ status: "in_progress"|"complete", spec, turns }`.
 * The per-turn response only carries the assistant's latest `reply` (NOT the full
 * transcript) and the rubric/confidence are emitted ONLY in the finalized `spec`
 * (the soft gate self-assesses internally; PRD §5/§6.3). We therefore:
 *   - return the assistant reply as the new turn(s) and let `DiscoveryChat` own the
 *     running transcript (it concatenates `messages` + the optimistic user turn),
 *   - light the five rubric facets from the finalized spec's `facetNotes` (so they
 *     flip on at the gate - the backend exposes no per-facet running signal),
 *   - surface `confidence` from the finalized spec, and `0` while still scoping
 *     (DiscoveryChat renders an indeterminate meter until the gate clears).
 *
 * If MNEMO-29's contract evolves, change it HERE only - the components/pages stay put.
 */
import { post } from "./client";

/** One turn of the clarify-scope exchange. */
export interface DiscoveryTurn {
  role: "user" | "assistant";
  content: string;
}

/** The five soft-rubric facets (PRD §5(1)); keys mirror the MNEMO-29 spec fields. */
export interface DiscoveryRubric {
  subject: boolean;
  entityType: boolean;
  sources: boolean;
  cadence: boolean;
  outputFormat: boolean;
}

/**
 * UI-facing Discovery state. `messages` are the new turn(s) for this exchange
 * (the caller accumulates the transcript); `rubric`/`confidence` visualize the
 * soft gate; `ready` is true once the confidence gate has cleared.
 */
export interface DiscoveryState {
  messages: DiscoveryTurn[];
  rubric: DiscoveryRubric;
  /** Self-assessed confidence in [0,1]; `0` while still scoping (see header note). */
  confidence: number;
  ready: boolean;
}

/** Handle returned by `startDiscovery` - the `discoveryId` is the new agent's id. */
export interface DiscoveryStart {
  discoveryId: string;
  state: DiscoveryState;
}

/** Result of finalizing - the provisioned agent's id, for navigating to its detail page. */
export interface DiscoveryResult {
  agentId: string;
}

// ── Backend wire shapes (MNEMO-29 / MNEMO-05), kept local to this adapter ─────

interface BackendAgent {
  id: string;
}

interface BackendFacetNotes {
  subject: string;
  entityType: string;
  sources: string;
  cadence: string;
  outputFormat: string;
}

interface BackendDiscoverySpec {
  subject: string;
  entityType: string;
  sources: string[];
  cadence: string;
  outputFormat: string;
  confidence: number;
  facetNotes: BackendFacetNotes;
}

interface BackendDiscoveryProgress {
  facetNotes: BackendFacetNotes;
  confidence: number;
}

interface BackendDiscoveryState {
  status: "in_progress" | "complete";
  spec: BackendDiscoverySpec | null;
  turns: number;
  /** Running self-assessment, refreshed each turn before the gate clears. */
  progress?: BackendDiscoveryProgress | null;
}

interface BackendTurnResult {
  reply: string;
  state: BackendDiscoveryState;
}

/** A facet counts as understood when its captured note is non-empty. */
function facetSatisfied(note: string | undefined): boolean {
  return typeof note === "string" && note.trim().length > 0;
}

/** Map a set of facet notes onto the five rubric chips (empty note ⇒ chip off). */
function rubricFromNotes(
  notes: BackendFacetNotes | undefined,
): DiscoveryRubric {
  return {
    subject: facetSatisfied(notes?.subject),
    entityType: facetSatisfied(notes?.entityType),
    sources: facetSatisfied(notes?.sources),
    cadence: facetSatisfied(notes?.cadence),
    outputFormat: facetSatisfied(notes?.outputFormat),
  };
}

/**
 * Resolve the facet notes + confidence to visualize. Prefer the finalized spec
 * once the gate clears; otherwise use the running `progress` the backend refreshes
 * each turn (so the rubric lights up and the meter climbs DURING the interview).
 */
function activeAssessment(backend: BackendDiscoveryState): {
  notes: BackendFacetNotes | undefined;
  confidence: number;
} {
  if (backend.status === "complete" && backend.spec) {
    return {
      notes: backend.spec.facetNotes,
      confidence: backend.spec.confidence,
    };
  }
  const progress = backend.progress ?? null;
  return {
    notes: progress?.facetNotes,
    confidence: progress?.confidence ?? 0,
  };
}

/**
 * Strip any machine-readable envelope the model may have leaked into its reply
 * (e.g. a `<followup>{…}</followup>` block) so only human prose reaches the chat
 * bubble. Defensive: the live prompt keeps structure in tool calls, but a model
 * regression must never render raw tags/JSON to the person. Returns the trimmed
 * prose, which may be empty (the caller then renders no bubble).
 */
function sanitizeReply(reply: string | undefined): string {
  if (!reply) return "";
  return reply
    .replace(/<followup>[\s\S]*?<\/followup>/gi, "")
    .replace(/<\/?followup>/gi, "")
    .trim();
}

/** Build the UI state for one exchange from the backend state + the assistant's reply. */
function mapState(
  backend: BackendDiscoveryState,
  reply?: string,
): DiscoveryState {
  const ready = backend.status === "complete";
  const { notes, confidence } = activeAssessment(backend);
  const text = sanitizeReply(reply);
  return {
    // Only the assistant's reply is server-authored per turn; the caller owns the
    // running transcript. Skip empty/whitespace-only replies so a finalize turn
    // (which often produces no prose) never renders a blank bubble.
    messages: text ? [{ role: "assistant", content: text }] : [],
    rubric: rubricFromNotes(notes),
    confidence,
    ready,
  };
}

/**
 * Begin Discovery for a new agent: create the draft agent, then start the
 * clarify-scope conversation against it. Returns the `discoveryId` (the new
 * agent's id) plus the initial state (empty transcript, gate closed).
 */
export async function startDiscovery(seed: {
  name: string;
  description: string;
}): Promise<DiscoveryStart> {
  const agent = await post<BackendAgent>("/agents", {
    name: seed.name,
    description: seed.description,
  });
  const state = await post<BackendDiscoveryState>(
    `/agents/${encodeURIComponent(agent.id)}/discovery/start`,
    { name: seed.name, description: seed.description },
  );
  return { discoveryId: agent.id, state: mapState(state) };
}

/**
 * Send one clarify-scope answer. Returns the assistant's reply (as the new
 * turn(s)) plus the refreshed rubric/confidence/ready gate. The caller appends
 * `messages` to its running transcript (after its optimistic user turn).
 */
export async function sendDiscoveryMessage(
  discoveryId: string,
  content: string,
): Promise<DiscoveryState> {
  const result = await post<BackendTurnResult>(
    `/agents/${encodeURIComponent(discoveryId)}/discovery/message`,
    { message: content },
  );
  return mapState(result.state, result.reply);
}

/**
 * Finalize Discovery once `ready`: provision + go live (MNEMO-30 Build, which is
 * idempotent). The agent already exists, so we return its id for navigation.
 */
export async function finalizeDiscovery(
  discoveryId: string,
): Promise<DiscoveryResult> {
  await post(`/agents/${encodeURIComponent(discoveryId)}/build`);
  return { agentId: discoveryId };
}
