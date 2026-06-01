# Mnemosyne - Product Requirements Document

> **Status:** Draft v0.6 - brainstorm + feasibility research + working-session decisions (2026-05-24).
>
> **v0.6 changes:** added §6.10 - a single **up-front, token-driven design system + shared component
> library** (`frontend/src/components/ui/`), strict **lint-enforced reuse** (no bespoke controls; reskin
> later by swapping tokens). New playbook **MNEMO-32-b** authored before feature UIs; frontend phases
> 33–43 depend on it.
>
> **v0.5 changes:** **iMessage dropped for now** (per-line cost ~$39–100/mo killed it); the messaging
> channel is **SMS via Twilio** (~$1.15/mo per number + usage), with `MessagingChannel` kept so iMessage
> can return later (§9). Whitelist: pulling a bot into a group **grants every group member the right to
> message it** - capability tiers, not the access list, guard private memory (§9.6).
>
> **v0.4 changes - all open questions resolved; §10 removed.** Audience = **public multi-tenant SaaS** (§3);
> container model **decided** - DO is the cheap always-home, per-agent sandbox is warm-on-activity /
> idle-down, R2-persisted, **complete per-agent isolation** (§7.3, §8.4); **no hard v1 cut** - phased
> delivery via Auto Run docs, nothing is removed (§2); Discovery exit operationalized as a good-enough
> confidence gate (§5); **rich agentic interface** with user-authored persistent tools + internal direct
> service layer (§6.3); **web brain explorer + git-versioned brain** with restore added (§6.9); messaging =
> **managed provider, per-agent number is a paid add-on**, recommended Blooio/Sendblue, a later phase (§9);
> bot presence self-evident on first reply, **no join announcement** (§9.4); open-vs-personal is a
> **per-agent user choice** (§9.6).
>
> **Carried from v0.3:** harness **topology A** (§7); **LLM provider** - Qwen3-30B free default + BYOK (§7.2);
> **memory model** - real parsed `[[wikilink]]` graph the agent reasons over (§4, §6.2); four committed
> differentiators - living brain, self-authored tools, audit-log "glass cockpit," computed PNG reports (§6);
> **audit-log spike built + unit-tested** (§8.6).
>
> Companion docs: `docs/crema-architecture-reference.md` (reusable Cloudflare/agent mechanics),
> `AGENTS.md` (repo conventions).

---

## 1. Overview

**Mnemosyne** packages AI research capability as a web application for non-technical users.
Today these research agents are hand-built inside Maestro: they produce markdown with Obsidian
front matter, driven by per-entity templates (vendors, products, investors, founders). Mnemosyne
turns that bespoke workflow into a self-serve product - a user describes what they want researched,
the platform stands up a persistent agent, and the agent researches, remembers, and reports on a
schedule without the user touching a terminal.

**The thesis (the name is the product):** the differentiator is *memory*. Each agent owns a
persistent Linux filesystem that is its knowledge base - files are "neurons," links between them
are "synapses." Agents grow a durable, searchable brain over time rather than starting cold every
session. This is precisely the long-term-memory gap that the Crema-CRM reference explicitly punts on.

---

## 2. Goals & Scope

### Goals (core capabilities)
- A non-technical user can create a research agent in minutes via a guided **Discovery → Build → Operation** flow.
- Each agent has **persistent, file-based memory** that survives across runs and is searchable.
- Memory is a **real `[[wikilink]]` graph** (neurons + synapses) the agent reasons over, with an idle/scheduled **consolidation pass**.
- Agents can **write and persist their own tools** (procedural memory), reused across runs.
- Every agent has a **streamable, filterable, searchable audit log** (the "glass cockpit").
- The agent's brain is **browsable, editable, downloadable, and version-controlled** from the web UI (§6.9).
- Agents run **web research with tool use** and produce markdown reports (Obsidian-compatible), including **computed charts** (rendered to PNG).
- Agents report **on a schedule** (e.g., weekly) and notify by **email**.
- Users view, search, and thread **conversations** with their agents from web and mobile.
- Passwordless **magic-link auth** (Resend).

