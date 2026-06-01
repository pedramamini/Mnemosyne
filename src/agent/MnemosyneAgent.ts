/**
 * MnemosyneAgent - the per-agent "always-home" Durable Object.
 *
 * One instance per agent, addressed via `env.AGENT.idFromName(agentId)` (no
 * allocation logic - mirrors Crema, see docs/crema-architecture-reference.md §1).
 * It is the DO-warm half of the DO-warm / sandbox-ephemeral split (PRD §7.4,
 * §8.4): it holds chat history (via AIChatAgent), settings, schedule, and later
 * the memory/audit index - so search and brain-size work WITHOUT waking the
 * sandbox container.
 *
 * State lives in `ctx.storage.sql` (the DO is a `new_sqlite_classes` migration),
 * NOT in in-memory fields, so it survives hibernation - a hard requirement of
 * the harness host (PRD §7.1). Settings/schedule are therefore read straight
 * from SQLite on every access rather than cached on the instance.
 *
 * Cross-boundary access: the worker invokes most public methods directly on the
 * DO stub via native Workers RPC (`env.AGENT.get(id).getSettings()`) - the
 * `agents` SDK's documented stub idiom. The agentic chat surface (MNEMO-15) is
 * the exception: the worker forwards the raw request to `fetch` so the base can
 * handle the WS upgrade (interactive `onChatMessage` loop); a plain `POST .../chat`
 * entry runs the same loop non-interactively, and `runHeadless` is the
 * `generateText` counterpart for scheduled/background work.
 */
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { Connection, ConnectionContext } from "agents";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  type LanguageModelUsage,
  type ModelMessage,
  type StreamTextOnFinishCallback,
  stepCountIs,
  streamText,
  type ToolSet,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { archiveHtmlArtifact } from "../artifacts/store.ts";
import {
  type AuditEmitTarget,
  AuditEmitter,
  getAuditStub,
} from "../audit/index.ts";
import type { AuditInput } from "../audit/types.ts";
import {
  acquireSandboxSlot,
  releaseSandboxSlot,
} from "../billing/concurrency.ts";
import {
  type AdmissionResult,
  admitSandboxRun,
  checkCostCap,
  checkTierFeature,
} from "../billing/limits.ts";
import { recordUsage as meterUsage } from "../billing/meter.ts";
import { getSubscription } from "../billing/subscriptions.ts";
import { getTier } from "../billing/tiers.ts";
import {
  type AccountProfile,
  type AgentTemplate,
  getAccount,
  getAgent,
  updateAgent,
} from "../db/index.ts";
import type { Env } from "../env.ts";
import { getModel, type ResolvedModel } from "../llm/getModel.ts";
import { recordUsage } from "../llm/recordUsage.ts";
import type { ResolvedModelConfig } from "../llm/types.ts";
import {
  type ArchiveFormat,
  archiveBrain,
  type BrainArchive,
} from "../memory/archive.ts";
import { writeCommitMsg } from "../memory/commit-messages.ts";
import {
  type ConsolidationPlan,
  type NoteInput,
  planConsolidation,
} from "../memory/consolidation.ts";
import {
  applyConsolidation,
  type ConsolidationDiff,
  diffPlan,
} from "../memory/consolidation-apply.ts";
import {
  type BrainEntry,
  type BrainFileContent,
  type BrainWriteInput,
  type BrainWriteResult,
  createBrainDir,
  createBrainFile,
  deleteBrainPath,
  listTree,
  readBrainFile,
  writeBrainFile,
} from "../memory/explorer.ts";
import { autoCommit, isCleanTree } from "../memory/git.ts";
import {
  type BrainSize,
  type Direction,
  GraphIndex,
  type NeuronRef,
  planReindex,
  type Subgraph,
  type SynapseRef,
  type TraverseOpts,
} from "../memory/graph-index.ts";
import { hashContent } from "../memory/hash.ts";
import { NOTES_DIR, notePath } from "../memory/layout.ts";
import {
  type CommitDiff,
  commitDiff,
  type FileAtRevision,
  type FileDiff,
  fileAtRevision,
  fileDiff,
  fileHistory,
  type HistoryOpts,
  type HistoryPage,
  listHistory,
  type RestoreHooks,
  type RestoreResult,
  restoreFile,
  restoreTree,
} from "../memory/versioning.ts";
import { parseWikilinks } from "../memory/wikilink.ts";
import {
  appendNote,
  type BrainWriteHooks,
  deleteNote,
  type NoteAppendInput,
  type NoteWriteInput,
  type NoteWriteResult,
  writeNote,
} from "../memory/write.ts";
import { expandWhitelistForGroup } from "../messaging/access.ts";
import type {
  GroupRecordInput,
  GroupRecordResult,
  GroupReplyInput,
} from "../messaging/groupTypes.ts";
import {
  appendMessage,
  getOrCreate1to1Session,
  getOrCreateGroupSession,
  listMessages,
  listSessions,
  type MessagingMessage,
  type MessagingSession,
} from "../messaging/persistence.ts";
import { sendAgentReply } from "../messaging/reply.ts";
import { CapabilityTier, tierConstraints } from "../messaging/tiers.ts";
import { Channel, InboundMessage } from "../messaging/types.ts";
import {
  getSandbox,
  type RunResult,
  type SandboxClient,
} from "../sandbox/client.ts";
import { ensureWarm, IDLE_TIMEOUT_MS, idleDown } from "../sandbox/lifecycle.ts";
import {
  nextDreamDelaySec,
  nextRunAfter,
  ScheduledRunPayload,
} from "../schedule/types.ts";
import type {
  ArtifactDraft,
  FinalReportData,
  MnemosyneTool,
  ToolContext,
} from "../tools/index.ts";
import { buildTools, makeTerminator } from "../tools/index.ts";
import {
  ASSESSMENT_OVERLAY,
  buildAssessmentPrompt,
} from "./assessment/prompt.ts";
import { makeAssessmentTerminator } from "./assessment/tools.ts";
import {
  ASSESSMENT_HISTORY_CAP,
  type AssessmentInput,
  type AssessmentRecord,
  AssessmentState,
  defaultAssessmentState,
} from "./assessment/types.ts";
import { provisionFilesystem } from "./build/provision.ts";
import { assembleSystemPrompt } from "./build/systemPrompt.ts";
import { type EntityTemplate, getTemplate } from "./build/template.ts";
import {
  BuildStatus,
  type BuildStep,
  defaultBuildStatus,
} from "./build/types.ts";
import {
  DEFAULT_HEADLESS_STEP_BUDGET,
  DISCOVERY_MIN_TURNS,
  DISCOVERY_STEP_BUDGET,
  INTERACTIVE_STEP_BUDGET,
} from "./config.ts";
import type {
  ConversationDetail,
  ConversationSummary,
} from "./conversations/store.ts";
import * as conversations from "./conversations/store.ts";
import {
  DEEP_DIVE_PLAN,
  phaseSpec,
  startingDeepDiveStatus,
} from "./deepdive/plan.ts";
import { buildDeepDivePhasePrompt } from "./deepdive/prompt.ts";
import {
  type DeepDivePhaseRecord,
  DeepDiveStatus,
  defaultDeepDiveStatus,
} from "./deepdive/types.ts";
import { buildDiscoverySystemPrompt } from "./discovery/prompt.ts";
import { makeDiscoveryTools } from "./discovery/tools.ts";
import {
  type DiscoveryEntityType,
  DiscoveryProgress,
  DiscoverySpec,
  DiscoveryState,
  defaultDiscoveryState,
} from "./discovery/types.ts";
import {
  type AgentPersonaContext,
  buildSystemPrompt,
  DEEP_RESEARCH_OVERLAY,
} from "./prompts.ts";
import { getMeta, initAgentSchema, setMeta, sqlDriver } from "./sql.ts";
import { terminatorOrBudget } from "./stopConditions.ts";
// AgentSettings / AgentSchedule are each both a Zod schema (value) and the
// inferred type, so one value import covers `.parse(...)` and type positions.
import {
  AgentSchedule,
  AgentSettings,
  defaultSchedule,
  defaultSettings,
} from "./types.ts";

const SETTINGS_KEY = "settings";
const SCHEDULE_KEY = "schedule";
// Scheduling state (MNEMO-27), persisted to DO-SQLite so it survives hibernation
// (PRD §7.1): the id of the single pending `runScheduled` alarm (so we cancel/
// re-arm exactly one, never accumulate) and the DO-side last-run marker the
// chained `scheduleNextRun` advances. The PLATFORM-side marker the cron fan-out
// reads lives in SCHEDULE_KV (src/schedule/fanout.ts) - a separate concern.
const SCHEDULED_RUN_KEY = "schedule:runScheduleId";
const SCHEDULE_LAST_RUN_KEY = "schedule:lastRunAt";
// Sandbox lifecycle state, persisted to DO-SQLite so the idle decision survives
// hibernation (PRD §7.1): the last-activity timestamp and the id of the pending
// idle-down alarm (so we can cancel/re-arm exactly one, never accumulate).
const LAST_ACTIVITY_KEY = "sandbox:lastActivityTs";
const IDLE_SCHEDULE_KEY = "sandbox:idleScheduleId";
// Billing/enforcement state (MNEMO-49), persisted to DO-SQLite so it survives
// hibernation: the epoch-ms when the current container booted (so idle-down can
// meter active sandbox-seconds) and the KV concurrency-slot lease id held for
// this boot (released on idle-down). Both cleared (set to JSON `null`) on stop.
const SANDBOX_BOOT_KEY = "sandbox:bootTs";
const SANDBOX_LEASE_KEY = "sandbox:leaseId";

// Discovery lifecycle state (MNEMO-29), persisted to DO-SQLite so the clarify-
// scope conversation survives hibernation. The structured state (status/spec/
// turns) lives under `discovery`; the opening name+description (needed to rebuild
// the system prompt each turn) under `discovery:input`; the running clarify-scope
// transcript under `discovery:messages`.
const DISCOVERY_KEY = "discovery";
const DISCOVERY_INPUT_KEY = "discovery:input";
const DISCOVERY_MESSAGES_KEY = "discovery:messages";

// Build lifecycle state (MNEMO-30), persisted to DO-SQLite so a provisioning run
// that fails mid-way (a half-built sandbox) is resumable across hibernation: each
// completed BuildStep is recorded here so a re-run skips it.
const BUILD_KEY = "build";

// Onboarding deep dive (the agent's multi-phase initial research). The phase
// progress (the resume cursor) lives under `deepdive`; `deepdive:scheduleId`
// tracks the single pending phase alarm (cancel/re-arm exactly one, never
// accumulate - mirrors the run/idle alarm bookkeeping). `DEEP_DIVE_KICKOFF_DELAY_SEC`
// lets POST /build return before the (background) dive boots the sandbox;
// `DEEP_DIVE_PHASE_GAP_SEC` is the short gap chained between phases.
const DEEPDIVE_KEY = "deepdive";
const DEEPDIVE_SCHEDULE_KEY = "deepdive:scheduleId";
const DEEP_DIVE_KICKOFF_DELAY_SEC = 2;
const DEEP_DIVE_PHASE_GAP_SEC = 2;

// Weekly self-assessment ("Karpathy loop"). The rolling review history lives
// under `assessment`; `assessment:scheduleId` tracks the single pending weekly
// alarm. `operatingNotes` caches the agent's self-authored operating playbook
// (the system-prompt-learning artifact) so every turn's prompt carries it without
// waking the sandbox; it is also mirrored to a brain note for the human to read.
const ASSESSMENT_KEY = "assessment";
// The self-review ("Karpathy loop") is no longer on its own cron - it runs right
// after each weekly research update (see defaultScheduledRun), armed as a short
// one-shot so it gets its own bounded alarm rather than piling into the research
// handler. Its cadence IS the research cadence.
const ASSESSMENT_KICKOFF_DELAY_SEC = 2;
const OPERATING_NOTES_KEY = "operatingNotes";
// The brain note the operating playbook is mirrored to (human-readable + versioned).
const OPERATING_NOTES_SLUG = "operating-playbook";
// Runaway ceiling for one weekly self-review (the terminator is the intended exit).
const ASSESSMENT_STEP_BUDGET = 40;

// Nightly "dream": the recurring memory-consolidation ("sleep") pass - merge
// near-duplicates, relink now-resolvable danglers, compress. Runs at a per-agent
// RANDOM time within a UTC night window (nextDreamDelaySec - spreads sandbox boots
// to avoid a thundering herd) and ONLY when the agent was used since its last dream
// (LAST_ACTIVITY vs DREAM_LAST_RUN_KEY - no point consolidating an unchanged brain).
// Armed when the deep dive completes, re-chained after every pass. The planner is
// model-free (src/memory/consolidation.ts), so a dream's only cost is the sandbox
// boot. `consolidate:scheduleId` tracks the pending alarm; `consolidate:lastRunAt`
// stamps the last completed dream (the "was it used since?" comparison point).
const CONSOLIDATION_SCHEDULE_KEY = "consolidate:scheduleId";
const DREAM_LAST_RUN_KEY = "consolidate:lastRunAt";

// Messaging inbound receipt (MNEMO-45). A lightweight record of the last inbound
// message the gateway handed off - the MNEMO-45 gateway smoke test reads it back
// to prove the gateway→DO handoff landed. Distinct from the real transcript
// (`msg_session`/`msg_message`, MNEMO-46) the web UI renders.
const LAST_INBOUND_KEY = "messaging:lastInbound";

// Messaging access control (MNEMO-47, PRD §9.6). The gateway loads these from
// `agent_meta` to decide whether to accept an inbound message and at what tier:
// the owner's verified E.164 (a sender matching it resolves to the `owner` tier;
// unset ⇒ owner tier unreachable until registered) and the open-to-the-world flag
// (whitelist-by-default ⇒ false unless the owner deliberately opens the agent).
const MESSAGING_OWNER_NUMBER_KEY = "messaging:ownerNumber";
const MESSAGING_OPEN_TO_WORLD_KEY = "messaging:openToWorld";

// Messaging reply (MNEMO-46, PRD §9.3). The SMS reply runs the SAME brain/memory/
// tools loop web chat uses, with this overlay so the model keeps its reply terse
// and SMS-appropriate (long output links to the full web thread, §9.2/§9.3).
const SMS_REPLY_OVERLAY =
  "You are replying to a text message (SMS). Keep your reply terse and " +
  "conversational - a few short sentences at most. Do NOT use markdown, " +
  "headings, code blocks, or bullet lists. If the full answer is long or " +
  "detailed, give a one- or two-sentence summary and tell the user the complete " +
  "version is in their web thread.";

// Bound how much of a counterparty's transcript rides into the loop as context -
// the most recent turns, so an old daily session doesn't blow the prompt budget.
const MAX_REPLY_CONTEXT_MESSAGES = 20;

// Group threads (MNEMO-48, PRD §9.4/§9.5). The agent records the full multi-party
// history into a group session keyed by threadId. On FIRST sight of a group it runs
// the §9.6 permissive whitelist auto-expansion (every member gains the right to DM
// the bot); this meta key (one per threadId) makes that a once-per-group action.
const GROUP_JOINED_PREFIX = "group:joined:";
// How many recent group-session lines recordGroupMessage hands back to the
// coordinator as the triage gate's context (bounded so a long thread still fits).
const MAX_GROUP_TAIL_MESSAGES = 12;

/**
 * Payload for the deferred {@link MnemosyneAgent.runInboundReply} alarm (MNEMO-46).
 * Carries what the reply needs that isn't re-derivable: the daily session to read
 * the transcript from, and the SMS routing (`to` = the counterparty, `fromNumber`
 * = the agent's provisioned number). Parsed defensively because an alarm payload
 * survives hibernation and could carry a stale shape.
 */
const InboundReplyTask = z.object({
  sessionId: z.string(),
  to: z.string(),
  fromNumber: z.string(),
  channel: Channel,
  // The capability tier the gateway resolved for the sender (MNEMO-47, §9.6) -
  // threaded through so the reply's system context is constrained to it (§9.6's
  // gating takes effect here). Defaults to `owner` so a pre-MNEMO-47 alarm payload
  // (or a direct test call) keeps the unconstrained MNEMO-46 1:1 behavior.
  tier: CapabilityTier.default("owner"),
});
/** Input shape (tier optional - `.default` fills it on parse) for callers/schedule. */
type InboundReplyTaskInput = z.input<typeof InboundReplyTask>;

// The operational tool capabilities Build enables (MNEMO-30 step 5): web
// search/fetch + sandbox exec + self-authored tools (the MNEMO-16/17/19
// registry). Recorded as a capability list in settings.enabledTools - the
// forward-looking flag the harness consults to gate the live tool surface.
const OPERATIONAL_TOOLS: readonly string[] = [
  "web_search",
  "web_fetch",
  "sandbox_exec",
  "self_authored_tools",
];

/** Returned by {@link MnemosyneAgent.build} when Discovery has not finalized a spec. */
const BUILD_NEEDS_SPEC =
  "Build requires a finalized Discovery spec (status must be 'complete').";

// ─── Harness identity (MNEMO-15) ─────────────────────────────────────────────
// The per-agent registry context (agentId / owning account / template / system
// prompt) cached in DO-SQLite so it survives hibernation and a cold DO can build
// its persona + resolve its per-user model without a D1 read on every wake.
const REGISTRY_KEY = "registry:context";
// Owning account id captured from the per-connection identity header the Worker
// forwards (the §3 x-rep-jwt threading pattern), so a cold DO that gets a request
// before its D1 row is loaded can still self-identify for getModel/recordUsage.
const ACCOUNT_KEY = "identity:accountId";
/** Header the Worker copies the authenticated account id into before forwarding. */
const ACCOUNT_HEADER = "x-mnemo-account";

/** Registry context cached in DO-SQLite (mirrors the agent's D1 row subset). */
interface RegistryContext {
  agentId: string;
  accountId: string;
  template: AgentTemplate | null;
  systemPrompt: string | null;
  /**
   * The owning account's profile (timezone + owner name/notes), mirrored here so
   * the persona's date + "about the person" layers build without a D1 read every
   * turn. Optional: a pre-0012 cached context lacks it (⇒ `undefined`), which
   * {@link MnemosyneAgent.rehydrateContext} treats as "load it from D1 once" - a
   * stored profile is an object (never `undefined`), even when its fields are all
   * null. Refreshed on edit via {@link MnemosyneAgent.updateOwnerProfile}.
   */
  ownerProfile?: AccountProfile;
}

