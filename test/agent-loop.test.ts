import {
  abortAllDurableObjects,
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { INTERACTIVE_STEP_BUDGET } from "../src/agent/config.ts";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import worker from "../src/index.ts";
import { streamingModel, uiText } from "./mock-model.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-15: the interactive agentic loop in MnemosyneAgent (streamText hosted by
// AIChatAgent, bounded by stopWhen, with message-history persistence). The model
// is injected via testModelOverride (the mock LanguageModel) so the loop runs
// hermetically - no real inference, empty tool map this phase.

const BASE = "https://mnemosyne.test";

function userMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
  };
}

async function seedAgent(): Promise<string> {
  const account = await createAccount(env, {
    email: `loop-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Loop agent",
    template: "vendor",
    system_prompt: "Track Acme releases.",
  });
  return agent.id;
}

describe("MnemosyneAgent - interactive agentic loop", () => {
  it("runs a turn, persists history, and survives hibernation", async () => {
    const agentId = await seedAgent();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));
    const reply = "Hello from Mnemosyne.";

    await runInDurableObject(stub, async (instance: MnemosyneAgent) => {
      instance.testModelOverride = streamingModel(reply);
      // The loop now builds the MNEMO-16 tool catalog over a warm sandbox; the
      // workers pool can't boot a container, so inject a stub one.
      instance.testSandboxOverride = stubSandboxClient().client;
      // saveMessages persists the user message, drives onChatMessage (the loop),
      // and resolves once the streamed assistant reply is persisted too.
      await instance.saveMessages([...instance.messages, userMessage("hi")]);

      expect(instance.messages.length).toBeGreaterThanOrEqual(2);
      const last = instance.messages.at(-1);
      expect(last?.role).toBe("assistant");
      expect(uiText(last)).toContain(reply);
    });

    // Hibernation/eviction: live instances are torn down but DO-SQLite survives.
    // Re-acquiring the same DO must see the persisted history (PRD §7.1) - i.e.
    // history round-tripped through SQLite, not volatile memory.
    await abortAllDurableObjects();
    const again = env.AGENT.get(env.AGENT.idFromName(agentId));
    await runInDurableObject(again, async (instance: MnemosyneAgent) => {
      expect(instance.messages.length).toBeGreaterThanOrEqual(2);
      expect(uiText(instance.messages.at(-1))).toContain(reply);
    });
  });

  it("onChatMessage returns a streamed UI-message response (one model call, INTERACTIVE_STEP_BUDGET ceiling)", async () => {
    const agentId = await seedAgent();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));
    const reply = "Streamed answer.";

    await runInDurableObject(stub, async (instance: MnemosyneAgent) => {
      const override = streamingModel(reply);
      instance.testModelOverride = override;
      instance.testSandboxOverride = stubSandboxClient().client;
      instance.messages = [userMessage("stream please")];

      const res = await instance.onChatMessage(async () => {});
      expect(res).toBeDefined();
      // The UI message stream carries the assistant text deltas.
      const body = await (res as Response).text();
      expect(body).toContain(reply);

      // The loop invoked the model exactly once: with an empty tool map a turn is
      // a single model call, well under the INTERACTIVE_STEP_BUDGET hard ceiling.
      const mock = override.model as unknown as { doStreamCalls: unknown[] };
      expect(mock.doStreamCalls.length).toBe(1);
    });

    // The interactive ceiling onChatMessage wires into stopWhen.
    expect(INTERACTIVE_STEP_BUDGET).toBe(30);
  });
});

describe("chat route - auth + ownership guard", () => {
  async function call(
    path: string,
    opts: { cookie?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (opts.cookie) headers.Cookie = opts.cookie;
    const req = new Request(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "hi" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("401s a chat POST without a session", async () => {
    const res = await call(`/agents/${crypto.randomUUID()}/chat`);
    expect(res.status).toBe(401);
  });

  it("404s (not 403) a chat POST for a non-owned agent", async () => {
    const account = await createAccount(env, {
      email: `guard-${crypto.randomUUID()}@example.com`,
    });
    const cookie = `${SESSION_COOKIE}=${await createSession(env, account.id)}`;
    // A random agent id this account does not own → ownership check 404s before
    // the request ever reaches the DO (so no model is invoked).
    const res = await call(`/agents/${crypto.randomUUID()}/chat`, { cookie });
    expect(res.status).toBe(404);
  });
});
