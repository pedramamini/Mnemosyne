import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchInit,
  fetchUrl,
  installFetchMock,
  jsonResponse,
} from "../../test/apiMock";
import type { ChatMessage } from "../conversations";
import {
  chatEndpoint,
  createConversation,
  getConversation,
  isTextPart,
  listConversations,
  messageText,
  renameConversation,
  searchConversations,
} from "../conversations";

describe("conversations - pure message helpers", () => {
  it("isTextPart recognizes only well-formed text parts", () => {
    expect(isTextPart({ type: "text", text: "hi" })).toBe(true);
    expect(isTextPart({ type: "text" } as never)).toBe(false);
    expect(isTextPart({ type: "tool", name: "x" })).toBe(false);
  });

  it("messageText concatenates text parts and drops non-text ones", () => {
    const msg: ChatMessage = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "text", text: "Hello " },
        { type: "reasoning", text: "ignored" },
        { type: "text", text: "world" },
      ],
    };
    expect(messageText(msg)).toBe("Hello world");
  });
});

describe("conversations - chatEndpoint (pure URL)", () => {
  it("builds the per-thread streaming chat URL with encoding", () => {
    expect(chatEndpoint("a 1", "c/2")).toContain(
      "/agents/a%201/conversations/c%2F2/chat",
    );
  });
});

describe("conversations - fetch-backed", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("listConversations GETs the agent's conversations", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await listConversations("a1");
    expect(fetchUrl(fetchMock).endsWith("/agents/a1/conversations")).toBe(true);
  });

  it("createConversation POSTs an optional firstMessage", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "c1" }));
    await createConversation("a1", "hi there");
    expect(fetchInit(fetchMock).method).toBe("POST");
    expect(fetchInit(fetchMock).body).toBe(
      JSON.stringify({ firstMessage: "hi there" }),
    );
  });

  it("getConversation fetches one thread's transcript", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "c1", messages: [] }));
    await getConversation("a1", "c1");
    expect(fetchUrl(fetchMock)).toContain("/agents/a1/conversations/c1");
  });

  it("renameConversation PATCHes the title", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "c1", title: "New" }));
    await renameConversation("a1", "c1", "New");
    expect(fetchInit(fetchMock).method).toBe("PATCH");
    expect(fetchInit(fetchMock).body).toBe(JSON.stringify({ title: "New" }));
  });

  it("searchConversations passes an encoded q", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await searchConversations("a1", "a b&c");
    expect(fetchUrl(fetchMock)).toContain("/conversations?q=a%20b%26c");
  });
});
