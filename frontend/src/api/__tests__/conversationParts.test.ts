import { describe, expect, it } from "vitest";
import {
  type ChatMessage,
  isArtifactPart,
  messageArtifacts,
  messageText,
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
