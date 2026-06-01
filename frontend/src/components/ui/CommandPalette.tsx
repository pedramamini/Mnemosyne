import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "@/lib/fuzzy";
import { Kbd } from "./Code";
import styles from "./CommandPalette.module.css";
import { Portal } from "./Portal";
import { SearchInput } from "./SearchInput";
import { useFocusTrap } from "./useFocusTrap";
import { cx } from "./utils";

export interface CommandItem {
  /** Stable identity for the item. */
  id: string;
  /** Primary text - what's fuzzy-matched and highlighted. */
  label: string;
  /** Section header the item sorts under (shown when not searching). */
  group?: string;
  /** Extra space-separated terms to match on (synonyms); never highlighted. */
  keywords?: string;
  /** Leading icon/avatar node. */
  icon?: ReactNode;
  /** Trailing slot - e.g. an "Active" badge or a shortcut hint. */
  hint?: ReactNode;
  /** Invoked when the item is chosen (click or Enter). The palette then closes. */
  onSelect: () => void;
  /**
   * Invoked when the item becomes the highlighted row - for live, transient
   * previews (e.g. applying a theme as it's cycled). Must be cheap and
   * reversible; the caller undoes it via {@link CommandPaletteProps.onPreviewClear}.
   */
  onPreview?: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  /** Requested close (Escape, backdrop click, or after selecting an item). */
  onClose: () => void;
  /** The full command set; filtered/ranked internally as the user types. */
  items: CommandItem[];
  placeholder?: string;
  /** Shown when the query matches nothing. */
  emptyMessage?: string;
  /**
   * Undo any live {@link CommandItem.onPreview}. Called when the highlighted
   * row has no preview of its own and when the palette closes - so a preview
   * never outlives the palette unless an item committed it via `onSelect`.
   */
  onPreviewClear?: () => void;
}

interface Ranked {
  item: CommandItem;
  ranges: Array<[number, number]>;
}

