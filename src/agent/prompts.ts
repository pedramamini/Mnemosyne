/**
 * System-prompt layering for the Mnemosyne harness (MNEMO-15).
 *
 * `buildSystemPrompt` composes the turn's `system` text in a FIXED order
 * (mirrors `docs/crema-architecture-reference.md` §11):
 *
 *   1. Base Mnemosyne persona      - who the agent is + scope/safety rules
 *   2. Current date and time        - today's date in the owner's timezone
 *                                     (computed per turn), so the model never
 *                                     falls back to its training-era sense of
 *                                     "now" and treats its own memory as stale
 *   3. Entity-template overlay      - vendor / product / investor / founder lens
 *   4. About the person you work for - owner name + how they like to work (profile)
 *   5. The agent's own system_prompt - the operator's instructions (registry row)
 *   6. Per-turn extras              - anything the caller wants for THIS turn only
 *
 * The base persona's scope/safety rules ALWAYS win: overlays shape *how* the
 * agent researches and writes, never *what* it is allowed to do. Null/empty
 * layers are skipped cleanly. Everything is data-driven - no agent is named in
 * code, so a new agent needs no prompt-layer change.
 */
import type { AgentTemplate } from "../db/index.ts";
import { getTemplate } from "./build/template.ts";

/**
 * The registry-derived persona inputs the builder layers on top of the base. The
 * DO rehydrates these from its `agents` row (MNEMO-15 `onStart`); tests can pass
 * a literal. Kept structural (not a class) so it round-trips over RPC/storage.
 */
export interface AgentPersonaContext {
  /** Entity lens (`agents.template`); null ⇒ no template overlay. */
  template: AgentTemplate | null;
  /** Operator-authored instructions (`agents.system_prompt`); null ⇒ skipped. */
  systemPrompt: string | null;
  /**
   * The agent's self-authored operating playbook - the lessons it has folded back
   * in from its weekly self-reviews ("system prompt learning"; src/agent/assessment).
   * DO-resident state (NOT a registry field), refreshed by the assessment loop and
   * injected on every turn so accumulated lessons actually steer the work. Null/
   * empty until the first review writes one ⇒ the layer is skipped.
   */
  operatingNotes?: string | null;
  /**
   * The owner's IANA timezone (account profile); null ⇒ the date layer renders in
   * UTC. Account-level, so it applies to every agent the owner runs.
   */
  timezone?: string | null;
  /**
   * Who the agent works for (account profile) - feeds the "About the person you
   * work for" layer. Null ⇒ no profile set; the layer is skipped.
   */
  owner?: OwnerProfile | null;
}

/**
 * Base Mnemosyne persona - loaded as the lead-in of EVERY turn (interactive and
 * headless). Establishes the research-agent identity, the persistent file-based
 * brain (PRD §4/§6.2 - notes are "neurons," `[[links]]` are "synapses"; notes are
 * declarative memory, self-authored tools are procedural memory), and the
 * scope/safety rails that the overlays below cannot override.
 */
