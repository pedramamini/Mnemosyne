# Crema-CRM → Mnemosyne: Architecture Reference

> **Status:** analysis / reference. Not a spec for Mnemosyne - a catalog of reusable
> Cloudflare Durable Object + agentic-LLM mechanics harvested from Crema-CRM.
>
> **Source:** https://github.com/Crema-Sales/Crema-CRM (cloned to `_crema-crm/`).
> All file paths below are relative to `_crema-crm/backend/` unless noted.
>
> **Framing:** Crema is a **parts donor**, not a template. We lift the domain-agnostic
> agent-hosting machinery; we leave the CRM domain behind. Crema itself is a hackathon
> build (`name = "ctrl-alt-elite-agent"`, "Phase 04/05/08" comments) - the architecture
> is sound, expect rough edges in error handling.

---

## The pattern in one sentence

A **per-user Durable Object** (`RepAgent`, addressed by `idFromName(repId)`) extends
Cloudflare's `AIChatAgent` base class; the agentic tool-calling loop is just **Vercel AI SDK
`streamText` with `stopWhen: stepCountIs(10)`**, and **every tool is a thin HTTP call back into
the Worker's own `/v1/*` API** carrying the user's JWT over a `SELF` service binding.

The "agent framework" is two npm packages (`agents` + `@cloudflare/ai-chat`), not bespoke loop code.

---

## The DO cast (`wrangler.toml`)

| DO class | Binding | Job | Source |
|---|---|---|---|
| `RepAgent` | `AGENT` | Chat copilot - agentic LLM + tool use | `src/agent.ts` |
| `RepMcp` | `MCP_AGENT` | Same tool catalog re-exposed as an MCP server | `src/mcp.ts` |
| `RepExtension` | `REP_EXT` | Hibernating WebSocket bridge (command queue + ack correlation) | `src/rep-extension.ts` |
| `CustomerStream` | `CUSTOMER_STREAM` | Per-customer SSE fan-out (subscriber set + ring buffer) | `src/customer-stream.ts` |

All four are declared as `new_sqlite_classes` and keyed by `idFromName(<stable id>)`.
**One instance per entity, globally addressable, no allocation/routing logic.** This is the
core DO idiom the whole project leans on.

---

## Reusable kit (carry into Mnemosyne)

### 1. Per-entity DO via `idFromName`

```toml
# wrangler.toml
[[durable_objects.bindings]]
name = "AGENT"
class_name = "RepAgent"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RepAgent"]
```

```typescript
// index.ts - route a request to the one DO that owns this user
const id = env.AGENT.idFromName(repId);
const stub = env.AGENT.get(id);
return stub.fetch(forwarded);
```

Pick your unit (user, session, document, memory-namespace) and key the DO by it. Zero routing logic.

### 2. Agent engine - `AIChatAgent` + `streamText` + `stopWhen`

`RepAgent extends AIChatAgent<Env>` gives you message-history persistence in DO storage,
streaming, WebSocket plumbing, and summarization rollups for free. The entire loop:

```typescript
// agent.ts - onChatMessage (trimmed)
async onChatMessage(): Promise<Response | undefined> {
  const jwt = await this.getRepJwt();
  const model = getModel(this.env);
  const tools = buildTools(this.env, jwt, this);
  const system = buildSystemPrompt(coachSlug, { orgPrompt, userPrompt });

  const result = streamText({
    model,
    system,
    messages: await convertToModelMessages(this.messages),
    tools,
    stopWhen: stepCountIs(10), // ← this IS the agentic loop bound
  });
  return result.toUIMessageStreamResponse({ originalMessages: this.messages });
}
```

You override three hooks: `onStart` (rehydrate state), `onConnect` (capture per-connection
auth), `onChatMessage` (the turn). No hand-rolled "call → parse tool → execute → feed back" loop.

### 3. Auth through hibernation

A DO hibernates after ~30s idle; tool calls need the JWT after it wakes. The flow:

1. Worker verifies `?token=<jwt>` on the WS upgrade, copies it into an `x-rep-jwt` header
   before forwarding to the DO (`index.ts`):
   ```typescript
   const headers = new Headers(request.headers);
   headers.set("x-rep-jwt", token);
   return env.AGENT.get(env.AGENT.idFromName(repId)).fetch(new Request(request, { headers }));
   ```