export class MnemosyneAgent extends AIChatAgent<Env> {
  /** In-memory guard so the idempotent DDL runs once per wake, not per call. */
  private schemaReady = false;

  // ─── Harness context (MNEMO-15) ──────────────────────────────────────────
  // Rehydrated from the D1 registry row (cached in DO-SQLite) on first use. Kept
  // as in-DO fields so the loop reads them without re-querying every turn; the
  // canonical copy is the `agents` table (PRD §7.4), this is the operating mirror.
  /** Owning account id - threads into `getModel`/`recordUsage` (per-user billing). */
  private accountId: string | null = null;
  /** Entity-template lens for the persona overlay (mirrors `agents.template`). */
  private template: AgentTemplate | null = null;
  /** Operator-authored system prompt (mirrors `agents.system_prompt`). */
  private agentSystemPrompt: string | null = null;
  /** Owning account's owner profile (timezone + name/notes); null until loaded. */
  private ownerProfile: AccountProfile | null = null;
  /** True once the registry context has been loaded (from cache or D1) this wake. */
  private contextLoaded = false;

  /**
   * TEST-ONLY model override. Production leaves this undefined and
   * `resolveModel()` goes through `getModel()`. The vitest-pool-workers DO tests
   * can't swap the `AI` binding on a runtime-constructed DO, so they inject the
   * `ai` SDK's `MockLanguageModelV3` here (via `runInDurableObject`) to keep the
   * loop hermetic - no real inference, no module mocking.
   */
  testModelOverride?: ResolvedModel;

  /**
   * TEST-ONLY sandbox override (mirrors {@link testModelOverride}). The
   * workers-pool env can't boot a real container, so the tool-integration test
   * injects a {@link SandboxClient} wrapping a stub `SandboxLike` here; the
   * harness drives the tool registry against it instead of warming a real
   * sandbox. Production leaves this undefined and warms the live container.
   */
  testSandboxOverride?: SandboxClient;

  /**
   * TEST-ONLY audit sink (mirrors the override pattern above). When this array is
   * set, every emitted event is ALSO recorded here so tests can assert what the
   * loop + terminator narrated (e.g. `report.generated` on a clean exit, or the
   * `error`-level soft-fail note when no report came back). In production it is
   * undefined and {@link emitAudit} forwards solely to the AuditLog DO (MNEMO-20).
   */
  testAuditSink?: AuditInput[];

  /**
   * Cached forwarding emitter to this agent's AuditLog DO (MNEMO-20/21). Bound to
   * a `null` sessionId because the generic {@link AuditEmitter.emit} passthrough
   * preserves each input's own `sessionId`; the DO stub is cast through
   * {@link AuditEmitTarget} to bridge the not-yet-typed RPC boundary (MNEMO-22).
   */
  private auditOut?: AuditEmitter;

  /**
   * Injectable scheduled-run executor (MNEMO-27). The seam where the REAL
   * scheduled work hooks in - MNEMO-15's headless loop + MNEMO-26's delta report
   * for `kind: "report"`, or {@link onConsolidateIdle} for `kind: "consolidation"`
   * - so scheduling has NO hard dependency on those phases landing. Left
   * undefined in production today: {@link runScheduled} falls back to
   * {@link defaultScheduledRun}, a stub that just narrates a session pair. Tests
   * also set this to drive deterministic / failing runs.
   */
  scheduledRunner?: (run: ScheduledRunPayload) => Promise<void>;

  /**
   * Ensure the DO-SQLite schema exists. Called on first use (rather than in the
   * constructor) so we never run SQL before the base AIChatAgent finishes its
   * own setup. The flag resets on hibernation; `CREATE TABLE IF NOT EXISTS`
   * makes the post-wake re-run a cheap no-op.
   */
  private ensureInit(): void {
    if (this.schemaReady) return;
    initAgentSchema(this.ctx.storage.sql);
    this.schemaReady = true;
  }

  /** Current settings, or `defaultSettings()` if never written. */
  getSettings(): AgentSettings {
    this.ensureInit();
    const json = getMeta(this.ctx.storage.sql, SETTINGS_KEY);
    return json ? AgentSettings.parse(JSON.parse(json)) : defaultSettings();
  }

  /** Merge `patch` over the persisted (or default) settings and store. */
  updateSettings(patch: Partial<AgentSettings>): AgentSettings {
    const merged = AgentSettings.parse({ ...this.getSettings(), ...patch });
    setMeta(this.ctx.storage.sql, SETTINGS_KEY, JSON.stringify(merged));
    return merged;
  }

  /**
   * Current run schedule, or `defaultSchedule()` if never written.
   *
   * Named `getScheduleConfig`, NOT `getSchedule`, on purpose: the `agents` base
   * class already owns `getSchedule(id)` / `getSchedules()` for its alarm-based
   * task scheduler (which MNEMO-27 builds on), and that signature is
   * incompatible with ours. This pair persists the agent's *run configuration*
   * (cron + enabled) - a distinct concern from the SDK's scheduled-task registry.
   */
  getScheduleConfig(): AgentSchedule {
    this.ensureInit();
    const json = getMeta(this.ctx.storage.sql, SCHEDULE_KEY);
    return json ? AgentSchedule.parse(JSON.parse(json)) : defaultSchedule();
  }

  /** Merge `patch` over the persisted (or default) schedule and store. */
  updateScheduleConfig(patch: Partial<AgentSchedule>): AgentSchedule {
    const merged = AgentSchedule.parse({
      ...this.getScheduleConfig(),
      ...patch,
    });
    setMeta(this.ctx.storage.sql, SCHEDULE_KEY, JSON.stringify(merged));
    return merged;
  }

  // ─── Sandbox lifecycle (MNEMO-06) ────────────────────────────────────────
  // The DO is the always-cheap home (PRD §7.4) and the ONLY owner of sandbox
  // lifecycle: request handlers never start or stop a container, so a sandbox is
  // never left running. The DO warms the container on activity and arms an idle
  // alarm via the `agents` scheduler (`this.schedule`), which survives
  // hibernation (crema-architecture-reference.md §8) and fires `onSandboxIdle`.

  /**
   * Warm this agent's sandbox (rehydrating its brain FS from R2 on a cold
   * start), record the activity, and arm the idle-down alarm. `this.name` is the
   * agentId (the idFromName key), so the sandbox maps 1:1 to this DO. Returns the
   * ready handle; the agentic loop (MNEMO-15) does NOT run here.
   */
  private async warmSandbox(): Promise<SandboxClient> {
    this.ensureInit();
    let sandbox: SandboxClient;
    let coldStart: boolean;
    if (this.testSandboxOverride) {
      // Test path: the workers pool can't boot a real container. Treat it as a
      // cold boot only the FIRST time per active period (until idle-down clears
      // the boot marker) so the MNEMO-49 lease + sandbox-seconds bookkeeping still
      // runs exactly once - mirroring a real boot/idle-down cycle.
      sandbox = this.testSandboxOverride;
      coldStart = this.readMetaJson<number>(SANDBOX_BOOT_KEY) === null;
    } else {
      const warmed = await ensureWarm(this.env, this.name);
      sandbox = warmed.sandbox;
      coldStart = warmed.coldStart;
    }
    // MNEMO-49 enforcement: on a fresh boot, lease a concurrency slot and stamp
    // the boot time (the sandbox-seconds meter reads it at idle-down).
    if (coldStart) await this.leaseSandboxSlotOnBoot();
    await this.recordActivityAndArmIdle();
    return sandbox;
  }

  /** Read a JSON `agent_meta` value, or null when unset OR cleared to JSON `null`. */
  private readMetaJson<T>(key: string): T | null {
    const raw = getMeta(this.ctx.storage.sql, key);
    return raw === null ? null : (JSON.parse(raw) as T | null);
  }

  /**
   * MNEMO-49 enforcement (sandbox spin-up): a container just booted. Stamp the
   * boot time so idle-down can meter active sandbox-seconds, and lease a per-account
   * concurrency slot (the §8.4 cost guard). Best-effort: KV/D1 leasing is a SOFT
   * bound, so a glitch here NEVER blocks the boot (admission already gated the run).
   */
  private async leaseSandboxSlotOnBoot(): Promise<void> {
    setMeta(this.ctx.storage.sql, SANDBOX_BOOT_KEY, JSON.stringify(Date.now()));
    try {
      await this.rehydrateContext();
      if (!this.accountId) return;
      const tier = getTier(
        (await getSubscription(this.env, this.accountId)).tier,
      );
      const { leased, leaseId } = await acquireSandboxSlot(
        this.env,
        this.accountId,
        tier.maxConcurrentSandboxes,
      );
      if (leased && leaseId) {
        setMeta(
          this.ctx.storage.sql,
          SANDBOX_LEASE_KEY,
          JSON.stringify(leaseId),
        );
      }
    } catch {
      // Soft cost bound (§8.4) - never block a boot on a leasing glitch.
    }
  }

  /**
   * MNEMO-49 enforcement (sandbox teardown): the container stopped. Release the
   * concurrency slot and meter the active sandbox-seconds into the usage ledger.
   * Invoked by {@link onSandboxIdle} after the container is released; public so the
   * teardown path is exercisable. Idempotent - clears the markers first so a
   * re-fire can't double-count. Best-effort: metering must never crash teardown.
   */
  async meterAndReleaseSandbox(): Promise<void> {
    this.ensureInit();
    const bootTs = this.readMetaJson<number>(SANDBOX_BOOT_KEY);
    const leaseId = this.readMetaJson<string>(SANDBOX_LEASE_KEY);
    setMeta(this.ctx.storage.sql, SANDBOX_BOOT_KEY, JSON.stringify(null));
    setMeta(this.ctx.storage.sql, SANDBOX_LEASE_KEY, JSON.stringify(null));
    try {
      await this.rehydrateContext();
      if (!this.accountId) return;
      if (leaseId) await releaseSandboxSlot(this.env, this.accountId, leaseId);
      if (bootTs !== null) {
        const seconds = Math.max(0, (Date.now() - bootTs) / 1000);
        await meterUsage(this.env, {
          accountId: this.accountId,
          agentId: this.name,
          kind: "sandbox_sec",
          quantity: seconds,
        });
      }
    } catch {
      // Best-effort: a metering/release fault must not break idle-down.
    }
  }

  /**
   * Tear this agent down for good - the DO side of a registry DELETE
   * (service.deleteAgentOwned). First stop the container so it stops billing and
   * frees its concurrency slot; we do NOT persist the brain to R2 (idleDown's job)
   * because the agent - and its R2 snapshot - is being deleted. Then `destroy()`
   * (base AIChatAgent) drops EVERY DO-SQLite table + KV and clears the alarm, then
   * aborts the isolate on the next tick. Because of that abort, the in-flight RPC
   * may reject even on success, so the caller treats this as fire-and-forget.
   */
  async teardownForDelete(): Promise<void> {
    this.ensureInit();
    try {
      // Stop the live container without the R2 persist idleDown does.
      await getSandbox(this.env, this.name).stop();
      // Release the concurrency lease + meter the active sandbox-seconds; without
      // this a leaked lease would count against the account's cap forever.
      await this.meterAndReleaseSandbox();
    } catch {
      // Best-effort: a stop/metering fault must not block the wipe below.
    }
    // Drops all DO state + alarm, then aborts the isolate (fire-and-forget).
    await this.destroy();
  }

  /**
   * Stamp last-activity to now and ensure exactly one pending idle alarm:
   * cancel the prior one (if any) and schedule a fresh `onSandboxIdle` after
   * IDLE_TIMEOUT_MS. Persisting the timestamp lets the alarm - which may fire
   * after a hibernation/wake - decide correctly whether the agent is truly idle.
   */
  private async recordActivityAndArmIdle(): Promise<void> {
    setMeta(
      this.ctx.storage.sql,
      LAST_ACTIVITY_KEY,
      JSON.stringify(Date.now()),
    );

    const prevId = getMeta(this.ctx.storage.sql, IDLE_SCHEDULE_KEY);
    if (prevId) await this.cancelSchedule(JSON.parse(prevId));

    const delaySec = Math.ceil(IDLE_TIMEOUT_MS / 1000);
    const scheduled = await this.schedule(delaySec, "onSandboxIdle");
    setMeta(
      this.ctx.storage.sql,
      IDLE_SCHEDULE_KEY,
      JSON.stringify(scheduled.id),
    );
  }

  /**
   * Idle-down alarm. Fired by the scheduler; if the agent has truly been idle
   * for IDLE_TIMEOUT_MS it persists the brain to R2 and releases the container
   * so billing stops (active-time only, §8.4). If activity landed after this
   * alarm was armed, it re-arms for the remaining window instead of stopping.
   * Public because the scheduler invokes it by name.
   */
  async onSandboxIdle(): Promise<void> {
    this.ensureInit();
    const lastJson = getMeta(this.ctx.storage.sql, LAST_ACTIVITY_KEY);
    const last = lastJson ? (JSON.parse(lastJson) as number) : 0;
    const elapsed = Date.now() - last;

    if (elapsed >= IDLE_TIMEOUT_MS) {
      await idleDown(this.env, this.name);
      // MNEMO-49 enforcement: the container is gone - release its concurrency slot
      // and meter the active sandbox-seconds it consumed.
      await this.meterAndReleaseSandbox();
      setMeta(this.ctx.storage.sql, IDLE_SCHEDULE_KEY, JSON.stringify(null));
      return;
    }

    const remainingSec = Math.ceil((IDLE_TIMEOUT_MS - elapsed) / 1000);
    const scheduled = await this.schedule(remainingSec, "onSandboxIdle");
    setMeta(
      this.ctx.storage.sql,
      IDLE_SCHEDULE_KEY,
      JSON.stringify(scheduled.id),
    );
  }

  /**
   * Warm the sandbox, then run one shell command through the client wrapper.
   * The provisioning smoke-test path used by the debug route (MNEMO-06); real
   * tool execution is gated behind the harness/tool framework (Track C).
   */
  async runSandboxCommand(cmd: string): Promise<RunResult> {
    const sandbox = await this.warmSandbox();
    return sandbox.run(cmd);
  }

  // ─── Brain auto-commit (MNEMO-07) ────────────────────────────────────────
  // The single auto-commit chokepoint referenced by PRD §6.2/§6.9: every
  // memory-write path (MNEMO-10) and the consolidation pass MUST call
  // `commitBrain` so the brain's git history is complete and per-file diffs are
  // meaningful. Concentrating commits here (rather than scattering `git` calls)
  // is what makes MNEMO-12's history view and one-click restore trustworthy.

  /**
   * Warm the sandbox and auto-commit the brain with a (structured) message,
   * returning the new commit sha - or `null` if the tree was clean (nothing to
   * commit). This is the chokepoint described above.
   */
  async commitBrain(message: string): Promise<string | null> {
    const sandbox = await this.warmSandbox();
    return autoCommit(this.env, this.name, message, undefined, sandbox);
  }

  /**
   * Debug smoke test for the write→commit path (the `POST /brain/commit` route):
   * writes a test note at its canonical `notePath`, then commits it through
   * `commitBrain`. Proves the memory-write→auto-commit chokepoint end to end
   * before MNEMO-10 builds the real write paths on top of it.
   */
  async debugWriteNoteAndCommit(
    slug = "debug-note",
  ): Promise<{ sha: string | null; path: string }> {
    const sandbox = await this.warmSandbox();
    const path = notePath(slug);
    await sandbox.writeFile(
      path,
      `# Debug note\n\nWritten ${new Date().toISOString()} to prove the brain write→commit path (MNEMO-07).\n`,
    );
    const sha = await this.commitBrain(writeCommitMsg(slug));
    return { sha, path };
  }

  // ─── Memory graph index (MNEMO-08) ───────────────────────────────────────
  // The neuron/synapse index lives in DO-SQLite so search, traversal, and
  // brain-size work WITHOUT waking the sandbox container (PRD §7.4). `GraphIndex`
  // is stateless (just a wrapper over the SQL driver), so it's built on demand
  // over `ctx.storage.sql` rather than cached on the (hibernating) instance.
  //
  // The reindex hooks below keep that DO index in lockstep with the brain: the
  // memory-write paths (MNEMO-10) MUST call `reindexNote` after every write, so
  // the graph reflects the FS without subsequent reads ever waking the container.
  // This phase implements the reindex hook only - NOT the write API itself.

  /** Build a `GraphIndex` over this DO's SQLite (schema ensured via `ensureInit`). */
  private graph(): GraphIndex {
    this.ensureInit();
    return new GraphIndex(sqlDriver(this.ctx.storage.sql));
  }

  /**
   * Re-index one note: read it from the sandbox (MNEMO-06 client) and upsert its
   * neuron + outgoing synapses. Called by every memory-write path after a write
   * so the index stays current; the read here is the only sandbox touch.
   */
  async reindexNote(path: string): Promise<void> {
    const sandbox = await this.warmSandbox();
    const content = await sandbox.readFile(path);
    // Store the content hash so the next bulk sweep can skip this note unless it
    // changes again - keeping the single-write and bulk paths' notion of
    // "unchanged" identical (both are SHA-256 over the same UTF-8 bytes).
    this.graph().upsertNeuron(
      path,
      titleFromContent(content),
      content,
      await hashContent(content),
    );
  }

  /**
   * Re-index `/brain/notes` incrementally. The generic `writeFile` tool skips the
   * per-write reindex hook, so this sweep runs after every research/deep-dive
   * phase and after a restore (R2 → sandbox) to keep the DO index in lockstep with
   * the FS. Rather than re-read + re-parse every note each time (which also reset
   * every neuron's `updated_at`, destroying recency ordering), it hashes the whole
   * tree in ONE `sha256sum` command, diffs against the stored hashes, and reads +
   * upserts only the notes that actually changed - dropping neurons whose files
   * are gone. Returns the number of note files now indexed (the prior contract).
   */
  async reindexAllNotes(): Promise<number> {
    const sandbox = await this.warmSandbox();
    const fsHashes = await this.hashNotes(sandbox);
    const graph = this.graph();
    // FS-side hashing unavailable (no `sha256sum`, command error) → fall back to a
    // full read so the index is never left stale, still populating content hashes.
    if (fsHashes === null) return this.fullReindex(sandbox, graph);

    const plan = planReindex(fsHashes, graph.indexedHashes());
    for (const path of plan.toIndex) {
      const content = await sandbox.readFile(path);
      graph.upsertNeuron(
        path,
        titleFromContent(content),
        content,
        fsHashes.get(path) ?? null,
      );
    }
    for (const path of plan.toRemove) graph.removeNeuron(path);
    return fsHashes.size;
  }

