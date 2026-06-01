import { relativeTime } from "@/components/audit/AuditEventRow";
import { Button, EmptyState, Text } from "@/components/ui";
import { cx } from "@/components/ui/utils";
import styles from "./ReportList.module.css";

/** One row's data - a report (list mode) or a search hit (carries `snippet`). */
export interface ReportListItem {
  id: string;
  title: string;
  createdAt: string;
  snippet?: string;
}

export interface ReportListProps {
  items: ReportListItem[];
  /** The selected report id, highlighted in the list. */
  selectedId: string | null;
  /** Fired when a row is clicked. */
  onSelect: (id: string) => void;
  /** True when `items` are search hits (shows snippets + a "no matches" empty state). */
  isSearchResults?: boolean;
  /** The active query - only used for the "no matches for '<q>'" empty-state copy. */
  query?: string;
}

/**
 * ReportList (MNEMO-41) - the left-pane list of reports, or of search hits when
 * `isSearchResults`. Each row shows the title + relative date (and, for hits, the
 * matched `snippet`); the selected row is highlighted. Empty states differ for the
 * list ("No reports yet") vs. a fruitless search ("No matches for '<q>'"). Rows are
 * ghost `Button`s (span-only content) - the same selectable-row pattern as the
 * brain `CommitList`. Presentational only.
 */
export function ReportList({
  items,
  selectedId,
  onSelect,
  isSearchResults = false,
  query,
}: ReportListProps) {
  if (items.length === 0) {
    return isSearchResults ? (
      <EmptyState
        title={query ? `No matches for "${query}"` : "No matches"}
        description="Try a different search term."
      />
    ) : (
      <EmptyState
        title="No reports yet"
        description="This agent hasn't produced any reports yet."
      />
    );
  }

  return (
    <ul className={styles.list} aria-label="Reports">
      {items.map((item) => {
        const isSelected = item.id === selectedId;
        return (
          <li key={item.id} className={styles.item}>
            <Button
              variant="ghost"
              size="sm"
              fullWidth
              className={cx(styles.row, isSelected && styles.selected)}
              aria-current={isSelected || undefined}
              onClick={() => onSelect(item.id)}
            >
              <span className={styles.rowBody}>
                <span className={styles.titleLine}>
                  <Text
                    as="span"
                    size="sm"
                    weight="medium"
                    className={styles.title}
                  >
                    {item.title}
                  </Text>
                  {item.createdAt && (
                    <Text as="span" size="xs" color="text-muted">
                      {relativeTime(item.createdAt)}
                    </Text>
                  )}
                </span>
                {isSearchResults && item.snippet && (
                  <Text
                    as="span"
                    size="xs"
                    color="text-muted"
                    className={styles.snippet}
                  >
                    {item.snippet}
                  </Text>
                )}
              </span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
