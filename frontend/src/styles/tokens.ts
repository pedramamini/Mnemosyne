/**
 * Typed mirror of the CSS custom properties declared in `tokens.css`.
 *
 * This module gives TypeScript-aware access to token *names* and to the scale
 * keys components accept as props (e.g. `space="4"`, `size="lg"`). It does NOT
 * hold the visual values themselves - those live only in `tokens.css` so the
 * skin can be swapped there without touching code. The helpers below build
 * `var(--token)` references from a key, keeping component styling token-driven.
 */

/** Semantic color roles. Each maps to a `--color-*` custom property. */
export const COLOR_ROLES = [
  "bg",
  "surface",
  "surface-raised",
  "surface-sunken",
  "border",
  "border-strong",
  "text",
  "text-muted",
  "text-inverted",
  "primary",
  "primary-hover",
  "primary-active",
  "primary-fg",
  "primary-subtle",
  "success",
  "success-fg",
  "success-subtle",
  "warning",
  "warning-fg",
  "warning-subtle",
  "danger",
  "danger-fg",
  "danger-subtle",
  "focus-ring",
  "overlay",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

/** Spacing scale keys (4px base). Map to `--space-*`. */
export const SPACE_SCALE = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
] as const;
export type SpaceScale = (typeof SPACE_SCALE)[number];

/** Type-size scale keys. Map to `--text-*`. */
export const TEXT_SCALE = [
  "xs",
  "sm",
  "md",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
] as const;
export type TextScale = (typeof TEXT_SCALE)[number];

/** Font-weight tokens. Map to `--font-weight-*`. */
export const FONT_WEIGHTS = ["regular", "medium", "semibold", "bold"] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

/** Radius scale keys. Map to `--radius-*`. */
export const RADII = ["sm", "md", "lg", "full"] as const;
export type Radius = (typeof RADII)[number];

/** Elevation tokens. Map to `--shadow-*`. */
export const SHADOWS = ["1", "2", "3"] as const;
export type Shadow = (typeof SHADOWS)[number];

/** Z-index layers. Map to `--z-*`. */
export const Z_LAYERS = [
  "base",
  "dropdown",
  "overlay",
  "modal",
  "toast",
] as const;
export type ZLayer = (typeof Z_LAYERS)[number];

/** Motion duration tokens. Map to `--dur-*`. */
export const DURATIONS = ["fast", "base", "slow"] as const;
export type Duration = (typeof DURATIONS)[number];

/**
 * Breakpoint widths in pixels. Kept in sync with the `--bp-*` constants in
 * `tokens.css`. Use for matchMedia / programmatic responsive checks.
 */
export const BREAKPOINTS = {
  sm: 480,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;
export type Breakpoint = keyof typeof BREAKPOINTS;

/** Build a `var(--color-<role>)` reference for inline/style-object use. */
export function colorVar(role: ColorRole): string {
  return `var(--color-${role})`;
}

/** Build a `var(--space-<step>)` reference. */
export function spaceVar(step: SpaceScale): string {
  return `var(--space-${step})`;
}

/** Build a `var(--radius-<key>)` reference. */
export function radiusVar(key: Radius): string {
  return `var(--radius-${key})`;
}

/** Build a `var(--shadow-<level>)` reference. */
export function shadowVar(level: Shadow): string {
  return `var(--shadow-${level})`;
}

/** Build a `var(--z-<layer>)` reference. */
export function zVar(layer: ZLayer): string {
  return `var(--z-${layer})`;
}
