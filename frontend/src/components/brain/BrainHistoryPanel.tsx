import { useEffect, useState } from "react";
import { ResponsiveMasterDetail } from "@/components/layout";
import {
  Banner,
  EmptyState,
  Inline,
  Panel,
  Spinner,
  Stack,
  Text,
  useToast,
} from "@/components/ui";
import styles from "./BrainHistoryPanel.module.css";
import { CommitList } from "./CommitList";
import { DiffViewer } from "./DiffViewer";
import { RestoreButton } from "./RestoreButton";
import { useCommitDiff, useCommits, useRestoreFile } from "./useBrain";

export interface BrainHistoryPanelProps {
  agentId: string;
  /**
   * When set, scopes the view to a single file's history (opened from the file
   * editor's "View history"); otherwise shows the whole brain's history.
   */
  path?: string;
}

/** Abbreviate a full sha to git's 7-char short form. */
function shortShaOf(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * BrainHistoryPanel (MNEMO-39, PRD §6.9) - the composed versioning view: a commit
 * list on the left, the selected commit's per-file diff on the right, each file
 * carrying a one-click `RestoreButton`. Owns the selected-sha state and the
 * restore mutation (the children stay presentational); surfaces restore outcomes
 * via toast. Handles loading, error, and the empty (no commits yet) states.
 */
export function BrainHistoryPanel({ agentId, path }: BrainHistoryPanelProps) {
  const { toast } = useToast();
  const { commits, loading, error, hasMore, loadMore, loadingMore } =
    useCommits(agentId, path);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  // On mobile the commit list shows first; choosing a commit pushes the diff
  // view. A commit auto-selects (below) so this can't derive from `selectedSha`.
  const [viewingDiff, setViewingDiff] = useState(false);

  // Keep a valid selection: keep the current sha if it's still in the list,
  // otherwise fall back to the newest commit (or null when there are none). This
  // also re-selects after the scope (`path`) changes and the list refetches.
  useEffect(() => {
    setSelectedSha((cur) =>
      cur && commits.some((c) => c.sha === cur)
        ? cur
        : (commits[0]?.sha ?? null),
    );
  }, [commits]);

  const { diffs, loading: diffLoading } = useCommitDiff(
    agentId,
    selectedSha,
    path,
  );
  const { restore, isRestoring } = useRestoreFile(agentId);
  const [restoringPath, setRestoringPath] = useState<string | null>(null);

  async function handleRestore(filePath: string): Promise<void> {
    if (!selectedSha) return;
    setRestoringPath(filePath);
    try {
      await restore(filePath, selectedSha);
      toast({
        title: "File restored",
        description: `${filePath} restored to ${shortShaOf(selectedSha)}.`,
        variant: "success",
      });
    } catch (err) {
      toast({
        title: "Couldn't restore file",
        description: (err as Error).message,
        variant: "danger",
      });
    } finally {
      setRestoringPath(null);
    }
  }

  if (error) {
    return (
      <Banner variant="danger" title="Couldn't load history">
        {error.message}
      </Banner>
    );
  }

  if (loading) {
    return (
      <Inline gap="2" align="center">
        <Spinner label="Loading history" />
        <Text color="text-muted">Loading history…</Text>
      </Inline>
    );
  }

  if (commits.length === 0) {
    return (
      <EmptyState
        title="No history yet"
        description={
          path
            ? "This file has no commits yet."
            : "This brain has no commits yet. History appears once the agent writes to its brain."
        }
      />
    );
  }

  const list = (
    <Panel padding="3" className={styles.listPane}>
      <CommitList
        commits={commits}
        selectedSha={selectedSha}
        onSelect={(sha) => {
          setSelectedSha(sha);
          setViewingDiff(true);
        }}
        onLoadMore={loadMore}
        hasMore={hasMore}
        loadingMore={loadingMore}
      />
    </Panel>
  );

  const diff = (
    <Panel padding="4" className={styles.diffPane}>
      {selectedSha ? (
        <Stack gap="3">
          <Text size="sm" color="text-muted">
            Commit{" "}
            <Text as="span" mono weight="medium">
              {shortShaOf(selectedSha)}
            </Text>
          </Text>
          <DiffViewer
            diffs={diffs}
            isLoading={diffLoading}
            renderFileActions={(diff) => (
              <RestoreButton
                path={diff.path}
                sha={selectedSha}
                shortSha={shortShaOf(selectedSha)}
                onRestore={() => handleRestore(diff.path)}
                isRestoring={isRestoring && restoringPath === diff.path}
              />
            )}
          />
        </Stack>
      ) : (
        <EmptyState
          title="Select a commit"
          description="Choose a commit from the list to see what it changed."
        />
      )}
    </Panel>
  );

  return (
    <ResponsiveMasterDetail
      master={list}
      detail={diff}
      showDetail={viewingDiff}
      onBack={() => setViewingDiff(false)}
      backLabel="Back to commits"
      masterWidth="22rem"
    />
  );
}