### Scope & phasing - *nothing is cut*
There is **no hard v1 boundary.** The full product ships in ~50 sequential **phases**, each driven by an
Auto Run doc that bundles 5–10 tasks sized to a single working context (see §11, Build plan). Items once
framed as "deferred" are simply **later phases**, not removed:
- Voice interaction (press/toggle-to-talk, delay detection).
- Multi-agent **group chat** (specified in §9 as part of the messaging channel).
- Anonymous **agent ranking / leaderboard** system.
- Command+K palette, inline help panel, keyboard-shortcut system.
- Public marketplace / forkable-shareable brains.

Sequencing principle: land the **memory + research + scheduled-reporting + audit-log + brain-explorer**
core first (it is independently complete and defensible), then layer messaging, collaboration, and
marketplace in later phases.

---

## 3. Target Users

People who need recurring research - competitive/market intel, deal sourcing, vendor tracking -
but lack the technical setup to run agents themselves. **This is a public multi-tenant SaaS** (not a
personal / invite-only tool) - so billing, abuse controls, rate limiting, and per-user cost caps are
in scope from the start. Public exposure *increases* when a user enables the messaging channel (§9) and
opens their agent's whitelist to the world, which sharpens the per-agent access model (§9.6).

---

## 4. Core Concepts

| Concept | Definition |
|---|---|
| **Agent** | A named research persona with a description, a persistent filesystem (its brain), a conversation history, a report archive, an audit log, and a schedule. |
| **Memory (neurons/synapses)** | Files on the agent's filesystem = neurons. `[[wikilink]]`-style links parsed into a **real graph** = synapses. The agent retrieves *and reasons over* the graph (traversal, not just search). "Brain size" = neuron count + synapse count. |
| **Self-authored tool** | A script (usually Python) the agent writes once, saves to `/brain/tools/`, and reuses across sessions - *procedural* memory, vs. notes as *declarative* memory. |
| **Report** | A generated markdown artifact (Obsidian front matter), optionally with **computed charts (PNG)**, produced on demand or on schedule, archived and searchable. |
| **Audit log** | A per-agent, append-only **productivity stream** of what the agent *did* (read N sources, wrote N neurons, authored a tool, generated a report) - streamable, filterable, searchable. Not a raw token/tool dump. |
| **Conversation** | A threaded chat with one (core) or more (later) agents. Conversation-centric organization, with rename/search. |

---

## 5. Agent Lifecycle - Discovery → Build → Operation