  /**
   * Hash every note under `/brain/notes` in one batched `sha256sum` so a re-index
   * sweep can diff FS state against the index without reading file bodies. Returns
   * a path → hex-hash map, or `null` when FS-side hashing isn't available so the
   * caller falls back to a full read. A leading `*` (binary-mode marker) is
   * stripped from the path so the hash lines parse on any coreutils variant.
   */
  private async hashNotes(
    sandbox: SandboxClient,
  ): Promise<Map<string, string> | null> {
    const res = await sandbox.run(
      `find ${NOTES_DIR} -type f -name '*.md' -exec sha256sum {} +`,
    );
    if (res.exitCode !== 0) return null;
    const map = new Map<string, string>();
    for (const line of res.stdout.split("\n")) {
      const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
      if (match) map.set(match[2], match[1]);
    }
    return map;
  }

  /**
   * Whole-tree fallback re-index: read + upsert every note (the pre-incremental
   * behavior) when {@link hashNotes} can't hash FS-side. Each note's hash is still
   * computed in-process so the index carries content hashes regardless of path.
   */
  private async fullReindex(
    sandbox: SandboxClient,
    graph: GraphIndex,
  ): Promise<number> {
    const found = await sandbox.run(`find ${NOTES_DIR} -type f -name '*.md'`);
    const paths = found.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    for (const path of paths) {
      const content = await sandbox.readFile(path);
      graph.upsertNeuron(
        path,
        titleFromContent(content),
        content,
        await hashContent(content),
      );
    }
    return paths.length;
  }

  // ─── Graph retrieval (MNEMO-09) ──────────────────────────────────────────
  // Read-only pass-throughs to `GraphIndex`. They read straight from the
  // DO-SQLite index (`ctx.storage.sql`) and DO NOT warm the sandbox (PRD §7.4) -
  // search, traversal, and brain-size all answer while the container stays
  // asleep. The API routes (src/index.ts) call these over native Workers RPC;
  // the agent consumes them as a retrieval tool in Track C (MNEMO-16).

  /** BFS subgraph from `startSlug` (bounded). Reads the DO index; no sandbox warm. */
  graphTraverse(startSlug: string, opts?: TraverseOpts): Subgraph {
    return this.graph().traverse(startSlug, opts);
  }

  /** Whole brain as one capped subgraph (Graph-tab default). Reads the DO index; no sandbox warm. */
  graphWhole(opts?: { maxNodes?: number }): Subgraph {
    return this.graph().wholeGraph(opts);
  }

  /** Edges touching `slug` in `dir`. Reads the DO index; no sandbox warm. */
  graphNeighbors(slug: string, dir?: Direction): SynapseRef[] {
    return this.graph().neighbors(slug, dir);
  }

  /** Bounded title/slug search over the index. Reads the DO index; no sandbox warm. */
  graphSearch(query: string, limit?: number): NeuronRef[] {
    return this.graph().searchNeurons(query, limit);
  }

  /** Canonical brain size (neurons/synapses/dangling). Reads the DO index; no sandbox warm. */
  getBrainSize(): BrainSize {
    return this.graph().brainSize();
  }

  // ─── Memory write API (MNEMO-10) ─────────────────────────────────────────
  // The write side of memory: every note mutation warms the sandbox, then runs
  // the src/memory/write.ts pipeline (writeFile → reindex → commit) so the FS,
  // the DO graph index, and the git history stay in lockstep. The graph/commit
  // operations the pipeline needs are passed as `this`-bound hooks (see
  // `writeHooks`) rather than a self-addressed DO stub - a DO calling its own RPC
  // stub would deadlock. The Worker routes (src/index.ts) call these over RPC.

  /** Write a full note (writeFile → reindex → commit). Returns path + commit sha. */
  async memoryWrite(input: NoteWriteInput): Promise<NoteWriteResult> {
    const sandbox = await this.warmSandbox();
    const result = await writeNote(
      this.env,
      this.name,
      input,
      this.writeHooks(),
      sandbox,
    );
    // MNEMO-21: a write is a memory event - narrate the neuron + its new synapses
    // (the wikilinks the parser just recorded). No session here: a route-driven
    // write isn't part of a research run (sessionId null).
    await this.emitMemoryWrite(null, input.slug, result.path, input.content);
    return result;
  }

  /** Append to a note (read-then-write → reindex → commit). Creates if absent. */
  async memoryAppend(input: NoteAppendInput): Promise<NoteWriteResult> {
    const sandbox = await this.warmSandbox();
    const result = await appendNote(
      this.env,
      this.name,
      input,
      this.writeHooks(),
      sandbox,
    );
    // The appended text carries any new links - narrate those (MNEMO-21).
    await this.emitMemoryWrite(null, input.slug, result.path, input.content);
    return result;
  }

  /** Delete a note (rm → removeNeuron → commit). Incoming links go dangling. */
  async memoryDelete(slug: string): Promise<NoteWriteResult> {
    const sandbox = await this.warmSandbox();
    return deleteNote(this.env, this.name, slug, this.writeHooks(), sandbox);
  }

  /**
   * Narrate a memory write (MNEMO-21): one `memory.wrote` for the neuron, plus a
   * `memory.linked` per distinct `[[wikilink]]` the content declares (the synapses
   * the MNEMO-08 reindex just recorded). Runs the same pure parser the index uses,
   * so the audit stream agrees with the graph. Best-effort - the emitter swallows.
   */
  private async emitMemoryWrite(
    sessionId: string | null,
    slug: string,
    path: string,
    content: string,
  ): Promise<void> {
    const audit = this.auditFor(sessionId);
    await audit.memoryWrote(path, `Wrote note "${slug}"`);
    const targets = new Set<string>();
    for (const link of parseWikilinks(content)) targets.add(link.target);
    for (const target of targets) {
      await audit.memoryLinked(slug, target, `Linked ${slug} → ${target}`);
    }
  }

  /**
   * The graph + commit operations the write pipeline composes, bound to `this`
   * so the pipeline invokes the DO's own methods directly (no self-RPC). Shared
   * by the write API above and the consolidation apply pass.
   */
  private writeHooks(): BrainWriteHooks {
    return {
      reindexNote: (path) => this.reindexNote(path),
      removeNeuron: (path) => {
        this.graph().removeNeuron(path);
      },
      commitBrain: (message) => this.commitBrain(message),
    };
  }

  // ─── Consolidation: the "sleep" pass (MNEMO-10, PRD §6.2) ────────────────
  // The agent re-reads, merges, and re-links its own notes. Planning is pure
  // (src/memory/consolidation.ts); applying is versioned + diffed before commit
  // (src/memory/consolidation-apply.ts). `dryRun` returns the plan + diffs
  // without touching the brain; otherwise the pass applies and makes ONE commit.

  /**
   * Run (or preview) a consolidation pass. Reads the current notes, plans the
   * pass, and - unless `dryRun` - applies it as one diffed, versioned commit.
   * `dryRun` (the default) returns the same plan + diffs with `commit: null`.
   */
  async consolidate({
    dryRun = true,
    sessionId = null,
  }: {
    dryRun?: boolean;
    sessionId?: string | null;
  } = {}): Promise<{
    dryRun: boolean;
    plan: ConsolidationPlan;
    diffs: ConsolidationDiff[];
    commit: string | null;
  }> {
    const sandbox = await this.warmSandbox();
    const notes = await this.readNotes(sandbox);
    const plan = planConsolidation(notes);

    if (dryRun) {
      return { dryRun: true, plan, diffs: diffPlan(plan), commit: null };
    }
    const { commit, diffs } = await applyConsolidation(
      this.env,
      this.name,
      plan,
      this.writeHooks(),
      sandbox,
    );

    // MNEMO-21: a consolidation pass is a milestone - narrate what merged/relinked
    // with counts + the git ref (§6.9). `sessionId` groups it with the scheduled
    // pass's session.started/completed when one is supplied.
    const merges = plan.ops.filter((op) => op.type === "merge").length;
    const relinks = plan.ops.filter((op) => op.type === "relink").length;
    await this.auditFor(sessionId).memoryConsolidated(
      `Consolidated brain: ${merges} merge(s), ${relinks} relink(s)`,
      { ops: plan.ops.length, merges, relinks, commit },
    );

    return { dryRun: false, plan, diffs, commit };
  }

  /**
   * One consolidation ("dream") pass - the "sleep" pass of PRD §6.2 and the body
   * of the nightly {@link runNightlyConsolidation} loop. Runs only when the tree is
   * clean so the consolidation commit stays isolated; a dirty tree defers to the
   * next pass rather than entangling commits. Public because the scheduler may
   * invoke it by name.
   */
  async onConsolidateIdle(): Promise<void> {
    const sandbox = await this.warmSandbox();
    if (!(await isCleanTree(this.env, this.name, sandbox))) return; // defer
    // MNEMO-21: this pass runs OUTSIDE a research loop, so mint a synthetic
    // session (`consolidate:<ts>`) and wrap it with session.started/completed so
    // its memory.consolidated event still groups into one stream.
    const sessionId = `consolidate:${Date.now()}`;
    const audit = this.auditFor(sessionId);
    await audit.sessionStarted("Started scheduled consolidation");
    try {
      const { plan, commit } = await this.consolidate({
        dryRun: false,
        sessionId,
      });
      await audit.sessionCompleted("Consolidation complete", {
        ops: plan.ops.length,
        commit,
      });
    } catch (err) {
      await audit.error(`Consolidation failed: ${errMessage(err)}`, {
        sessionId,
      });
      throw err;
    }
  }

  /**
   * Arm the next nightly dream at a per-agent RANDOM time within the UTC night
   * window ({@link nextDreamDelaySec}) - the jitter spreads sandbox boots so every
   * agent doesn't dream at the same instant. Cancels any previously-armed dream
   * alarm first (never accumulate across wakes). Its own alarm slot.
   */
  async scheduleNextConsolidation(): Promise<void> {
    this.ensureInit();
    const prevId = getMeta(this.ctx.storage.sql, CONSOLIDATION_SCHEDULE_KEY);
    if (prevId && prevId !== "null") {
      await this.cancelSchedule(JSON.parse(prevId) as string);
    }
    const delaySec = nextDreamDelaySec(Date.now(), Math.random());
    const scheduled = await this.schedule(delaySec, "runNightlyConsolidation");
    setMeta(
      this.ctx.storage.sql,
      CONSOLIDATION_SCHEDULE_KEY,
      JSON.stringify(scheduled.id),
    );
  }

  /**
   * Run one nightly dream - but ONLY if the agent was used since the last one - then
   * re-chain the next. Fired by the scheduler by name; PUBLIC for that reason.
   *
   * The "used" gate compares LAST_ACTIVITY (stamped on every sandbox warm - chat,
   * research, writes) against the last completed dream; if nothing happened since,
   * we skip WITHOUT booting a container (the check precedes any warm), so an idle
   * agent costs nothing nightly. When it did run, the pass itself
   * ({@link onConsolidateIdle}) is the model-free "sleep" pass, so its only cost is
   * the sandbox boot - still gated on the monthly cost cap (fail-open) and only for
   * `ready` agents. Best-effort and self-contained: any failure is swallowed
   * (onConsolidateIdle narrates its own) and the cadence ALWAYS re-chains in the
   * `finally`, so one bad/skipped dream never stops the loop.
   */
  async runNightlyConsolidation(): Promise<void> {
    this.ensureInit();
    try {
      if (this.getBuildStatus().phase !== "ready") return;

      // Dream iff used since last dream - checked before any sandbox warm.
      const lastActivity = this.readMetaJson<number>(LAST_ACTIVITY_KEY) ?? 0;
      const lastDream = this.readMetaJson<number>(DREAM_LAST_RUN_KEY) ?? 0;
      if (lastActivity <= lastDream) return;

      if (this.accountId) {
        const cap = await checkCostCap(this.env, this.accountId).catch(
          () => null,
        );
        if (cap && !cap.allowed) return;
      }
      await this.onConsolidateIdle();
      // Stamp the completed dream so the next night's "was it used?" gate compares
      // against now (the dream's own sandbox warm bumped LAST_ACTIVITY just before).
      setMeta(
        this.ctx.storage.sql,
        DREAM_LAST_RUN_KEY,
        JSON.stringify(Date.now()),
      );
    } catch {
      // Swallowed: a thrown alarm callback would just retry the (sandbox) spend;
      // the dream re-chains below regardless.
    } finally {
      await this.scheduleNextConsolidation();
    }
  }

  // ─── Scheduling: per-agent run cadence (MNEMO-27, PRD §6.4/§7.4/§8.5) ─────
  // This is the per-agent half of the two-layer scheduler. The DO arms its OWN
  // next run via `this.schedule` (the `agents` SDK alarm scheduler) - which
  // SURVIVES HIBERNATION (§7.1), so an agent keeps its cadence even after the DO
  // is evicted. The Worker `scheduled` cron (src/schedule/fanout.ts) is the
  // independent safety net that wakes a DO whose own timer was lost before it
  // fired. We arm a DELAYED one-shot (not the SDK's native cron) and re-chain
  // after each run, so the SAME owned cron evaluator (src/schedule/types.ts)
  // drives both this timer and the Worker-side fan-out - one cron semantics.

  /**
   * Arm the next scheduled run from the persisted {@link getScheduleConfig}.
   * Cancels any previously-armed run alarm first (so we never accumulate
   * duplicates across wakes), then - if the schedule is enabled with a valid
   * cron - computes the next fire via `nextRunAfter` and enqueues a one-shot
   * `runScheduled` alarm. A disabled/cron-less/malformed schedule leaves the
   * timer unarmed (a bad cron must not throw into a wake path).
   */
  async scheduleNextRun(): Promise<void> {
    this.ensureInit();
    await this.cancelArmedRun();

    const schedule = this.getScheduleConfig();
    if (!schedule.enabled || !schedule.cron) return;

    let nextTs: number;
    try {
      nextTs = nextRunAfter(schedule.cron, Date.now());
    } catch {
      return; // malformed cron - leave unarmed rather than crash the wake
    }

    const delaySec = Math.max(1, Math.ceil((nextTs - Date.now()) / 1000));
    const scheduled = await this.schedule<ScheduledRunPayload>(
      delaySec,
      "runScheduled",
      { kind: "report", scheduledFor: nextTs },
    );
    setMeta(
      this.ctx.storage.sql,
      SCHEDULED_RUN_KEY,
      JSON.stringify(scheduled.id),
    );
  }

  /**
   * The scheduled-run callback (fired by the DO alarm OR forced by the cron
   * fan-out / dev route). Performs the work via the injected
   * {@link scheduledRunner} (default {@link defaultScheduledRun}), then - in a
   * `finally` so a failed run still chains - records the DO-side last-run marker
   * and arms the next occurrence. Public because the scheduler invokes it by name
   * and the fan-out calls it over RPC.
   */
  async runScheduled(payload?: ScheduledRunPayload): Promise<void> {
    this.ensureInit();
    const run = ScheduledRunPayload.parse(payload ?? {});
    try {
      if (this.scheduledRunner) await this.scheduledRunner(run);
      else await this.defaultScheduledRun(run);
    } finally {
      // Mark + re-chain regardless of outcome: one failed run must never
      // silently stop all future runs (PRD §6.4). The error (if any) still
      // propagates to the caller so the cron fan-out can record the failure.
      setMeta(
        this.ctx.storage.sql,
        SCHEDULE_LAST_RUN_KEY,
        JSON.stringify(Date.now()),
      );
      await this.scheduleNextRun();
    }
  }

  /**
   * Enable (or update) the run schedule with `cron`, persist it (MNEMO-04
   * `updateScheduleConfig`), and arm the DO timer. Returns the persisted schedule.
   * NB: the cross-agent fan-out reads the D1 `agents.schedule_cron` column - that
   * registry sync is the registry route's job (MNEMO-05); this method owns the
   * DO-side operating state + timer only.
   */
  async enableSchedule(cron: string): Promise<AgentSchedule> {
    const updated = this.updateScheduleConfig({ cron, enabled: true });
    await this.scheduleNextRun();
    return updated;
  }

  /** Disable the run schedule (keeps the cron value) and cancel the armed timer. */
  async disableSchedule(): Promise<AgentSchedule> {
    const updated = this.updateScheduleConfig({ enabled: false });
    await this.cancelArmedRun();
    return updated;
  }

  /**
   * Cancel the single pending `runScheduled` alarm (if any) and clear its stored
   * id. Mirrors the idle-alarm bookkeeping in {@link recordActivityAndArmIdle}.
   */
  private async cancelArmedRun(): Promise<void> {
    const prevId = getMeta(this.ctx.storage.sql, SCHEDULED_RUN_KEY);
    if (prevId && prevId !== "null") {
      await this.cancelSchedule(JSON.parse(prevId) as string);
    }
    setMeta(this.ctx.storage.sql, SCHEDULED_RUN_KEY, JSON.stringify(null));
  }

  /**
   * The weekly research update - the real work behind the `runScheduled` cron
   * (the `scheduledRunner` seam stays for tests; this is the production default).
   *
   * For `kind: "report"`: run a real headless research pass ({@link runHeadless})
   * off the agent's CORE SCOPE (subject + sources + output format from the finalized
   * Discovery spec) asking "what changed since last run", then sweep the tree into
   * the graph index (the writeFile tool the loop uses skips the per-write reindex
   * hook). Right after the research lands, arm the self-review ("Karpathy loop") as
   * a short one-shot so it runs in its OWN bounded alarm - review cadence == research
   * cadence, no separate cron. `kind: "consolidation"` runs the sleep pass (the
   * nightly dream owns its own loop; this only fires if a payload requests it).
   * Only `ready` agents with a finalized spec run; otherwise a no-op (never throws).
   */
  private async defaultScheduledRun(run: ScheduledRunPayload): Promise<void> {
    if (run.kind === "consolidation") {
      await this.onConsolidateIdle();
      return;
    }

    const spec = this.getDiscoveryState().spec;
    if (!spec || this.getBuildStatus().phase !== "ready") return;

    const sessionId = `scheduled:report:${Date.now()}`;
    const sources = spec.sources.length
      ? spec.sources.join("; ")
      : "the subject's official site and reputable third-party coverage";
    const prompt = [
      `This is your scheduled research update on ${spec.subject}.`,
      `Check your sources (${sources}) for what has materially changed since your last run.`,
      "Record new facts as notes under /brain/notes - give each a clear title and link related notes with [[wikilinks]]; update existing notes instead of duplicating.",
      `When you've captured what's new, call submitFinalReport with a brief (${spec.outputFormat}) that leads with what changed.`,
    ].join(" ");

    await this.runHeadless({ prompt, sessionId });
    // The loop writes notes via the generic writeFile tool, which skips the
    // per-write reindex hook - sweep the tree so new neurons/synapses land.
    await this.reindexAllNotes().catch(() => {});

    // Karpathy loop right after the research update: a short one-shot so the review
    // runs in its own bounded alarm rather than extending this handler.
    await this.schedule(ASSESSMENT_KICKOFF_DELAY_SEC, "runWeeklyAssessment");
  }

