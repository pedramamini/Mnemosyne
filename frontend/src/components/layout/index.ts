/**
 * Layout primitives - the shared app chrome and responsive helpers. Screens import
 * the breakpoint hooks and `<ResponsiveMasterDetail>` from here so responsiveness
 * comes from ONE source of truth (MNEMO-43), the same way feature code imports UI
 * exclusively from `@/components/ui`.
 */

export type { AppLayoutProps } from "./AppLayout";
export { AppLayout } from "./AppLayout";
export type { ResponsiveMasterDetailProps } from "./ResponsiveMasterDetail";
export { ResponsiveMasterDetail } from "./ResponsiveMasterDetail";
export {
  atLeast,
  below,
  useBreakpoint,
  useIsMobile,
  useMediaQuery,
} from "./useBreakpoint";

/*
 * ──────────────────────────────────────────────────────────────────────────────
 * Mobile no-overflow checklist (MNEMO-43)
 *
 * Runtime viewport tests are the primary guard (see responsive.test.tsx and the
 * mobile-viewport assertions in the page __tests__). A static lint rule for fixed
 * widths proved more trouble than value, so this is the documented standard every
 * screen must hold to - verify it must stay true at a 360px viewport:
 *
 *  1. Top-level page/tab containers use NO fixed `width`/`min-width` in px. Width
 *     comes from the flow (`Page`/`Container`, `width: 100%`, `flex`, `grid`).
 *  2. Fixed widths belong on INNER panes only, paired with `max-width: 100%` (or
 *     supplied via `<ResponsiveMasterDetail masterWidth=…>`, which a mobile branch
 *     drops entirely).
 *  3. Overflowing content (diffs, code, wide tables, the graph canvas) lives in a
 *     container with `overflow-x: auto` + `min-width: 0`, never the page.
 *  4. Media images/charts: `max-width: 100%; height: auto`.
 *  5. Grids reflow to one column (auto-fit `min(col, 100%)`, or an explicit
 *     `columns={1}` mobile branch).
 *  6. Interactive controls keep a ≥44px touch target on mobile (the
 *     `--touch-target-min` token; see Input/Select/Button/IconButton).
 * ──────────────────────────────────────────────────────────────────────────────
 */
