import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  type ChatMessage,
  messageArtifacts,
  messageText,
} from "@/api/conversations";
import { Avatar } from "@/components/ui";
import { cx } from "@/components/ui/utils";
import { HtmlArtifact } from "./HtmlArtifact";
import styles from "./MessageBubble.module.css";

export interface MessageBubbleProps {
  message: ChatMessage;
  /** Owning agent - scopes the (auth-guarded) artifact iframe URLs. */
  agentId: string;
  /** Agent display name - drives the assistant avatar. */
  agentName: string;
  /** Optional agent avatar image URL. */
  agentAvatarUrl?: string;
  /** Show the streaming/typing indicator on this (in-progress assistant) bubble. */
  streaming?: boolean;
}

/** The pulsing three-dot "assistant is typing" affordance. */
function TypingIndicator() {
  return (
    <span
      className={styles.typing}
      role="status"
      aria-label="Assistant is typing"
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.dot} aria-hidden="true" />
    </span>
  );
}

/**
 * MessageBubble (MNEMO-35) - renders one chat message. User turns are plain text
 * (right-aligned); assistant turns show the agent `Avatar` and render their text
 * parts as sanitized markdown, followed by any `data-artifact` parts as inline
 * sandboxed HTML previews (the renderHtml tool). While `streaming`, an in-progress
 * assistant bubble appends a typing indicator (shown alone when nothing has
 * streamed yet).
 *
 * `reasoning`/`tool` parts are intentionally dropped here and surfaced in MNEMO-37.
 */
export function MessageBubble({
  message,
  agentId,
  agentName,
  agentAvatarUrl,
  streaming = false,
}: MessageBubbleProps) {
  const isAssistant = message.role === "assistant";
  const text = messageText(message);
  const artifacts = isAssistant ? messageArtifacts(message) : [];

  return (
    <div className={cx(styles.row, !isAssistant && styles.user)}>
      {isAssistant && (
        <Avatar
          className={styles.avatar}
          name={agentName}
          src={agentAvatarUrl}
          size="sm"
        />
      )}
      <div
        className={cx(
          styles.bubble,
          isAssistant ? styles.assistantBubble : styles.userBubble,
        )}
      >
        {isAssistant ? (
          <>
            {text && (
              <div className={styles.markdown}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeSanitize]}
                >
                  {text}
                </ReactMarkdown>
              </div>
            )}
            {artifacts.map((artifact) => (
              <HtmlArtifact
                key={artifact.artifactId}
                agentId={agentId}
                artifactId={artifact.artifactId}
                title={artifact.title}
              />
            ))}
            {streaming && <TypingIndicator />}
          </>
        ) : (
          text
        )}
      </div>
    </div>
  );
}