export const BASE_PERSONA = `You are Mnemosyne, an autonomous research agent.

Identity
You research a specific subject on the open web, remember what you learn across runs, and produce clear written findings for the person who set you up. You are one of many such agents; you operate only on your own assignment and your own memory.

Your brain
You own a persistent filesystem - your brain - that survives across every run. Notes are your neurons; the [[wiki-links]] between them are your synapses. Before researching, recall: search and read your existing notes so you build on what you already know instead of rediscovering it. After researching, remember: write durable, well-linked notes so your future self inherits the work. Prefer many small, densely-linked notes over a few sprawling ones.

You can also build reusable tools. When you find yourself doing the same scripted work repeatedly, save it once with authorTool - a Python or shell script under /brain/tools/ - and call it again in later sessions (this is your procedural memory). Such tools run only inside your own private sandbox, never anywhere else.

How you work
Use your tools - do not answer from memory. Your built-in knowledge is stale and often wrong about anything current. For ANY question that touches real-world facts, prices, news, events, companies, or people, you MUST call the webSearch tool first (then webFetch the most promising results to read them) BEFORE you write an answer. Do not state external facts, and do not say a search "failed" or "returned no results," unless you actually called webSearch and saw its output. Recalling from your brain and searching the web are your first moves on essentially every turn.

Plan before you act. Take one well-chosen step at a time - search or recall, read the result, then decide the next step - rather than firing speculative actions in parallel. When a tool returns a large result, write it to your brain and carry forward a reference (a path), not the raw blob, so your working context stays disciplined. Cite the source URLs you actually read for every external claim; if a search genuinely returns nothing useful, say so plainly rather than guessing.

Scope and safety
Stay on your assigned research subject. If asked for something off-task or out of scope, decline briefly and steer back. Gather only public, voluntarily-shared information; never pursue private records, credentials, or anything behind a login you were not granted. You draft and report - you do not take outward actions (sending, posting, purchasing) on anyone's behalf. Never fabricate a fact, a source, or a memory.`;

/**
 * The "Current date and time" layer - computed fresh on every turn (never baked
 * into the static persona constant) so the agent always knows what *now* is and
 * never anchors to its training-era sense of the date. The model's parametric
 * knowledge has a cutoff in the past; stating today's date here, right after the
 * persona, makes "use your tools for anything current" concrete rather than
 * abstract.
 *
 * Rendered in the owner's local timezone (`timeZone`, an IANA zone from their
 * account profile) so "today" matches the person reading the report; falls back
 * to UTC when no zone is set or the stored value is not a valid IANA zone (an
 * unknown zone makes `toLocaleString` throw, so the format is guarded). The
 * explicit zone label keeps the reference unambiguous either way.
 */
export function currentDateLayer(now: Date, timeZone?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  };
  let formatted: string;
  try {
    formatted = now.toLocaleString("en-US", {
      ...opts,
      timeZone: timeZone || "UTC",
    });
  } catch {
    // Invalid/unknown IANA zone (RangeError) - fall back to UTC rather than fail.
    formatted = now.toLocaleString("en-US", { ...opts, timeZone: "UTC" });
  }
  return `Current date and time
Right now it is ${formatted}. This is the real present moment. Your built-in training knowledge has a cutoff in the past, so any date, price, version, release, news, or "latest" fact you recall from memory is likely stale and may be years out of date. Never present old information as if it were current. When an answer depends on what is true today, verify it with webSearch (then webFetch the sources) before you write - do not rely on what you think you remember.`;
}

/**
 * Persona inputs describing the person the agent works for (account-level, from
 * the owner profile). Kept structural so it round-trips over RPC/DO storage.
 */
export interface OwnerProfile {
  /** How to address them; null ⇒ unknown. */
  name: string | null;
  /** Freeform notes - how they like to work, their goals; null/empty ⇒ skipped. */
  notes: string | null;
}

/**
 * The "About the person you work for" layer - who the operator is and how they
 * like to work, drawn from their account profile. Gives the agent standing
 * context to tune tone, emphasis, and what to surface, WITHOUT loosening the
 * scope/safety rails (it informs *how* to serve, never *what* is allowed).
 * Returns null when there is nothing worth stating (no name and no notes), so
 * the layer is skipped cleanly.
 */
export function ownerProfileLayer(owner: OwnerProfile): string | null {
  const name = owner.name?.trim();
  const notes = owner.notes?.trim();
  if (!name && !notes) return null;
  const lines = ["About the person you work for"];
  if (name) lines.push(`Their name is ${name}.`);
  if (notes) lines.push(notes);
  lines.push(
    `Keep this in mind as standing context for how you work and what you surface for them.`,
  );
  return lines.join("\n");
}

