/**
 * Authoring meta-tools for self-authored tools (procedural memory - PRD §6.2).
 *
 * These are the tools the agent uses to manage its OWN tools: write one
 * (`authorTool`), list them (`listTools`), remove one (`deleteTool`). Authoring
 * or deleting writes to the brain and auto-commits through the MNEMO-07 commit
 * helper, so every revision is in the brain git history and a bad write is
 * restorable (PRD §6.9). Authoring emits `tool.authored`; running an authored
 * tool emits `tool.ran` (see `./discover.ts`).
 *
 * SECURITY (PRD §6.2/§7.3): the name is slug-validated and every write path is
 * re-checked against the tool's own directory (`./security.ts`) before it
 * touches the sandbox. The authored code itself is contained by per-agent
 * sandbox isolation - it only ever runs inside this agent's own container.
 */
import { tool } from "ai";
import { z } from "zod";
import { autoCommit, shQuote } from "../../memory/git.ts";
import type { MnemosyneTool, ToolContext } from "../types.ts";
import { listManifests } from "./discover.ts";
import { manifestPath, type ToolManifest, toolDir } from "./manifest.ts";
import { assertWithinToolDir, validateToolName } from "./security.ts";

/** Commit one brain change; returns the new sha (or null if the tree was clean). */
export type CommitFn = (message: string) => Promise<string | null>;

/** Injectable dependencies - the commit helper is stubbed in tests. */
export interface AuthoringDeps {
  commit?: CommitFn;
}

/**
 * Build the authoring meta-tools over a turn's {@link ToolContext}. `deps.commit`
 * defaults to the MNEMO-07 {@link autoCommit} bound to this turn's sandbox; tests
 * inject a stub to assert the commit message without a real git repo.
 */
export function buildAuthoringTools(
  ctx: ToolContext,
  deps: AuthoringDeps = {},
): Record<string, MnemosyneTool> {
  const commit: CommitFn =
    deps.commit ??
    ((message) =>
      autoCommit(ctx.env, ctx.agentId, message, undefined, ctx.sandbox));

  return {
    authorTool: tool({
      description:
        "Save a reusable tool to your brain (procedural memory): a script you " +
        "write once and can call again in later sessions. Provide a slug name, a " +
        "description, the runtime (python|shell), the entrypoint filename, the " +
        "script `code`, and a JSON-Schema `inputSchema` for its input. Re-authoring " +
        "an existing name bumps its version. The tool runs only in your sandbox.",
      inputSchema: z.object({
        name: z
          .string()
          .describe("Slug name (lowercase letters, digits, hyphens)."),
        description: z.string().describe("What the tool does."),
        runtime: z
          .enum(["python", "shell"])
          .describe("Interpreter the entrypoint runs under."),
        entrypoint: z
          .string()
          .min(1)
          .describe("Script filename within the tool dir (e.g. main.py)."),
        code: z.string().describe("The script source."),
        inputSchema: z
          .record(z.string(), z.unknown())
          .describe("JSON-Schema object describing the tool's input."),
      }),
      execute: async ({
        name,
        description,
        runtime,
        entrypoint,
        code,
        inputSchema,
      }) => {
        validateToolName(name);
        // Contain both writes to the tool's own dir before touching the sandbox.
        const codePath = assertWithinToolDir(entrypoint, name);
        const mfPath = assertWithinToolDir(manifestPath(name), name);

        // Preserve createdAt + bump version if the tool already exists.
        const prior = (await listManifests(ctx)).find((m) => m.name === name);
        const manifest: ToolManifest = {
          name,
          description,
          runtime,
          entrypoint,
          inputSchema,
          createdAt: prior?.createdAt ?? new Date().toISOString(),
          version: (prior?.version ?? 0) + 1,
        };

        await ctx.sandbox.writeFile(codePath, code);
        await ctx.sandbox.writeFile(mfPath, JSON.stringify(manifest, null, 2));
        await commit(`tool: author ${name}`);

        await ctx.emit({
          type: "tool.authored",
          level: "milestone",
          sessionId: ctx.sessionId,
          text: `Authored tool ${name} (v${manifest.version})`,
          payload: { name, runtime, version: manifest.version },
        });

        return { saved: true, name, version: manifest.version };
      },
    }),

    listTools: tool({
      description:
        "List the reusable tools you have authored to your brain (name + " +
        "description). Use this to recall what procedural memory you already have.",
      inputSchema: z.object({}),
      execute: async () => {
        const tools = (await listManifests(ctx)).map((m) => ({
          name: m.name,
          description: m.description,
        }));
        return { tools };
      },
    }),

    deleteTool: tool({
      description:
        "Delete a self-authored tool from your brain. It is removed from the " +
        "catalog but stays restorable from your brain's git history.",
      inputSchema: z.object({
        name: z.string().describe("Slug name of the tool to delete."),
      }),
      execute: async ({ name }) => {
        validateToolName(name);
        const dir = toolDir(name);
        await ctx.sandbox.run(`rm -rf ${shQuote(dir)}`);
        await commit(`tool: delete ${name}`);

        await ctx.emit({
          type: "tool.authored",
          level: "milestone",
          sessionId: ctx.sessionId,
          text: `Deleted tool ${name}`,
          payload: { name, deleted: true },
        });

        return { deleted: true, name };
      },
    }),
  };
}
