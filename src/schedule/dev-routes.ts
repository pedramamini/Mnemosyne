/**
 * Dev-only schedule trigger routes (MNEMO-27, PRD §8.5).
 *
 * ⚠️ These exist for ONE reason: **cron does NOT fire under `wrangler dev`**, so
 * the Worker `scheduled` handler never runs locally. These routes let you drive
 * the same code paths by hand while developing:
 *
 *   POST /__dev/cron               - simulate one cron tick (runs the fan-out)
 *   POST /agents/:agentId/__dev/run - force one agent's `runScheduled` now
 *
 * ⚠️ They MUST NEVER be reachable in production. The guard middleware below 404s
 * every request unless `env.ENVIRONMENT !== "production"`. The gate is enforced
 * PER REQUEST (Worker env is request-scoped), so even though the group is always
 * mounted in src/index.ts, it is inert in prod. There is intentionally no auth on
 * these routes - cron has no user identity, and the prod gate is the protection.
 */
import {
  convertToModelMessages,
  generateText,
  stepCountIs,
  type ToolSet,
  tool,
  type UIMessage,
} from "ai";
import { Hono } from "hono";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { getAgentStub } from "../agent/index.ts";
import { buildSystemPrompt } from "../agent/prompts.ts";
import type { AppEnv } from "../auth/middleware.ts";
import { getModel } from "../llm/getModel.ts";
import type { SandboxClient } from "../sandbox/client.ts";
import { ensureWarm } from "../sandbox/lifecycle.ts";
import { buildTools } from "../tools/index.ts";
import type { ToolContext } from "../tools/types.ts";
import { buildWebTools, runWebSearch } from "../tools/web/searchTools.ts";
import { runDueAgents } from "./fanout.ts";
import { ScheduledRunPayload } from "./types.ts";

