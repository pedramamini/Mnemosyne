import { FileText } from "lucide-react";
import { useState } from "react";
import type { DocumentRecord } from "@/api/documents";
import {
  Badge,
  type BadgeVariant,
  Banner,
  Button,
  Checkbox,
  EmptyState,
  FormField,
  Heading,
  Icon,
  Inline,
  Input,
  List,
  ListItem,
  Modal,
  Panel,
  Spinner,
  Stack,
  Text,
} from "@/components/ui";
import { useAgentDocuments } from "./useAgentDocuments";

export interface DocumentsManagerProps {
  /** The agent whose ingested documents this manages. */
  agentId: string;
}

/** A compact status pill for a document row (no busy/seed-count detail needed here). */
function statusPill(status: DocumentRecord["status"]): {
  variant: BadgeVariant;
  label: string;
} {
  switch (status) {
    case "pending":
      return { variant: "neutral", label: "Converting" };
    case "converted":
      return { variant: "primary", label: "Converted" };
    case "seeded":
      return { variant: "success", label: "Seeded" };
    case "failed":
      return { variant: "danger", label: "Failed" };
  }
}

/**
 * DocumentsManager (DOCS-02) - the destructive document-removal surface, mounted
 * in the agent's Settings Danger zone (never an inline one-click delete, per the
 * destructive-actions convention). Lists ingested documents; "Remove" opens a
 * type-the-filename confirm with an optional "also remove the N derived neurons"
 * checkbox that maps to `deleteDocument(..., { purgeNeurons })`.
 */
export function DocumentsManager({ agentId }: DocumentsManagerProps) {
  const { documents, loading, error, remove } = useAgentDocuments(agentId);

  const [pending, setPending] = useState<DocumentRecord | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [purgeNeurons, setPurgeNeurons] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState(false);

  const neuronCount = pending?.neuron_count ?? 0;
  // Only seeded docs have derived neurons to optionally purge.
  const canPurge = Boolean(pending?.source_slug) && neuronCount > 0;
  const confirmMatches = pending !== null && confirmName === pending.filename;

  function openRemove(doc: DocumentRecord) {
    setPending(doc);
    setConfirmName("");
    setPurgeNeurons(false);
    setRemoveError(false);
  }

  function closeRemove() {
    if (removing) return;
    setPending(null);
  }

  async function confirmRemove() {
    if (!pending || !confirmMatches) return;
    setRemoving(true);
    setRemoveError(false);
    try {
      await remove(pending.id, { purgeNeurons: canPurge && purgeNeurons });
      setPending(null);
    } catch {
      setRemoveError(true);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Panel padding="5">
      <Stack gap="3">
        <Heading level={3}>Documents</Heading>
        <Text size="sm" color="text-muted">
          Documents you've uploaded to this agent. Removing one deletes the
          original upload; you can also remove the neurons it seeded into the
          brain. This can't be undone.
        </Text>

        {error && (
          <Banner variant="danger" title="Couldn't load documents">
            {error.message}
          </Banner>
        )}

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
            title="No documents"
            description="Documents uploaded during creation or from the Brain tab will appear here."
          />
        ) : (
          <List>
            {documents.map((doc) => {
              const pill = statusPill(doc.status);
              const neurons = doc.neuron_count ?? 0;
              return (
                <ListItem
                  key={doc.id}
                  trailing={
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => openRemove(doc)}
                    >
                      Remove
                    </Button>
                  }
                >
                  <Stack gap="1">
                    <Inline gap="2" align="center" wrap={false}>
                      <Icon icon={FileText} size="sm" />
                      <Text size="sm" truncate>
                        {doc.filename}
                      </Text>
                    </Inline>
                    <Inline gap="2" align="center">
                      <Badge variant={pill.variant} appearance="subtle">
                        {pill.label}
                      </Badge>
                      {doc.status === "seeded" && (
                        <Text size="xs" color="text-muted">
                          {neurons} neuron{neurons === 1 ? "" : "s"}
                        </Text>
                      )}
                    </Inline>
                  </Stack>
                </ListItem>
              );
            })}
          </List>
        )}
      </Stack>

      <Modal
        open={pending !== null}
        onClose={closeRemove}
        title="Remove this document"
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeRemove}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={confirmRemove}
              loading={removing}
              disabled={!confirmMatches}
            >
              Remove document
            </Button>
          </>
        }
      >
        <Stack gap="4">
          {removeError && (
            <Banner variant="danger" title="Couldn't remove">
              Something went wrong. Please try again.
            </Banner>
          )}
          <Text size="sm">
            This removes the uploaded document. {canPurge ? "Optionally, " : ""}
            {canPurge
              ? "it can also remove the neurons it seeded into the brain."
              : "It has no derived neurons to remove."}{" "}
            This can't be undone.
          </Text>
          {canPurge && (
            <Checkbox
              checked={purgeNeurons}
              onChange={(e) => setPurgeNeurons(e.target.checked)}
              label={`Also remove the ${neuronCount} derived neuron${
                neuronCount === 1 ? "" : "s"
              } from the brain`}
            />
          )}
          <FormField
            label={`Type "${pending?.filename ?? ""}" to confirm`}
            help="The filename must match exactly, including case and spacing."
          >
            <Input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && confirmMatches) confirmRemove();
              }}
              placeholder={pending?.filename}
              autoFocus
            />
          </FormField>
        </Stack>
      </Modal>
    </Panel>
  );
}
