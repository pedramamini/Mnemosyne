/**
 * Public surface of the tool framework (MNEMO-16).
 *
 * The harness reaches Mnemosyne's own services via a **direct service layer**,
 * NOT Crema's tools-over-own-API pattern (docs/crema-architecture-reference.md,
 * the "tools-over-own-API" trade-off - the one decision to make deliberately).
 * Mnemosyne's tool surface mostly reads/writes a memory store on the agent's
 * sandbox, so a tool's `execute` calls the sandbox/service wrappers directly -
 * there is no `SELF` binding and no per-call HTTP round-trip back into the
 * Worker (PRD §6.3). The cost would be latency + subrequest budget for no gain.
 *
 * The load-bearing discipline rule lives in `largeOutput.ts`: the `ai` SDK does
 * not compact the in-loop message array, so every sandbox-driving tool routes
 * its output through {@link spillIfLarge} - a large result is written to the
 * brain FS and the loop is fed a PATH, never the blob (PRD §7.1).
 */
export { type SpillResult, spillIfLarge } from "./largeOutput.ts";
export { buildTools } from "./registry.ts";
export {
  FinalReport,
  type FinalReportData,
} from "./reportSchema.ts";
// MNEMO-19 self-authored tools (procedural memory): authoring meta-tools +
// per-turn discovery/replay, contained by per-agent sandbox isolation (PRD §6.2).
export {
  type AuthoringDeps,
  buildAuthoringTools,
  type CommitFn,
} from "./selfAuthored/authoring.ts";
export {
  discoverSelfAuthoredTools,
  listManifests,
  SELF_AUTHORED_PREFIX,
} from "./selfAuthored/discover.ts";
export {
  manifestPath,
  ToolManifest,
  toolDir,
} from "./selfAuthored/manifest.ts";
export {
  assertWithinToolDir,
  SELF_AUTHORED_RUN_TIMEOUT_MS,
  ToolSecurityError,
  validateInput,
  validateToolName,
} from "./selfAuthored/security.ts";
export { makeTerminator, type Terminator } from "./terminator.ts";
export {
  type ArtifactDraft,
  LARGE_OUTPUT_THRESHOLD_BYTES,
  type MnemosyneTool,
  type SandboxHandle,
  type ToolContext,
} from "./types.ts";