  /**
   * Read every note under `/brain/notes` into the planner's `{ slug, content }`
   * shape. The slug is the filename stem so it round-trips through `notePath`
   * (the same key the write pipeline and graph index use).
   */
  private async readNotes(sandbox: SandboxClient): Promise<NoteInput[]> {
    const found = await sandbox.run(`find ${NOTES_DIR} -type f -name '*.md'`);
    const paths = found.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

    const notes: NoteInput[] = [];
    for (const path of paths) {
      const content = await sandbox.readFile(path);
      const file = path.split("/").pop() ?? path;
      notes.push({ slug: file.replace(/\.md$/i, ""), content });
    }
    return notes;
  }

  // ─── Brain explorer (MNEMO-11) ───────────────────────────────────────────
  // The DO mediates every explorer operation: it warms the sandbox and supplies
  // the `this`-bound write hooks (reindex/removeNeuron/commit), so the Worker
  // routes (src/index.ts) never touch the sandbox directly and a note edited
  // from the web reindexes + commits exactly like an agent write. Reads are
  // size-capped + binary-aware in the service; writes/deletes funnel notes
  // through the MNEMO-10 pipeline and raw-write everything else.

  /** List the brain tree (or a sub-path) - typed entries. Warms the sandbox. */
  async brainListTree(subpath?: string): Promise<BrainEntry[]> {
    const sandbox = await this.warmSandbox();
    return listTree(this.env, this.name, subpath, sandbox);
  }

  /** Read one brain file (size-capped, base64 for binary). Warms the sandbox. */
  async brainReadFile(path: string): Promise<BrainFileContent> {
    const sandbox = await this.warmSandbox();
    return readBrainFile(this.env, this.name, path, sandbox);
  }

  /** Write/overwrite a brain file (note → pipeline; else raw + commit). */
  async brainWriteFile(input: BrainWriteInput): Promise<BrainWriteResult> {
    const sandbox = await this.warmSandbox();
    return writeBrainFile(
      this.env,
      this.name,
      input,
      this.writeHooks(),
      sandbox,
    );
  }

  /** Create a brain file, failing if it already exists. */
  async brainCreateFile(input: BrainWriteInput): Promise<BrainWriteResult> {
    const sandbox = await this.warmSandbox();
    return createBrainFile(
      this.env,
      this.name,
      input,
      this.writeHooks(),
      sandbox,
    );
  }

  /** Create a directory under `/brain` (no commit - git ignores empty dirs). */
  async brainCreateDir(path: string): Promise<{ path: string }> {
    const sandbox = await this.warmSandbox();
    return createBrainDir(this.env, this.name, path, sandbox);
  }

  /** Delete a brain path (note → pipeline; else `rm -rf` + commit). */
  async brainDeletePath(path: string): Promise<BrainWriteResult> {
    const sandbox = await this.warmSandbox();
    return deleteBrainPath(
      this.env,
      this.name,
      path,
      this.writeHooks(),
      sandbox,
    );
  }

  /** Build a whole-brain archive (zip/tar, includes `.git`). Warms the sandbox. */
  async brainArchive(format: ArchiveFormat): Promise<BrainArchive> {
    const sandbox = await this.warmSandbox();
    return archiveBrain(this.env, this.name, format, sandbox);
  }

  // ─── Brain versioning (MNEMO-12) ─────────────────────────────────────────
  // History/diff/restore over the brain's git repo (PRD §6.9). Every method
  // warms the sandbox (git lives in the container) and delegates to
  // src/memory/versioning.ts. Restore is the one state-changing op: it funnels
  // through the MNEMO-07 autoCommit chokepoint as a NEW commit and re-syncs the
  // DO graph index via the `this`-bound restore hooks below (so the index never
  // diverges from the restored FS - PRD §7.4). The Worker routes call these RPC.

  /** Paged commit history, newest first (categorized). Warms the sandbox. */
  async brainHistory(opts?: HistoryOpts): Promise<HistoryPage> {
    const sandbox = await this.warmSandbox();
    return listHistory(this.env, this.name, opts, sandbox);
  }

  /** Paged history of one file, following renames. Warms the sandbox. */
  async brainFileHistory(
    path: string,
    opts?: HistoryOpts,
  ): Promise<HistoryPage> {
    const sandbox = await this.warmSandbox();
    return fileHistory(this.env, this.name, path, opts, sandbox);
  }

  /** Per-file diff of one commit (numstat + truncated patches). Warms the sandbox. */
  async brainCommitDiff(sha: string): Promise<CommitDiff> {
    const sandbox = await this.warmSandbox();
    return commitDiff(this.env, this.name, sha, sandbox);
  }

  /** Unified diff of one file between revisions (or vs working tree). Warms the sandbox. */
  async brainFileDiff(
    path: string,
    from: string,
    to?: string,
  ): Promise<FileDiff> {
    const sandbox = await this.warmSandbox();
    return fileDiff(this.env, this.name, path, from, to, sandbox);
  }

  /** One file's content at a revision (side-by-side view). Warms the sandbox. */
  async brainFileAt(path: string, sha: string): Promise<FileAtRevision> {
    const sandbox = await this.warmSandbox();
    return fileAtRevision(this.env, this.name, path, sha, sandbox);
  }

  /** Restore one file to a revision as a NEW commit (reindexes the note). */
  async brainRestoreFile(path: string, sha: string): Promise<RestoreResult> {
    const sandbox = await this.warmSandbox();
    return restoreFile(
      this.env,
      this.name,
      path,
      sha,
      this.restoreHooks(),
      sandbox,
    );
  }

  /** Restore the whole brain to a revision as a NEW commit (snapshot + full reindex). */
  async brainRestoreTree(sha: string): Promise<RestoreResult> {
    const sandbox = await this.warmSandbox();
    return restoreTree(this.env, this.name, sha, this.restoreHooks(), sandbox);
  }

  /**
   * The index-resync operations a restore composes, bound to `this` so the
   * restore invokes the DO's own reindex methods directly (no self-RPC, which
   * would deadlock a single-threaded DO). `reindexNote` for a single-file
   * restore; `reindexAllNotes` for a whole-tree restore.
   */
  private restoreHooks(): RestoreHooks {
    return {
      reindexNote: (path) => this.reindexNote(path),
      reindexAll: () => this.reindexAllNotes(),
    };
  }

  // ─── Harness: the agentic loop (MNEMO-15, PRD §7.1 topology A) ────────────
  // The DO is the harness host; the model is called via API; the (empty, this
  // phase) tool map is the surface the model acts through. The loop itself is the
  // Vercel AI SDK loop hosted by AIChatAgent - `streamText` for the interactive
  // turn, `generateText` for headless/scheduled work - bounded by `stopWhen`. No
  // hand-rolled call→parse→execute→feed-back loop. The tool catalog lands in
  // MNEMO-16; the terminator (deliberate exit) in MNEMO-18.

  /**
   * Rehydrate the agent's registry context (agentId / owning account / template /
   * system prompt) into in-DO fields. Reads the DO-SQLite cache first; on a cold
   * DO (cache miss) loads the row from D1 via `getAgent` (keyed by `this.name`,
   * which is the agentId - the idFromName key) and caches it. Resilient to a
   * missing row (a DO addressed before its registry row exists, or an ad-hoc test
   * name): it leaves the context unset and the model/persona paths degrade safely.
   */
  private async rehydrateContext(): Promise<void> {
    if (this.contextLoaded) return;
    this.ensureInit();

    const cached = getMeta(this.ctx.storage.sql, REGISTRY_KEY);
    if (cached) {
      const ctx = JSON.parse(cached) as RegistryContext;
      // Self-heal a pre-0012 cache that predates the owner profile: load it from
      // D1 once and rewrite the cache, so the date/owner layers populate without
      // forcing a cold load. A stored profile is always an object (never
      // undefined), so this runs at most once per agent.
      if (ctx.ownerProfile === undefined && ctx.accountId) {
        ctx.ownerProfile = await this.loadOwnerProfile(ctx.accountId);
        setMeta(this.ctx.storage.sql, REGISTRY_KEY, JSON.stringify(ctx));
      }
      this.applyContext(ctx);
      this.contextLoaded = true;
      return;
    }

    const row = await getAgent(this.env, this.name).catch(() => null);
    if (row) {
      const ctx: RegistryContext = {
        agentId: row.id,
        accountId: row.account_id,
        template: row.template,
        systemPrompt: row.system_prompt,
        ownerProfile: await this.loadOwnerProfile(row.account_id),
      };
      setMeta(this.ctx.storage.sql, REGISTRY_KEY, JSON.stringify(ctx));
      this.applyContext(ctx);
      this.contextLoaded = true;
      return;
    }

    // No D1 row yet - fall back to the header-captured account id (if any) so a
    // freshly-addressed DO can still self-identify for getModel/recordUsage.
    const acct = getMeta(this.ctx.storage.sql, ACCOUNT_KEY);
    if (acct && !this.accountId) this.accountId = JSON.parse(acct) as string;
  }

  /**
   * Read the owning account's owner profile (timezone + name/notes) from D1.
   * Resilient to a missing/erroring account row - returns an all-null profile so
   * the persona's date layer still renders (in UTC) and the owner layer is just
   * skipped. The result is cached in {@link RegistryContext}; edits re-push via
   * {@link updateOwnerProfile}, so this is a cold-load-only read.
   */
  private async loadOwnerProfile(accountId: string): Promise<AccountProfile> {
    const account = await getAccount(this.env, accountId).catch(() => null);
    return {
      timezone: account?.timezone ?? null,
      owner_name: account?.owner_name ?? null,
      owner_notes: account?.owner_notes ?? null,
    };
  }

  /** Apply a loaded {@link RegistryContext} onto the in-DO fields. */
  private applyContext(ctx: RegistryContext): void {
    this.accountId = ctx.accountId;
    this.template = ctx.template;
    this.agentSystemPrompt = ctx.systemPrompt;
    this.ownerProfile = ctx.ownerProfile ?? null;
  }

  /**
   * Re-push the owning account's owner profile into the DO after an edit
   * (account-settings save fans this out to every agent the owner runs). Updates
   * the in-DO field AND the cached {@link RegistryContext} so the next turn's
   * persona picks it up without a D1 read. Safe before the registry context has
   * loaded: it patches the cache if present, leaving the cold load to fill the
   * rest. RPC-callable via the DO stub.
   */
  updateOwnerProfile(profile: AccountProfile): void {
    this.ensureInit();
    this.ownerProfile = profile;
    const cached = getMeta(this.ctx.storage.sql, REGISTRY_KEY);
    if (cached) {
      const ctx = JSON.parse(cached) as RegistryContext;
      ctx.ownerProfile = profile;
      setMeta(this.ctx.storage.sql, REGISTRY_KEY, JSON.stringify(ctx));
    }
  }

  /** The persona inputs the prompt builder layers on top of the base persona. */
  private personaContext(): AgentPersonaContext {
    return {
      template: this.template,
      systemPrompt: this.agentSystemPrompt,
      // System-prompt learning: the agent's own operating playbook (from its
      // weekly self-reviews), read from DO-SQLite so every turn carries the
      // accumulated lessons without a sandbox touch.
      operatingNotes: this.getOperatingNotes(),
      // Owner profile (account-level): the date layer's timezone + who the agent
      // works for. Mapped from the snake_case D1 shape to the persona's fields.
      timezone: this.ownerProfile?.timezone ?? null,
      owner: this.ownerProfile
        ? {
            name: this.ownerProfile.owner_name,
            notes: this.ownerProfile.owner_notes,
          }
        : null,
    };
  }

  /** The agent's self-authored operating playbook, or null until a review writes one. */
  getOperatingNotes(): string | null {
    this.ensureInit();
    const raw = getMeta(this.ctx.storage.sql, OPERATING_NOTES_KEY);
    return raw === null ? null : (JSON.parse(raw) as string | null);
  }

  /** Cache the operating playbook so subsequent turns' prompts pick it up. */
  private setOperatingNotes(notes: string): void {
    setMeta(this.ctx.storage.sql, OPERATING_NOTES_KEY, JSON.stringify(notes));
  }

  /**
   * Resolve the per-user model (PRD §7.2). Returns the test override when one is
   * injected (hermetic tests); otherwise ensures context is loaded and resolves
   * through `getModel(env, accountId)`. A null accountId degrades to the free
   * Workers AI default inside `getModel`.
   *
   * MNEMO-49: BYOK is a paid-tier feature. When the account's subscription tier
   * doesn't include BYOK, `getModel` is forced to the free default (ignoring any
   * stored BYOK profile). Fail-open - if the tier check itself errors, BYOK is
   * allowed rather than silently downgrading a paying user over a glitch.
   */
  private async resolveModel(): Promise<ResolvedModel> {
    if (this.testModelOverride) return this.testModelOverride;
    await this.rehydrateContext();
    const accountId = this.accountId ?? "";
    let forceFree = false;
    if (accountId) {
      const byok = await checkTierFeature(this.env, accountId, "byok").catch(
        () => null,
      );
      forceFree = byok ? !byok.allowed : false;
    }
    return getModel(this.env, accountId, { forceFree });
  }

  /**
   * Capture the per-connection identity header the Worker forwards (account id)
   * and persist it, mirroring Crema's `x-rep-jwt` flow (§3) so a hibernated DO
   * that wakes on a chat connection can still self-identify. Delegates to the base
   * for the WebSocket lifecycle, then records the header.
   */
  override async onConnect(
    conn: Connection,
    ctx: ConnectionContext,
  ): Promise<void> {
    await super.onConnect(conn, ctx);
    this.captureAccountHeader(ctx.request);
  }

  /** Rehydrate the registry context on every wake (cheap after the first load). */
  override async onStart(props?: Record<string, unknown>): Promise<void> {
    await super.onStart(props);
    await this.rehydrateContext();
  }

  /**
   * Persist the `x-mnemo-account` header (if present) so the owning account is
   * known across hibernation without a D1 read. The Worker only sets it after an
   * ownership check, so it is trusted self-identification, not user input.
   */
  private captureAccountHeader(request: Request): void {
    const acct = request.headers.get(ACCOUNT_HEADER);
    if (!acct) return;
    this.ensureInit();
    setMeta(this.ctx.storage.sql, ACCOUNT_KEY, JSON.stringify(acct));
    this.accountId = acct;
  }

  /**
   * Build the per-turn {@link ToolContext} (MNEMO-16). Warms this agent's sandbox
   * (or uses the test override) and assembles the live sandbox, the owning
   * identity, the research `sessionId`, and the audit `emit`. Shared by
   * {@link buildTurnTools} and `runHeadless` (which also builds the MNEMO-18
   * terminator over the same context, so the report event narrates on this emit).
   */
  private async buildToolContext(
    sessionId: string | null,
    opts?: { onArtifact?: (draft: ArtifactDraft) => void },
  ): Promise<ToolContext> {
    // warmSandbox returns the test override when set, and on a real boot runs the
    // MNEMO-49 slot-lease + boot-time bookkeeping - so the run path always goes
    // through the single boot chokepoint.
    const sandbox = await this.warmSandbox();
    return {
      env: this.env,
      agentId: this.name,
      accountId: this.accountId ?? "",
      sandbox,
      sessionId,
      emit: (e) => this.emitAudit(e),
      onArtifact: opts?.onArtifact,
    };
  }

  /**
   * Build the per-turn tool catalog (MNEMO-16) over a fresh {@link ToolContext}.
   * Used by the interactive turn; `runHeadless` builds its own catalog so it can
   * add the terminator tool and share its context with it. Pass `onArtifact` to
   * enable the web-chat-only `renderHtml` tool (inline HTML iframe views).
   */
  private async buildTurnTools(
    sessionId: string | null,
    opts?: { onArtifact?: (draft: ArtifactDraft) => void },
  ): Promise<Record<string, MnemosyneTool>> {
    return buildTools(await this.buildToolContext(sessionId, opts));
  }

  /**
   * Per-agent audit emit - the single sink every tool, the terminator, and the
   * loop narrate through (the `ToolContext.emit` and {@link auditFor} both funnel
   * here). Records into {@link testAuditSink} when a test set one, then forwards
   * to the AuditLog DO (MNEMO-20). The forward is swallowed inside the emitter, so
   * a failed audit write can never throw into the loop (§7.1: audit is
   * observability, not control flow).
   */
  private async emitAudit(input: AuditInput): Promise<void> {
    this.testAuditSink?.push(input);
    await this.auditSink().emit(input);
  }

  /** Lazily-built forwarding emitter to the AuditLog DO (cached per wake). */
  private auditSink(): AuditEmitter {
    this.auditOut ??= AuditEmitter.withSession(
      // The native RPC stub can't type `emit` (MNEMO-22 seam); cast through the
      // structural target so the one bridge lives here, not at every call site.
      getAuditStub(this.env, this.name) as unknown as AuditEmitTarget,
      null,
    );
    return this.auditOut;
  }

  /**
   * A rubric-typed {@link AuditEmitter} bound to one run's `sessionId`, funnelled
   * through {@link emitAudit} so its events reach BOTH the test spy and the
   * AuditLog DO. Build a fresh one per research run (PRD §7.1 - reasoning parts
   * feed the "show the work" view; we narrate intents, never raw reasoning).
   */
  private auditFor(sessionId: string | null): AuditEmitter {
    return AuditEmitter.withSession(
      { emit: (input) => this.emitAudit(input) },
      sessionId,
    );
  }

  /**
   * Emit a one-sentence `narration` for a model step's tool-call intent (PRD
   * §7.1) - the calm milestone stream reads as plain English ("Searching the
   * web…", "Writing acme.md"). Derived from the step's tool calls only; raw
   * reasoning is NOT dumped here (it belongs to the `info`-level "show the work").
   */
  private async narrateStep(
    audit: AuditEmitter,
    toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>,
  ): Promise<void> {
    for (const call of toolCalls) {
      await audit.narration(describeToolCall(call.toolName, call.input));
    }
  }

