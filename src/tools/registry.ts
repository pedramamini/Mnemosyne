/**
 * Core sandbox-driving tool registry (PRD §6.3). `buildTools(ctx)` returns the
 * Zod-typed tools whose `execute` bodies act on the agent's sandbox - shell,
 * Python, and file ops. Every tool:
 *   - validates its input with a Zod schema (the model can't call it malformed),
 *   - routes any sizeable output through {@link spillIfLarge} so the loop sees a
 *     PATH not a blob (PRD §7.1 context discipline), and
 *   - emits a `tool.ran` audit event with a one-line summary.
 *
 * The sandbox tools are joined by the MNEMO-17 web-research tools
 * (`webFetch`/`webSearch`, spread in from {@link buildWebTools}); the terminator
 * tool (the deliberate loop exit) is MNEMO-18; and the agent's own self-authored
 * tools (MNEMO-19, procedural memory) - the `authorTool`/`listTools`/`deleteTool`
 * meta-tools plus every discovered `brain__<name>` tool - are spread in under the
 * `brain__*`/authoring namespace. Discovery is best-effort: a broken manifest
 * disables only its own tool, never the rest of the catalog.
 */
import { tool } from "ai";
import { z } from "zod";
import type { AuditType } from "../audit/types.ts";
import { shQuote } from "../memory/git.ts";
import { spillIfLarge } from "./largeOutput.ts";
import { buildAuthoringTools } from "./selfAuthored/authoring.ts";
import { discoverSelfAuthoredTools } from "./selfAuthored/discover.ts";
import type { MnemosyneTool, ToolContext } from "./types.ts";
import { buildWebTools } from "./web/searchTools.ts";

/**
 * Per-command wall-clock guard. Driving the sandbox is the product's cost lever
 * (PRD §8.4) and a runaway command must not pin a container; 60s is the cap a
 * single shell/Python step gets before the SDK aborts it.
 */
const COMMAND_TIMEOUT_MS = 60_000;

/**
 * Hard ceiling on a single rendered HTML artifact. Generous enough for a rich,
 * self-contained dashboard (inline CSS/JS + data: images) but bounded so a runaway
 * generation can't push a multi-MB blob into R2 / the message store. 1 MiB.
 */
const MAX_ARTIFACT_BYTES = 1024 * 1024;

/**
 * Build the per-turn tool catalog. Called by the harness (MnemosyneAgent) on
 * every turn with a live {@link ToolContext}; the resulting map is passed as
 * `tools` to `streamText`/`generateText`. Async because the MNEMO-19 self-authored
 * tools are *discovered* from the brain FS each turn (procedural-memory replay).
 */
export async function buildTools(
  ctx: ToolContext,
): Promise<Record<string, MnemosyneTool>> {
  return {
    runShell: tool({
      description:
        "Run a shell command in the agent's sandbox (real Linux tooling: " +
        "find/grep/sed/awk/etc). Returns exitCode plus stdout/stderr; large " +
        "output is written to a file path instead of returned inline.",
      inputSchema: z.object({
        command: z.string().min(1).describe("The shell command to run."),
        cwd: z
          .string()
          .optional()
          .describe("Working directory for the command."),
      }),
      execute: async ({ command, cwd }) => {
        const r = await ctx.sandbox.run(command, {
          cwd,
          timeout: COMMAND_TIMEOUT_MS,
        });
        const stdout = await spillIfLarge(ctx, "runShell-stdout", r.stdout);
        const stderr = await spillIfLarge(ctx, "runShell-stderr", r.stderr);
        await emitRan(ctx, "runShell", `$ ${command} → exit ${r.exitCode}`);
        return { exitCode: r.exitCode, stdout, stderr };
      },
    }),

    runPython: tool({
      description:
        "Run a Python 3 snippet in the agent's sandbox; returns exitCode plus " +
        "stdout/stderr (large output is written to a file path, not inlined).",
      inputSchema: z.object({
        code: z.string().min(1).describe("Python source to execute."),
      }),
      execute: async ({ code }) => {
        // MNEMO-06 ships no dedicated Code Interpreter wrapper yet, so we run
        // Python via the shell exec surface: write the snippet to a scratch file
        // (avoids shell-quoting an arbitrary program) and invoke `python3`. A
        // richer interpreter context (kernels, rich results) is a later phase.
        const file = `/tmp/mnemo-py-${Date.now()}.py`;
        await ctx.sandbox.writeFile(file, code);
        const r = await ctx.sandbox.run(`python3 ${file}`, {
          timeout: COMMAND_TIMEOUT_MS,
        });
        const stdout = await spillIfLarge(ctx, "runPython-stdout", r.stdout);
        const stderr = await spillIfLarge(ctx, "runPython-stderr", r.stderr);
        await emitRan(ctx, "runPython", `python3 snippet → exit ${r.exitCode}`);
        return { exitCode: r.exitCode, stdout, stderr };
      },
    }),

    readFile: tool({
      description:
        "Read a UTF-8 file from the agent's sandbox FS. Large files are written " +
        "to a spill path with a preview rather than returned in full.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Absolute path to read."),
      }),
      execute: async ({ path }) => {
        const content = await ctx.sandbox.readFile(path);
        const spilled = await spillIfLarge(ctx, "readFile", content);
        await emitRan(ctx, "readFile", `read ${path} (${spilled.bytes} bytes)`);
        return { path, content: spilled };
      },
    }),

    writeFile: tool({
      description:
        "Write (overwrite) a UTF-8 file in the agent's sandbox FS. Returns the " +
        "path and the number of bytes written.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Absolute path to write."),
        content: z.string().describe("UTF-8 content to write."),
      }),
      execute: async ({ path, content }) => {
        await ctx.sandbox.writeFile(path, content);
        const bytesWritten = utf8ByteLength(content);
        // A write to the brain is a memory event; surface it as such AND as a
        // tool run so the cockpit shows both the high-level fact and the action.
        await ctx.emit({
          type: "memory.wrote",
          level: "info",
          sessionId: ctx.sessionId,
          text: `Wrote ${path} (${bytesWritten} bytes)`,
          payload: { path, bytesWritten },
        });
        await emitRan(
          ctx,
          "writeFile",
          `wrote ${path} (${bytesWritten} bytes)`,
        );
        return { path, bytesWritten };
      },
    }),

    listDir: tool({
      description:
        "List a directory in the agent's sandbox FS (one entry per line; a " +
        "trailing '/' marks a subdirectory). Returns a compact listing.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Absolute directory path to list."),
      }),
      execute: async ({ path }) => {
        // `-1` one per line, `-A` include dotfiles (not . / ..), `-p` mark dirs.
        const r = await ctx.sandbox.run(`ls -1Ap ${shQuote(path)}`);
        const entries = await spillIfLarge(ctx, "listDir", r.stdout);
        await emitRan(ctx, "listDir", `ls ${path} → exit ${r.exitCode}`);
        return { path, exitCode: r.exitCode, entries };
      },
    }),

    // renderHtml: show a self-contained HTML view inline in the chat (a sandboxed
    // iframe). Only present on the web-chat turn - `ctx.onArtifact` is the sink the
    // turn wires; without it the iframe surface doesn't exist, so we omit the tool
    // rather than offer the model a capability it can't fulfil.
    ...(ctx.onArtifact ? { renderHtml: buildRenderHtmlTool(ctx) } : {}),

    // MNEMO-17 web-research tools (webFetch/webSearch) - same large-output-to-FS
    // discipline + audit emit as the sandbox tools above.
    ...buildWebTools(ctx),

    // MNEMO-19 self-authored tools (procedural memory): the authoring meta-tools
    // (authorTool/listTools/deleteTool) plus every discovered `brain__<name>`.
    // Discovery degrades gracefully - a broken manifest disables only that tool.
    ...buildAuthoringTools(ctx),
    ...(await discoverSelfAuthoredTools(ctx)),
  };
}