export function devTriggerRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Hard gate: outside production only. 404 (not 403) so prod betrays nothing
  // about these routes' existence - same no-leak convention as the agent routes.
  app.use("/__dev/*", async (c, next) => {
    if (c.env.ENVIRONMENT === "production") {
      return c.json({ error: "not found" }, 404);
    }
    await next();
  });
  app.use("/agents/:agentId/__dev/*", async (c, next) => {
    if (c.env.ENVIRONMENT === "production") {
      return c.json({ error: "not found" }, 404);
    }
    await next();
  });

  // Simulate the platform cron heartbeat locally (the real one is the Worker
  // `scheduled` handler, which doesn't fire under `wrangler dev`).
  app.post("/__dev/cron", async (c) => {
    const result = await runDueAgents(c.env, Date.now());
    return c.json(result);
  });

  // Force a single agent's scheduled run immediately, bypassing cadence - for
  // testing one agent without waiting for its cron. Body is an optional
  // ScheduledRunPayload (`{ kind?, scheduledFor? }`).
  app.post("/agents/:agentId/__dev/run", async (c) => {
    const agentId = c.req.param("agentId");
    const parsed = ScheduledRunPayload.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    await getAgentStub(c.env, agentId).runScheduled({
      kind: parsed.data.kind,
      scheduledFor: parsed.data.scheduledFor ?? Date.now(),
    });
    return c.json({ ok: true, agentId } as const);
  });

  // Probe the configured web-search backend directly (no agent loop, no model) -
  // verifies the keyless DuckDuckGo path actually returns results from the
  // Worker's egress, independent of whether the model chooses to call the tool.
  // `?q=` is the query. Prod-gated by the `/__dev/*` guard above.
  app.get("/__dev/search", async (c) => {
    const query = c.req.query("q")?.trim();
    if (!query) return c.json({ error: "q is required" }, 400);
    try {
      const hits = await runWebSearch(c.env, query, 5);
      return c.json({ ok: true, count: hits.length, hits });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  });

  // Diagnostic: does the resolved model actually DRIVE a tool via the AI SDK?
  // Runs a one-shot NON-streaming `generateText` with the real `webSearch` tool
  // and reports whether the model emitted an executable tool call (`toolCalls`)
  // vs. answering as text. Distinguishes a streaming-only tool-call gap from a
  // fundamental model limitation. `?mode=stream` runs the streamText path for the
  // A/B. Prod-gated. webSearch's small results inline, so the dummy sandbox is
  // never touched.
  app.get("/__dev/tooltest", async (c) => {
    const query = c.req.query("q")?.trim() || "NVIDIA investor relations";
    const ctx: ToolContext = {
      env: c.env,
      agentId: "tooltest",
      accountId: "",
      sandbox: {} as unknown as SandboxClient,
      sessionId: null,
      emit: async () => {},
    };
    // `?extra=N` pads the catalog with N dummy no-op tools to find the count at
    // which the free model stops reliably tool-calling (isolates tool-COUNT from
    // schema complexity, reproducing the full-loop failure without a sandbox).
    const extra = Math.min(
      Number.parseInt(c.req.query("extra") ?? "0", 10) || 0,
      30,
    );
    // `?real=1` builds the EXACT interactive catalog (buildTools) over a warm
    // sandbox - the last difference from the real loop. Else: webSearch + N dummies.
    let tools: Record<string, unknown>;
    if (c.req.query("real") === "1") {
      const { sandbox } = await ensureWarm(c.env, "tooltest-real");
      tools = await buildTools({ ...ctx, sandbox });
    } else {
      tools = { webSearch: buildWebTools(ctx).webSearch };
      for (let i = 0; i < extra; i++) {
        tools[`noop_tool_${i}`] = tool({
          description: `A no-op diagnostic tool number ${i} that does nothing useful.`,
          inputSchema: z.object({
            value: z.string().optional().describe("ignored"),
          }),
          execute: async () => ({ ok: true }),
        });
      }
    }
    // `?sys=full` uses the REAL layered persona prompt (the suspected culprit for
    // the full-loop tool-call failure); default is a simple directive prompt.
    const system =
      c.req.query("sys") === "full"
        ? buildSystemPrompt({ template: null, systemPrompt: null })
        : "You are a research assistant with a webSearch tool. Always call webSearch to answer questions about current/real-world info.";
    // `?nat=1` uses a NATURAL question (the real-world failure case - no explicit
    // "you MUST call webSearch"); default is the forceful imperative prompt.
    const prompt =
      c.req.query("nat") === "1"
        ? `What is the current spot price of ${query}?`
        : `Search the web for "${query}" and tell me the single best URL. You MUST call the webSearch tool.`;
    // `?msg=1` feeds the prompt as `messages: convertToModelMessages([UIMessage])`
    // (exactly what the real chat loop does) instead of `prompt` - to test whether
    // structured UIMessage content is what disables Workers-AI tool-calling.
    const useMessages = c.req.query("msg") === "1";
    const uiMessages: UIMessage[] = [
      { id: "probe-u", role: "user", parts: [{ type: "text", text: prompt }] },
    ];
    try {
      // `?model=<id>` tests an arbitrary Workers AI model (no secret needed) for
      // natural-query tool-calling - to find a free default that drives the loop.
      const override = c.req.query("model")?.trim();
      const { model, config } = override
        ? {
            model: createWorkersAI({ binding: c.env.AI })(override),
            config: { provider: "workers-ai" as const, model: override },
          }
        : await getModel(c.env, "");
      const result = await generateText({
        model,
        tools: tools as ToolSet,
        system,
        ...(useMessages
          ? { messages: await convertToModelMessages(uiMessages) }
          : { prompt }),
        stopWhen: stepCountIs(4),
      });
      const toolCalls = result.steps.flatMap((s) =>
        s.toolCalls.map((t) => t.toolName),
      );
      return c.json({
        ok: true,
        model: config.model,
        toolCount: Object.keys(tools).length,
        toolNames: Object.keys(tools),
        steps: result.steps.length,
        finishReason: result.finishReason,
        toolCalls,
        executedTool: toolCalls.length > 0,
        textPreview: result.text.slice(0, 300),
      });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  });

  // Same tool-call probe but driven INSIDE the agent DO (mirrors the worker-side
  // `/__dev/tooltest`) - isolates whether the DO runtime itself is why interactive
  // turns don't tool-call. `?msg=1` uses messages input; `?step=1` adds the
  // onStepFinish audit callback (the two diffs from the worker probe). Prod-gated.
  app.get("/agents/:agentId/__dev/tooltest", async (c) => {
    const agentId = c.req.param("agentId");
    const query = c.req.query("q")?.trim() || "NVIDIA investor relations";
    try {
      const out = await getAgentStub(c.env, agentId).debugToolTest({
        query,
        useMessages: c.req.query("msg") === "1",
        withStepCallback: c.req.query("step") === "1",
        natural: c.req.query("nat") === "1",
      });
      return c.json({ ok: true, ...out });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  });

  return app;
}
