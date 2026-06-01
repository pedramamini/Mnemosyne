import type { Commit } from "@/api/brain";
import { relativeTime } from "@/components/audit/AuditEventRow";
import { Badge, Button, Code, Text } from "@/components/ui";
import { cx } from "@/components/ui/utils";
import styles from "./CommitList.module.css";

export interface CommitListProps {
  /** Commits, newest first (as MNEMO-12 returns them). */
  commits: Commit[];
  /** The currently-selected commit sha, highlighted in the list. */
  selectedSha: string | null;
  /** Fired when a commit row is clicked - receives the full sha. */
  onSelect: (sha: string) => void;
  /** When present (and `hasMore`), renders a "Load more" control. */
  onLoadMore?: () => void;
  /** Whether another page is available (gates the "Load more" control). */
  hasMore?: boolean;
  /** True while the next page is loading (shows the control's spinner). */
  loadingMore?: boolean;
}

/** Abbreviate a full 40-char sha to git's 7-char short form. */
function shortShaOf(sha: string): string {
  return sha.slice(0, 7);
}

/** First line of a commit subject (the rest, if any, is the body). */
function firstLine(subject: string): string {
  const nl = subject.indexOf("\n");
  return nl === -1 ? subject : subject.slice(0, nl);
}

/**
 * CommitList (MNEMO-39, PRD §6.9) - a scrollable list of brain commits. Each row
 * shows the short message, short sha, and relative time; consolidation-pass
 * commits ("sleep" passes) get a badge so they stand out. Purely presentational:
 * the parent owns selection state and pagination. Row content is spans only -
 * `Button` wraps its children in a `<span>`, so no block-level layout primitives.
 */
export function CommitList({
  commits,
  selectedSha,
  onSelect,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
}: CommitListProps) {
  return (
    <ul className={styles.list} aria-label="Commit history">
      {commits.map((commit) => {
        const isSelected = commit.sha === selectedSha;
        const isConsolidation = commit.category === "consolidate";
        return (
          <li key={commit.sha} className={styles.item}>
            <Button
              variant="ghost"
              size="sm"
              fullWidth
              className={cx(styles.row, isSelected && styles.selected)}
              aria-current={isSelected || undefined}
              onClick={() => onSelect(commit.sha)}
            >
              <span className={styles.rowBody}>
                <span className={styles.messageLine}>
                  <Text
                    as="span"
                    size="sm"
                    weight="medium"
                    className={styles.message}
                  >
                    {firstLine(commit.subject)}
                  </Text>
                  {isConsolidation && (
                    <Badge variant="primary" size="sm">
                      consolidation
                    </Badge>
                  )}
                </span>
                <span className={styles.metaLine}>
                  <Code className={styles.sha}>{shortShaOf(commit.sha)}</Code>
                  <Text as="span" size="xs" color="text-muted">
                    {relativeTime(new Date(commit.ts).toISOString())}
                  </Text>
                </span>
              </span>
            </Button>
          </li>
        );
      })}
      {onLoadMore && hasMore && (
        <li className={styles.item}>
          <Button
            variant="ghost"
            size="sm"
            fullWidth
            loading={loadingMore}
            onClick={onLoadMore}
          >
            Load more
          </Button>
        </li>
      )}
    </ul>
  );
}
