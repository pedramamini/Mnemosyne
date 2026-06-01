/**
 * useAgentChat (MNEMO-35) - the streaming lifecycle for one conversation.
 *
 * Wraps `@ai-sdk/react`'s `useChat` configured to talk to the per-agent DO chat
 * endpoint (MNEMO-15), keyed by `agentId` + `conversationId` and seeded with the
 * persisted history loaded via `getConversation`. The hook OWNS the streaming
 * lifecycle (transport, status, abort); components stay declarative and consume
 * the small, stable surface `{ messages, input, setInput, send, status, stop,
 * error }`.
 *
 * The AI SDK v5+ `useChat` no longer manages the input box, so we keep `input`/
 * `setInput` local here to preserve that ergonomic surface for the composer.
 *
 * Transport: `DefaultChatTransport` POSTs to `chatEndpoint(...)` with
 * `credentials: "include"` so the MNEMO-03 session cookie rides along, and reads
 * the UI-message stream that MNEMO-15's `toUIMessageStreamResponse` emits. If the
 * backend's stream turns out to be a plain SSE rather than the AI-SDK transport,
 * swap in a small custom transport HERE and keep this public shape identical -
 * components don't care how bytes arrive.
 */
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useMemo, useState } from "react";
import {
  type ChatMessage,
  chatEndpoint,
  type MessagePart,
} from "@/api/conversations";

export type { ChatStatus } from "ai";

export interface UseAgentChatOptions {
  agentId: string;
  conversationId: string;
  /** Persisted history (from `getConversation`) used to seed the transcript. */
  initialMessages?: ChatMessage[];
}

export interface UseAgentChat {
  /** The running transcript (seed history + streamed turns), mapped to `ChatMessage`. */
  messages: ChatMessage[];
  /** The composer's current text. */
  input: string;
  setInput: (value: string) => void;
  /** Send `text` (or the current `input` if omitted) and clear the box. */
  send: (text?: string) => void;
  /** AI-SDK status: `"submitted" | "streaming" | "ready" | "error"`. */
  status: ReturnType<typeof useChat>["status"];
  /** Abort the in-flight turn (keeps any tokens already streamed). */
  stop: () => void;
  error: Error | undefined;
}

/** Map our persisted `ChatMessage` onto the AI-SDK `UIMessage` used to seed the hook. */
function toUIMessage(message: ChatMessage): UIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts as UIMessage["parts"],
  };
}

/** Map an AI-SDK `UIMessage` back onto our `ChatMessage` (system turns become user). */
function toChatMessage(message: UIMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    parts: message.parts as unknown as MessagePart[],
  };
}

export function useAgentChat({
  agentId,
  conversationId,
  initialMessages,
}: UseAgentChatOptions): UseAgentChat {
  const [input, setInput] = useState("");

  // Memoize the transport per (agent, conversation) so a re-render doesn't tear
  // down the in-flight stream.
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: chatEndpoint(agentId, conversationId),
        credentials: "include",
      }),
    [agentId, conversationId],
  );

  const seeded = useMemo(
    () => (initialMessages ?? []).map(toUIMessage),
    [initialMessages],
  );

  const chat = useChat({
    // Re-key per conversation so switching threads resets the transcript state.
    id: conversationId,
    transport,
    messages: seeded,
  });

  const messages = useMemo(
    () => chat.messages.map(toChatMessage),
    [chat.messages],
  );

  const send = useCallback(
    (text?: string) => {
      const value = (text ?? input).trim();
      if (!value) return;
      void chat.sendMessage({ text: value });
      setInput("");
    },
    [chat, input],
  );

  const stop = useCallback(() => {
    void chat.stop();
  }, [chat]);

  return {
    messages,
    input,
    setInput,
    send,
    status: chat.status,
    stop,
    error: chat.error,
  };
}