2. DO reads it in `onConnect` and **persists to DO storage** (`agent.ts`):
   ```typescript
   async onConnect(_c, ctx) {
     const jwt = ctx.request.headers.get("x-rep-jwt");
     if (jwt) { this.repJwt = jwt; await this.ctx.storage.put("rep:jwt", jwt); }
   }
   ```
3. On wake, `onStart` / `getRepJwt()` rehydrate from storage. Cron and background paths
   **forge their own per-user JWT** and thread it the same way, so a cold DO that never saw
   a chat connection can still self-authenticate.

This is the answer to "how does a sleeping edge agent stay authenticated to its own backend."

### 4. Provider abstraction (`llm.ts`)

One function resolves any Vercel-AI-compatible `LanguageModel`:

- **Primary:** OpenRouter (`anthropic/claude-sonnet-4.5`) routed through a **Cloudflare AI
  Gateway** URL when `AI_GATEWAY_ACCOUNT_ID` is set (caching, retries, request logs, single
  billing surface). Falls back to hitting OpenRouter directly if the gateway isn't provisioned.
- **Fallback:** Workers AI (`@cf/meta/llama-3.3-70b`) behind `AGENT_LLM_PROVIDER=workers-ai` -
  zero secrets, zero egress, for offline/demo.

Everything downstream speaks the `ai` SDK's `LanguageModel` interface, so swapping providers/models
is a config change, not a code change.

### 5. One tool catalog, two transports

`buildTools(env, jwt, agent)` (`agent-tools.ts`) returns the tool map. It's consumed by:

- the **chat WS** path via Vercel AI SDK (`agent.ts`), and
- an **MCP server** (`RepMcp extends McpAgent`, `mcp.ts`) for CLI / external clients (Claude
  Desktop, MCP inspector).

MCP re-declares the Zod param shapes (it wants `ZodRawShape`, not wrapped `ZodObject`) and adapts
`execute`, but reuses the tool *logic* verbatim. Auth flows through `ctx.props = { jwt, repId }`
(the Cloudflare Agents convention) set by the Worker before the request reaches the DO. Build tools
once, decouple from surface.

### 6. Terminator-tool-as-schema (typed loop exit)

End a background loop by forcing structured output through a tool whose `inputSchema` **is** your
result Zod schema (`osint-tools.ts`):

```typescript
saveAffinities: tool({
  description: "TERMINATOR - call exactly once with your final, structured findings...",
  inputSchema: ProspectAffinities,           // ← the result schema
  execute: async (affinities) => { sink.save(affinities); return { saved: true }; },
}),
```

The DO captures the result via a closure (`sink`) and reads it after the loop returns. Cleaner
than JSON-mode-and-pray. If the model finishes without calling it, that's a detectable soft-fail.

### 7. Background sub-agent (`agent.ts` `runResearch`)

A second agentic loop inside the same DO, for work nobody's watching:

```typescript
// fetch handler returns 202 immediately; loop runs detached
this.ctx.waitUntil(this.runResearch({ jobId, customerId, ... }));

// inside runResearch - non-streaming, different toolset, capped steps
const result = await generateText({
  model, system: RESEARCH_SYSTEM_PROMPT, prompt,
  tools: buildOsintTools(env, { save: (a) => { captured = a; } }),
  stopWhen: stepCountIs(8),
});
// then PATCH the typed result back through the app's own API
```

`generateText` (non-streaming) for headless work, `streamText` for the interactive turn. Result is
written back through the same self-API call as everything else.

### 8. Scheduling

- **Per-user timers:** the `scheduleReminder` tool calls `agent.schedule(when, "reminder", {what})`
  - the `agents` SDK scheduler. Survives hibernation; fires back into the DO's `reminder()` method,
  which appends a proactive assistant message.
- **Cron fan-out (`cron.ts`):** the Worker `scheduled` handler enumerates active users, **forges a
  per-user JWT**, and calls each DO's `/cron/daily`. Note: cron does **not** fire in `wrangler dev` -
  there's a dev-only `GET /__cron/daily` route to exercise it.

### 9. Hibernatable WebSocket bridge (`rep-extension.ts`)

Textbook pattern if Mnemosyne talks to a live client:

- `ctx.acceptWebSocket()` for hibernation-aware sockets.
- `ctx.setWebSocketAutoResponse(ping → pong)` - keepalive billed at **zero CPU** (workerd answers
  without waking the DO).
- A `pending` Map correlating request IDs → ack promises with timeouts.
- A **persisted FIFO queue** (24h TTL) for commands that arrive while the socket is offline; drained
  on reconnect.

