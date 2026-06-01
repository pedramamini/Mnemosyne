/**
 * Discovery + replay of self-authored tools (procedural memory - PRD §6.2).
 *
 * Each turn the registry calls {@link discoverSelfAuthoredTools}: it lists every
 * `tool.json` under `/brain/tools/<name>/`, validates each through
 * {@link ToolManifest}, and registers the valid ones as `ai`-SDK tools named
 * `brain__<name>`. Running one
 * is *procedural memory replayed*: the agent wrote the script in an earlier
 * session, and a later session re-runs it.
 *
 * SECURITY (PRD §7.3/§8.4): a tool's `execute` runs the entrypoint ONLY inside
 * the agent's own sandbox. Two rules are load-bearing here:
 *   1. Input is validated against the manifest's JSON-Schema ({@link validateInput})
 *      BEFORE the script runs - a bad call returns an error, never reaches code.
 *   2. The validated input is delivered as a JSON file the script reads from
 *      stdin; it is NEVER string-interpolated into the shell command. The command
 *      contains only our own (shell-quoted) paths, so tool input cannot inject
 *      shell, no matter what the model passed.
 *
 * Robustness: a malformed/invalid manifest disables only THAT tool (it is skipped
 * with an `error`-level audit note) - the discovery loop never throws, so one bad
 * write can't break the whole catalog.
 */
import { type JSONSchema7, jsonSchema, tool } from "ai";
import { shQuote } from "../../memory/git.ts";
import { TOOLS_DIR } from "../../memory/layout.ts";
import { spillIfLarge } from "../largeOutput.ts";
import type { MnemosyneTool, ToolContext } from "../types.ts";
import { ToolManifest } from "./manifest.ts";
import {
  assertWithinToolDir,
  SELF_AUTHORED_RUN_TIMEOUT_MS,
  validateInput,
} from "./security.ts";

/** The `brain__` namespace keeps discovered tools from colliding with built-ins. */
export const SELF_AUTHORED_PREFIX = "brain__";

/**
 * Read + validate every self-authored manifest in the brain. Skips (and emits an
 * `error` note for) any that fail to read/parse/validate, so a single bad tool
 * never breaks listing. Shared by {@link discoverSelfAuthoredTools} and the
 * `listTools` authoring meta-tool.
 */
export async function listManifests(ctx: ToolContext): Promise<ToolManifest[]> {
  // `-maxdepth 2` pins the search to `/brain/tools/<name>/tool.json` exactly;
  // `2>/dev/null` + `|| true` keep an empty tools dir from being an error.
  const listing = await ctx.sandbox.run(
    `find ${shQuote(TOOLS_DIR)} -maxdepth 2 -name tool.json -type f 2>/dev/null || true`,
  );
  const paths = listing.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const manifests: ToolManifest[] = [];
  for (const path of paths) {
    const manifest = await readManifest(ctx, path);
    if (manifest) manifests.push(manifest);
  }
  return manifests;
}

/** Read + validate one manifest; on any failure emit an `error` note + return null. */
async function readManifest(
  ctx: ToolContext,
  path: string,
): Promise<ToolManifest | null> {
  try {
    const raw = await ctx.sandbox.readFile(path);
    const parsed = ToolManifest.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      await ctx.emit({
        type: "error",
        level: "error",
        sessionId: ctx.sessionId,
        text: `Skipped malformed self-authored tool manifest at ${path}`,
        payload: { path, issues: parsed.error.issues.map((i) => i.message) },
      });
      return null;
    }
    return parsed.data;
  } catch (err) {
    await ctx.emit({
      type: "error",
      level: "error",
      sessionId: ctx.sessionId,
      text: `Skipped unreadable self-authored tool manifest at ${path}`,
      payload: {
        path,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  }
}

/**
 * Discover the agent's self-authored tools and expose each as an `ai`-SDK tool
 * named `brain__<name>`. The whole listing is wrapped so a total sandbox failure
 * degrades to an empty catalog rather than aborting turn setup.
 */
export async function discoverSelfAuthoredTools(
  ctx: ToolContext,
): Promise<Record<string, MnemosyneTool>> {
  let manifests: ToolManifest[];
  try {
    manifests = await listManifests(ctx);
  } catch {
    // Discovery is best-effort: a broken sandbox/listing must not break the turn.
    return {};
  }

  const tools: Record<string, MnemosyneTool> = {};
  for (const manifest of manifests) {
    tools[`${SELF_AUTHORED_PREFIX}${manifest.name}`] = buildReplayTool(
      ctx,
      manifest,
    );
  }
  return tools;
}

/** Build the `ai`-SDK tool that replays one self-authored tool in the sandbox. */
function buildReplayTool(
  ctx: ToolContext,
  manifest: ToolManifest,
): MnemosyneTool {
  return tool({
    description: `Self-authored tool: ${manifest.description}`,
    // The model-facing schema is the manifest's stored JSON Schema. We do our
    // OWN validation in execute (below) too, so a direct call still can't bypass
    // it - the SDK only validates SDK-routed calls.
    inputSchema: jsonSchema(manifest.inputSchema as unknown as JSONSchema7),
    execute: async (input: unknown) => {
      // 1. Validate input against the declared schema BEFORE running anything.
      const check = validateInput(manifest.inputSchema, input);
      if (!check.ok) {
        return { error: `input validation failed: ${check.errors.join("; ")}` };
      }

      // 2. Resolve + contain the entrypoint, then deliver input as a JSON file
      //    the script reads from stdin - never interpolated into the command.
      const entry = assertWithinToolDir(manifest.entrypoint, manifest.name);
      const inputFile = `/tmp/mnemo-tool-in-${Date.now()}.json`;
      await ctx.sandbox.writeFile(inputFile, JSON.stringify(input ?? {}));

      const interpreter = manifest.runtime === "python" ? "python3" : "sh";
      const command = `${interpreter} ${shQuote(entry)} < ${shQuote(inputFile)}`;
      const r = await ctx.sandbox.run(command, {
        timeout: SELF_AUTHORED_RUN_TIMEOUT_MS,
      });

      // 3. Spill large output to a path (PRD §7.1) and narrate the replay.
      const stdout = await spillIfLarge(
        ctx,
        `${manifest.name}-stdout`,
        r.stdout,
      );
      const stderr = await spillIfLarge(
        ctx,
        `${manifest.name}-stderr`,
        r.stderr,
      );
      await ctx.emit({
        type: "tool.ran",
        level: "info",
        sessionId: ctx.sessionId,
        text: `Ran self-authored tool ${manifest.name} → exit ${r.exitCode}`,
        payload: {
          tool: `${SELF_AUTHORED_PREFIX}${manifest.name}`,
          selfAuthored: true,
          exitCode: r.exitCode,
        },
      });

      return { exitCode: r.exitCode, stdout, stderr };
    },
  });
}
