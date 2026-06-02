import { FileText, Upload } from "lucide-react";
import { type DragEvent, useState } from "react";
import {
  ACCEPT_ATTRIBUTE,
  checkFile,
  type DocumentRecord,
  type DocumentStatus,
  type IngestResult,
} from "@/api/documents";
import {
  Badge,
  type BadgeVariant,
  Banner,
  EmptyState,
  FileButton,
  Icon,
  Inline,
  List,
  ListItem,
  Spinner,
  Stack,
  Text,
} from "@/components/ui";
import { cx } from "@/components/ui/utils";
import styles from "./DocumentUploader.module.css";
import { useAgentDocuments } from "./useAgentDocuments";

/** Which surface the uploader is mounted on - tweaks copy only. */
export type DocumentUploaderVariant = "discovery" | "brain";

export interface DocumentUploaderProps {
  /** The agent (or draft-agent/discovery) id to upload against. */
  agentId: string;
  /** Fired after an upload completes, with the per-file results. */
  onIngested?: (results: IngestResult[]) => void;
  /** The host surface - only changes the explanatory copy. */
  variant: DocumentUploaderVariant;
}

/** A file the client-side gate rejected before any upload (name + why). */
interface Rejection {
  name: string;
  reason: string;
}

const COPY: Record<DocumentUploaderVariant, { title: string; help: string }> = {
  discovery: {
    title: "Attach documents",
    help: "Mnemosyne reads these while scoping the agent, and seeds them into the brain when the agent is built. PDF, Office, OpenDocument, CSV/HTML, and images are supported.",
  },
  brain: {
    title: "Add documents to brain",
    help: "Each document is converted to Markdown and seeded as linked neurons right away. PDF, Office, OpenDocument, CSV/HTML, and images are supported.",
  },
};

/** Map a document status to a Badge variant + label (seeded carries its neuron count). */
function statusBadge(doc: DocumentRecord): {
  variant: BadgeVariant;
  label: string;
  busy: boolean;
} {
  const status: DocumentStatus = doc.status;
  switch (status) {
    case "pending":
      return { variant: "neutral", label: "Converting…", busy: true };
    case "converted":
      return {
        variant: "primary",
        label: "Ready · seeds at build",
        busy: false,
      };
    case "seeded":
      return {
        variant: "success",
        label: `Seeded · ${doc.neuron_count ?? 0} neurons`,
        busy: false,
      };
    case "failed":
      return { variant: "danger", label: "Failed", busy: false };
  }
}

/**
 * DocumentUploader (DOCS-02) - the reusable upload surface for both the create
 * wizard (variant `discovery`) and a live agent's brain (variant `brain`). A
 * drag-and-drop zone that also opens the file picker via the shared `FileButton`,
 * gates files client-side against the DOCS-01 accept-list + size ceiling, and
 * lists each attached document with its live status (pending → converting,
 * converted, seeded with neuron count, failed with the error). Composed entirely
 * from `@/components/ui` primitives - no raw interactive HTML, no bespoke controls.
 */
export function DocumentUploader({
  agentId,
  onIngested,
  variant,
}: DocumentUploaderProps) {
  const { documents, loading, error, uploading, upload } =
    useAgentDocuments(agentId);
  const [dragging, setDragging] = useState(false);
  const [rejections, setRejections] = useState<Rejection[]>([]);

  const copy = COPY[variant];

  /** Partition incoming files by the client-side gate, then upload the valid ones. */
  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    const accepted: File[] = [];
    const rejected: Rejection[] = [];
    for (const file of files) {
      const check = checkFile(file);
      if (check.ok) accepted.push(file);
      else rejected.push({ name: file.name, reason: check.reason });
    }
    setRejections(rejected);
    if (accepted.length === 0) return;
    try {
      const results = await upload(accepted);
      onIngested?.(results);
    } catch {
      // The hook records the error on its `error` channel; the Banner below shows it.
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
    void handleFiles(files);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!dragging) setDragging(true);
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    // Only clear when the pointer actually leaves the zone (not a child enter).
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  }

  return (
    <Stack gap="4">
      <Stack gap="1">
        <Text weight="semibold">{copy.title}</Text>
        <Text size="sm" color="text-muted" as="p">
          {copy.help}
        </Text>
      </Stack>

      {/* Drop zone - a non-interactive region; the FileButton owns the input. */}
      <div
        className={cx(styles.dropZone, dragging && styles.dragging)}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        role="group"
        aria-label={copy.title}
      >
        <Stack gap="3" align="center">
          <Icon icon={Upload} size="lg" className={styles.dropIcon} />
          <Text size="sm" color="text-muted">
            Drag files here, or
          </Text>
          <FileButton
            label={`${copy.title} - choose files`}
            accept={ACCEPT_ATTRIBUTE}
            multiple
            onSelectFiles={handleFiles}
            className={styles.pickerTrigger}
          >
            <span
              className={styles.pickerButton}
              data-busy={uploading || undefined}
            >
              {uploading ? (
                <Spinner size="sm" label="Uploading" />
              ) : (
                <Icon icon={Upload} size="sm" />
              )}
              <Text size="sm" weight="medium" color="inherit">
                Choose files
              </Text>
            </span>
          </FileButton>
          <Text size="xs" color="text-muted">
            Up to 25 MB each. Legacy .doc/.ppt/.rtf aren't supported.
          </Text>
        </Stack>
      </div>

      {rejections.length > 0 && (
        <Banner
          variant="warning"
          title={
            rejections.length === 1
              ? "A file couldn't be added"
              : `${rejections.length} files couldn't be added`
          }
          onDismiss={() => setRejections([])}
        >
          <Stack gap="1">
            {rejections.map((r) => (
              <Text key={`${r.name}:${r.reason}`} size="sm" as="p">
                <Text as="span" weight="medium">
                  {r.name}
                </Text>{" "}
                - {r.reason}
              </Text>
            ))}
          </Stack>
        </Banner>
      )}

      {error && (
        <Banner variant="danger" title="Upload failed">
          {error.message}
        </Banner>
      )}

      {/* Attached-document list with per-file status. */}
      {loading && documents.length === 0 ? (
        <Inline gap="2" align="center">
          <Spinner size="sm" label="Loading documents" />
          <Text size="sm" color="text-muted">
            Loading documents…
          </Text>
        </Inline>
      ) : documents.length === 0 ? (
        <EmptyState
          icon={<Icon icon={FileText} size="md" />}
          title="No documents yet"
          description="Attached documents will appear here with their status."
        />
      ) : (
        <List>
          {documents.map((doc) => {
            const badge = statusBadge(doc);
            return (
              <ListItem
                key={doc.id}
                trailing={
                  <Inline gap="2" align="center" wrap={false}>
                    {badge.busy && (
                      <Spinner size="sm" label="Converting document" />
                    )}
                    <Badge
                      variant={badge.variant}
                      appearance={doc.status === "seeded" ? "solid" : "subtle"}
                    >
                      {badge.label}
                    </Badge>
                  </Inline>
                }
              >
                <Stack gap="1">
                  <Inline gap="2" align="center" wrap={false}>
                    <Icon
                      icon={FileText}
                      size="sm"
                      className={styles.docIcon}
                    />
                    <Text size="sm" truncate className={styles.docName}>
                      {doc.filename}
                    </Text>
                  </Inline>
                  {doc.status === "failed" && doc.error && (
                    <Text size="xs" color="danger" as="p">
                      {doc.error}
                    </Text>
                  )}
                </Stack>
              </ListItem>
            );
          })}
        </List>
      )}
    </Stack>
  );
}