  /**
   * The interactive turn. Resolves the per-user model, builds the layered system
   * prompt, and runs the streaming SDK loop over the persisted message history
   * with the sandbox-driving tool catalog (MNEMO-16). `AIChatAgent` persists the
   * user + assistant messages automatically. `stopWhen` is the hard ceiling
   * (INTERACTIVE_STEP_BUDGET); the terminator tool (MNEMO-18) is the intended exit.
   */
  override async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    // The agents-SDK WebSocket path: the base persists the assistant reply by
    // consuming the returned stream, so we hand it the SDK's own message log and
    // let `streamChatTurn` own the model/tools/audit/cost-cap machinery.
    return this.streamChatTurn({ history: this.messages });
  }

  /**
   * The shared interactive chat turn (MNEMO-15). Resolves the per-user model,
   * builds the layered system prompt, and runs the streaming SDK loop over
   * `history` with the sandbox-driving tool catalog (MNEMO-16). `stopWhen` is the
   * hard ceiling (INTERACTIVE_STEP_BUDGET); the terminator tool (MNEMO-18) is the
   * intended exit.
   *
   * Two callers share it: {@link onChatMessage} (the SDK's single-log WS path,
   * which persists by consuming the stream) and {@link streamConversationTurn}
   * (the MNEMO-35 multi-thread HTTP path, which persists the assistant reply via
   * `onAssistantFinish` into its own `web_conversation_message` store). The cost
   * cap, model, persona, tools, and audit are identical for both.
   */
  private async streamChatTurn(opts: {
    history: UIMessage[];
    /**
     * Persist the streamed assistant reply (the multi-thread path supplies this;
     * the SDK path leaves it undefined and persists via stream consumption). Best-
     * effort and skipped when the stream was aborted mid-flight.
     */
    onAssistantFinish?: (message: UIMessage) => void | Promise<void>;
  }): Promise<Response> {
    // MNEMO-21: a fresh sessionId groups every audit event from this turn.
    const sessionId = crypto.randomUUID();
    const audit = this.auditFor(sessionId);
    await this.rehydrateContext();

    // MNEMO-49 enforcement (LLM path): gate the turn on the account's monthly cost
    // cap BEFORE building tools (which warms the sandbox) or calling the model.
    // Over cap → abort with a user-facing message; the model is NEVER called.
    // Fail-open: a cap-check fault degrades to allow (never bricks a paying user).
    if (this.accountId) {
      const cap = await checkCostCap(this.env, this.accountId).catch(
        () => null,
      );
      if (cap && !cap.allowed) return this.costCapAbortResponse(audit, cap);
    }

    const { model, config } = await this.resolveModel();
    const system = buildSystemPrompt(this.personaContext());
    const tools = await this.buildTurnTools(sessionId);

    await audit.sessionStarted(
      `Started chat turn: ${promptSummary(latestUserText(opts.history))}`,
    );

    const result = streamText({
      model,
      system,
      messages: await convertToModelMessages(opts.history),
      tools,
      stopWhen: stepCountIs(INTERACTIVE_STEP_BUDGET),
      // MNEMO-21: narrate each step's tool-call intent into the calm stream.
      onStepFinish: (step) => this.narrateStep(audit, step.toolCalls),
      onFinish: async ({ usage, steps }) => {
        // MNEMO-14 + MNEMO-49: accumulate this turn's spend on finish.
        await this.recordTurnUsage(usage, config, sessionId);
        await audit.sessionCompleted("Chat turn complete", {
          steps: steps.length,
        });
      },
      // A streaming error still closes the session - narrate it as an error
      // (swallowed in the emitter; never re-thrown into the stream).
      onError: ({ error }) =>
        audit.error(`Chat turn failed: ${errMessage(error)}`),
    });

    return result.toUIMessageStreamResponse({
      originalMessages: opts.history,
      onFinish: opts.onAssistantFinish
        ? async ({ responseMessage, isAborted }) => {
            // Persist the completed assistant reply (skip a partial/aborted turn -
            // the user message is already stored, so the thread isn't lost).
            if (!isAborted) await opts.onAssistantFinish?.(responseMessage);
          }
        : undefined,
    });
  }

  /**
   * MNEMO-49: the user-facing abort when an interactive turn is blocked by the
   * monthly cost cap. Narrates the block to the audit stream (error + narration,
   * so the user sees WHY) and streams a single assistant message back over the UI
   * message stream - the model is NEVER called.
   */
  private async costCapAbortResponse(
    audit: AuditEmitter,
    result: AdmissionResult,
  ): Promise<Response> {
    const detail = result.detail ?? "monthly cost cap reached";
    await audit.error(`Chat turn blocked: ${detail}`, {
      reason: result.reason,
    });
    await audit.narration(
      "Your monthly usage cap has been reached - new runs are paused until your next billing cycle or an upgrade.",
    );
    const text = `Monthly cost cap reached - ${detail}. New runs are paused until your next billing cycle or you upgrade your plan.`;
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        const id = "cost-cap";
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: text });
        writer.write({ type: "text-end", id });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  /**
   * Headless counterpart of the interactive turn - a non-streaming `generateText`
   * loop for scheduled/background work (reporting MNEMO-24, scheduling MNEMO-27).
   * Same model + layered persona PLUS the deep-research overlay, the sandbox tool
   * catalog, and the MNEMO-18 terminator (`submitFinalReport`) - the *deliberate*
   * exit whose input schema IS the final-report schema.
   *
   * `stopWhen` combines the step budget (the hard ceiling - deep-research callers
   * pass DEEP_RESEARCH_STEP_BUDGET) with the terminator firing, so the loop ends
   * promptly on a clean exit. After the loop, the captured report is read from the
   * terminator and returned as `finalReport`; a null `finalReport` is the
   * detectable soft-fail (PRD §6.3/§7.1) and emits an `error`-level audit note.
   */
  async runHeadless(input: {
    prompt: string;
    /** Groups this run's tool spills + audit events (MNEMO-21 correlation). */
    sessionId?: string;
    stepBudget?: number;
  }): Promise<{
    text: string;
    finishReason: string;
    steps: number;
    finalReport: FinalReportData | null;
    /** Set (with `allowed: false`) when MNEMO-49 admission blocked the run. */
    admission?: AdmissionResult;
  }> {
    // MNEMO-21: a sessionId groups every audit event from this run (a caller may
    // supply one for cross-run correlation, else we mint one).
    const sessionId = input.sessionId ?? crypto.randomUUID();
    const audit = this.auditFor(sessionId);
    await this.rehydrateContext();

    // MNEMO-49 enforcement (sandbox spin-up + LLM path): admit the run BEFORE
    // booting the sandbox or calling the model. Always gate on the cost cap; gate
    // on CONCURRENCY only when a cold boot is actually needed - if this agent's
    // container is already warm it holds its slot, so its own next run must not be
    // blocked by it (the limit is per-account NEW boots, not re-runs). Denied →
    // narrate WHY (error + narration) and return the failure without booting or
    // invoking the model. Both checks fail-open on an unknown error (§8.4).
    if (this.accountId) {
      const alreadyWarm = this.readMetaJson<number>(SANDBOX_BOOT_KEY) !== null;
      const admission = alreadyWarm
        ? ((await checkCostCap(this.env, this.accountId).catch(() => null)) ?? {
            allowed: true,
          })
        : await admitSandboxRun(this.env, this.accountId);
      if (!admission.allowed) {
        await this.emitAudit({
          type: "error",
          level: "error",
          sessionId,
          text: `Research run blocked: ${admission.detail ?? admission.reason}`,
          payload: { reason: admission.reason ?? null },
        });
        await audit.narration(
          `Run paused - ${admission.detail ?? "usage limit reached"}.`,
        );
        return {
          text: "",
          finishReason: `blocked:${admission.reason}`,
          steps: 0,
          finalReport: null,
          admission,
        };
      }
    }

    const { model, config } = await this.resolveModel();
    const system = buildSystemPrompt(this.personaContext(), {
      extras: DEEP_RESEARCH_OVERLAY,
    });
    const stepBudget = input.stepBudget ?? DEFAULT_HEADLESS_STEP_BUDGET;

    // The terminator shares the turn's context (so its report event narrates on
    // the same emit), is registered under `submitFinalReport`, and extends
    // `stopWhen` so the loop stops the moment it fires.
    const ctx = await this.buildToolContext(sessionId);
    const term = makeTerminator(ctx);
    const tools: Record<string, MnemosyneTool> = {
      ...(await buildTools(ctx)),
      submitFinalReport: term.tool,
    };

    await audit.sessionStarted(
      `Started research: ${promptSummary(input.prompt)}`,
      { stepBudget },
    );

    try {
      const result = await generateText({
        model,
        system,
        prompt: input.prompt,
        tools,
        stopWhen: terminatorOrBudget(stepBudget, term.wasCalled),
        // MNEMO-21: narrate each step's tool-call intent (incl. the terminator
        // selection) into the calm stream - derived from the call, not reasoning.
        onStepFinish: (step) => this.narrateStep(audit, step.toolCalls),
      });
      await this.recordTurnUsage(result.usage, config, sessionId);

      const finalReport = term.getResult();
      if (finalReport === null) {
        // Soft-fail: the loop ran out of road (or finished as prose) without the
        // deliberate terminator exit - the detectable failure mode from PRD §6.3.
        // Kept as a `narration` at `error` level (the established soft-fail shape)
        // rather than an `error`-type event.
        await this.emitAudit({
          type: "narration",
          level: "error",
          sessionId,
          text: "research ended without a final report",
          payload: {
            finishReason: result.finishReason,
            steps: result.steps.length,
          },
        });
      }

      await audit.sessionCompleted(
        finalReport
          ? `Research complete: ${finalReport.title}`
          : "Research ended without a final report",
        {
          steps: result.steps.length,
          finishReason: result.finishReason,
          hadReport: finalReport !== null,
        },
      );

      return {
        text: result.text,
        finishReason: result.finishReason,
        steps: result.steps.length,
        finalReport,
      };
    } catch (err) {
      // A thrown/aborted loop closes the session as an error (message only - no
      // stack into `text`; detail rides in `payload`).
      await audit.error(`Research run failed: ${errMessage(err)}`, {
        sessionId,
      });
      throw err;
    }
  }

  /**
   * Accumulate one turn's usage (MNEMO-14 + MNEMO-49). Best-effort: a metering
   * write must never break the chat stream or a headless run, and a turn with no
   * known account (e.g. a degraded cold DO) is skipped. Two independent ledgers:
   *   - MNEMO-14 `llm_spend` (milli-USD, BYOK spend cap).
   *   - MNEMO-49 `usage_events` (normalized cents, the subscription cost-cap signal).
   */
  private async recordTurnUsage(
    usage: LanguageModelUsage,
    config: ResolvedModelConfig,
    sessionId?: string,
  ): Promise<void> {
    if (!this.accountId) return;
    const accountId = this.accountId;
    try {
      await recordUsage(this.env, accountId, usage, {
        provider: config.provider,
        model: config.model,
      });
    } catch {
      // Swallow: spend accounting is not allowed to fail the turn.
    }
    // MNEMO-49: append the LLM-token consumption to the billing usage ledger (the
    // cost-cap gate sums it). prompt + completion tokens; skipped when zero.
    try {
      const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      if (tokens > 0) {
        await meterUsage(this.env, {
          accountId,
          agentId: this.name,
          kind: "llm_tokens",
          quantity: tokens,
          sessionId: sessionId ?? null,
        });
      }
    } catch {
      // Swallow: usage metering is observability, not control flow.
    }
  }

  // ─── Lifecycle: Discovery (MNEMO-29, PRD §5/§6.3) ────────────────────────
  // The clarify-scope conversation that PRECEDES provisioning. It runs entirely
  // inside this always-cheap DO - pure dialogue + model calls, NO sandbox (the
  // agent isn't provisioned yet). The confidence gate is the `finalize_discovery`
  // terminator tool (mirrors MNEMO-18): the only way to end Discovery is to emit a
  // well-formed DiscoverySpec, which persists to `agent_meta` under `discovery`.
  // MNEMO-30 reads getDiscoveryState().spec to provision a live agent - we
  // provision nothing here.

  /**
   * Begin Discovery for this agent: persist a fresh {@link DiscoveryState}
   * (`in_progress`, 0 turns), stash the opening name + description (so each later
   * turn can rebuild the system prompt), and clear any prior transcript. Returns
   * the initial state.
   */
  startDiscovery(input: { name: string; description: string }): DiscoveryState {
    this.ensureInit();
    setMeta(
      this.ctx.storage.sql,
      DISCOVERY_INPUT_KEY,
      JSON.stringify({
        name: input.name.trim(),
        description: input.description.trim(),
      }),
    );
    setMeta(this.ctx.storage.sql, DISCOVERY_MESSAGES_KEY, JSON.stringify([]));
    const state = defaultDiscoveryState();
    setMeta(this.ctx.storage.sql, DISCOVERY_KEY, JSON.stringify(state));
    return state;
  }

  /**
   * Run one clarify-scope turn. Appends `userMessage` to the persisted transcript,
   * runs the MNEMO-15 `generateText` loop with the Discovery system prompt and the
   * `finalize_discovery` terminator (whose `onFinalize` flips status via
   * {@link completeDiscovery}), and returns the assistant's reply plus the current
   * state. `stopWhen` stops the moment the terminator fires - else at the modest
   * {@link DISCOVERY_STEP_BUDGET} ceiling, since Discovery is shallow. Increments
   * `turns` once per call.
   */
  async discoveryTurn(
    userMessage: string,
  ): Promise<{ reply: string; state: DiscoveryState }> {
    this.ensureInit();
    const { name, description } = this.discoveryInput();
    const messages = this.discoveryMessages();
    messages.push({ role: "user", content: userMessage });

    // This call processes the (prevTurns + 1)-th user turn. Finalize is hard-gated
    // below DISCOVERY_MIN_TURNS so a vague opener can't shortcut to "ready" - the
    // model is forced to interview first (the prompt also steers it there).
    const prevTurns = this.getDiscoveryState().turns;
    const canFinalize = prevTurns + 1 >= DISCOVERY_MIN_TURNS;

    const { model, config } = await this.resolveModel();
    // The terminator flips this true; `stopWhen` reads it to end the loop
    // promptly on a deliberate finalize (mirrors MNEMO-18's wasCalled()).
    let finalized = false;
    const tools = makeDiscoveryTools({
      canFinalize,
      // Running self-assessment: persist it so the UI lights the rubric / climbs
      // the meter mid-interview (kept out of the prose the person reads).
      onProgress: (progress) => this.recordDiscoveryProgress(progress),
      onFinalize: (spec) => {
        finalized = true;
        this.completeDiscovery(spec);
      },
    });

    const result = await generateText({
      model,
      system: buildDiscoverySystemPrompt({ name, description }),
      messages,
      tools,
      stopWhen: [stepCountIs(DISCOVERY_STEP_BUDGET), () => finalized],
    });
    await this.recordTurnUsage(result.usage, config);

    messages.push({ role: "assistant", content: result.text });
    setMeta(
      this.ctx.storage.sql,
      DISCOVERY_MESSAGES_KEY,
      JSON.stringify(messages),
    );

    // Re-read AFTER the loop: a mid-loop finalize already persisted the spec +
    // flipped status, so we increment `turns` on top of that rather than clobber.
    const after = this.getDiscoveryState();
    const next: DiscoveryState = { ...after, turns: after.turns + 1 };
    setMeta(this.ctx.storage.sql, DISCOVERY_KEY, JSON.stringify(next));
    return { reply: result.text, state: next };
  }

  /**
   * Persist a finalized {@link DiscoverySpec} and flip status to `complete`
   * (keeping the current `turns`). Validates the spec - the terminator already
   * does, but this is the durable gate. MNEMO-30 reads getDiscoveryState().spec to
   * provision a live agent.
   */
  completeDiscovery(spec: DiscoverySpec): DiscoveryState {
    this.ensureInit();
    const parsed = DiscoverySpec.parse(spec);
    const current = this.getDiscoveryState();
    const next: DiscoveryState = {
      status: "complete",
      spec: parsed,
      turns: current.turns,
      progress: current.progress,
    };
    setMeta(this.ctx.storage.sql, DISCOVERY_KEY, JSON.stringify(next));
    return next;
  }

  /**
   * Persist the latest running self-assessment from the `note_progress` tool,
   * merging it onto the current state without touching `status`/`spec`/`turns`.
   * Lets the UI light the rubric and climb the confidence meter DURING the
   * interview rather than only at the finalize gate.
   */
  private recordDiscoveryProgress(progress: DiscoveryProgress): void {
    const current = this.getDiscoveryState();
    const next: DiscoveryState = {
      ...current,
      progress: DiscoveryProgress.parse(progress),
    };
    setMeta(this.ctx.storage.sql, DISCOVERY_KEY, JSON.stringify(next));
  }

  /** Current Discovery state, or `defaultDiscoveryState()` if never started. */
  getDiscoveryState(): DiscoveryState {
    this.ensureInit();
    const json = getMeta(this.ctx.storage.sql, DISCOVERY_KEY);
    return json
      ? DiscoveryState.parse(JSON.parse(json))
      : defaultDiscoveryState();
  }

  /** The opening name + description stashed by {@link startDiscovery}. */
  private discoveryInput(): { name: string; description: string } {
    const json = getMeta(this.ctx.storage.sql, DISCOVERY_INPUT_KEY);
    return json
      ? (JSON.parse(json) as { name: string; description: string })
      : { name: "", description: "" };
  }

  /** The persisted clarify-scope transcript (model-message form). */
  private discoveryMessages(): ModelMessage[] {
    const json = getMeta(this.ctx.storage.sql, DISCOVERY_MESSAGES_KEY);
    return json ? (JSON.parse(json) as ModelMessage[]) : [];
  }

  // ─── Lifecycle: Build (MNEMO-30, PRD §5(2)) ──────────────────────────────
  // Turn a finalized Discovery spec (MNEMO-29) into a live, operable agent.
  // Orchestrated from this DO (PRD §7.1 topology A): it spins the sandbox up to
  // lay down the brain filesystem, then lets it idle (PRD §8.4) - Build never
  // holds the container warm. Idempotent + resumable: each completed BuildStep is
  // recorded into `buildStatus` (agent_meta) as it lands, so a re-run (a
  // half-built sandbox MUST be safe to retry) skips already-finished steps.

  /**
   * Build the agent. REQUIRES a complete Discovery spec; without one it returns a
   * failed {@link BuildStatus} carrying {@link BUILD_NEEDS_SPEC} and writes
   * nothing (you cannot build without a finalized spec). Otherwise it runs the
   * steps in order - (2) provision the brain FS + git repo, (3/4) apply the
   * template + assemble & persist the system prompt, (5) enable the operational
   * tool set, (6) enable schedule defaults, (7) sync the D1 registry row to
   * `operational` - persisting `buildStatus` as each lands (so a mid-way failure
   * is resumable) and short-circuiting a build that already reached `ready`.
   */
  async build(): Promise<BuildStatus> {
    this.ensureInit();

    const discovery = this.getDiscoveryState();
    if (discovery.status !== "complete" || !discovery.spec) {
      // Typed pre-condition failure: touch NOTHING (sandbox/settings/registry)
      // and persist nothing - the agent stays `not_started`.
      return {
        phase: "failed",
        completed: [],
        error: BUILD_NEEDS_SPEC,
        builtAt: null,
      };
    }
    const spec = discovery.spec;

    // Resume: a fully-built agent is a no-op. Otherwise pick up the recorded
    // `completed` cursor and flip to `building`.
    let status = this.getBuildStatus();
    if (status.phase === "ready") return status;
    status = { ...status, phase: "building", error: null };
    this.setBuildStatus(status);

    const has = (step: BuildStep): boolean => status.completed.includes(step);
    const complete = (step: BuildStep): void => {
      if (!status.completed.includes(step)) {
        status = { ...status, completed: [...status.completed, step] };
      }
      this.setBuildStatus(status);
    };
    const fail = (step: BuildStep, message: string): BuildStatus => {
      status = { ...status, phase: "failed", error: `${step}: ${message}` };
      this.setBuildStatus(status);
      return status;
    };

    const template = getTemplate(spec.entityType);

    // Surface the provisioning arc in the agent's audit tab as a small run of
    // onboarding milestones, so "initial setup" is a visible part of the live
    // stream the user watches - not invisible work that finishes before the deep
    // dive's first phase event appears. Best-effort: an audit hiccup must never
    // fail the build, and emits are gated to the step that did the work so a
    // resumed build doesn't double-log.
    const setupMilestone = (
      text: string,
      payload?: Record<string, unknown>,
    ): Promise<void> =>
      this.auditFor("build:setup")
        .onboardingPhase(text, payload)
        .catch(() => {});
    if (status.completed.length === 0) {
      await setupMilestone(`Provisioning your agent for "${spec.subject}"`, {
        subject: spec.subject,
        entityType: spec.entityType,
      });
    }

    try {
      // (2) Provision the brain filesystem + git repo (MNEMO-06/07). Skip when
      // both filesystem steps already landed (a resumed / repeat build) so the
      // sandbox is never re-touched needlessly.
      if (!has("fs_init") || !has("git_init")) {
        const sandbox = this.testSandboxOverride ?? (await this.warmSandbox());
        const results = await provisionFilesystem(
          this.env,
          this.name,
          sandbox,
          template,
        );
        const failed = results.find((r) => !r.ok);
        if (failed)
          return fail(failed.step, failed.detail ?? "provisioning failed");
        complete("fs_init");
        complete("git_init");

        // The template's seed notes were written straight to the sandbox FS by
        // provisionFilesystem, which bypasses the per-write reindex hook the
        // memory-write API (MNEMO-10) goes through - so the DO graph index would
        // read empty ("0 neurons") until the first consolidation pass touched
        // them. Index the freshly-seeded tree now so a built agent has a brain
        // from the first read. Idempotent (INSERT OR REPLACE), so a resumed build
        // re-running this is harmless.
        await this.reindexAllNotes();
        await setupMilestone(
          "Knowledge base initialized - seeded your brain from the template",
          { entityType: spec.entityType },
        );
      }

      // (3/4) Apply the template selection + assemble & persist the operating
      // system prompt. `"other"` ⇒ null registry template (no persona overlay).
      if (!has("template_applied") || !has("system_prompt")) {
        const systemPrompt = assembleSystemPrompt({ spec, template });
        this.updateSettings({
          systemPrompt,
          template: registryTemplate(spec.entityType),
        });
        complete("template_applied");
        complete("system_prompt");
      }

      // (5) Enable the operational tool set (recorded as a capability list).
      if (!has("tools_enabled")) {
        this.updateSettings({ enabledTools: [...OPERATIONAL_TOOLS] });
        complete("tools_enabled");
      }

      // (6) Schedule defaults - persist the template's default cadence AND arm
      // the DO's own run timer (MNEMO-27 `enableSchedule` does both). Arming a
      // timer does not hold the sandbox warm.
      if (!has("schedule_defaults")) {
        await this.enableSchedule(template.defaultCadenceCron);
        complete("schedule_defaults");
        await setupMilestone("Recurring research schedule enabled", {
          cron: template.defaultCadenceCron,
        });
      }

      // (7) Sync the D1 registry row → `operational` (the MNEMO-05 update path),
      // mirroring the persisted settings so the registry and the DO agree.
      if (!has("registry_synced")) {
        await this.syncRegistry(spec, template);
        complete("registry_synced");
      }

      // (8) Kick off the agent's initial deep dive so "operational" means "has
      // begun learning," not just "provisioned" - a fresh agent fills its brain
      // through a multi-phase initial research pass rather than sitting empty
      // until the weekly cron fires. `startDeepDive` only ARMS the first phase as
      // a near-immediate background alarm (NOT awaited work), so POST /build
      // returns now and the (cost-gated, minutes-long) dive runs in the
      // background. Idempotent: an already-started dive is a no-op, so a resumed
      // build can't restart it.
      await this.startDeepDive();

      status = {
        ...status,
        phase: "ready",
        error: null,
        builtAt: new Date().toISOString(),
      };
      this.setBuildStatus(status);
      return status;
    } catch (err) {
      // A thrown step fails the build; the recorded `completed` cursor lets the
      // next build() resume from where it stopped (PRD §5(2) idempotence).
      status = { ...status, phase: "failed", error: errMessage(err) };
      this.setBuildStatus(status);
      return status;
    }
    // The sandbox is left to idle down on its own (PRD §8.4) - Build never stops
    // or holds the container; the warmSandbox idle alarm releases it.
  }

  // ─── Lifecycle: the initial deep dive (onboarding) ───────────────────────
  // After Build provisions the agent, its brain holds only template seeds. The
  // deep dive is the agent's first job: a fixed SIX-phase initial research pass
  // (see src/agent/deepdive/plan.ts) that fills the brain end to end before the
  // agent settles into its recurring cadence. Each phase is its own alarm-driven
  // headless run (`runHeadless`) - so the dive survives hibernation, is resumable
  // (the per-phase cursor is the resume point), and the user sees an honest
  // "phase N of 6" progress bar over the live audit stream. Build kicks it off;
  // it advances itself phase by phase; on completion it arms the weekly review.

  /** Current deep-dive state, or `defaultDeepDiveStatus()` if never started. */
  getDeepDiveStatus(): DeepDiveStatus {
    this.ensureInit();
    const json = getMeta(this.ctx.storage.sql, DEEPDIVE_KEY);
    return json
      ? DeepDiveStatus.parse(JSON.parse(json))
      : defaultDeepDiveStatus();
  }

  /** Persist the deep-dive state to DO-SQLite (survives hibernation → resumable). */
  private setDeepDiveStatus(status: DeepDiveStatus): void {
    setMeta(this.ctx.storage.sql, DEEPDIVE_KEY, JSON.stringify(status));
  }

  /**
   * Kick off the initial deep dive: seed the all-`pending` phase plan and arm the
   * first phase as a near-immediate background alarm. Idempotent - a dive that has
   * already started (running OR complete) is a no-op, so a resumed/repeat build
   * never restarts it. Returns the (possibly pre-existing) status. Only ARMS work;
   * the phases run on their own alarms so the caller (Build) returns immediately.
   */
  async startDeepDive(): Promise<DeepDiveStatus> {
    this.ensureInit();
    const existing = this.getDeepDiveStatus();
    if (existing.phase !== "not_started") return existing; // already kicked off

    if (!this.getDiscoveryState().spec) return existing; // no scope ⇒ nothing to dive

    const status = startingDeepDiveStatus(new Date().toISOString());
    this.setDeepDiveStatus(status);
    await this.auditFor(`deepdive:start`).onboardingPhase(
      `Starting initial deep dive - ${DEEP_DIVE_PLAN.length} phases`,
      { phases: DEEP_DIVE_PLAN.length },
    );
    await this.armNextDeepDivePhase(DEEP_DIVE_KICKOFF_DELAY_SEC);
    return status;
  }

  /**
   * Run the next pending deep-dive phase, then chain the one after it (or finalize
   * the dive when none remain). Fired by the scheduler by name; PUBLIC for that
   * reason. One alarm = one phase = one bounded `runHeadless` pass. A phase that
   * throws is recorded as `failed` but does NOT abort the dive (one weak phase
   * shouldn't leave the brain empty); an admission BLOCK (cost cap) pauses the
   * dive as `failed` since retrying would just re-block.
   */
  async runDeepDivePhase(): Promise<void> {
    this.ensureInit();
    // We're firing now - clear the stored alarm id so the chained re-arm tracks a
    // fresh one (mirrors the run/idle alarm bookkeeping).
    setMeta(this.ctx.storage.sql, DEEPDIVE_SCHEDULE_KEY, JSON.stringify(null));

    let status = this.getDeepDiveStatus();
    if (status.phase !== "running") return; // done / aborted / never started

    const index = status.phases.findIndex((p) => p.status === "pending");
    if (index === -1) {
      // No pending phase left → the dive is finished.
      await this.finalizeDeepDive(status);
      return;
    }

    const spec = this.getDiscoveryState().spec;
    if (!spec) {
      // Should be impossible (Build requires a spec), but never throw in an alarm.
      this.setDeepDiveStatus({
        ...status,
        phase: "failed",
        error: "deep dive lost its scope",
      });
      return;
    }

    const record = status.phases[index];
    const plan = phaseSpec(record.id);
    const sessionId = `deepdive:${record.id}:${Date.now()}`;

    // Mark this phase running BEFORE the work, so a redelivered alarm (which would
    // pick the next pending phase) and the progress UI both see it in flight.
    status = this.patchPhase(status, index, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    this.setDeepDiveStatus(status);
    await this.auditFor(sessionId).onboardingPhase(
      `Phase ${index + 1} of ${status.phases.length}: ${plan.label}`,
      { phase: record.id, index: index + 1, total: status.phases.length },
    );

    let outcome: DeepDivePhaseRecord["status"] = "complete";
    let note: string | null = null;
    let blocked = false;
    try {
      const prior = status.phases
        .slice(0, index)
        .map((p) => ({ label: p.label, note: p.note }));
      const prompt = buildDeepDivePhasePrompt({
        spec,
        phase: plan,
        phaseNumber: index + 1,
        totalPhases: status.phases.length,
        prior,
      });
      const result = await this.runHeadless({
        prompt,
        sessionId,
        stepBudget: plan.stepBudget,
      });
      if (result.admission && !result.admission.allowed) {
        blocked = true;
        outcome = "failed";
        note = result.admission.detail ?? "usage limit reached";
      } else {
        note =
          result.finalReport?.summary ??
          result.finalReport?.title ??
          (result.text.trim() ? clip(result.text.trim(), 280) : null);
      }
    } catch (err) {
      outcome = "failed";
      note = errMessage(err);
      await this.auditFor(sessionId)
        .error(`Deep-dive phase ${record.id} failed: ${errMessage(err)}`)
        .catch(() => {});
    }

    // The phase wrote notes via the generic FS tool (no per-write reindex hook) -
    // sweep the tree so the new neurons land in the DO index and the brain-size /
    // graph views grow phase by phase (best-effort).
    await this.reindexAllNotes().catch(() => {});

    status = this.getDeepDiveStatus(); // re-read (the loop may have mutated nothing here, but stay honest)
    status = this.patchPhase(status, index, {
      status: outcome,
      finishedAt: new Date().toISOString(),
      note,
    });
    if (outcome === "failed") status = { ...status, error: note };
    this.setDeepDiveStatus(status);

    if (blocked) {
      // Cost-capped: pause the dive rather than spin on a guaranteed re-block.
      this.setDeepDiveStatus({ ...status, phase: "failed" });
      return;
    }

    const more = status.phases.some((p) => p.status === "pending");
    if (more) {
      await this.armNextDeepDivePhase(DEEP_DIVE_PHASE_GAP_SEC);
    } else {
      await this.finalizeDeepDive(status);
    }
  }

  /**
   * Finish the dive: run a consolidation "sleep" pass (best-effort), reindex, mark
   * the dive complete, and ARM the recurring weekly self-review. Consolidation is
   * skipped on a dirty tree (it defers itself), and any failure here never blocks
   * completion - a finished brain is better than a dive stuck on a tidy-up step.
   */
  private async finalizeDeepDive(status: DeepDiveStatus): Promise<void> {
    const sessionId = `deepdive:synthesis:${Date.now()}`;
    try {
      await this.consolidate({ dryRun: false, sessionId });
    } catch {
      // Best-effort: the baseline brain stands even if the tidy-up pass faults.
    }
    await this.reindexAllNotes().catch(() => {});

    const done: DeepDiveStatus = {
      ...status,
      phase: "complete",
      finishedAt: new Date().toISOString(),
    };
    this.setDeepDiveStatus(done);
    await this.auditFor(sessionId).onboardingPhase(
      "Initial deep dive complete - the brain has its baseline",
      { neurons: this.getBrainSize().neurons },
    );

    // Now that the agent has a baseline brain, begin its nightly "dream" (memory
    // consolidation, only on nights the agent was used). The weekly self-review is
    // NOT armed here - it runs right after each weekly research update (see
    // defaultScheduledRun); the recurring research cron was armed by Build step 6.
    await this.scheduleNextConsolidation();
  }

  /**
   * Arm the single pending deep-dive phase alarm `delaySec` from now, cancelling
   * any prior one first (cancel/re-arm exactly one - never accumulate across
   * wakes; mirrors {@link cancelArmedRun}).
   */
  private async armNextDeepDivePhase(delaySec: number): Promise<void> {
    const prevId = getMeta(this.ctx.storage.sql, DEEPDIVE_SCHEDULE_KEY);
    if (prevId && prevId !== "null") {
      await this.cancelSchedule(JSON.parse(prevId) as string);
    }
    const scheduled = await this.schedule(
      Math.max(1, delaySec),
      "runDeepDivePhase",
    );
    setMeta(
      this.ctx.storage.sql,
      DEEPDIVE_SCHEDULE_KEY,
      JSON.stringify(scheduled.id),
    );
  }

  /** Return a copy of `status` with one phase record patched (pure helper). */
  private patchPhase(
    status: DeepDiveStatus,
    index: number,
    patch: Partial<DeepDivePhaseRecord>,
  ): DeepDiveStatus {
    const phases = status.phases.map((p, i) =>
      i === index ? { ...p, ...patch } : p,
    );
    return { ...status, phases };
  }

  // ─── Lifecycle: the self-assessment ("Karpathy loop") ────────────────────
  // After each weekly research update the agent reviews ITSELF: how is it doing
  // against its mission, what's working, what's missing - and then it self-iterates
  // by rewriting its own operating playbook ("system prompt learning"). That
  // playbook is cached in DO-SQLite and injected into every later turn (see
  // personaContext), so the agent compounds what works rather than relearning it.
  // The review runs as its own headless loop (assessment overlay + `record_assessment`
  // terminator), triggered by the research run (defaultScheduledRun) - its cadence
  // IS the research cadence, so there's no separate review cron.

  /** Current self-assessment state, or `defaultAssessmentState()` if never run. */
  getAssessmentState(): AssessmentState {
    this.ensureInit();
    const json = getMeta(this.ctx.storage.sql, ASSESSMENT_KEY);
    return json
      ? AssessmentState.parse(JSON.parse(json))
      : defaultAssessmentState();
  }

  /** Persist the self-assessment state to DO-SQLite. */
  private setAssessmentState(state: AssessmentState): void {
    setMeta(this.ctx.storage.sql, ASSESSMENT_KEY, JSON.stringify(state));
  }

  /**
   * Run one self-review. Fired by the scheduler by name (armed right after each
   * weekly research update); PUBLIC for that reason. Runs a headless loop with the
   * assessment overlay + the `record_assessment` terminator; on a clean finish it
   * persists the record, folds the rewritten operating playbook into the agent's
   * context (DO cache + brain-note mirror), and narrates the self-iteration.
   * Best-effort and self-contained: any failure is narrated and swallowed (a thrown
   * alarm callback would just retry the spend). It does NOT re-arm itself - the next
   * review is triggered by the next research run, so the review can't outlive or
   * out-pace the research it reflects on.
   */
  async runWeeklyAssessment(): Promise<void> {
    this.ensureInit();
    const spec = this.getDiscoveryState().spec;
    // Only operational agents review themselves; never throw in an alarm.
    if (!spec || this.getBuildStatus().phase !== "ready") return;

    const sessionId = `assessment:${Date.now()}`;
    const audit = this.auditFor(sessionId);
    try {
      await this.rehydrateContext();

      // Gate on the monthly cost cap before booting the sandbox or calling the
      // model (fail-open on an unknown error - never brick a paying user).
      if (this.accountId) {
        const cap = await checkCostCap(this.env, this.accountId).catch(
          () => null,
        );
        if (cap && !cap.allowed) {
          await audit.narration(
            `Self-review paused - ${cap.detail ?? "usage limit reached"}.`,
          );
          return;
        }
      }

      const { model, config } = await this.resolveModel();
      const system = buildSystemPrompt(this.personaContext(), {
        extras: ASSESSMENT_OVERLAY,
      });
      const prompt = buildAssessmentPrompt({
        spec,
        operatingNotes: this.getOperatingNotes(),
        brainSize: this.getBrainSize(),
        previous: this.getAssessmentState().lastRecord,
        today: new Date().toISOString().slice(0, 10),
      });

      // The terminator shares the run's context so its `assessment.completed`
      // event narrates on the same emit; the tool set lets the review recall its
      // own brain (and optionally sanity-check the live web).
      const ctx = await this.buildToolContext(sessionId);
      const term = makeAssessmentTerminator(ctx);
      const tools: Record<string, MnemosyneTool> = {
        ...(await buildTools(ctx)),
        record_assessment: term.tool,
      };

      await audit.sessionStarted("Started weekly self-review");
      const result = await generateText({
        model,
        system,
        prompt,
        tools,
        stopWhen: terminatorOrBudget(ASSESSMENT_STEP_BUDGET, term.wasCalled),
        onStepFinish: (step) => this.narrateStep(audit, step.toolCalls),
      });
      await this.recordTurnUsage(result.usage, config, sessionId);

      const assessment = term.getResult();
      if (assessment) {
        await this.applyAssessment(assessment, sessionId);
        await audit.sessionCompleted("Weekly self-review complete", {
          grade: assessment.grade,
          lessons: assessment.lessons.length,
        });
      } else {
        // Soft-fail: the review ran out of road without recording - the same
        // detectable failure shape as a research run with no final report.
        await this.emitAudit({
          type: "narration",
          level: "error",
          sessionId,
          text: "self-review ended without recording an assessment",
          payload: { finishReason: result.finishReason },
        });
      }
    } catch (err) {
      await audit
        .error(`Weekly self-review failed: ${errMessage(err)}`)
        .catch(() => {});
    }
  }

  /**
   * Fold a finished self-review into the agent: stamp + store the record (rolling,
   * newest-first, capped), cache the rewritten operating playbook so subsequent
   * turns pick it up, and mirror it to a versioned brain note for the human to
   * read. Adjustments to mission/cadence are recorded as PROPOSALS only - those
   * are the owner's to apply, so we never silently rewrite the schedule here.
   */
  private async applyAssessment(
    input: AssessmentInput,
    sessionId: string,
  ): Promise<void> {
    const record: AssessmentRecord = {
      ...input,
      id: crypto.randomUUID(),
      ranAt: new Date().toISOString(),
    };
    const prev = this.getAssessmentState();
    const history = [record, ...prev.history].slice(0, ASSESSMENT_HISTORY_CAP);
    this.setAssessmentState({
      lastRunAt: record.ranAt,
      runCount: prev.runCount + 1,
      lastRecord: record,
      history,
    });

    // System-prompt learning: cache the rewritten playbook (every later turn's
    // prompt now carries it) and mirror it to a brain note (human-readable +
    // versioned). The mirror is best-effort - the cache is the runtime source.
    const notes = input.operatingNotes.trim();
    if (notes) {
      this.setOperatingNotes(notes);
      const body = `# Operating Playbook\n\nThe agent's own standing notes on how to do this job well - rewritten each weekly self-review. Last updated ${record.ranAt}.\n\n${notes}\n`;
      await this.memoryWrite({
        slug: OPERATING_NOTES_SLUG,
        content: body,
      }).catch(() => {});
      await this.auditFor(sessionId).selfRevised(
        "Revised its operating playbook from this week's lessons",
        { lessons: input.lessons.length },
      );
    }
  }

  /** Current Build state, or `defaultBuildStatus()` if never built. */
  getBuildStatus(): BuildStatus {
    this.ensureInit();
    const json = getMeta(this.ctx.storage.sql, BUILD_KEY);
    return json ? BuildStatus.parse(JSON.parse(json)) : defaultBuildStatus();
  }

  /** Persist the Build state to DO-SQLite (survives hibernation → resumable). */
  private setBuildStatus(status: BuildStatus): void {
    setMeta(this.ctx.storage.sql, BUILD_KEY, JSON.stringify(status));
  }

  /**
   * Sync the D1 registry row to reflect the built agent and promote it to
   * `operational` (the MNEMO-05 update path). Mirrors the persisted settings so
   * the registry's `template`/`system_prompt`/`schedule_cron` agree with the DO.
   */
  private async syncRegistry(
    spec: DiscoverySpec,
    template: EntityTemplate,
  ): Promise<void> {
    const settings = this.getSettings();
    await updateAgent(this.env, this.name, {
      name: spec.name,
      description: spec.description,
      template: registryTemplate(spec.entityType),
      system_prompt: settings.systemPrompt,
      schedule_cron: template.defaultCadenceCron,
      status: "operational",
    });
  }

  /**
   * DO entrypoint. The WS upgrade (interactive chat) and native RPC method calls
   * are handled by the base. This override adds two HTTP chat entries (no
   * `onConnect` fires for a plain POST, so each captures the identity header):
   *
   *   POST .../conversations/:id/chat  - the MNEMO-35 multi-thread web chat. Body
   *     is the Vercel AI SDK transport shape (`{ messages }`); streams a UI-message
   *     SSE response and persists the turn to the named thread's transcript.
   *   POST .../chat                    - the legacy single-thread JSON entry
   *     (`{ message }` → `{ text }`) kept for the MNEMO-06 smoke test + callers
   *     that want a non-streamed reply.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      const conv = url.pathname.match(/\/conversations\/([^/]+)\/chat$/);
      if (conv) {
        this.captureAccountHeader(request);
        return this.streamConversationTurn(
          decodeURIComponent(conv[1]),
          request,
        );
      }
      return this.handlePostChat(request);
    }
    return super.fetch(request);
  }

  /**
   * MNEMO-35 multi-thread web chat turn. Loads the thread's persisted transcript,
   * appends the new user message(s) from the AI-SDK transport body (deduped by id
   * so a re-sent client history doesn't double-store), persists them immediately
   * (so an aborted stream still keeps the user turn), then streams the assistant
   * reply via the shared {@link streamChatTurn} - persisting it on finish into the
   * same `web_conversation_message` store. Threads live in THIS per-agent DO, so
   * the loop keeps direct brain/persona/tool access.
   */
  private async streamConversationTurn(
    conversationId: string,
    request: Request,
  ): Promise<Response> {
    this.ensureInit();
    const sql = this.ctx.storage.sql;
    const body = (await request.json().catch(() => null)) as {
      messages?: UIMessage[];
    } | null;
    const incoming: UIMessage[] = Array.isArray(body?.messages)
      ? body.messages
      : [];

    // Defensive upsert: the create-first UI flow normally makes the row, but a
    // direct/replayed POST shouldn't 404 - seed the title from the first user turn.
    const firstUserText = incoming.find((m) => m.role === "user");
    conversations.ensureConversation(sql, this.name, conversationId, {
      titleSeed: firstUserText ? uiMessageText(firstUserText) : undefined,
      now: Date.now(),
    });

    const persisted = conversations.loadConversationMessages(
      sql,
      conversationId,
    );
    const known = conversations.persistedMessageIds(sql, conversationId);
    const newUserMessages = incoming.filter(
      (m) => m.role === "user" && !known.has(m.id),
    );
    for (const message of newUserMessages) {
      conversations.appendMessage(
        sql,
        conversationId,
        { id: message.id, role: message.role, parts: message.parts },
        Date.now(),
      );
    }

    const history = [...persisted, ...newUserMessages];
    return this.runConversationTurn(conversationId, history);
  }

  /**
   * Run one interactive conversation turn and emit it as a UI-message stream.
   *
   * ⚠️ Uses `generateText` (NOT `streamText`) for a load-bearing reason: with the
   * free Workers AI models, the SDK's STREAMING path doesn't surface native tool
   * calls - the model emits them as plain text and they never execute, so agents
   * never search/recall/run anything (staging QA 2026-05-25). `generateText`
   * drives the tool loop correctly on the same models. The cost: the reply isn't
   * token-streamed - it arrives complete once the turn finishes. Live tool
   * activity still reaches the audit cockpit via `onStepFinish`. We then replay the
   * final text over a UI-message stream so the frontend's `DefaultChatTransport`
   * is unchanged. (A future optimization: keep `streamText` for BYOK providers
   * whose streaming tool-calls work.)
   */
  private async runConversationTurn(
    conversationId: string,
    history: UIMessage[],
  ): Promise<Response> {
    const sessionId = crypto.randomUUID();
    const audit = this.auditFor(sessionId);
    await this.rehydrateContext();

    // MNEMO-49: gate on the monthly cost cap BEFORE booting tools / calling the
    // model (same as the streaming path). Over cap → user-facing abort stream.
    if (this.accountId) {
      const cap = await checkCostCap(this.env, this.accountId).catch(
        () => null,
      );
      if (cap && !cap.allowed) return this.costCapAbortResponse(audit, cap);
    }

    const { model, config } = await this.resolveModel();
    const system = buildSystemPrompt(this.personaContext());
    // Collect any HTML views the `renderHtml` tool produces this turn; archived +
    // turned into `data-artifact` message parts AFTER the model loop finishes.
    const artifactDrafts: ArtifactDraft[] = [];
    const tools = await this.buildTurnTools(sessionId, {
      onArtifact: (draft) => artifactDrafts.push(draft),
    });
    await audit.sessionStarted(
      `Started chat turn: ${promptSummary(latestUserText(history))}`,
    );

    let text: string;
    // Every tool the model invoked this turn (flattened across steps), surfaced
    // back to the chat transcript as `data-tool` parts below (MNEMO-37).
    let toolCalls: Array<{ toolName: string; input: unknown }> = [];
    try {
      const result = await generateText({
        model,
        system,
        messages: await convertToModelMessages(history),
        tools,
        stopWhen: stepCountIs(INTERACTIVE_STEP_BUDGET),
        onStepFinish: (step) => this.narrateStep(audit, step.toolCalls),
      });
      toolCalls = result.steps.flatMap((step) => step.toolCalls);
      await this.recordTurnUsage(result.usage, config, sessionId);
      await audit.sessionCompleted("Chat turn complete", {
        steps: result.steps.length,
      });
      text =
        result.text.trim() ||
        "I wasn't able to produce a response for that - please try rephrasing.";
    } catch (err) {
      await audit.error(`Chat turn failed: ${errMessage(err)}`);
      text =
        "Sorry - something went wrong while working on that. Please try again.";
    }

    const assistantId = crypto.randomUUID();
    // Archive any HTML views the turn produced and turn each into a `data-artifact`
    // UI part (AI SDK v6 custom data part). The SAME part shape is persisted and
    // streamed, so a reload renders identically; `convertToModelMessages` ignores
    // `data-*` parts, so an artifact in history never disturbs a later turn. A
    // failed archive is logged + skipped, never failing the whole reply.
    const artifactParts = await this.archiveTurnArtifacts(
      conversationId,
      artifactDrafts,
      audit,
    );
    const toolParts = this.buildToolUseParts(assistantId, toolCalls);
    const parts: unknown[] = [
      { type: "text", text },
      ...toolParts,
      ...artifactParts,
    ];
    conversations.appendMessage(
      this.ctx.storage.sql,
      conversationId,
      { id: assistantId, role: "assistant", parts },
      Date.now(),
    );

    // Replay the completed reply as a UI-message stream (the shape the frontend's
    // DefaultChatTransport already consumes - see costCapAbortResponse). Tool-use
    // chips + artifacts ride the SAME stream so a live turn and a reload match.
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "text-start", id: assistantId });
        writer.write({ type: "text-delta", id: assistantId, delta: text });
        writer.write({ type: "text-end", id: assistantId });
        for (const part of toolParts) writer.write(part);
        for (const part of artifactParts) writer.write(part);
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  /**
   * Map the turn's tool calls to `data-tool` UI-message parts (MNEMO-37) so the
   * chat transcript shows what the agent actually DID - searched, fetched, ran,
   * wrote - not just its final words. Mirrors the `data-artifact` pattern exactly:
   * the SAME part is streamed live AND persisted in `parts_json`, and
   * `convertToModelMessages` ignores `data-*` parts, so a tool chip in history never
   * disturbs a later model turn. Each part's human `summary` reuses the audit
   * `describeToolCall` phrasing, and the `id` makes the streamed chips reconcilable.
   */
  private buildToolUseParts(
    assistantId: string,
    calls: ReadonlyArray<{ toolName: string; input: unknown }>,
  ): Array<{
    type: "data-tool";
    id: string;
    data: { tool: string; summary: string };
  }> {
    return calls.map((call, i) => ({
      type: "data-tool",
      id: `${assistantId}-tool-${i}`,
      data: {
        tool: call.toolName,
        summary: describeToolCall(call.toolName, call.input),
      },
    }));
  }

  /**
   * Archive each HTML view the `renderHtml` tool produced this turn (R2 + D1) and
   * map it to a `data-artifact` UI-message part. The part carries only the minted
   * `artifactId` + title (NOT the HTML), so the message store stays lean and the
   * frontend fetches the body back through the ownership-guarded `/artifacts/:id/raw`
   * route. A failed archive is logged to the audit stream and SKIPPED - one bad
   * artifact must never sink the whole reply (§7.1: observability, not control).
   */
  private async archiveTurnArtifacts(
    conversationId: string,
    drafts: ArtifactDraft[],
    audit: AuditEmitter,
  ): Promise<
    Array<{
      type: "data-artifact";
      id: string;
      data: { artifactId: string; title: string; kind: "html" };
    }>
  > {
    const parts: Array<{
      type: "data-artifact";
      id: string;
      data: { artifactId: string; title: string; kind: "html" };
    }> = [];
    for (const draft of drafts) {
      try {
        const record = await archiveHtmlArtifact(this.env, {
          agentId: this.name,
          conversationId,
          title: draft.title,
          html: draft.html,
        });
        parts.push({
          type: "data-artifact",
          id: record.id,
          data: { artifactId: record.id, title: record.title, kind: "html" },
        });
      } catch (err) {
        await audit.error(`Failed to save HTML view: ${errMessage(err)}`);
      }
    }
    return parts;
  }

  /**
   * DEV diagnostic (prod-gated route): run a one-shot tool turn INSIDE the DO with
   * the real catalog + resolved model, to isolate why interactive turns don't call
   * tools on the free tier (worker-probe tool-calls succeed; DO turns don't). Mirror
   * of `/__dev/tooltest` but in the DO context. `variant` toggles the suspected
   * differences: `prompt` vs `messages` input, and whether `onStepFinish` runs.
   */
  async debugToolTest(input: {
    query: string;
    useMessages?: boolean;
    withStepCallback?: boolean;
    natural?: boolean;
    budget?: number;
  }): Promise<{
    model: string;
    toolCount: number;
    steps: number;
    toolCalls: string[];
    executedTool: boolean;
    textPreview: string;
  }> {
    this.ensureInit();
    const sessionId = crypto.randomUUID();
    const audit = this.auditFor(sessionId);
    await this.rehydrateContext();
    const { model, config } = await this.resolveModel();
    const system = buildSystemPrompt(this.personaContext());
    const tools = await this.buildTurnTools(sessionId);
    // `natural` mimics the real chat loop (a question, no explicit tool command);
    // default is the forceful imperative. `budget` defaults to the real
    // INTERACTIVE_STEP_BUDGET so this matches runConversationTurn exactly.
    const prompt = input.natural
      ? `What is the current spot price of ${input.query}?`
      : `Search the web for "${input.query}" and tell me the single best URL. You MUST call the webSearch tool.`;
    const ui: UIMessage[] = [
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
      },
    ];
    const result = await generateText({
      model,
      system,
      tools,
      stopWhen: stepCountIs(input.budget ?? INTERACTIVE_STEP_BUDGET),
      ...(input.useMessages
        ? { messages: await convertToModelMessages(ui) }
        : { prompt }),
      ...(input.withStepCallback
        ? { onStepFinish: (step) => this.narrateStep(audit, step.toolCalls) }
        : {}),
    });
    const toolCalls = result.steps.flatMap((s) =>
      s.toolCalls.map((t) => t.toolName),
    );
    return {
      model: config.model,
      toolCount: Object.keys(tools).length,
      steps: result.steps.length,
      toolCalls,
      executedTool: toolCalls.length > 0,
      textPreview: result.text.slice(0, 200),
    };
  }

  // ─── Web conversation RPC (MNEMO-35/36, PRD §6.5) ────────────────────────
  // Thread CRUD over the per-agent `web_conversation` store, called by the
  // ownership-guarded HTTP routes (src/agent/conversations/routes.ts). The
  // STREAMING turn goes through `fetch` above (it returns a Response, not a value);
  // these return plain JSON-able values over native Workers RPC.

  /** List this agent's conversation threads, newest-updated first. */
  listConversations(): ConversationSummary[] {
    this.ensureInit();
    return conversations.listConversations(this.ctx.storage.sql, this.name);
  }

  /** Title-search this agent's threads (case-insensitive substring). */
  searchConversations(query: string): ConversationSummary[] {
    this.ensureInit();
    return conversations.searchConversations(
      this.ctx.storage.sql,
      this.name,
      query,
    );
  }

  /** Create a new thread; an opening `firstMessage` seeds the title only. */
  createConversation(input?: { firstMessage?: string }): ConversationSummary {
    this.ensureInit();
    return conversations.createConversation(this.ctx.storage.sql, this.name, {
      firstMessage: input?.firstMessage,
      now: Date.now(),
    });
  }

  /** Fetch one thread's metadata + transcript, or null if it doesn't exist. */
  getConversation(conversationId: string): ConversationDetail | null {
    this.ensureInit();
    return conversations.getConversationDetail(
      this.ctx.storage.sql,
      this.name,
      conversationId,
    );
  }

  /** Rename one thread; returns the updated summary, or null if it doesn't exist. */
  renameConversation(
    conversationId: string,
    title: string,
  ): ConversationSummary | null {
    this.ensureInit();
    return conversations.renameConversation(
      this.ctx.storage.sql,
      this.name,
      conversationId,
      title,
      Date.now(),
    );
  }

  /** Plain-POST chat entry: persist the user message, run the turn, return the reply. */
  private async handlePostChat(request: Request): Promise<Response> {
    this.captureAccountHeader(request);

    const body = (await request.json().catch(() => null)) as {
      message?: unknown;
    } | null;
    const text = typeof body?.message === "string" ? body.message.trim() : "";
    if (!text) {
      return Response.json({ error: "message is required" }, { status: 400 });
    }

    const userMessage: UIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }],
    };
    // saveMessages persists the user message, triggers onChatMessage (which
    // streams + persists the assistant reply), and resolves when the turn ends.
    await this.saveMessages([...this.messages, userMessage]);

    const reply = this.messages.at(-1);
    return Response.json({
      id: reply?.id ?? null,
      role: reply?.role ?? null,
      text: reply ? uiMessageText(reply) : "",
    });
  }

  // ─── Messaging inbound → loop → async reply (MNEMO-46) ───────────────────
  // The public inbound gateway (src/messaging/gateway.ts) authenticates the
  // Twilio webhook, resolves the destination number → this agent, normalizes the
  // payload, then FIRE-AND-FORGETS this handoff via `c.executionCtx.waitUntil(...)`
  // so the agent's work runs AFTER the webhook ack - the ack must never block on
  // the loop (PRD §9.3). This is the agent: the inbound→loop→reply lifecycle lives
  // here, but the SEND goes back out through the MNEMO-44 MessagingChannel seam
  // (src/messaging/reply.ts) so the DO never imports Twilio directly.

  /**
   * PRD §9.3: reply asynchronously. Receive one inbound message handed off by the
   * gateway (MNEMO-45): resolve/create the counterparty's 1:1 daily session,
   * persist the inbound turn, and DEFER the loop+reply onto a DO alarm.
   *
   * The loop is NOT run inline: an agent loop can exceed the webhook timeout
   * (§9.3), so rather than hold the gateway's `waitUntil` open for the whole run
   * we schedule the continuation via `this.schedule` (the `agents` SDK alarm,
   * which survives hibernation) - {@link runInboundReply} is the alarm callback
   * that runs the SAME brain/memory/tools loop web chat uses and sends the reply.
   */
  async onInboundMessage(
    msg: InboundMessage,
    tier: CapabilityTier = "owner",
  ): Promise<void> {
    this.ensureInit();
    // Parse at the boundary so a malformed handoff fails loud here, not silently.
    const parsed = InboundMessage.parse(msg);
    // The gateway has already decided acceptance + tier (MNEMO-47); parse the tier
    // defensively (default `owner`, keeping MNEMO-46 1:1 behavior intact for a call
    // without one) so a stale/absent value can't widen disclosure unexpectedly.
    const accessTier = CapabilityTier.catch("owner").parse(tier);
    const sql = this.ctx.storage.sql;
    const now = Date.now();

    // (1) Resolve/create the 1:1 daily session keyed by the counterparty (§9.5).
    const session = getOrCreate1to1Session(sql, {
      counterparty: parsed.from,
      channel: parsed.channel,
      ts: now,
    });
    // (2) Persist the inbound turn, tagged with its `from` + `channel` (§9.5).
    appendMessage(sql, {
      sessionId: session.id,
      fromId: parsed.from,
      direction: "in",
      channel: parsed.channel,
      body: parsed.body,
      ts: now,
    });
    // A lightweight handoff receipt for the MNEMO-45 gateway smoke test (distinct
    // from the transcript above - proves the gateway→DO handoff landed).
    setMeta(sql, LAST_INBOUND_KEY, JSON.stringify(parsed));

    // (3/4) Defer the loop+reply onto a DO alarm (§9.3) - to = the counterparty,
    // fromNumber = this agent's provisioned number (the one Twilio delivered to).
    // The resolved `tier` rides along so the deferred reply's system context is
    // constrained to it (MNEMO-47 §9.6).
    await this.schedule<InboundReplyTaskInput>(0, "runInboundReply", {
      sessionId: session.id,
      to: parsed.from,
      fromNumber: parsed.to,
      channel: parsed.channel,
      tier: accessTier,
    });
  }

  /**
   * The deferred reply (the DO-alarm callback scheduled by {@link onInboundMessage};
   * MNEMO-46, PRD §9.3). Runs the SAME `generateText` loop / brain / memory / tools
   * web chat uses - assembling the loop input from the counterparty's RECENT
   * transcript so the agent has conversational context - then sends the final text
   * out through the messaging channel and persists the outbound copy. Public so the
   * scheduler can invoke it by name (mirrors {@link runScheduled}).
   *
   * Defensive throughout: a loop or send failure is audited and swallowed - a
   * messaging turn must never crash the DO (audit is observability, not control
   * flow, §7.1). The reply goes out only AFTER the loop completes (never inline).
   */
  async runInboundReply(payload?: InboundReplyTaskInput): Promise<void> {
    this.ensureInit();
    const task = InboundReplyTask.parse(payload ?? {});
    await this.deliverReply({
      sessionId: task.sessionId,
      to: task.to,
      fromNumber: task.fromNumber,
      channel: task.channel,
      tier: task.tier,
    });
  }

  /**
   * The shared reply loop behind both 1:1 ({@link runInboundReply}) and group
   * ({@link replyInGroup}) messaging (MNEMO-46/48). Runs the SAME brain/memory/tools
   * `generateText` loop web chat uses, assembled from a session's recent transcript,
   * under the SMS terseness overlay + the capability-tier disclosure constraint
   * (§9.6 - where group_member/open_world gating takes effect), then sends the final
   * text out through the channel seam and persists the outbound copy. Defensive: a
   * loop or send failure is audited and swallowed - a messaging turn never crashes
   * the DO (audit is observability, not control flow, §7.1).
   */
  private async deliverReply(args: {
    sessionId: string;
    to: string;
    fromNumber: string;
    channel: Channel;
    tier: CapabilityTier;
  }): Promise<void> {
    const sql = this.ctx.storage.sql;
    const transcript = listMessages(sql, args.sessionId);
    if (transcript.length === 0) return; // nothing to reply to
    const lastInbound = [...transcript]
      .reverse()
      .find((m) => m.direction === "in");

    // MNEMO-21: a fresh audit sessionId groups this reply run's events. (This is
    // the observability run id - distinct from the messaging session id.)
    const auditSessionId = crypto.randomUUID();
    const audit = this.auditFor(auditSessionId);
    await audit.sessionStarted(
      `Started SMS reply: ${promptSummary(lastInbound?.body ?? "")}`,
      { channel: args.channel },
    );

    let finalText: string;
    try {
      const { model, config } = await this.resolveModel();
      // Same layered persona web chat uses, plus the SMS terseness overlay (§9.3)
      // AND the capability-tier constraint (MNEMO-47 §9.6) - this is where the tier
      // gating actually takes effect: `owner` adds nothing (full agent), while a
      // group/open-world sender gets the disclosure guard injected into `system`.
      const constraint = tierConstraints(args.tier).systemConstraint;
      const extras = constraint
        ? `${SMS_REPLY_OVERLAY}\n\n${constraint}`
        : SMS_REPLY_OVERLAY;
      const system = buildSystemPrompt(this.personaContext(), { extras });
      const tools = await this.buildTurnTools(auditSessionId);
      const result = await generateText({
        model,
        system,
        messages: toReplyMessages(transcript),
        tools,
        stopWhen: stepCountIs(INTERACTIVE_STEP_BUDGET),
        onStepFinish: (step) => this.narrateStep(audit, step.toolCalls),
      });
      await this.recordTurnUsage(result.usage, config);
      finalText = result.text.trim();
      await audit.sessionCompleted("SMS reply ready", {
        steps: result.steps.length,
      });
    } catch (err) {
      // The loop failed (model/sandbox/etc.) - audit and stop. Never crash the DO.
      await audit.error(`SMS reply failed: ${errMessage(err)}`);
      return;
    }

    if (!finalText) return; // empty completion - nothing to send

    // Send via the MNEMO-44 channel seam, only AFTER the loop completed (§9.3).
    const sent = await sendAgentReply(this.env, {
      agentId: this.name,
      fromNumber: args.fromNumber,
      to: args.to,
      body: finalText,
      channel: args.channel,
    });

    if (sent.ok) {
      // Persist the outbound copy so the web UI renders the full reply (§9.5);
      // the over-SMS body may have been truncated + linked (src/messaging/reply.ts).
      appendMessage(sql, {
        sessionId: args.sessionId,
        fromId: "agent",
        direction: "out",
        channel: args.channel,
        body: finalText,
        ts: Date.now(),
      });
    } else {
      // The reply didn't go out - log an error audit event, don't crash the DO.
      await audit.error(`SMS send failed: ${sent.error}`, {
        to: args.to,
        status: sent.status,
      });
    }
  }

  // ─── Messaging group threads (MNEMO-48, PRD §9.4/§9.5) ───────────────────
  // The group-aware half of the messaging surface. The per-thread coordinator
  // (src/messaging/ThreadCoordinator.ts) ORCHESTRATES - it fans every message to
  // each member here so every agent records the full multi-party history (§9.5),
  // and invokes only the floor winners' loop (§9.4). This agent DO still owns its
  // own identity/memory/tools; it does NOT decide the floor. 1:1 behavior above is
  // untouched.

  /**
   * Record one group message into this agent's group session (the coordinator fans
   * it to every member, §9.5). The session is keyed by `threadId`; a message from
   * this agent itself (`fromSelf`) is its own outbound turn, anyone else's is
   * inbound. On FIRST sight of the group it runs the §9.6 permissive whitelist
   * auto-expansion (every member gains the right to DM the bot - once per group).
   * Returns the recent transcript tail the coordinator feeds the triage gate.
   */
  async recordGroupMessage(
    input: GroupRecordInput,
  ): Promise<GroupRecordResult> {
    this.ensureInit();
    const sql = this.ctx.storage.sql;

    const session = getOrCreateGroupSession(sql, {
      threadId: input.threadId,
      channel: input.channel,
      ts: input.ts,
    });
    appendMessage(sql, {
      sessionId: session.id,
      fromId: input.fromSelf ? "agent" : input.from,
      direction: input.fromSelf ? "out" : "in",
      channel: input.channel,
      body: input.body,
      ts: input.ts,
    });

    // First sight of this group → permissive whitelist auto-expansion (§9.6). The
    // DB add is idempotent; this meta gate keeps it a once-per-group action.
    const joinedKey = `${GROUP_JOINED_PREFIX}${input.threadId}`;
    if (!getMeta(sql, joinedKey)) {
      await expandWhitelistForGroup(this.env, this.name, input.memberNumbers);
      setMeta(sql, joinedKey, JSON.stringify(true));
    }

    const tail = listMessages(sql, session.id)
      .slice(-MAX_GROUP_TAIL_MESSAGES)
      .map((m) => ({ from: m.from, body: m.body }));
    return { tail };
  }

  /**
   * Run the loop as a group floor winner and reply (MNEMO-48, §9.4). Invoked by the
   * coordinator ONLY for the cleared winners: resolves the group session (already
   * created by {@link recordGroupMessage}) and runs {@link deliverReply} under the
   * `group_member` tier - so the §9.6 constraint (do NOT volunteer the owner's
   * private memory) is injected into the loop's system context. The reply goes out
   * via the same async Twilio send path 1:1 uses.
   */
  async replyInGroup(input: GroupReplyInput): Promise<void> {
    this.ensureInit();
    const session = getOrCreateGroupSession(this.ctx.storage.sql, {
      threadId: input.threadId,
      channel: input.channel,
      ts: Date.now(),
    });
    await this.deliverReply({
      sessionId: session.id,
      to: input.to,
      fromNumber: input.fromNumber,
      channel: input.channel,
      tier: input.tier,
    });
  }

  /**
   * Read the last inbound message recorded by {@link onInboundMessage}, or `null`
   * if none has arrived. The receipt the MNEMO-45 gateway test reads back to prove
   * the gateway→DO handoff landed (the durable transcript is below).
   */
  getLastInboundMessage(): InboundMessage | null {
    this.ensureInit();
    const json = getMeta(this.ctx.storage.sql, LAST_INBOUND_KEY);
    return json ? InboundMessage.parse(JSON.parse(json)) : null;
  }

  // ─── Messaging access control (MNEMO-47, PRD §9.6) ───────────────────────
  // The owner's verified number + the open-to-the-world flag live in `agent_meta`
  // (MNEMO-04). The public gateway loads them via `getMessagingAccess` to call
  // `decideAccess` BEFORE handing a message to the loop; the settings API
  // (src/messaging/accessRoutes.ts) writes them. The whitelist itself is D1
  // (`message_whitelist`), read straight by `decideAccess` - not mirrored here.

  /**
   * The access context the gateway needs to decide acceptance + tier: the owner's
   * verified E.164 (null until registered) and the open-to-the-world flag
   * (defaults false - whitelist-by-default, §9.6). Plain serializable shape so it
   * crosses the RPC boundary without a structural-cast bridge.
   */
  getMessagingAccess(): { ownerNumber: string | null; openToWorld: boolean } {
    this.ensureInit();
    const owner = getMeta(this.ctx.storage.sql, MESSAGING_OWNER_NUMBER_KEY);
    const open = getMeta(this.ctx.storage.sql, MESSAGING_OPEN_TO_WORLD_KEY);
    return {
      ownerNumber: owner ? (JSON.parse(owner) as string) : null,
      openToWorld: open ? (JSON.parse(open) as boolean) : false,
    };
  }

  /**
   * Persist the open-to-the-world flag (the settings API's `PUT /messaging/access`
   * writes it). The `open_world` safe-default public persona (tier constraints,
   * §9.6) is the day-one social-engineering guard, so this stays false until the
   * owner deliberately opens the agent.
   */
  setMessagingOpenToWorld(openToWorld: boolean): void {
    this.ensureInit();
    setMeta(
      this.ctx.storage.sql,
      MESSAGING_OPEN_TO_WORLD_KEY,
      JSON.stringify(openToWorld),
    );
  }

  /**
   * Register (or clear, with null) the owner's verified E.164 - the number that
   * resolves a 1:1 sender to the `owner` tier (§9.6). Until set, the owner tier is
   * simply unreachable; every other tier still resolves normally.
   */
  setMessagingOwnerNumber(ownerNumber: string | null): void {
    this.ensureInit();
    setMeta(
      this.ctx.storage.sql,
      MESSAGING_OWNER_NUMBER_KEY,
      JSON.stringify(ownerNumber),
    );
  }

  // ─── Messaging web-rendering reads (MNEMO-46, PRD §9.5) ──────────────────
  // The web UI reads the SAME store the SMS turns persist to, so text threads
  // render as first-class conversations. Both responses carry `channel` (per
  // session + per message) so the UI can render a channel badge (§9.5). Driven
  // by the `/agents/:agentId/messaging/...` routes over native RPC - the shapes
  // are plain string/number/null, so no structural-cast RPC bridge is needed.

  /** List this agent's messaging sessions (newest first, with message counts). */
  listMessagingSessions(): MessagingSession[] {
    this.ensureInit();
    return listSessions(this.ctx.storage.sql);
  }

  /** List one session's messages in chronological order (each with `from`/`channel`). */
  listMessagingMessages(sessionId: string): MessagingMessage[] {
    this.ensureInit();
    return listMessages(this.ctx.storage.sql, sessionId);
  }
}

