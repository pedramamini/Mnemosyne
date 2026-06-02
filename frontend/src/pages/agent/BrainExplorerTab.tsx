import { FileUp, Plus } from "lucide-react";
import { useState } from "react";
import { BrainHistoryPanel } from "@/components/brain/BrainHistoryPanel";
import { BrainTree } from "@/components/brain/BrainTree";
import { DownloadBrainButton } from "@/components/brain/DownloadBrainButton";
import { FileEditor } from "@/components/brain/FileEditor";
import { NewFileDialog } from "@/components/brain/NewFileDialog";
import {
  useBrainFile,
  useBrainFiles,
  useDeleteBrainFile,
  useWriteBrainFile,
} from "@/components/brain/useBrain";
import { DocumentUploader } from "@/components/documents/DocumentUploader";
import { ResponsiveMasterDetail } from "@/components/layout";
import {
  Banner,
  Button,
  EmptyState,
  Icon,
  Inline,
  Modal,
  Panel,
  Spinner,
  Stack,
  Tabs,
  Text,
  useToast,
} from "@/components/ui";
import styles from "./BrainExplorerTab.module.css";

type BrainView = "files" | "history";

export interface BrainExplorerTabProps {
  agentId: string;
}

/**
 * BrainExplorerTab (MNEMO-38, PRD §6.9) - the agent-detail "Brain" tab: a
 * two-pane explorer where the user browses the agent's filesystem as a tree
 * (left) and views/edits files (right), creates files via a dialog, deletes
 * with a confirm, and downloads the whole brain as an archive. Composes the
 * `@/components/brain` primitives over the `useBrain` query/mutation hooks.
 */
export function BrainExplorerTab({ agentId }: BrainExplorerTabProps) {
  const { toast } = useToast();
  const { entries, loading, error, refetch } = useBrainFiles(agentId);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // "Add documents to brain" (DOCS-02): seeds neurons via the existing pipeline,
  // then refetches the tree so the new source-index + chunk neurons appear.
  const [docsOpen, setDocsOpen] = useState(false);
  const { file, loading: fileLoading } = useBrainFile(agentId, selectedPath);
  const { write, isSaving } = useWriteBrainFile(agentId);
  const { remove } = useDeleteBrainFile(agentId);

  const [newOpen, setNewOpen] = useState(false);
  const [newDir, setNewDir] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [view, setView] = useState<BrainView>("files");
  // When set, the per-file history modal is open scoped to this path.
  const [historyPath, setHistoryPath] = useState<string | null>(null);

  async function handleSave(content: string): Promise<void> {
    if (!selectedPath) return;
    try {
      await write(selectedPath, content);
      toast({ title: "File saved", variant: "success" });
    } catch (err) {
      toast({
        title: "Couldn't save file",
        description: (err as Error).message,
        variant: "danger",
      });
    }
  }

  async function handleCreate(path: string, content: string): Promise<void> {
    try {
      await write(path, content);
      setNewOpen(false);
      setSelectedPath(path);
      toast({ title: "File created", variant: "success" });
    } catch (err) {
      toast({
        title: "Couldn't create file",
        description: (err as Error).message,
        variant: "danger",
      });
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    const path = pendingDelete;
    try {
      await remove(path);
      if (selectedPath === path) setSelectedPath(null);
      toast({ title: "File deleted", variant: "success" });
    } catch (err) {
      toast({
        title: "Couldn't delete file",
        description: (err as Error).message,
        variant: "danger",
      });
    } finally {
      setPendingDelete(null);
    }
  }

  function openNew(dir: string): void {
    setNewDir(dir);
    setNewOpen(true);
  }

  const tree = (
    <Panel padding="3" className={styles.treePane}>
      <Stack gap="3">
        <Inline gap="2" justify="between" wrap>
          <Inline gap="2" wrap={false}>
            <Button
              size="sm"
              leftIcon={<Icon icon={Plus} size="sm" />}
              onClick={() => openNew("")}
            >
              New file
            </Button>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Icon icon={FileUp} size="sm" />}
              onClick={() => setDocsOpen(true)}
            >
              Add documents
            </Button>
          </Inline>
          <DownloadBrainButton agentId={agentId} />
        </Inline>

        {error ? (
          <Banner variant="danger" title="Couldn't load the brain">
            {error.message}
          </Banner>
        ) : loading ? (
          <Inline gap="2" align="center">
            <Spinner label="Loading brain" />
            <Text color="text-muted">Loading brain…</Text>
          </Inline>
        ) : entries.length === 0 ? (
          <EmptyState
            title="Empty brain"
            description="This agent hasn't written any files yet."
          />
        ) : (
          <BrainTree
            entries={entries}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
            onRequestNew={openNew}
            onRequestDelete={setPendingDelete}
          />
        )}
      </Stack>
    </Panel>
  );

  const editor = (
    <Panel padding="4" className={styles.editorPane}>
      <FileEditor
        path={selectedPath}
        content={file?.content ?? ""}
        isLoading={Boolean(selectedPath) && fileLoading}
        isSaving={isSaving}
        onSave={handleSave}
        onCancel={() => setSelectedPath(null)}
        onViewHistory={
          selectedPath ? () => setHistoryPath(selectedPath) : undefined
        }
      />
    </Panel>
  );

  // Master/detail: on mobile, the tree shows first; selecting a file pushes the
  // editor over it with a back control (selection drives `showDetail`).
  const filesView = (
    <ResponsiveMasterDetail
      master={tree}
      detail={editor}
      showDetail={selectedPath !== null}
      onBack={() => setSelectedPath(null)}
      backLabel="Back to files"
      masterWidth="20rem"
    />
  );

  return (
    <Stack gap="4">
      <Tabs
        label="Brain view"
        value={view}
        onChange={(id) => setView(id as BrainView)}
        tabs={[
          { id: "files", label: "Files", content: filesView },
          {
            id: "history",
            label: "History",
            content: <BrainHistoryPanel agentId={agentId} />,
          },
        ]}
      />

      <NewFileDialog
        open={newOpen}
        defaultDir={newDir}
        onCreate={handleCreate}
        onClose={() => setNewOpen(false)}
      />

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete file?"
        footer={
          <Inline gap="2" justify="end" wrap={false}>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete}>
              Delete
            </Button>
          </Inline>
        }
      >
        <Text>
          Delete{" "}
          <Text as="span" weight="semibold">
            {pendingDelete}
          </Text>
          ? This removes it from the brain and is recorded in the brain's
          history.
        </Text>
      </Modal>

      <Modal
        open={historyPath !== null}
        onClose={() => setHistoryPath(null)}
        title={historyPath ? `History - ${historyPath}` : "History"}
        size="lg"
      >
        {historyPath && (
          <BrainHistoryPanel agentId={agentId} path={historyPath} />
        )}
      </Modal>

      <Modal
        open={docsOpen}
        onClose={() => setDocsOpen(false)}
        title="Add documents to brain"
        size="lg"
      >
        <DocumentUploader
          agentId={agentId}
          variant="brain"
          onIngested={(results) => {
            // New neurons were written through the brain pipeline - refetch the
            // tree so they show up without a full reload.
            const seeded = results.filter((r) => r.status === "seeded").length;
            if (seeded > 0) {
              refetch();
              toast({
                title:
                  seeded === 1
                    ? "Document seeded into the brain"
                    : `${seeded} documents seeded into the brain`,
                variant: "success",
              });
            }
          }}
        />
      </Modal>
    </Stack>
  );
}
