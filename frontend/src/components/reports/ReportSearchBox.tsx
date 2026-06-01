import { useEffect, useRef, useState } from "react";
import { SearchInput } from "@/components/ui";

export interface ReportSearchBoxProps {
  /** Current committed query (the source of truth lives in the parent). */
  value: string;
  /** Fired with the debounced query as the user types / on clear. */
  onQueryChange: (query: string) => void;
  placeholder?: string;
}

/** Debounce delay before a settled query is reported upstream. */
const DEBOUNCE_MS = 250;

/**
 * ReportSearchBox (MNEMO-41) - a search input over the kit's `SearchInput` that
 * debounces keystrokes (~250ms) before calling `onQueryChange`, with a clear
 * button (SearchInput's `onClear`) that resets immediately. Presentational +
 * local debounce only - the parent owns the query state and runs the search.
 */
export function ReportSearchBox({
  value,
  onQueryChange,
  placeholder = "Search reports…",
}: ReportSearchBoxProps) {
  // Local, immediately-responsive input text; the debounced value flows upstream.
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local text in sync if the parent resets the committed value.
  useEffect(() => {
    setText(value);
  }, [value]);

  // Clear any pending debounce on unmount.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function schedule(next: string) {
    setText(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onQueryChange(next), DEBOUNCE_MS);
  }

  function clear() {
    if (timer.current) clearTimeout(timer.current);
    setText("");
    onQueryChange("");
  }

  return (
    <SearchInput
      value={text}
      placeholder={placeholder}
      aria-label="Search reports"
      onChange={(e) => schedule(e.target.value)}
      onClear={clear}
    />
  );
}