1. **Discovery.** User gives an agent name + short description; the platform asks follow-ups until it
   understands **what the agent is meant to specialize in.** Exit is a **"good-enough" confidence gate**
   (the brainstorm's "~90%"): the model self-assesses that it has enough to start building, using a soft
   rubric of the facets that matter - subject, entity type, sources, cadence, output format. It is a soft
   threshold (start when confident), not a hard slot-filling form.
2. **Build.** Platform provisions the agent: filesystem, system prompt, enabled tools (web search,
   tool execution), schedule defaults. Agent is configured with its template (vendor/product/investor/founder).
3. **Operation.** Agent runs research turns (interactive or scheduled), writes to memory, emits
   reports, and notifies by email.

---

## 6. Functional Requirements

### 6.1 Auth & Accounts - *Must*
- Magic-link login via Resend; time-limited single-use tokens.
- One account → many agents.

### 6.2 Filesystem / Memory - *Must*
- Persistent per-agent Linux filesystem, durable across runs and sleeps (R2-backed; see §8.1).
- Standard CLI tooling available to the agent: `find`, `grep`, `sed`, `awk`, plus the ability to
  **write and run custom tools** (e.g., a Python script that parses a site or computes a statistic).
- Memory is the agent's knowledge base; reports and notes persist as files.
- **Living brain:** parse `[[wikilinks]]` into a real graph; expose a visible map that grows; provide
  graph traversal as a retrieval tool. An idle/scheduled **consolidation pass** lets the agent
  re-read, merge, and re-link its own notes ("sleep"). Consolidation must be **versioned + diffed
  before commit** - it can corrupt the brain otherwise (backed by the git history of §6.9).
- **Self-authored tools:** the agent persists reusable scripts to `/brain/tools/`. This is the
  product's largest security surface (agent-authored code re-run later) - contained by complete
  per-agent sandbox isolation (§7.3, §8.4).

### 6.3 Research & Tools - *Must*
- Web search + fetch with time/size safety caps (carry Crema's `BLOCKED_HOSTS`, 15s timeout, 200KB cap).
- The harness is the **Vercel AI SDK tool-calling loop** (§7.1), bounded by `stopWhen`. For deep
  research the step budget is high (~50–200) and exit is deliberate via a **terminator tool** whose
  input schema is the final-report schema.
- Tools are Zod-typed; each tool's `execute` body drives the sandbox (shell / Python / file ops).
- **Rich agentic interface (not a thin API):** while talking to their agent, the user/agent can
  **write tools that persist** (Python or shell run in the container) and reuse them across sessions
  (§6.2). Internally the harness reaches Mnemosyne services via a **direct service layer** (no self-API
  round-trips); that surface is exposed to the model as a rich, extensible tool set.
- Entity templates: vendor / product / investor / founder.

### 6.4 Reporting & Notifications - *Must*
- Markdown output with Obsidian front matter.
- **Computed reports:** the Code Interpreter (§7.3) runs Python to compute and **visualize** findings;
  charts are rendered to **PNG** (and SVG→PNG). PNG is chosen deliberately so one artifact embeds across
  **every** delivery medium - web, email (core), and the premium SMS channel (§9), where MMS/email
  cannot reliably render SVG.
- Scheduled reporting (e.g., weekly) via DO scheduler + cron fan-out. **Delta-aware:** because the agent
  remembers prior state, scheduled reports surface *what changed*, not a from-scratch re-summary.
- Email notification on report/update via Resend.
- Web-based report viewing + full-text search.

### 6.5 Conversations - *Must (single-agent) / Later (group)*
- Threaded conversations with search + rename.
- Conversation-centric navigation.
- Mobile-responsive with feature parity.
- Agent avatars. Filter by agent / time / keyword.

### 6.6 Agent Management & Metrics - *Should*
- List/filter/search agents.
- Agent detail: chat history, reports, audit log, settings, creation date, metadata.
- "Brain size" metric: neurons (files) + synapses (parsed links), backed by the real graph (§6.2).

### 6.7 Audit log - the "glass cockpit" - *Must*
- **Per-agent, append-only productivity stream.** Each event states what the agent *did* at a higher
  level than raw tokens/tool calls (types: `session.*`, `source.read`, `memory.wrote/linked/consolidated`,
  `tool.authored/ran`, `report.generated`, `chart.rendered`, `narration`, `error`).
- **Streamable** (SSE, with a `sinceSeq` cursor for reconnect backfill), **filterable**
  (type/level/session/time), **searchable** (FTS5 over the human summary).
- **`level` is the altitude control** (`milestone` | `info` | `error`) enabling **narrated progressive
  disclosure**: a calm plain-English milestone stream by default, with a "show the work" toggle for the
  raw bash/Python/reasoning. This is how complex machinery stays *attainable to the general population*.
- Status: **spike built + unit-tested** (§8.6).

### 6.8 Later phases - *planned, not cut*
- Anonymous ranking; Command+K + help panel + shortcuts; voice; forkable/cloneable brains + marketplace.
- Messaging channel (**SMS via Twilio**; iMessage parked) + multi-agent group chat (§9) - a **later
  phase**, delivered as a **paid per-agent add-on** (~$1.15/mo per number + usage, §9.2).

### 6.9 Brain explorer & versioning - *Must*
- The agent's filesystem (its brain) is **browsable and editable from the web UI**: view, edit, create,
  and delete files/notes directly, and **download the entire brain** as an archive (zip/tarball).
- **Revision control + restore - yes, and it's a natural fit:** the brain is a **git repo inside the
  sandbox**, auto-committed on writes and on each consolidation pass (§6.2). The UI exposes commit
  history, per-file diffs, and one-click **restore** to a prior revision. This doubles as the safety net
  consolidation requires ("versioned + diffed before commit") and a guard against a bad self-authored-tool
  write. (Git-in-sandbox gives clean per-file diff/restore; R2 object versioning is a coarser backstop.)

### 6.10 Design system & shared components - *Must (defined up front, before feature UIs)*
- A **single design language is defined up front** - one token set (color, typography, spacing, radius,
  elevation, z-index, breakpoints, motion) is the source of *every* visual value. **Token-driven theming:**
  components never hardcode visual values, so the product can be **reskinned later by swapping tokens**
  without touching feature code. Neutral default skin for now.
- A **canonical shared component library** in `frontend/src/components/ui/` - buttons, inputs, selects,
  toggles, form fields, modals, drawers, tabs, tables, cards, badges, avatars, toasts, tooltips, menus,
  spinners, skeletons, empty states, layout primitives, an icon component, and the app shell - with a
  living **component catalog** page rendering every component and variant.
- **Strict reuse - non-negotiable:** every feature screen composes these shared components; **no bespoke
  one-off controls.** A missing primitive is added to the shared kit + catalog, never built locally. This
  is **lint-enforced** (raw interactive HTML elements banned outside `components/ui/`).
- Built in **MNEMO-32-b**, before any feature UI; all frontend phases (33–43) depend on it.

---

## 7. Architecture & Stack

Built on the Cloudflare-edge patterns harvested from Crema-CRM (see `docs/crema-architecture-reference.md`).

### 7.1 Harness - topology A (orchestrate-from-DO) - *decided 2026-05-24*

The **Durable Object is the harness host; the model is called via API; the sandbox is a tool surface.**
(The alternative - running an agent framework *inside* the container, "topology B" - was set aside for
cost/control reasons.) The harness is **not bespoke loop code and not an off-the-shelf agent CLI** - it
is the Vercel AI SDK loop hosted by `AIChatAgent`:

- **`AIChatAgent<Env>`** (`@cloudflare/ai-chat`, on the `agents` SDK), one per agent via
  `idFromName(agentId)` - message-history persistence, streaming, hibernation survival, scheduling.
- **`streamText`** (interactive) / **`generateText`** (headless + scheduled) from `ai` - *this is the
  agentic loop*: call model → run tool calls → feed results back → repeat, bounded by `stopWhen`.
- **Deep-research deltas from Crema's copilot loop:** high step budget (~50–200, not 10); terminator
  tool for deliberate exit; **write large tool outputs to the brain FS and feed back a *path*, not the
  blob** (the SDK does not compact the in-loop message array - critical for context discipline);
  reasoning models surface `reasoning` parts for the "show the work" view (§6.7).

### 7.2 LLM provider - single model-agnostic resolver - *decided 2026-05-24*

One harness, swappable model. `getModel()` resolves a Vercel-AI-compatible `LanguageModel` **per-user**
(Crema's resolver is global-env; Mnemosyne reads the user's profile).

- **Free default:** Workers AI **`@cf/qwen/qwen3-30b-a3b-fp8`** - confirmed function-calling + reasoning
  + batch; 10k Neurons/day free, then $0.011/1k. Chosen over Hermes 2 Pro 7B (Qwen3 adds a reasoning
  trace and a 32k-class context). Zero secrets, billed to the platform, capped per-user.
- **BYOK upgrade:** user saves `{provider, model, key}` in their profile. **OpenRouter** primary (one key
  → Claude/GPT/Gemini/…); **Anthropic / OpenAI direct** as asked. **LiteLLM** only if per-user budget
  *enforcement* becomes a hard requirement - otherwise not worth the ops over OpenRouter.
- **AI Gateway:** route BYOK through it for caching, request logs, and **per-user spend caps**.
- **Secret custody** is a real obligation (§6.1).

### 7.3 Sandbox - the agent's computer - *lifecycle decided 2026-05-24*

Per-agent **Cloudflare Sandbox (container)** - the real Linux filesystem and command/tool execution
layer, **one sandbox per agent (complete per-bot isolation; brains cannot cross-contaminate).** It is
**spun up on demand, kept warm during activity, and idled down after inactivity**; the filesystem
persists to **R2** across sleeps, so nothing is lost when the container goes away. The sandbox `exec`
command runs shell + custom tools; `readFile`/`writeFile` for memory; the **Code Interpreter**
(`createCodeContext` / `runCode`) runs persistent Python contexts with rich outputs (charts, tables) -
the basis for §6.4's PNG charts. Snapshot/restore for recovery; a git repo in `/brain` for versioning (§6.9).

### 7.4 The rest

- **Audit log:** dedicated `AuditLog` Durable Object per agent (`idFromName(agentId)`), DO SQLite + FTS5,
  fanning out over SSE (§6.7, §8.6).
- **Per-agent Durable Object** - the always-cheap home: chat history, settings, schedule, and the memory
  *index* (file/link graph metadata in DO SQLite, up to 10 GB/object) so search/brain-size work *without*
  waking the container.
- **Email** - Resend for magic links + report notifications.
- **Scheduling** - DO `this.schedule` for per-agent timers + Worker `scheduled` cron fan-out.
- **Storage** - D1 (accounts, agent registry, report metadata), KV (sessions/identity), DO SQLite
  (per-agent state, memory index, audit log), R2 (sandbox FS persistence + report/PNG blobs).
- **API/UI** - Hono + Zod backend; frontend reusing Crema component patterns. TypeScript/ESM.

---

## 8. Feasibility Assessment (2026-05-24)

**Verdict: feasible.** The one capability that looked impossible on Cloudflare a year ago is now GA.

### 8.1 The hard requirement is solved - Cloudflare Sandboxes (GA April 2026)
The brainstorm's "standard Linux filesystem + `find`/`grep`/`sed`/`awk` + run custom tools" is
**not** achievable in plain Workers/DOs (no POSIX FS, no arbitrary process execution). It **is** the
exact use case of **Cloudflare Sandboxes**, which reached general availability in April 2026:
- Full isolated Linux container per sandbox; the sandbox `exec` command runs shell (stdout/stderr/exit code).
- `writeFile`/`readFile`; **persistence across sleep/wake** via R2/S3 mounted as a local filesystem.
- **Code Interpreter** with persistent Python contexts + rich outputs - directly enables computed PNG charts (§6.4).
- Sandbox addressed by stable name (same `idFromName` idiom as DOs) - one sandbox per agent maps cleanly.
- *Caveat:* the Containers/Sandbox **infrastructure** is GA, but the Sandbox **SDK docs still carry a
  "Beta" header** - don't pin business-critical behavior to an undocumented method without a test.

### 8.2 Storage ceilings - fine
- DO SQLite: 10 GB per object (Paid). Ample for an agent's chat history + memory index.
- Sandbox disk: configurable via instance type (raised 15× in Feb 2026); durable layer on R2.

### 8.3 Auth - low risk
Magic-link + Resend on Workers is well-trodden; Cloudflare even documents the pattern. No blockers.

### 8.4 Top risk: **cost & lifecycle of per-agent containers** ⚠️
Sandboxes inherit **Containers pricing**: memory ~$0.0000025/GiB-s, CPU ~$0.000020/vCPU-s, disk
~$0.00000007/GB-s, with a monthly free allowance (~25 GiB-hr mem, 375 vCPU-min, 200 GB-hr disk).
Billing is **active-time only** - you pay while a container runs, not while it sleeps. Community
sentiment (HN, Oct 2025) flags container pricing as expensive at scale.

Implications:
- Research agents are **bursty** (minutes of work per session + a scheduled weekly run), so if
  containers **sleep aggressively** per-agent cost should be small.
- The danger is (a) containers that don't idle-down promptly, (b) many concurrent agents, (c) large
  persistent disks. A public multi-tenant launch needs **per-user cost caps + concurrency limits**.
- **Container model - decided:** the **Durable Object is the always-cheap home** (conversation history,
  settings, schedule, memory/audit index - survives regardless). A **per-agent sandbox is spun up on
  demand, kept warm during activity, and idled down after inactivity**; the filesystem persists to **R2**,
  so nothing is lost when the container goes away. **Complete per-agent (per-bot) isolation** - one
  sandbox per agent, brains cannot cross-contaminate - with cost controlled precisely by the DO-warm /
  sandbox-ephemeral split, *not* by sharing sandboxes across agents.

### 8.5 LLM economics & other notes
- **Free tier:** Workers AI 10k Neurons/day free, then $0.011/1k. Qwen3-30B-A3B confirmed
  function-calling + reasoning + batch. Honest ceiling: a free open model is below frontier for the
  deepest 100-step chains - hence BYOK Claude for the flagship tier (§7.2).
- **Cron does not fire in `wrangler dev`** (Crema gotcha) - need a dev-only trigger route.
- Sandbox subrequest cap: 1,000/request on Paid; each command/`readFile`/`writeFile` is one - fine
  for normal use, relevant for tight loops.

### 8.6 Build status
- **Audit-log spike: built + unit-tested.** `src/audit/types.ts`, `src/audit/store.ts`,
  `test/audit-store.test.ts` - **6/6 passing** on bare Node 25 via `node:sqlite` (`npm run test:audit`).
  Covers append (monotonic `seq`), filter (type/level/seq-cursor/time), **FTS5 search**, and
  injection-safety. The store sits behind a `SqlDriver` interface so the *same* logic runs in the test
  (node:sqlite) and the DO (`ctx.storage.sql`) - verified parity for DDL, `RETURNING`, FTS5.
- The `AuditLog` DO + SSE wrapper is the remaining ~60 lines of plumbing; it can't run outside the
  workers runtime, so it is reviewed code pending the worker scaffold.

---

## 9. Messaging Channel - SMS via Twilio (Premium, later phase)

Premium feature: each agent is reachable by **text message** with the *same brain, memory, and tools*
as the web chat. SMS is just another entry point that resolves to the existing per-agent DO (§7) and
runs the same `streamText`/`generateText` loop. Conversations persist to the same store the web UI
reads, so text threads render in-app as first-class conversations tagged by channel. Shipped as a
**paid per-agent add-on** in a later phase (§6.8).

**iMessage is parked (not cancelled).** Dual blue/green delivery required an iMessage API provider
owning the line at **~$39–100/mo per number** (§9.2 history) - far too expensive for a number-per-agent
SaaS. We ship **SMS-only via Twilio** now (~$1.15/mo per number) and keep the `MessagingChannel`
abstraction (§9.3) so an `ImessageProviderChannel` can be added later if the economics change.

### 9.1 Channel strategy - SMS via Twilio
**Twilio is the channel.** Each opted-in agent gets a dedicated Twilio long-code number; outbound and
inbound SMS run through Twilio's Programmable Messaging API. SMS (not WhatsApp) is chosen for global
reach. Messages render green everywhere - there are no blue bubbles without iMessage, which is parked.

**Friction to plan for - A2P 10DLC.** US application-to-person SMS requires carrier registration: a
one-time **brand** registration and a **campaign** registration (small monthly fee), after which a
brand/campaign covers many numbers. Unregistered numbers get throttled/blocked, so 10DLC onboarding
must be part of the messaging-enable flow, not an afterthought - it is a *days-not-minutes* step.

The **`MessagingChannel` interface** (§9.3) still abstracts send + inbound normalization so iMessage
or RCS can be re-added later without touching the agent loop.

### 9.2 Cost - Twilio per agent (verified 2026-05)
Per **number per agent**:
- **Number:** ~**$1.15/mo** (US long code; toll-free ~$2.15/mo).
- **Per message:** ~**$0.0083/segment** (160 GSM-7 chars; volume tiers down to ~$0.0073) **+ ~$0.005/segment** A2P carrier surcharge → ~**$0.013/segment** all-in.
- **A2P 10DLC (shared, not per-number):** brand ~$4.50 (sole-prop/low-volume) to ~$46 (standard w/ vetting), one-time; campaign ~$15 one-time + **~$1.50–10/mo**. One brand/campaign covers many agent numbers.

**Net:** a number per agent is **~$1.15/mo + usage** - roughly **35–85× cheaper** than the parked
iMessage providers (~$39–100/mo). Cheap enough that a number per opted-in agent is economically
trivial; the real cost is per-message volume and the one-time 10DLC onboarding, not the line.

> *History (parked):* managed iMessage providers - Blooio ~$39/mo, Sendblue ~$100/mo per line; self-host
> (LoopMessage BYO-Mac, BlueBubbles) doesn't scale to a number-per-agent SaaS. Revisit only if dual
> blue/green delivery becomes a must-have.

### 9.3 Architecture - reuse the agent DO, add a thread coordinator
- Inbound message → **gateway Worker**: validate the provider webhook signature, resolve destination
  number → `agentId`, check sender against the agent's access policy (§9.6), normalize to a
  channel-agnostic message.
- Gateway hands off to the existing **per-agent DO** (`onInboundMessage(from, body, channel)`), which
  runs the same loop with the agent's tools + memory - no separate brain.
- **Reply asynchronously**: ack the webhook immediately, then send via the provider's REST API when
  the loop finishes. Agentic loops exceed webhook timeouts, so never reply inline. DO `alarm`/`waitUntil`
  cover the lifecycle.
- **`MessagingChannel` interface** abstracts send + inbound normalization + capability flags (group,
  media, delivery-type). Implementation now: `TwilioSmsChannel` (primary); `ImessageProviderChannel` parked (§9.2).
- Long replies: SMS segments at ~160 chars - prompt the agent to be terse over text and/or send a
  link to the full web thread for long output.

### 9.4 Group threads + "only valuable chatter"
A thread may contain **one or more agents** (and humans). Every agent **sees and tracks every
message** but **responds only when it has something valuable** - no pile-on, only signal.

1. **Triage gate (cheap, per agent per message):** a fast Haiku call - "given this conversation and
   my role, do I have something valuable to add now? yes/no + confidence." No → stay silent, just
   append to the agent's transcript.
2. **Floor control:** a **thread-coordinator DO** (one per group thread) fans the message to each
   member's gate, collects confidence bids within a short debounce window, and lets only the **top
   1–2** run the full loop and reply. Each agent keeps its own DO (identity/memory/tools); the thread
   DO orchestrates.
3. **@-mention override:** a named agent always responds.
4. **Loop prevention:** agents triage aggressively on *human* messages but do **not** reply to
   *other agents* unless addressed, with a hard cap on agent turns per human turn + post-speak
   cooldown. Prevents agent↔agent runaway.

**Adding agents to human group chats** is supported (e.g., owner + spouse + bot); the bot sees the
full conversation from join.

**Privacy - decided:** **no formal join announcement.** A bot's presence is self-evident the first
time it chimes in, which is sufficient notice. (Participants' messages do enter the agent's memory; the
access tiers in §9.6 govern what the agent will *do* with them.)

### 9.5 Persistence & web integration
- Each agent stores its own transcript keyed by counterparty: 1:1 = `(agentId, counterpartyNumber)`;
  group = `(agentId, threadId)` holding the **full multi-party history** (every participant + every
  agent), each message tagged with its `from` identity and `channel` (`imessage`/`sms`/`rcs`).
- 1:1 text threads are **bucketed one session per calendar day** (matches the web conversation model, §6.5).
- The web UI reads the same store → text threads render as labeled, searchable multi-party
  conversations with a channel badge. Not a separate silo.

### 9.6 Access control - capability-gated, user's choice
Per-agent setting; **whitelist by default**, with an **open-to-the-world** toggle. **Personal vs. shared
is the user's call per agent** - a bot kept personal stays private; a bot the user wants to share, they
share. Access tier gates **capability**, not merely message acceptance:
- **Owner 1:1** → full memory + tools.
- **Known whitelisted contact** → full conversation, guarded with private data.
- **Mixed/unverified group** (owner + spouse + bot) → answers in-context, does **not volunteer** the
  owner's private memory unprompted.
- **Open to the world** → the **safe default is a public persona with no private memory/sensitive tools**;
  the user can deliberately publish a *shared* bot with the brain/tools they choose to expose. The default
  prevents day-one social-engineering of a bot that was opened without thinking it through.

**Whitelist auto-expansion - decided permissive:** pulling a bot into a group **grants every member of
that group the right to message it** (added to the agent's whitelist, including 1:1). Safety rests on
the **capability tiers above, not the access list** - anyone can *reach* the bot, but what it *reveals*
is governed by tier (a stranger met in a group never gets owner-1:1 disclosure). **Webhook auth:**
validate the Twilio signature on every inbound call so only Twilio can post to the gateway.

---

## 10. Build Plan - phased Auto Run docs (next step)

Delivery is sequenced as ~50 **phases**, each an Auto Run doc bundling **5–10 tasks sized to a single
working context**, run one at a time. The early phases follow the §2 sequencing principle (memory +
research + scheduled reporting + audit log + brain explorer first; messaging and collaboration later).
*Authoring these phase docs is the immediate next deliverable.*

---

## Sources
- [Cloudflare Sandbox SDK docs](https://developers.cloudflare.com/sandbox/)
- [Sandboxes & Containers GA changelog (2026-04-13)](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/)
- [Cloudflare Sandboxes reach GA - InfoQ](https://www.infoq.com/news/2026/04/cloudflare-sandboxes-ga/)
- [Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Containers limits & instance types](https://developers.cloudflare.com/containers/platform-details/limits/)
- [Durable Objects storage limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Cloudflare Email Service - magic-link example](https://developers.cloudflare.com/email-service/examples/email-sending/magic-link/)
- [HN: Containers/Sandbox pricing discussion](https://news.ycombinator.com/item?id=45611237)
- [Sendblue - iMessage API (group messaging, RCS + SMS fallback)](https://www.sendblue.com/api)
- [Sendblue - iMessage API pricing comparison (2026)](https://www.sendblue.com/blog/imessage-api-pricing-comparison)
- [LoopMessage - iMessage API for Business (BYO-hardware, fallback add-ons)](https://loopmessage.com/pricing/)
- [Blooio - iMessage API alternatives & pricing](https://blooio.com/alternatives)
- [Cloudflare Sandbox - Code Interpreter API](https://developers.cloudflare.com/sandbox/api/interpreter/)
- [Workers AI - Qwen3-30B-A3B-FP8 model page](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)
- [Workers AI - function calling](https://developers.cloudflare.com/workers-ai/features/function-calling/)
- [Workers AI - pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Vercel AI SDK with Workers AI](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/)
- [AI SDK Core - tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [Cloudflare AI Gateway - REST API (2026-05-21)](https://developers.cloudflare.com/changelog/post/2026-05-21-rest-api/)
