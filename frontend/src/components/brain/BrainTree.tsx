import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderClosed,
  FolderOpen,
  Plus,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { BrainEntry } from "@/api/brain";
import { Button, Icon, IconButton } from "@/components/ui";
import { cx } from "@/components/ui/utils";
import styles from "./BrainTree.module.css";

export interface BrainTreeProps {
  /** Flat list of brain entries (paths may be absolute under `/brain` or relative). */
  entries: BrainEntry[];
  /** Currently-selected file path (brain-relative), or `null`. */
  selectedPath: string | null;
  /** Fired when a file row is clicked - receives the brain-relative path. */
  onSelect: (path: string) => void;
  /** Fired by a directory's "new file here" affordance - receives the dir path. */
  onRequestNew: (parentDir: string) => void;
  /** Fired by a row's delete affordance - receives the path to remove. */
  onRequestDelete: (path: string) => void;
}

interface TreeNode {
  /** Basename shown in the row. */
  name: string;
  /** Brain-relative path to this node (the value emitted by the callbacks). */
  path: string;
  type: "file" | "dir";
  children: TreeNode[];
}

/**
 * Normalize a backend path to a brain-relative key: strip a leading slash and an
 * optional `brain/` prefix, so both absolute (`/brain/notes/a.md`) and relative
 * (`notes/a.md`) inputs collapse to the same `notes/a.md`. The route's BrainPath
 * guard accepts this relative form, so it's also what we hand back to the API.
 */
function toRelative(path: string): string {
  let p = path.replace(/^\/+/, "");
  if (p === "brain") return "";
  if (p.startsWith("brain/")) p = p.slice("brain/".length);
  return p;
}

/** Build a nested tree from the flat entry list, synthesizing intermediate dirs. */
function buildTree(entries: BrainEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "dir", children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);

  function ensureDir(relPath: string): TreeNode {
    const existing = dirs.get(relPath);
    if (existing) return existing;
    const segments = relPath.split("/");
    const name = segments[segments.length - 1];
    const parent = ensureDir(segments.slice(0, -1).join("/"));
    const node: TreeNode = { name, path: relPath, type: "dir", children: [] };
    parent.children.push(node);
    dirs.set(relPath, node);
    return node;
  }

  for (const entry of entries) {
    const rel = toRelative(entry.path);
    if (!rel) continue; // the brain root itself
    if (entry.type === "dir") {
      ensureDir(rel);
      continue;
    }
    const segments = rel.split("/");
    const name = segments[segments.length - 1];
    const parent = ensureDir(segments.slice(0, -1).join("/"));
    if (!parent.children.some((c) => c.path === rel)) {
      parent.children.push({ name, path: rel, type: "file", children: [] });
    }
  }

  sortNode(root);
  return root.children;
}

/** Sort each level: directories first, then alphabetical by name. */
function sortNode(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortNode(child);
}

/**
 * BrainTree (MNEMO-38) - a collapsible file tree over a flat `BrainEntry[]`.
 * Purely presentational: directories expand/collapse, files are selectable, and
 * every row exposes a delete affordance (directories also get "new file here").
 * No data fetching - the parent owns selection state and all mutations.
 */
export function BrainTree({
  entries,
  selectedPath,
  onSelect,
  onRequestNew,
  onRequestDelete,
}: BrainTreeProps) {
  const tree = buildTree(entries);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderNode(node: TreeNode, depth: number): ReactNode {
    const indent = { paddingInlineStart: `calc(var(--space-3) * ${depth})` };

    if (node.type === "dir") {
      const isOpen = expanded.has(node.path);
      return (
        <li key={node.path} className={styles.item}>
          <div className={styles.row} style={indent}>
            <Button
              variant="ghost"
              size="sm"
              className={styles.rowButton}
              aria-expanded={isOpen}
              onClick={() => toggle(node.path)}
              leftIcon={
                <span className={styles.leadIcons}>
                  <Icon icon={isOpen ? ChevronDown : ChevronRight} size="sm" />
                  <Icon icon={isOpen ? FolderOpen : FolderClosed} size="sm" />
                </span>
              }
            >
              {node.name}
            </Button>
            <span className={styles.affordances}>
              <IconButton
                size="sm"
                label={`New file in ${node.path}`}
                icon={<Icon icon={Plus} size="sm" />}
                onClick={() => onRequestNew(node.path)}
              />
              <IconButton
                size="sm"
                variant="danger"
                label={`Delete ${node.path}`}
                icon={<Icon icon={Trash2} size="sm" />}
                onClick={() => onRequestDelete(node.path)}
              />
            </span>
          </div>
          {isOpen && node.children.length > 0 && (
            <ul className={styles.list}>
              {node.children.map((child) => renderNode(child, depth + 1))}
            </ul>
          )}
        </li>
      );
    }

    const isSelected = node.path === selectedPath;
    return (
      <li key={node.path} className={styles.item}>
        <div
          className={cx(styles.row, isSelected && styles.selected)}
          style={indent}
        >
          <Button
            variant="ghost"
            size="sm"
            className={styles.rowButton}
            aria-current={isSelected || undefined}
            onClick={() => onSelect(node.path)}
            leftIcon={
              <span className={styles.leadIcons}>
                <span className={styles.chevronSpacer} />
                <Icon icon={FileText} size="sm" />
              </span>
            }
          >
            {node.name}
          </Button>
          <span className={styles.affordances}>
            <IconButton
              size="sm"
              variant="danger"
              label={`Delete ${node.path}`}
              icon={<Icon icon={Trash2} size="sm" />}
              onClick={() => onRequestDelete(node.path)}
            />
          </span>
        </div>
      </li>
    );
  }

  return (
    <ul className={styles.list} aria-label="Brain files">
      {tree.map((node) => renderNode(node, 0))}
    </ul>
  );
}
