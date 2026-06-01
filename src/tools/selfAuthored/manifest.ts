/**
 * Self-authored tool manifest + path helpers (procedural memory - PRD §6.2).
 *
 * A self-authored tool is a script the agent writes ONCE, saves under
 * `/brain/tools/<name>/`, and re-runs across sessions - *procedural* memory, as
 * opposed to notes (*declarative* memory). Each tool dir carries a `tool.json`
 * manifest declaring its name, description, runtime, entrypoint script, and an
 * input schema (stored as JSON Schema so it round-trips to/from the FS without a
 * code-gen step). The registry (src/tools/registry.ts) discovers these manifests
 * each turn and registers them as callable `ai`-SDK tools.
 *
 * SECURITY (PRD §6.2): these scripts are *agent-authored code re-run later* -
 * the product's largest attack surface. The containment boundary is NOT this
 * module; it is complete per-agent sandbox isolation (§7.3/§8.4): a self-authored
 * tool only ever runs inside the agent's own private container, never in the
 * Worker/DO process and never against another agent's brain. The name/path
 * guards in `./security.ts` are defense-in-depth on top of that boundary.
 *
 * Pure constants + Zod schema + path helpers - NO filesystem calls.
 */
import { z } from "zod";
import { TOOLS_DIR } from "../../memory/layout.ts";

/** A tool name is a slug: lowercase alphanumerics + hyphens, nothing else. */
export const TOOL_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * The `tool.json` manifest schema. `inputSchema` is an arbitrary JSON-Schema
 * object (validated structurally at run time by `./security.ts`, not by Zod -
 * Zod only asserts it is an object here). `version` is bumped on re-authoring so
 * the brain git history (MNEMO-07) shows a tool's revisions.
 */
export const ToolManifest = z.object({
  /** Slug - the discovered tool registers as `brain__<name>`. */
  name: z.string().regex(TOOL_NAME_PATTERN),
  /** What the tool does, surfaced to the model in the tool description. */
  description: z.string(),
  /** Interpreter the entrypoint runs under inside the sandbox. */
  runtime: z.enum(["python", "shell"]),
  /** Script filename, relative to the tool dir (e.g. `main.py`). */
  entrypoint: z.string().min(1),
  /** JSON-Schema object describing the tool's input (reconstructed at discovery). */
  inputSchema: z.record(z.string(), z.unknown()),
  /** ISO timestamp of first authoring. */
  createdAt: z.string(),
  /** Monotonic revision; bumped each time the tool is re-authored. */
  version: z.number(),
});
export type ToolManifest = z.infer<typeof ToolManifest>;

/** The tool's directory: `/brain/tools/<name>` (matches `layout.ts` conventions). */
export function toolDir(name: string): string {
  return `${TOOLS_DIR}/${name}`;
}

/** The tool's manifest path: `/brain/tools/<name>/tool.json`. */
export function manifestPath(name: string): string {
  return `${toolDir(name)}/tool.json`;
}
