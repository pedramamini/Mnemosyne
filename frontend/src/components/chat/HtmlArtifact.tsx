import { ExternalLink, Maximize2 } from "lucide-react";
import { useState } from "react";
import { artifactRawUrl } from "@/api/artifacts";
import { Button, IconButton, Modal, Panel } from "@/components/ui";
import styles from "./HtmlArtifact.module.css";

export interface HtmlArtifactProps {
  /** The owning agent - scopes the (auth-guarded) artifact raw URL. */
  agentId: string;
  /** The artifact id minted by the backend when the agent ran `renderHtml`. */
  artifactId: string;
  /** Title shown in the artifact's header bar + as the iframe's accessible name. */
  title: string;
}

/**
 * HtmlArtifact - an inline preview of an agent-rendered HTML view (the renderHtml
 * tool). The body is loaded straight into a SANDBOXED iframe from the
 * ownership-guarded raw URL; we never inline the HTML string into the React tree.
 *
 * Security: `sandbox="allow-scripts"` WITHOUT `allow-same-origin` puts the document
 * in an opaque origin (no cookies, no parent-DOM access), and the backend serves it
 * behind a `Content-Security-Policy: sandbox allow-scripts; connect-src 'none'; …`
 * so inline scripts may run for interactivity but have no network egress. The two
 * sandboxes intersect, so either alone is sufficient - this is defense in depth.
 */
export function HtmlArtifact({
  agentId,
  artifactId,
  title,
}: HtmlArtifactProps) {
  const [expanded, setExpanded] = useState(false);
  const src = artifactRawUrl(agentId, artifactId);

  return (
    <Panel
      className={styles.card}
      padding="4"
      radius="md"
      style={{ padding: 0, overflow: "hidden" }}
    >
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <div className={styles.actions}>
          <IconButton
            label="Open in a new tab"
            icon={<ExternalLink size={16} />}
            size="sm"
            variant="ghost"
            onClick={() => window.open(src, "_blank", "noopener,noreferrer")}
          />
          <IconButton
            label="Expand preview"
            icon={<Maximize2 size={16} />}
            size="sm"
            variant="ghost"
            onClick={() => setExpanded(true)}
          />
        </div>
      </div>

      <iframe
        className={styles.frame}
        src={src}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
      />

      <Modal
        open={expanded}
        onClose={() => setExpanded(false)}
        title={title}
        size="lg"
      >
        <iframe
          className={styles.frameLarge}
          src={src}
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
        />
        <div className={styles.modalFooter}>
          <Button
            variant="secondary"
            leftIcon={<ExternalLink size={16} />}
            onClick={() => window.open(src, "_blank", "noopener,noreferrer")}
          >
            Open in a new tab
          </Button>
        </div>
      </Modal>
    </Panel>
  );
}
