import { describe, expect, it } from "vitest";
import {
  type ChatMessage,
  isArtifactPart,
  isToolPart,
  messageArtifacts,
  messageText,
  messageToolUses,
} from "../conversations";

// The message-part contract for inline HTML artifacts (the renderHtml tool). A
// `data-artifact` part rides in the SAME parts array as text and persists/streams
// identically; these guards drive the chat UI's "render an iframe for this" path.

const message: ChatMessage = {
  id: "a1",
  role: "assistant",
  parts: [
    { type: "text", text: "Here is the dashboard:" },
    {
      type: "data-artifact",
      id: "stream-id",
      data: { artifactId: "art-1", title: "Dashboard", kind: "html" },
    },
    // A malformed data-artifact (missing artifactId) must be ignored, not crash.
    { type: "data-artifact", data: { title: "broken" } },
  ],
};

describe("artifact message parts", () => {
  it("isArtifactPart accepts a well-formed part and rejects others", () => {
    expect(isArtifactPart(message.parts[1])).toBe(true);
    expect(isArtifactPart(message.parts[0])).toBe(false);
    expect(isArtifactPart(message.parts[2])).toBe(false);
  });

  it("messageArtifacts extracts only valid artifact references, in order", () => {
    const artifacts = messageArtifacts(message);
    expect(artifacts).toEqual([
      { artifactId: "art-1", title: "Dashboard", kind: "html" },
    ]);
  });

  it("messageText still concatenates only text parts (artifacts dropped)", () => {
    expect(messageText(message)).toBe("Here is the dashboard:");
  });
});

// The message-part contract for tool-use chips (MNEMO-37). A `data-tool` part rides
// in the SAME parts array as text/artifacts and persists/streams identically; these
// guards drive the chat UI's "show what the agent did this turn" row.

const toolMessage: ChatMessage = {
  id: "a2",
  role: "assistant",
  parts: [
    {
      type: "data-tool",
      id: "a2-tool-0",
      data: { tool: "webSearch", summary: "Searching the web: rust async" },
    },
    {
      type: "data-tool",
      id: "a2-tool-1",
      data: { tool: "webFetch", summary: "Reading https://example.com" },
    },
    { type: "text", text: "Here's what I found." },
    // A malformed data-tool (missing summary) must be ignored, not crash.
    { type: "data-tool", data: { tool: "runShell" } },
  ],
};

describe("tool-use message parts", () => {
  it("isToolPart accepts a well-formed part and rejects others", () => {
    expect(isToolPart(toolMessage.parts[0])).toBe(true);
    expect(isToolPart(toolMessage.parts[2])).toBe(false);
    expect(isToolPart(toolMessage.parts[3])).toBe(false);
  });

  it("messageToolUses extracts valid tool uses in call order with a stable key", () => {
    expect(messageToolUses(toolMessage)).toEqual([
      {
        tool: "webSearch",
        summary: "Searching the web: rust async",
        key: "a2-tool-0",
      },
      {
        tool: "webFetch",
        summary: "Reading https://example.com",
        key: "a2-tool-1",
      },
    ]);
  });

  it("text and artifact extractors ignore tool parts", () => {
    expect(messageText(toolMessage)).toBe("Here's what I found.");
    expect(messageArtifacts(toolMessage)).toEqual([]);
  });
});
