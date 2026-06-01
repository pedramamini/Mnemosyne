import { Wrench } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  type ChatMessage,
  messageArtifacts,
  messageText,
  messageToolUses,
} from "@/api/conversations";
import { Avatar, Badge, Icon, Inline } from "@/components/ui";
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
 * MNEMO-37: assistant turns lead with a compact row of `data-tool` chips - what the
 * agent actually did this turn (searched, fetched, ran, wrote) - above the reply.
 * Native `reasoning` parts still flow through untouched.
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
  const toolUses = isAssistant ? messageToolUses(message) : [];

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
            {toolUses.length > 0 && (
              <Inline
                className={styles.tools}
                gap="1"
                aria-label="Tools used this turn"
              >
                {toolUses.map((tool) => (
                  <Badge
                    key={tool.key}
                    className={styles.tool}
                    variant="neutral"
                    appearance="subtle"
                    size="sm"
                    title={tool.summary}
                  >
                    <Icon icon={Wrench} size="sm" />
                    {tool.summary}
                  </Badge>
                ))}
              </Inline>
            )}
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