/**
 * The `renderHtml` tool: archive-then-show an HTML view inline in the chat. The
 * model passes the HTML inline (`html`) or names a sandbox file it already wrote
 * (`path`); we validate + size-cap it, hand it to `ctx.onArtifact` (the turn does
 * the R2/D1 archival + the `data-artifact` part), and return a TINY confirmation
 * (never the HTML back - that would bloat the loop, PRD §7.1). The rendered view
 * runs in a locked-down sandbox (no network, opaque origin - enforced at the
 * serving route), which the description tells the model so it inlines assets.
 */
function buildRenderHtmlTool(ctx: ToolContext): MnemosyneTool {
  return tool({
    description:
      "Display an HTML document to the user as a live preview embedded directly " +
      "in the chat (rendered in a secure sandboxed iframe). Use it for " +
      "dashboards, charts, tables, diagrams, timelines, or any rich/interactive " +
      "visual that markdown can't express. Provide the document inline via " +
      "`html`, OR pass `path` to render an .html file you already wrote to the " +
      "sandbox. SECURITY SANDBOX: the preview has NO network access and runs in " +
      "an isolated origin - inline ALL CSS in <style> and JS in <script>, and " +
      "embed any images as data: URIs (external CDNs/URLs will NOT load).",
    inputSchema: z.object({
      title: z
        .string()
        .min(1)
        .max(200)
        .describe("Short title shown above the embedded preview."),
      html: z
        .string()
        .optional()
        .describe("The full HTML document (or fragment) to render."),
      path: z
        .string()
        .optional()
        .describe(
          "Absolute sandbox path to an .html file to render instead of `html`.",
        ),
    }),
    execute: async ({ title, html, path }) => {
      let source = html;
      if (!source?.trim() && path) {
        source = await ctx.sandbox.readFile(path);
      }
      if (!source?.trim()) {
        return {
          shown: false,
          error: "Provide non-empty `html`, or a `path` to an HTML file.",
        };
      }
      const bytes = utf8ByteLength(source);
      if (bytes > MAX_ARTIFACT_BYTES) {
        return {
          shown: false,
          error: `HTML is too large (${bytes} bytes; max ${MAX_ARTIFACT_BYTES}). Trim it or inline less data.`,
        };
      }
      // Hand the draft to the turn (it archives + emits the message part). The
      // gate in buildTools means onArtifact is always present when this tool runs.
      ctx.onArtifact?.({ title, html: source });
      await emitRan(
        ctx,
        "renderHtml",
        `rendered HTML view "${title}" (${bytes} bytes)`,
      );
      return { shown: true, title, bytes };
    },
  });
}

/** Emit a `tool.ran` audit event with the tool name + a one-line summary. */
function emitRan(
  ctx: ToolContext,
  name: string,
  summary: string,
): Promise<void> {
  const type: AuditType = "tool.ran";
  return ctx.emit({
    type,
    level: "info",
    sessionId: ctx.sessionId,
    text: summary,
    payload: { tool: name },
  });
}

/** True UTF-8 byte length of a string (multibyte-aware). */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