/**
 * The entity-template overlay text (PRD §6 personas) - layer 3 of the prompt.
 *
 * SINGLE SOURCE OF TRUTH: the lens prose lives on each entity template's
 * `systemPromptFragment` (src/agent/build/templates/*.ts) - the very fragment
 * Build also bakes into the assembled `system_prompt`. Deriving the runtime
 * overlay from the same object means the live persona layer and the provisioned
 * prompt can never drift (this file used to keep its own hand-written copies,
 * which had already diverged). `agents.template` is an `AgentTemplate`, a strict
 * subset of `DiscoveryEntityType`, so it always resolves to a real lens; the
 * caller skips the overlay entirely when the template is null.
 */
function templateOverlay(template: AgentTemplate): string {
  return getTemplate(template).systemPromptFragment.trim();
}

/**
 * Deep-research overlay (PRD §6.3) - appended as the per-turn `extras` ONLY for
 * headless / scheduled runs (`runHeadless`), never interactive chat (a human is
 * in the loop there and steers the exit). It tells the model to research with the
 * available tools and then end the run by calling the terminator tool exactly
 * once, as its final action, with the complete structured report. That tool's
 * input schema IS the final-report schema (MNEMO-18 / src/tools/reportSchema.ts),
 * so a clean exit yields a validated `FinalReportData` for MNEMO-24 to render.
 */
export const DEEP_RESEARCH_OVERLAY = `Deep-research run
This is an unattended research run - no human is watching to steer you. Work the assignment with the tools available to you: recall from your brain, search and read sources, run shell/Python as needed, and write durable notes as you go.

When - and only when - your research is complete, end the run by calling the submitFinalReport tool exactly once, as your final action. Pass the complete, structured report: a title, a short summary, the body broken into titled sections, the key findings, every source you actually consulted, and your overall confidence (low / medium / high). Do not call any other tool in that final step.

Never fabricate, pad, or guess a source - include only sources you genuinely consulted, and say so plainly when the evidence is thin. Do not end the run by simply writing prose: a run that stops without calling submitFinalReport has failed to deliver its report.`;

/**
 * Compose the full `system` prompt for a turn. Layers in fixed order; skips any
 * null/empty layer. The current-date layer is always present and computed from
 * `opts.now` (defaults to `new Date()`, overridable for deterministic tests).
 * `extras` is per-turn only (e.g. a continuation hint or a scheduled-run framing)
 * - it never persists.
 */
export function buildSystemPrompt(
  agent: AgentPersonaContext,
  opts?: { extras?: string | null; now?: Date },
): string {
  const sections: string[] = [
    BASE_PERSONA,
    currentDateLayer(opts?.now ?? new Date(), agent.timezone),
  ];

  if (agent.template) {
    const overlay = templateOverlay(agent.template);
    if (overlay) sections.push(overlay);
  }

  // Who they work for, before their explicit instructions: context about the
  // person frames the operator brief that follows.
  if (agent.owner) {
    const ownerLayer = ownerProfileLayer(agent.owner);
    if (ownerLayer) sections.push(ownerLayer);
  }

  const own = agent.systemPrompt?.trim();
  if (own) {
    sections.push(
      `Operator instructions\nThe person who set you up wrote the following. Follow it within the scope and safety rules above.\n${own}`,
    );
  }

  // Layer 4b - the agent's own operating playbook (system-prompt learning). Sits
  // after the operator instructions (it refines *how* to work, never overriding
  // what the operator asked for or the scope/safety rails) and before per-turn
  // extras. Skipped until a self-review has written one.
  const learned = agent.operatingNotes?.trim();
  if (learned) {
    sections.push(
      `What you've learned about doing this job well\nThese are your own standing notes, distilled from your weekly self-reviews. Apply them - they are how you compound what works.\n${learned}`,
    );
  }

  const extras = opts?.extras?.trim();
  if (extras) sections.push(extras);

  return sections.join("\n\n");
}
