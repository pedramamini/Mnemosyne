import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { FileDiff } from "@/api/brain";
import {
  Badge,
  type BadgeVariant,
  Button,
  Code,
  EmptyState,
  Icon,
  Spinner,
  Text,
} from "@/components/ui";
import { cx } from "@/components/ui/utils";
import styles from "./DiffViewer.module.css";

export interface DiffViewerProps {
  /** Per-file diffs of the selected commit (MNEMO-12 shape). */
  diffs: FileDiff[];
  /** True while the diff is loading; shows a spinner instead of content. */
  isLoading?: boolean;
  /**
   * Optional per-file action slot, rendered in each file's header beside the
   * collapse toggle. The parent uses it to drop a `RestoreButton` per file while
   * the viewer itself stays presentational (no mutation knowledge here).
   */
  renderFileActions?: (diff: FileDiff) => ReactNode;
}

/** A derived change kind for a file, since MNEMO-12 carries no `status` field. */
type FileStatus = "added" | "modified" | "deleted" | "renamed";

/** One parsed line of a unified diff. */
type DiffLineKind = "add" | "del" | "context" | "hunk";
interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Above this many files, sections start collapsed (the diff can be huge). */
const MANY_FILES = 4;

/** Structural patch headers we drop from the line list (status is derived first). */
const HEADER_PREFIXES = [
  "diff --git",
  "index ",
  "--- ",
  "+++ ",
  "new file",
  "deleted file",
  "rename ",
  "copy ",
  "similarity ",
  "dissimilarity ",
  "old mode",
  "new mode",
  "Binary files",
  "GIT binary",
];

const STATUS_VARIANT: Record<FileStatus, BadgeVariant> = {
  added: "success",
  modified: "neutral",
  deleted: "danger",
  renamed: "warning",
};

/** Derive the change kind from the patch's git headers (added/deleted/renamed/modified). */
function deriveStatus(diff: FileDiff): FileStatus {
  const lines = diff.patch.split("\n");
  if (
    lines.some((l) => l.startsWith("rename from") || l.startsWith("rename to"))
  )
    return "renamed";
  if (lines.some((l) => l.startsWith("new file mode"))) return "added";
  if (lines.some((l) => l.startsWith("deleted file mode"))) return "deleted";
  return "modified";
}

/** Split a unified patch into colorable lines, dropping structural headers. */
function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    // File headers are checked before +/- so `+++ `/`--- ` aren't read as content.
    if (HEADER_PREFIXES.some((p) => raw.startsWith(p))) continue;
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1) });
      continue;
    }
    out.push({
      kind: "context",
      text: raw.startsWith(" ") ? raw.slice(1) : raw,
    });
  }
  // Patches end with a trailing newline → drop the empty context line it yields.
  while (
    out.length > 0 &&
    out[out.length - 1].kind === "context" &&
    out[out.length - 1].text === ""
  ) {
    out.pop();
  }
  return out;
}

const GUTTER: Record<DiffLineKind, string> = {
  add: "+",
  del: "-",
  context: " ",
  hunk: "",
};

function DiffBody({ diff }: { diff: FileDiff }) {
  if (diff.binary) {
    return (
      <Text size="sm" color="text-muted" className={styles.note}>
        Binary file - no textual diff.
      </Text>
    );
  }
  const lines = parsePatch(diff.patch);
  if (lines.length === 0) {
    return (
      <Text size="sm" color="text-muted" className={styles.note}>
        No content changes.
      </Text>
    );
  }
  return (
    <div className={styles.body}>
      {lines.map((line, i) => (
        <div
          // Diff lines have no stable id; index within an immutable patch is fine.
          // biome-ignore lint/suspicious/noArrayIndexKey: lines come from one immutable patch string.
          key={i}
          className={cx(styles.line, styles[line.kind])}
          data-diff-kind={line.kind}
        >
          <span className={styles.gutter} aria-hidden="true">
            {GUTTER[line.kind]}
          </span>
          <span className={styles.lineText}>{line.text}</span>
        </div>
      ))}
      {diff.truncated && (
        <Text size="xs" color="text-muted" className={styles.note}>
          Diff truncated.
        </Text>
      )}
    </div>
  );
}

/**
 * DiffViewer (MNEMO-39, PRD §6.9) - renders the per-file diffs of a selected
 * commit. Each file shows its path, a derived status badge, and add/delete
 * counts; the body is a colored unified-diff line list (green adds, red deletes,
 * neutral context). Many files start collapsed. Presentational only.
 */
export function DiffViewer({
  diffs,
  isLoading = false,
  renderFileActions,
}: DiffViewerProps) {
  const manyFiles = diffs.length > MANY_FILES;
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());

  // Reset expansion whenever the diff set changes: expand all when few, collapse
  // all when there are many.
  useEffect(() => {
    setOpenPaths(manyFiles ? new Set() : new Set(diffs.map((d) => d.path)));
  }, [diffs, manyFiles]);

  function toggle(path: string): void {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if (isLoading) {
    return <Spinner label="Loading diff" />;
  }

  if (diffs.length === 0) {
    return (
      <EmptyState
        title="No changes"
        description="This commit didn't change any files."
      />
    );
  }

  return (
    <div className={styles.files}>
      {diffs.map((diff) => {
        const status = deriveStatus(diff);
        const isOpen = openPaths.has(diff.path);
        return (
          <div key={diff.path} className={styles.file}>
            <div className={styles.fileHeader}>
              <Button
                variant="ghost"
                size="sm"
                className={styles.fileToggle}
                aria-expanded={isOpen}
                onClick={() => toggle(diff.path)}
                leftIcon={
                  <Icon icon={isOpen ? ChevronDown : ChevronRight} size="sm" />
                }
              >
                <span className={styles.fileHeaderInner}>
                  <Code className={styles.filePath}>{diff.path}</Code>
                  <Badge variant={STATUS_VARIANT[status]} size="sm">
                    {status}
                  </Badge>
                  <Text size="xs" color="text-muted" className={styles.counts}>
                    <span className={styles.countAdd}>+{diff.additions}</span>{" "}
                    <span className={styles.countDel}>−{diff.deletions}</span>
                  </Text>
                </span>
              </Button>
              {renderFileActions && (
                <span className={styles.fileActions}>
                  {renderFileActions(diff)}
                </span>
              )}
            </div>
            {isOpen && <DiffBody diff={diff} />}
          </div>
        );
      })}
    </div>
  );
}
