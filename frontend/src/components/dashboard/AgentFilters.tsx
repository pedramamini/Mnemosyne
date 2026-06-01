import { useEffect, useRef, useState } from "react";
import { AGENT_TEMPLATES } from "@/api/agents";
import {
  Inline,
  SearchInput,
  Select,
  type SelectOption,
} from "@/components/ui";
import styles from "./AgentFilters.module.css";
import type { SortBy, StatusFilter, TemplateFilter } from "./useAgentMetrics";

/** Title-case a lowercase token for option labels. */
function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const TEMPLATE_OPTIONS: SelectOption[] = [
  { label: "All templates", value: "all" },
  ...AGENT_TEMPLATES.map((t) => ({ label: titleCase(t), value: t })),
];

/**
 * Lifecycle statuses an agent moves through (MNEMO-02): a draft is discovered,
 * built, then runs (active) or is paused; `error` is the failure bucket. "all"
 * is the passthrough. Free-form on the wire, but these cover the real values.
 */
const STATUS_VALUES = [
  "draft",
  "discovering",
  "building",
  "active",
  "paused",
  "error",
] as const;

const STATUS_OPTIONS: SelectOption[] = [
  { label: "All statuses", value: "all" },
  ...STATUS_VALUES.map((s) => ({ label: titleCase(s), value: s })),
];

const SORT_OPTIONS: SelectOption[] = [
  { label: "Name (A–Z)", value: "name" },
  { label: "Newest", value: "newest" },
];

export interface AgentFiltersProps {
  query: string;
  template: TemplateFilter;
  status: StatusFilter;
  sortBy: SortBy;
  /** Debounced (~200ms) - fires after the user stops typing. */
  onQueryChange: (query: string) => void;
  onTemplateChange: (template: TemplateFilter) => void;
  onStatusChange: (status: StatusFilter) => void;
  onSortByChange: (sortBy: SortBy) => void;
}

/** Debounce delay for the search box, in ms. */
const SEARCH_DEBOUNCE_MS = 200;

/**
 * AgentFilters (MNEMO-42) - the dashboard's search/filter/sort controls: a
 * debounced search box (name/description), a template select, a status select,
 * and a sort select. Built entirely from the shared UI library. Presentational +
 * a local ~200ms debounce on the search input; all narrowing is done by the
 * parent via `filterAndSortAgents`.
 */
export function AgentFilters({
  query,
  template,
  status,
  sortBy,
  onQueryChange,
  onTemplateChange,
  onStatusChange,
  onSortByChange,
}: AgentFiltersProps) {
  // Local mirror so typing is instant; the debounced effect lifts it to the parent.
  const [text, setText] = useState(query);
  const onQueryChangeRef = useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;

  // Keep the local field in sync if the parent resets `query` externally.
  useEffect(() => {
    setText(query);
  }, [query]);

  // Debounce: only push to the parent once typing pauses for SEARCH_DEBOUNCE_MS.
  useEffect(() => {
    if (text === query) return;
    const id = setTimeout(
      () => onQueryChangeRef.current(text),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(id);
  }, [text, query]);

  return (
    <Inline gap="3" align="center" className={styles.toolbar}>
      <div className={styles.search}>
        <SearchInput
          aria-label="Search agents"
          placeholder="Search agents…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onClear={() => {
            setText("");
            onQueryChangeRef.current("");
          }}
        />
      </div>
      <div className={styles.filter}>
        <Select
          aria-label="Filter by template"
          value={template}
          options={TEMPLATE_OPTIONS}
          onChange={(e) => onTemplateChange(e.target.value as TemplateFilter)}
        />
      </div>
      <div className={styles.filter}>
        <Select
          aria-label="Filter by status"
          value={status}
          options={STATUS_OPTIONS}
          onChange={(e) => onStatusChange(e.target.value)}
        />
      </div>
      <div className={styles.filter}>
        <Select
          aria-label="Sort agents"
          value={sortBy}
          options={SORT_OPTIONS}
          onChange={(e) => onSortByChange(e.target.value as SortBy)}
        />
      </div>
    </Inline>
  );
}