/**
 * Map a counterparty's recent transcript into `generateText` messages: an inbound
 * turn is a `user` message, an outbound (agent) turn is an `assistant` message, so
 * the loop sees the conversation as a normal chat history (MNEMO-46). Bounded to
 * the most recent turns so an old daily session never blows the prompt budget.
 */
function toReplyMessages(transcript: MessagingMessage[]): ModelMessage[] {
  return transcript
    .slice(-MAX_REPLY_CONTEXT_MESSAGES)
    .map(
      (m): ModelMessage =>
        m.direction === "in"
          ? { role: "user", content: m.body }
          : { role: "assistant", content: m.body },
    );
}

/** Concatenate the text parts of a UI message (drops tool/reasoning parts). */
function uiMessageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

/**
 * Best-effort note title for the neuron index: the YAML front-matter `title:` if
 * present, else the first `# H1` heading, else null (the index then falls back
 * to the filename stem). MNEMO-10 owns the canonical title↔path↔slug mapping for
 * writes; this is just the read-side heuristic used when re-indexing existing
 * notes, so a `[[Title]]` link resolves to the note that declares that title.
 */
function titleFromContent(content: string): string | null {
  const frontMatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontMatter) {
    const title = frontMatter[1].match(/^title:\s*(.+?)\s*$/m);
    if (title) return title[1].replace(/^["']|["']$/g, "").trim() || null;
  }
  const heading = content.match(/^#\s+(.+?)\s*$/m);
  return heading ? heading[1].trim() || null : null;
}

/** Max length of the prompt echo in a `session.started` summary. */
const PROMPT_SUMMARY_MAX = 120;

/**
 * A one-line, length-bounded echo of a prompt for the `session.started` audit
 * text - we narrate a *summary*, never the full prompt (§6.7 keeps the stream a
 * productivity log, not a transcript). Collapses whitespace and truncates.
 */
function promptSummary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "(empty)";
  return flat.length > PROMPT_SUMMARY_MAX
    ? `${flat.slice(0, PROMPT_SUMMARY_MAX - 1)}…`
    : flat;
}

/** Text of the most-recent user message (the turn's prompt), else "". */
function latestUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return uiMessageText(messages[i]);
  }
  return "";
}

