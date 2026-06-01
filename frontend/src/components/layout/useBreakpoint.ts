import { useEffect, useState } from "react";
import { BREAKPOINTS, type Breakpoint } from "@/styles/tokens";

/**
 * Shared responsive primitives (MNEMO-43). The single programmatic mirror of the
 * design-system breakpoints in `tokens.css`/`tokens.ts`, so every screen branches
 * on ONE source of truth instead of ad-hoc `window.innerWidth` checks. CSS-only
 * responsiveness still belongs in `@media` queries against the `--bp-*` tokens;
 * these hooks are for the cases that genuinely need a JS branch (e.g. swapping a
 * two-pane layout for a push/overlay detail view - see {@link ResponsiveMasterDetail}).
 */

/** True only in a browser with a working `matchMedia` (SSR/jsdom-without-a-stub → false). */
function canMatch(): boolean {
  return (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
  );
}

/**
 * Subscribe to a CSS media-query string, re-rendering when it changes. SSR-safe
 * (returns `false` when there is no `window`/`matchMedia`) and built around a
 * test seam: unit tests stub `window.matchMedia` to drive mobile vs. desktop.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    canMatch() ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (!canMatch()) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange(); // sync on mount and whenever `query` changes
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Media query matching viewports at/above the given breakpoint (mobile-first up). */
export function atLeast(bp: Breakpoint): string {
  return `(min-width: ${BREAKPOINTS[bp]}px)`;
}

/** Media query matching viewports below the given breakpoint. */
export function below(bp: Breakpoint): string {
  return `(max-width: ${BREAKPOINTS[bp] - 1}px)`;
}

/**
 * Whether the viewport currently sits at/above a breakpoint (default `md` - the
 * desktop threshold). Mirrors the `>= md` desktop layouts so a screen can decide,
 * in JS, whether it's on the desktop side of the design-system breakpoints.
 */
export function useBreakpoint(bp: Breakpoint = "md"): boolean {
  return useMediaQuery(atLeast(bp));
}

/** True on phone-sized viewports (below the `md` breakpoint). */
export function useIsMobile(): boolean {
  return useMediaQuery(below("md"));
}