/** Split `label` into highlighted (matched) and plain spans for rendering. */
function highlight(label: string, ranges: Array<[number, number]>): ReactNode {
  if (ranges.length === 0) return label;
  const out: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end]) => {
    if (start > cursor) out.push(label.slice(cursor, start));
    out.push(
      <mark key={`${start}-${end}`} className={styles.match}>
        {label.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < label.length) out.push(label.slice(cursor));
  return out;
}

/**
 * CommandPalette - a ⌘K-style overlay: a fuzzy-filtered, keyboard-driven command
 * list over a focus-trapped surface. Presentational + interaction only; the
 * caller supplies the {@link CommandItem}s (navigation, theme switches, agents,
 * …) and owns `open`. Filtering ranks by {@link fuzzyMatch}; matched characters
 * are highlighted. Navigate with ↑/↓ (Home/End jump), choose with Enter, dismiss
 * with Escape or a backdrop click. Implements the combobox + listbox ARIA
 * pattern with `aria-activedescendant` driving the active row.
 */
export function CommandPalette({
  open,
  onClose,
  items,
  placeholder = "Type a command or search…",
  emptyMessage = "No matches.",
  onPreviewClear,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const wasOpenRef = useRef(false);
  const listId = "command-palette-list";

  useFocusTrap(dialogRef, open, onClose);

  // Reset the query each time the palette opens so it never reopens pre-filled.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  // Rank items against the query: when blank, keep the caller's order (grouped);
  // otherwise fuzzy-match label (preferred, highlightable) then keywords, and
  // sort by score descending.
  const ranked = useMemo<Ranked[]>(() => {
    const q = query.trim();
    if (!q) return items.map((item) => ({ item, ranges: [] }));

    const scored: Array<Ranked & { score: number }> = [];
    for (const item of items) {
      const onLabel = fuzzyMatch(q, item.label);
      if (onLabel) {
        scored.push({ item, ranges: onLabel.ranges, score: onLabel.score });
        continue;
      }
      const onKeywords = item.keywords ? fuzzyMatch(q, item.keywords) : null;
      if (onKeywords) {
        scored.push({ item, ranges: [], score: onKeywords.score - 1 });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(({ item, ranges }) => ({ item, ranges }));
  }, [items, query]);

  const searching = query.trim().length > 0;

  // Keep the active index in range as the result set shrinks/grows.
  useEffect(() => {
    setActiveIndex((i) =>
      ranked.length === 0 ? 0 : Math.min(i, ranked.length - 1),
    );
  }, [ranked.length]);

  // Scroll the active row into view as it moves. `scrollIntoView` is absent in
  // jsdom (and older engines), so call it only when present.
  useEffect(() => {
    if (open) {
      rowRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeIndex, open]);

  // Live-preview the highlighted row: items exposing `onPreview` (theme/font
  // switches) apply transiently as they're cycled; landing on a row without one
  // clears any active preview so the committed look shows through.
  useEffect(() => {
    if (!open) return;
    const item = ranked[activeIndex]?.item;
    if (item?.onPreview) item.onPreview();
    else onPreviewClear?.();
  }, [open, activeIndex, ranked, onPreviewClear]);

  // Undo any live preview when the palette closes. A committing selection
  // persists its own choice first (clearing its draft), so this only reverts
  // previews the user dismissed without choosing.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      onPreviewClear?.();
    }
  }, [open, onPreviewClear]);

  if (!open) return null;

  function move(delta: 1 | -1) {
    if (ranked.length === 0) return;
    setActiveIndex((i) => (i + delta + ranked.length) % ranked.length);
  }

  function choose(index: number) {
    const entry = ranked[index];
    if (!entry) return;
    entry.item.onSelect();
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        if (ranked.length > 0) setActiveIndex(ranked.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        choose(activeIndex);
        break;
    }
  }

  const activeId = ranked[activeIndex]
    ? `command-item-${ranked[activeIndex].item.id}`
    : undefined;

  return (
    <Portal>
      <div className={styles.backdrop}>
        <div
          className={styles.backdropClick}
          onClick={onClose}
          aria-hidden="true"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          className={styles.panel}
        >
          <div className={styles.searchRow}>
            <SearchInput
              autoFocus
              value={query}
              placeholder={placeholder}
              aria-label="Command palette"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeId}
              aria-autocomplete="list"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              onClear={() => setQuery("")}
            />
          </div>

          {ranked.length === 0 ? (
            <div className={styles.empty}>{emptyMessage}</div>
          ) : (
            <div id={listId} role="listbox" className={styles.list}>
              {ranked.map(({ item, ranges }, index) => {
                const prevGroup =
                  index > 0 ? ranked[index - 1].item.group : undefined;
                const showHeader =
                  !searching && item.group && item.group !== prevGroup;
                const active = index === activeIndex;
                return (
                  <div key={item.id}>
                    {showHeader && (
                      <div className={styles.groupHeader} aria-hidden="true">
                        {item.group}
                      </div>
                    )}
                    <button
                      ref={(el) => {
                        rowRefs.current[index] = el;
                      }}
                      type="button"
                      role="option"
                      id={`command-item-${item.id}`}
                      aria-selected={active}
                      tabIndex={-1}
                      className={cx(
                        styles.option,
                        active && styles.optionActive,
                      )}
                      onClick={() => choose(index)}
                      onMouseMove={() => setActiveIndex(index)}
                    >
                      {item.icon && (
                        <span className={styles.optionIcon}>{item.icon}</span>
                      )}
                      <span className={styles.optionLabel}>
                        {highlight(item.label, ranges)}
                      </span>
                      {searching && item.group && (
                        <span className={styles.optionGroup}>{item.group}</span>
                      )}
                      {item.hint && (
                        <span className={styles.optionHint}>{item.hint}</span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className={styles.footer} aria-hidden="true">
            <span>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span>
              <Kbd>↵</Kbd> select
            </span>
            <span>
              <Kbd>esc</Kbd> close
            </span>
          </div>
        </div>
      </div>
    </Portal>
  );
}