/** A loop error's human message (no stack) for an audit `text`. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a Discovery `entityType` to the D1 `agents.template` enum (MNEMO-30 Build):
 * the four real lenses pass through unchanged; `"other"` has no registry template
 * (→ null, so the MNEMO-15 persona layerer skips the overlay).
 */
function registryTemplate(
  entityType: DiscoveryEntityType,
): AgentTemplate | null {
  return entityType === "other" ? null : entityType;
}

/**
 * Render a step's tool-call intent as one plain-English sentence for the calm
 * `narration` stream (PRD §7.1). Derived ONLY from the tool name + its already-
 * validated input - never from raw reasoning, which belongs to the `info`-level
 * "show the work" view, not narration.
 */
function describeToolCall(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  switch (toolName) {
    case "webSearch": {
      const q = str(i.query);
      return q ? `Searching the web: ${clip(q)}` : "Searching the web";
    }
    case "webFetch":
      return `Reading ${str(i.url) ?? "a web page"}`;
    case "readFile":
      return `Reading ${str(i.path) ?? "a file"}`;
    case "writeFile":
      return `Writing ${str(i.path) ?? "a file"}`;
    case "listDir":
      return `Listing ${str(i.path) ?? "a directory"}`;
    case "runShell": {
      const cmd = str(i.command);
      return cmd ? `Running a command: ${clip(cmd)}` : "Running a command";
    }
    case "runPython":
      return "Running a Python snippet";
    case "authorTool":
      return `Writing a reusable tool${str(i.name) ? `: ${str(i.name)}` : ""}`;
    case "listTools":
      return "Reviewing its authored tools";
    case "deleteTool":
      return `Removing a tool${str(i.name) ? `: ${str(i.name)}` : ""}`;
    case "submitFinalReport":
      return "Finalizing the report";
    default:
      return toolName.startsWith("brain__")
        ? `Running tool ${toolName.slice("brain__".length)}`
        : `Using ${toolName}`;
  }
}

/** Clip a value to a short, single-line fragment for a narration sentence. */
function clip(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