### 10. SSE fan-out DO (`customer-stream.ts`)

Per-topic live event push: `Set<Subscriber>` + a 50-event ring buffer for late-joiners, with
`/publish` and `/subscribe` endpoints. How the UI and the copilot "see each other's writes live"
without bespoke replication.

### 11. System-prompt layering (`agent-prompts.ts`)

`buildSystemPrompt` composes in fixed order: **base persona → org overlay → coach/persona overlay →
user overlay**, with scope/safety rules from the base always winning over the optional layers.
Null/empty overlays skipped cleanly. Overlays come off the JWT claims.

### 12. Safety rails (`osint-tools.ts` + prompts)

- `BLOCKED_HOSTS` set hard-blocks people-finder / address-aggregator domains at the fetch layer.
- All outbound HTTP time-boxed (15s) and content-capped (200KB).
- Citation requirement: every personal/family claim must carry a source URL or be omitted.
- Draft-not-send: the agent returns drafts for human confirmation; it never sends outbound itself.
- Reads + activity-style writes only - no schema mutation, no deletes, no cross-user visibility.

---

## Stays behind (Crema-specific - do not carry)

- CRM routes & schemas: `customers | leads | tickets | actions` (`src/routes/*`, `shared/`).
- OSINT / gift-research domain logic (`osint-tools.ts` *purpose*; the loop mechanics are reusable).
- `coach-personas.ts`, "Morning Cup" framing, sales voice.
- The browser-extension's **business purpose** (the WS *mechanism* is reusable; its reason for
  existing isn't).

---

## The one decision to make deliberately: tools-over-own-API

Crema routes **every tool through its own HTTP API** (`agent-tools.ts` → `dispatchFetch` → `SELF`
service binding, JWT in `Authorization`). Payoff:

- **Authz enforced once**, in the API layer - a tool literally can't read another user's data.
- Agent writes hit the **same validation, activity-logging, and webhook fan-out** as UI writes.
- Free audit attribution: rows record `source: "agent"` vs `"ui"`.

**Trade-off for Mnemosyne:** copy this only if Mnemosyne has a meaningful API/permission surface.
If tools mostly read/write a memory store, a **shared service layer** the tools call directly is
likely the better trade - you lose the single-audit-path guarantee but save an in-process HTTP
round-trip + JWT re-verify per tool call.

---

## Notable gap: long-term memory

Crema explicitly punts on long-term memory (`AGENTS-AGENTS.md` "Conversation memory"): history is
capped ~50 turns with summarization rollups, **nothing persisted across sessions**. Their stated v2
candidate was a `rep_agent_memory` D1 table keyed by user id, surfaced as a retrieval tool. If
Mnemosyne is a memory layer, this is precisely the gap it would fill.

---

## Stack to pin

- `compatibility_date = "2026-05-01"`, `compatibility_flags = ["nodejs_compat"]`
- `agents@^0.12.4`, `@cloudflare/ai-chat@^0.7.0`, `ai@^6`
- `@openrouter/ai-sdk-provider@^2.9`, `workers-ai-provider@^3.1`
- `@modelcontextprotocol/sdk@^1.29`, `zod@^4`, `hono@^4`, `jose@^6`
- Bindings: D1 (`DB`), KV (`IDENTITY`), AI (`AI`), and a `SELF` service binding (Worker → itself)

---

## File map (where each pattern lives)

```
_crema-crm/backend/
  wrangler.toml            # DO bindings, migrations, D1/KV/AI/SELF bindings, cron trigger
  src/
    index.ts               # Worker entry: WS upgrade → idFromName DO routing; x-rep-jwt threading; MCP mount
    agent.ts               # RepAgent (AIChatAgent): onChatMessage loop, runResearch sub-agent, cron handler
    agent-tools.ts         # buildTools(): tool catalog as thin self-API calls over SELF binding
    agent-prompts.ts       # layered system prompts, daily-summary + research prompts
    osint-tools.ts         # inner-loop toolset + terminator-tool-as-schema + safety rails
    llm.ts                 # getModel(): provider abstraction (OpenRouter/Gateway + Workers AI)
    mcp.ts                 # RepMcp (McpAgent): same buildTools catalog as MCP server
    rep-extension.ts       # hibernatable WS bridge: ack-correlation map + persisted queue
    customer-stream.ts     # per-topic SSE fan-out DO
    cron.ts                # scheduled fan-out; forges per-user JWTs
  AGENTS-AGENTS.md         # the authors' own architecture writeup (read this)
```
