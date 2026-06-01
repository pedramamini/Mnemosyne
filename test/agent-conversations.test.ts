import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import worker from "../src/index.ts";
import { generateModel, toolThenTextModel } from "./mock-model.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-35/36: multi-thread web conversations live INSIDE the per-agent DO (the
// `web_conversation` store), distinct from the agents-SDK single-log chat. These
// cover the thread CRUD RPC, the streaming turn that persists into a named thread,
// and the route-layer auth/ownership guard.

const BASE = "https://mnemosyne.test";

function userMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
  };
}

async function seedAgent(): Promise<{ agentId: string; cookie: string }> {
  const account = await createAccount(env, {
    email: `conv-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Conversation agent",
    template: "vendor",
    system_prompt: "Track the market.",
  });
  const cookie = `${SESSION_COOKIE}=${await createSession(env, account.id)}`;
  return { agentId: agent.id, cookie };
}

describe("MnemosyneAgent - web conversations", () => {
  it("creates, lists, renames, and searches threads", async () => {
    const { agentId } = await seedAgent();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    await runInDurableObject(stub, async (instance: MnemosyneAgent) => {
      // A fresh agent has no threads.
      expect(instance.listConversations()).toEqual([]);

      // Create seeds the title from the opening message; get returns it empty.
      const created = instance.createConversation({
        firstMessage: "Are we bullish on chips?",
      });
      expect(created.title).toContain("Are we bullish");
      expect(created.id).toBeTruthy();
      const detail = instance.getConversation(created.id);
      expect(detail?.messages).toEqual([]);

      // List sees it; rename updates it; an unknown id renames to null.
      expect(instance.listConversations().map((c) => c.id)).toContain(
        created.id,
      );
      const renamed = instance.renameConversation(created.id, "Chip thesis");
      expect(renamed?.title).toBe("Chip thesis");
      expect(instance.renameConversation("nope", "x")).toBeNull();

      // Title search is a case-insensitive substring match.
      expect(instance.searchConversations("CHIP").map((c) => c.id)).toContain(
        created.id,
      );
      expect(instance.searchConversations("nonsense")).toEqual([]);

      // Getting an unknown thread is null (the route turns this into a 404).
      expect(instance.getConversation("missing")).toBeNull();
    });
  });

  it("streams a turn and persists both sides into the named thread", async () => {
    const { agentId } = await seedAgent();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));
    const reply = "The market looks bullish.";

    await runInDurableObject(stub, async (instance: MnemosyneAgent) => {
      // The conversation turn runs generateText (Workers AI streaming drops tool
      // calls), so inject the non-streaming mock.
      instance.testModelOverride = generateModel(reply);
      instance.testSandboxOverride = stubSandboxClient().client;

      const conv = instance.createConversation();
      const req = new Request(
        `${BASE}/agents/${agentId}/conversations/${conv.id}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [userMessage("are we bullish?")] }),
        },
      );

      const res = await instance.fetch(req);
      const body = await res.text();
      // The UI-message stream carries the assistant text deltas.
      expect(body).toContain(reply);

      // The user turn persists synchronously; the assistant reply persists in the
      // stream's async onFinish - poll briefly for it to settle.
      for (
        let i = 0;
        i < 50 && (instance.getConversation(conv.id)?.messages.length ?? 0) < 2;
        i++
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const detail = instance.getConversation(conv.id);
      expect(detail?.messages.length).toBe(2);
      expect(detail?.messages[0].role).toBe("user");
      expect(detail?.messages[1].role).toBe("assistant");
      // The thread's recency/preview tracked the latest message.
      expect(detail?.lastMessagePreview).toContain(reply);
    });
  });

  it("surfaces the turn's tool calls as data-tool parts (streamed + persisted)", async () => {
    const { agentId } = await seedAgent();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    await runInDurableObject(stub, async (instance: MnemosyneAgent) => {
      // Drive one real tool round-trip: the model calls runShell, then replies.
      // The stub sandbox runs the command cleanly (exit 0), so the call lands in
      // the turn's steps and must become a chat-visible chip.
      instance.testModelOverride = toolThenTextModel(
        "runShell",
        { command: "ls -la" },
        "Here are the files.",
      );
      instance.testSandboxOverride = stubSandboxClient().client;

      const conv = instance.createConversation();
      const req = new Request(
        `${BASE}/agents/${agentId}/conversations/${conv.id}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [userMessage("list the files")] }),
        },
      );

      const res = await instance.fetch(req);
      const body = await res.text();
      // The data-tool part rides the SAME UI-message stream as the text.
      expect(body).toContain("data-tool");
      expect(body).toContain("Running a command: ls -la");

      for (
        let i = 0;
        i < 50 && (instance.getConversation(conv.id)?.messages.length ?? 0) < 2;
        i++
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const assistant = instance.getConversation(conv.id)?.messages[1];
      const toolParts = (assistant?.parts ?? []).filter(
        (
          p,
        ): p is {
          type: "data-tool";
          data: { tool: string; summary: string };
        } => (p as { type?: string }).type === "data-tool",
      );
      expect(toolParts).toHaveLength(1);
      expect(toolParts[0].data.tool).toBe("runShell");
      expect(toolParts[0].data.summary).toBe("Running a command: ls -la");
      // The reply text still persists alongside the chip.
      expect(
        (assistant?.parts ?? []).some(
          (p) =>
            (p as { type?: string }).type === "text" &&
            (p as { text?: string }).text === "Here are the files.",
        ),
      ).toBe(true);
    });
  });
});

describe("conversation routes - auth + ownership guard", () => {
  async function call(
    path: string,
    init: { method?: string; cookie?: string; body?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (init.cookie) headers.Cookie = init.cookie;
    const req = new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("401s a conversation request without a session", async () => {
    const res = await call(`/agents/${crypto.randomUUID()}/conversations`);
    expect(res.status).toBe(401);
  });

  it("404s (not 403) listing/creating for a non-owned agent", async () => {
    const account = await createAccount(env, {
      email: `convguard-${crypto.randomUUID()}@example.com`,
    });
    const cookie = `${SESSION_COOKIE}=${await createSession(env, account.id)}`;
    const other = crypto.randomUUID();
    expect(
      (await call(`/agents/${other}/conversations`, { cookie })).status,
    ).toBe(404);
    expect(
      (
        await call(`/agents/${other}/conversations`, {
          method: "POST",
          cookie,
          body: {},
        })
      ).status,
    ).toBe(404);
  });

  it("creates a thread for an owned agent over HTTP → 201", async () => {
    const { agentId, cookie } = await seedAgent();
    const res = await call(`/agents/${agentId}/conversations`, {
      method: "POST",
      cookie,
      body: { firstMessage: "Hello there" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      agentId: string;
      title: string;
    };
    expect(created.agentId).toBe(agentId);
    expect(created.title).toContain("Hello there");

    // It now shows up in the list for that agent.
    const list = (await (
      await call(`/agents/${agentId}/conversations`, { cookie })
    ).json()) as Array<{ id: string }>;
    expect(list.map((c) => c.id)).toContain(created.id);
  });
});
