/**
 * Tool framework types - the shared shape every sandbox-driving tool consumes.
 *
 * PRD §6.3: tools are Zod-typed and each tool's `execute` drives the agent's
 * sandbox (shell / Python / file ops). PRD §7.1: the SDK does NOT compact the
 * in-loop message array, so a large tool output must NOT be fed back inline -
 * it is written to the brain FS and the loop sees a PATH, not the blob (the
 * enforcement point is `src/tools/largeOutput.ts`).
 *
 * Tools are built per-turn by `buildTools(ctx)` (src/tools/registry.ts): the
 * `ToolContext` carries the live sandbox handle + the owning identity + an audit
 * emitter, so a tool's `execute` can act on the sandbox and narrate what it did
 * WITHOUT reaching back through an HTTP round-trip (the "direct service layer"
 * trade-off from docs/crema-architecture-reference.md - see src/tools/index.ts).
 */
import type { Tool } from "ai";
import type { AuditInput } from "../audit/types.ts";
import type { Env } from "../env.ts";
import type { SandboxClient } from "../sandbox/client.ts";

/**
 * The sandbox wrapper a tool drives - the MNEMO-06 {@link SandboxClient}, the
 * single typed boundary over the Beta Sandbox SDK. Aliased here so tool code
 * names the surface it depends on (`run`/`readFile`/`writeFile`/`mkdir`) without
 * binding to the file path of the wrapper.
 */
export type SandboxHandle = SandboxClient;

/**
 * An HTML view the `renderHtml` tool wants shown inline in the chat. The tool
 * hands one of these to {@link ToolContext.onArtifact}; the owning turn (only the
 * web-chat turn wires the sink) archives it to R2/D1 and appends a `data-artifact`
 * message part so the frontend renders it in a sandboxed iframe. Kept as the raw
 * `{ title, html }` (not a persisted id) so archival - which can fail - stays in
 * the turn, never orphaning a blob when the model turn aborts.
 */
export interface ArtifactDraft {
  title: string;
  html: string;
}

/**
 * Per-turn context handed to every tool's `execute`. Built by `buildTools` from
 * the owning DO (MnemosyneAgent): the live warm sandbox, the agent/account
 * identity (so tools stay scoped to the calling user), an audit `emit` (the
 * MNEMO-20 AuditLog seam - a no-op until that DO exists), and the current
 * research `sessionId` used to group spilled outputs + audit events.
 */
export interface ToolContext {
  env: Env;
  agentId: string;
  accountId: string;
  sandbox: SandboxHandle;
  emit: (e: AuditInput) => Promise<void>;
  sessionId: string | null;
  /**
   * Sink for an HTML view the agent wants rendered inline in the chat. Present
   * ONLY on the interactive web-chat turn (the one surface that can show an
   * iframe); when undefined the `renderHtml` tool is omitted from the catalog, so
   * the model never sees a tool it can't fulfil (headless/SMS/dev turns).
   */
  onArtifact?: (draft: ArtifactDraft) => void;
}

/**
 * A single registered tool - the `ai`-SDK `tool(...)` return. Left at the
 * permissive default (`Tool<any, any>`) so a heterogeneous registry of tools
 * (each with its own Zod input/output) collects into one `Record<string,
 * MnemosyneTool>` that is assignable to the SDK's `ToolSet` at the `streamText`/
 * `generateText` call site.
 */
export type MnemosyneTool = Tool;

/**
 * Output-size ceiling for inlining a tool result into the loop. At or above
 * this many UTF-8 bytes, a result is spilled to the brain FS and the loop is
 * fed a PATH + short preview instead - PRD §7.1's critical context-discipline
 * rule (the in-loop message array is never compacted by the SDK, so an
 * un-spilled blob would bloat every subsequent turn).
 */
export const LARGE_OUTPUT_THRESHOLD_BYTES = 8 * 1024;
